-- Immutable, tenant-scoped invoice collection ledger.
-- Runtime support in release 1.9.6 remains SQLite-first; this migration keeps
-- the Supabase schema ready without exposing financial writes to the browser.

create unique index if not exists idx_invoices_owner_id
  on public.invoices(owner_uid, id);

create table if not exists public.invoice_payment_entries (
  id text primary key,
  owner_uid text not null,
  invoice_id text not null,
  entry_type text not null check (entry_type in ('collection', 'reversal')),
  method text not null check (method in ('cash', 'card', 'bank_transfer', 'tap', 'other')),
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null default 'SAR' check (currency ~ '^[A-Z]{3}$'),
  reference text not null default '',
  note text not null default '',
  source_payment_id text,
  reverses_entry_id text,
  idempotency_key text not null,
  recorded_by text not null default '',
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint invoice_payment_entry_shape check (
    (entry_type = 'collection' and reverses_entry_id is null)
    or (entry_type = 'reversal' and reverses_entry_id is not null)
  ),
  constraint invoice_payment_invoice_owner_fk
    foreign key (owner_uid, invoice_id)
    references public.invoices(owner_uid, id)
    on delete restrict,
  constraint invoice_payment_reversal_fk
    foreign key (reverses_entry_id)
    references public.invoice_payment_entries(id)
    on delete restrict
);

create index if not exists idx_invoice_payment_entries_owner_time
  on public.invoice_payment_entries(owner_uid, occurred_at desc, created_at desc);
create index if not exists idx_invoice_payment_entries_invoice
  on public.invoice_payment_entries(owner_uid, invoice_id, occurred_at desc);
create unique index if not exists idx_invoice_payment_entries_idempotency
  on public.invoice_payment_entries(owner_uid, idempotency_key);
create unique index if not exists idx_invoice_payment_entries_source_payment
  on public.invoice_payment_entries(owner_uid, source_payment_id)
  where source_payment_id is not null and entry_type = 'collection';
create unique index if not exists idx_invoice_payment_entries_one_reversal
  on public.invoice_payment_entries(reverses_entry_id)
  where reverses_entry_id is not null;

create or replace function public.enforce_invoice_payment_entry_immutability()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  original public.invoice_payment_entries%rowtype;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    raise exception 'INVOICE_PAYMENT_ENTRY_IMMUTABLE' using errcode = '55000';
  end if;

  if new.entry_type = 'reversal' then
    select *
      into original
      from public.invoice_payment_entries
     where id = new.reverses_entry_id
       and owner_uid = new.owner_uid
       and entry_type = 'collection'
     for update;

    if not found
      or original.invoice_id <> new.invoice_id
      or original.method <> new.method
      or original.amount_minor <> new.amount_minor
      or original.currency <> new.currency
      or (
        original.source_payment_id is not null
        and new.source_payment_id is distinct from original.source_payment_id
      )
    then
      raise exception 'INVOICE_PAYMENT_REVERSAL_INVALID' using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists invoice_payment_entries_immutable on public.invoice_payment_entries;
create trigger invoice_payment_entries_immutable
before insert or update or delete on public.invoice_payment_entries
for each row execute function public.enforce_invoice_payment_entry_immutability();

alter table public.invoice_payment_entries enable row level security;

drop policy if exists invoice_payment_entries_owner_select on public.invoice_payment_entries;
create policy invoice_payment_entries_owner_select
  on public.invoice_payment_entries
  for select
  using (owner_uid = (select auth.uid())::text);

revoke all on table public.invoice_payment_entries from anon, authenticated;
grant select on table public.invoice_payment_entries to authenticated;
grant select, insert on table public.invoice_payment_entries to service_role;

revoke all on function public.enforce_invoice_payment_entry_immutability()
  from public, anon, authenticated;
