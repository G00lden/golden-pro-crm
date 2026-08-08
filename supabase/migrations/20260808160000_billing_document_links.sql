-- Durable, tenant-scoped links between approved quotes and their one source invoice.
alter table public.quotes
  add column if not exists invoice_id text,
  add column if not exists invoice_number text;

alter table public.invoices
  add column if not exists quote_number text;

create index if not exists quotes_owner_invoice_idx
  on public.quotes(owner_uid, invoice_id);

create index if not exists invoices_owner_quote_idx
  on public.invoices(owner_uid, quote_id);

do $$
declare
  duplicate_link record;
  number_conflict record;
  invoice_conflict record;
begin
  select owner_uid, quote_id, count(*) as invoice_count
    into duplicate_link
    from public.invoices
   where document_kind = 'invoice'
     and nullif(btrim(quote_id), '') is not null
   group by owner_uid, quote_id
  having count(*) > 1
   limit 1;
  if found then
    raise exception 'DUPLICATE_QUOTE_SOURCE_INVOICES owner=% quote=% count=%',
      duplicate_link.owner_uid, duplicate_link.quote_id, duplicate_link.invoice_count
      using errcode = '23505';
  end if;

  select invoice.id, invoice.quote_id
    into number_conflict
    from public.invoices invoice
    join public.quotes source
      on source.id = invoice.quote_id
     and source.owner_uid = invoice.owner_uid
   where invoice.document_kind = 'invoice'
     and nullif(btrim(invoice.quote_number), '') is not null
     and invoice.quote_number is distinct from source.quote_number
   limit 1;
  if found then
    raise exception 'INVOICE_QUOTE_NUMBER_CONFLICT invoice=% quote=%',
      number_conflict.id, number_conflict.quote_id using errcode = '23514';
  end if;

  select source.id, source.invoice_id, invoice.id as expected_invoice_id
    into invoice_conflict
    from public.quotes source
    join public.invoices invoice
      on invoice.quote_id = source.id
     and invoice.owner_uid = source.owner_uid
     and invoice.document_kind = 'invoice'
   where nullif(btrim(source.invoice_id), '') is not null
     and source.invoice_id is distinct from invoice.id
   limit 1;
  if found then
    raise exception 'QUOTE_INVOICE_LINK_CONFLICT quote=% invoice=% expected=%',
      invoice_conflict.id, invoice_conflict.invoice_id, invoice_conflict.expected_invoice_id
      using errcode = '23514';
  end if;
end;
$$;

create unique index if not exists invoices_owner_quote_source_uidx
  on public.invoices(owner_uid, quote_id)
  where document_kind = 'invoice' and nullif(btrim(quote_id), '') is not null;

update public.invoices invoice
   set quote_number = source.quote_number
  from public.quotes source
 where invoice.document_kind = 'invoice'
   and invoice.quote_id = source.id
   and invoice.owner_uid = source.owner_uid
   and nullif(btrim(invoice.quote_number), '') is null;

update public.quotes source
   set invoice_id = invoice.id,
       invoice_number = invoice.invoice_number
  from public.invoices invoice
 where invoice.document_kind = 'invoice'
   and invoice.quote_id = source.id
   and invoice.owner_uid = source.owner_uid;

create or replace function public.enforce_quote_financial_lock()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'INSERT' then
    if new.invoice_id is not null or new.invoice_number is not null then
      raise exception 'QUOTE_LINK_MUST_BE_CREATED_BY_CONVERSION' using errcode = '55000';
    end if;
    return new;
  end if;

  if (old.status = 'confirmed' or old.confirmed_at is not null or old.invoice_id is not null)
    and (to_jsonb(new) - array['updated_at', 'invoice_id', 'invoice_number'])
      is distinct from
      (to_jsonb(old) - array['updated_at', 'invoice_id', 'invoice_number']) then
    raise exception 'CONFIRMED_QUOTE_IMMUTABLE' using errcode = '55000';
  end if;

  if row(new.invoice_id, new.invoice_number) is distinct from row(old.invoice_id, old.invoice_number)
    and not (
      old.invoice_id is null
      and old.status = 'confirmed'
      and nullif(btrim(new.invoice_id), '') is not null
      and nullif(btrim(new.invoice_number), '') is not null
      and exists (
        select 1
        from public.invoices linked
        where linked.id = new.invoice_id
          and linked.owner_uid = old.owner_uid
          and linked.quote_id = old.id
          and linked.invoice_number = new.invoice_number
          and linked.document_kind = 'invoice'
      )
    ) then
    raise exception 'INVALID_QUOTE_INVOICE_LINK' using errcode = '55000';
  end if;

  return new;
end;
$$;

drop trigger if exists quotes_financial_lock on public.quotes;
create trigger quotes_financial_lock
before insert or update on public.quotes
for each row execute function public.enforce_quote_financial_lock();

create or replace function public.enforce_invoice_quote_link()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'INSERT'
    and new.document_kind = 'invoice'
    and new.quote_id is not null
    and (
      new.idempotency_key is distinct from ('quote:' || new.quote_id)
      or not exists (
        select 1
        from public.quotes source
        where source.id = new.quote_id
          and source.owner_uid = new.owner_uid
          and source.status = 'confirmed'
          and source.quote_number = new.quote_number
      )
    ) then
    raise exception 'INVALID_INVOICE_QUOTE_LINK' using errcode = '55000';
  end if;

  if tg_op = 'UPDATE'
    and (old.issued_at is not null or old.document_kind = 'credit_note' or old.status <> 'draft')
    and new.quote_number is distinct from old.quote_number then
    raise exception 'ISSUED_INVOICE_IMMUTABLE' using errcode = '55000';
  end if;

  return new;
end;
$$;

drop trigger if exists invoices_quote_link_guard on public.invoices;
create trigger invoices_quote_link_guard
before insert or update on public.invoices
for each row execute function public.enforce_invoice_quote_link();
