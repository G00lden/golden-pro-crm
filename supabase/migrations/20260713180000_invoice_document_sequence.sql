-- Durable, tenant-scoped tax-document numbering and credit-note lifecycle.
-- Sequence values never reset and allocation is committed independently of the
-- document write, so an abandoned number cannot be reused.

alter table public.invoices
  add column if not exists document_kind text not null default 'invoice',
  add column if not exists sequence_no bigint,
  add column if not exists issued_at timestamptz,
  add column if not exists source_invoice_id text,
  add column if not exists adjustment_kind text,
  add column if not exists adjustment_scope text,
  add column if not exists adjustment_reason text,
  add column if not exists idempotency_key text;

drop trigger if exists invoices_ledger_immutability on public.invoices;
drop index if exists public.idx_invoices_owner_sequence;

update public.invoices
set invoice_number = 'DRAFT-' || upper(left(replace(id::text, '-', ''), 20)),
    sequence_no = null
where status = 'draft'
  and issued_at is null
  and invoice_number not like 'DRAFT-%';

with historical as (
  select
    id,
    owner_uid,
    invoice_number,
    coalesce(issued_at, created_at, issue_date::timestamptz) as sort_time,
    case
      when sequence_no between 1 and 9007199254740991 then sequence_no::numeric
      when btrim(invoice_number) ~ '^(INV|CN)-.+-[0-9]+$'
        then (substring(btrim(invoice_number) from '([0-9]+)$'))::numeric
      else null
    end as candidate
  from public.invoices
  where status <> 'draft'
    and nullif(btrim(invoice_number), '') is not null
),
ranked as (
  select
    *,
    row_number() over (
      partition by owner_uid, candidate
      order by sort_time nulls first, invoice_number, id
    ) as collision_rank,
    max(candidate) over (partition by owner_uid) as maximum_candidate
  from historical
  where candidate between 1 and 9007199254740991
),
collision_assignments as (
  select
    id,
    maximum_candidate + row_number() over (
      partition by owner_uid
      order by sort_time nulls first, invoice_number, id
    ) as assigned_sequence
  from ranked
  where collision_rank > 1
),
assignments as (
  select id, candidate as assigned_sequence
  from ranked
  where collision_rank = 1
  union all
  select id, assigned_sequence
  from collision_assignments
)
update public.invoices as invoice
set sequence_no = assignments.assigned_sequence::bigint
from assignments
where invoice.id = assignments.id
  and assignments.assigned_sequence between 1 and 9007199254740991;

update public.invoices
set issued_at = coalesce(created_at, issue_date::timestamptz)
where issued_at is null
  and status <> 'draft'
  and nullif(btrim(invoice_number), '') is not null;

alter table public.invoices drop constraint if exists invoices_document_kind_check;
alter table public.invoices
  add constraint invoices_document_kind_check
  check (document_kind in ('invoice', 'credit_note'));

alter table public.invoices drop constraint if exists invoices_sequence_no_check;
alter table public.invoices
  add constraint invoices_sequence_no_check
  check (sequence_no is null or sequence_no between 1 and 9007199254740991);

alter table public.invoices drop constraint if exists invoices_adjustment_kind_check;
alter table public.invoices
  add constraint invoices_adjustment_kind_check
  check (adjustment_kind is null or adjustment_kind in ('cancellation', 'refund'));

alter table public.invoices drop constraint if exists invoices_adjustment_scope_check;
alter table public.invoices
  add constraint invoices_adjustment_scope_check
  check (adjustment_scope is null or adjustment_scope in ('full', 'partial'));

alter table public.invoices drop constraint if exists invoices_idempotency_key_check;
alter table public.invoices
  add constraint invoices_idempotency_key_check
  check (idempotency_key is null or nullif(btrim(idempotency_key), '') is not null);

alter table public.invoices drop constraint if exists invoices_issued_sequence_check;
alter table public.invoices
  add constraint invoices_issued_sequence_check
  check (issued_at is null or sequence_no is not null);

alter table public.invoices drop constraint if exists invoices_credit_note_lifecycle_check;
alter table public.invoices
  add constraint invoices_credit_note_lifecycle_check
  check (
    (
      document_kind = 'invoice'
      and source_invoice_id is null
      and adjustment_kind is null
      and adjustment_scope is null
      and adjustment_reason is null
    )
    or
    (
      document_kind = 'credit_note'
      and nullif(btrim(source_invoice_id), '') is not null
      and adjustment_kind in ('cancellation', 'refund')
      and adjustment_scope in ('full', 'partial')
      and nullif(btrim(adjustment_reason), '') is not null
    )
  );

do $$
begin
  if exists (
    select 1
    from public.invoices
    where sequence_no is not null
    group by owner_uid, sequence_no
    having count(*) > 1
  ) then
    raise exception 'Invoice sequence migration aborted: duplicate owner sequence values require manual repair.';
  end if;
  if exists (
    select 1
    from public.invoices
    where idempotency_key is not null
    group by owner_uid, idempotency_key
    having count(*) > 1
  ) then
    raise exception 'Invoice sequence migration aborted: duplicate owner idempotency keys require manual repair.';
  end if;
  if exists (
    select 1
    from public.invoices
    where document_kind = 'credit_note' and adjustment_scope = 'full'
    group by owner_uid, source_invoice_id
    having count(*) > 1
  ) then
    raise exception 'Invoice sequence migration aborted: duplicate full credit notes require manual repair.';
  end if;
end
$$;

create unique index if not exists idx_invoices_owner_sequence
  on public.invoices(owner_uid, sequence_no)
  where sequence_no is not null;
create unique index if not exists idx_invoices_owner_idempotency
  on public.invoices(owner_uid, idempotency_key)
  where idempotency_key is not null;
create unique index if not exists idx_invoices_one_full_credit_per_source
  on public.invoices(owner_uid, source_invoice_id)
  where document_kind = 'credit_note' and adjustment_scope = 'full';
create index if not exists idx_invoices_owner_source
  on public.invoices(owner_uid, source_invoice_id);

create or replace function public.enforce_invoice_ledger_immutability()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'INSERT' then
    if new.document_kind = 'credit_note' then
      -- Serialize every full-credit decision with status transitions for the
      -- same tenant/source invoice. The transaction-scoped lock is released
      -- automatically on commit/rollback and a hash collision only adds
      -- harmless serialization; it cannot weaken the invariant.
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          pg_catalog.concat(new.owner_uid, E'\x1f', new.source_invoice_id),
          0
        )
      );

      if not exists (
        select 1
        from public.invoices source
        where source.id = new.source_invoice_id
          and source.owner_uid = new.owner_uid
          and source.document_kind = 'invoice'
          and (
            (new.adjustment_kind = 'cancellation' and source.status in ('issued', 'sent'))
            or (new.adjustment_kind = 'refund' and source.status = 'paid')
          )
      ) then
        raise exception 'CREDIT_NOTE_SOURCE_STATE_CONFLICT' using errcode = '40001';
      end if;
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.issued_at is not null or old.document_kind = 'credit_note' or old.status <> 'draft' then
      raise exception 'ISSUED_INVOICE_DELETE_FORBIDDEN' using errcode = '55000';
    end if;
    return old;
  end if;

  if new.document_kind = 'invoice' and new.status is distinct from old.status then
    -- Use the exact same lock key as credit-note insertion. Whichever
    -- transaction wins is committed before the waiting transaction evaluates
    -- the ledger again, preventing paid/sent and full-credit from crossing.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        pg_catalog.concat(old.owner_uid, E'\x1f', old.id),
        0
      )
    );

    if exists (
        select 1
        from public.invoices credit
        where credit.owner_uid = old.owner_uid
          and credit.source_invoice_id = old.id
          and credit.document_kind = 'credit_note'
          and credit.adjustment_scope = 'full'
      ) then
      raise exception 'INVOICE_ALREADY_CREDITED' using errcode = '40001';
    end if;
  end if;

  if (old.issued_at is not null or old.document_kind = 'credit_note' or old.status <> 'draft') and row(
    new.owner_uid, new.invoice_number, new.document_kind, new.sequence_no,
    new.issued_at, new.source_invoice_id, new.adjustment_kind,
    new.adjustment_scope, new.adjustment_reason, new.idempotency_key,
    new.quote_id, new.customer_id, new.customer_name, new.customer_phone,
    new.customer_city, new.customer_vat, new.title, new.issue_date,
    new.due_date, new.payment_method, new.subtotal, new.discount,
    new.discount_mode, new.discount_value, new.vat, new.vat_percent,
    new.vat_amount, new.additional_fee, new.total_without_vat,
    new.total_with_vat, new.currency, new.items, new.notes, new.terms,
    new.seller_name, new.seller_vat, new.seller_vat_number,
    new.seller_address, new.invoice_type, new.qr_code, new.created_at
  ) is distinct from row(
    old.owner_uid, old.invoice_number, old.document_kind, old.sequence_no,
    old.issued_at, old.source_invoice_id, old.adjustment_kind,
    old.adjustment_scope, old.adjustment_reason, old.idempotency_key,
    old.quote_id, old.customer_id, old.customer_name, old.customer_phone,
    old.customer_city, old.customer_vat, old.title, old.issue_date,
    old.due_date, old.payment_method, old.subtotal, old.discount,
    old.discount_mode, old.discount_value, old.vat, old.vat_percent,
    old.vat_amount, old.additional_fee, old.total_without_vat,
    old.total_with_vat, old.currency, old.items, old.notes, old.terms,
    old.seller_name, old.seller_vat, old.seller_vat_number,
    old.seller_address, old.invoice_type, old.qr_code, old.created_at
  ) then
    raise exception 'ISSUED_INVOICE_IMMUTABLE' using errcode = '55000';
  end if;
  return new;
end;
$$;

drop trigger if exists invoices_ledger_immutability on public.invoices;
create trigger invoices_ledger_immutability
before insert or update or delete on public.invoices
for each row execute function public.enforce_invoice_ledger_immutability();

create table if not exists public.invoice_sequences (
  owner_uid text not null,
  series text not null,
  last_value bigint not null check (last_value between 0 and 9007199254740991),
  updated_at timestamptz not null default now(),
  primary key (owner_uid, series)
);

alter table public.invoice_sequences enable row level security;

-- The browser may inspect its own tax documents, but all ledger mutations go
-- through the authenticated CRM server. The service role keeps its explicit
-- write grant and bypasses RLS; anon/authenticated cannot INSERT arbitrary
-- sequence values or mutate/delete an issued document through PostgREST.
drop policy if exists invoices_owner_access on public.invoices;
drop policy if exists invoices_owner_select on public.invoices;
create policy invoices_owner_select on public.invoices
  for select
  using (owner_uid = (select auth.uid())::text);

revoke all on table public.invoices from anon, authenticated;
grant select on table public.invoices to authenticated;
grant select, insert, update, delete on table public.invoices to service_role;

insert into public.invoice_sequences(owner_uid, series, last_value, updated_at)
select owner_uid, 'tax_documents', max(sequence_no), now()
from public.invoices
where sequence_no is not null
group by owner_uid
on conflict(owner_uid, series) do update set
  last_value = greatest(public.invoice_sequences.last_value, excluded.last_value),
  updated_at = excluded.updated_at;

create or replace function public.allocate_invoice_sequence(
  p_owner_uid text,
  p_series text,
  p_minimum_next bigint default 1
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  allocated bigint;
begin
  if p_owner_uid is null or length(btrim(p_owner_uid)) = 0 or length(p_owner_uid) > 256 then
    raise exception 'Counter owner UID is invalid.' using errcode = '22023';
  end if;
  if p_series is null or p_series !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$' then
    raise exception 'Counter namespace is invalid.' using errcode = '22023';
  end if;
  if p_minimum_next is null or p_minimum_next < 1 or p_minimum_next > 9007199254740991 then
    raise exception 'Counter minimumNext is invalid.' using errcode = '22023';
  end if;

  insert into public.invoice_sequences(owner_uid, series, last_value, updated_at)
  values (btrim(p_owner_uid), p_series, p_minimum_next, now())
  on conflict(owner_uid, series) do update set
    last_value = greatest(public.invoice_sequences.last_value + 1, excluded.last_value),
    updated_at = excluded.updated_at
  returning last_value into allocated;

  return allocated;
end;
$$;

revoke all on table public.invoice_sequences from anon, authenticated;
revoke all on function public.enforce_invoice_ledger_immutability() from public, anon, authenticated;
revoke all on function public.allocate_invoice_sequence(text, text, bigint) from public, anon, authenticated;
grant execute on function public.allocate_invoice_sequence(text, text, bigint) to service_role;
