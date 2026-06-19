create extension if not exists pgcrypto;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

alter table if exists public.customers
  add column if not exists store_provider text,
  add column if not exists store_customer_id text,
  add column if not exists notes text;

alter table if exists public.products
  add column if not exists store_provider text,
  add column if not exists price numeric,
  add column if not exists sale_price numeric,
  add column if not exists currency text default 'SAR',
  add column if not exists image_url text,
  add column if not exists stock_quantity numeric,
  add column if not exists store_status text,
  add column if not exists last_synced_at timestamptz;

alter table if exists public.bookings
  add column if not exists completed_at timestamptz,
  add column if not exists confirmed_by_technician boolean default false,
  add column if not exists technician_confirmed_at timestamptz,
  add column if not exists technician_reminded_at timestamptz,
  add column if not exists notes text;

alter table if exists public.installations
  add column if not exists notes text;

alter table if exists public.store_webhook_events
  add column if not exists payload_hash text;

create table if not exists public.quotes (
  id text primary key default ('quote_' || replace(gen_random_uuid()::text, '-', '')),
  owner_uid text not null,
  quote_number text not null,
  customer_id text,
  customer_name text not null default '',
  customer_phone text default '',
  customer_city text default '',
  title text default '',
  status text not null default 'issued'
    check (status in ('draft', 'issued', 'confirmed', 'declined', 'expired', 'follow_up')),
  issue_date date not null default current_date,
  valid_until date,
  follow_up_date date,
  subtotal numeric not null default 0,
  discount numeric not null default 0,
  tax numeric not null default 0,
  total numeric not null default 0,
  currency text not null default 'SAR',
  payment_method text default '',
  payment_down_percent numeric default 70,
  payment_final_percent numeric default 30,
  payment_down_text text default '',
  payment_final_text text default '',
  payment_bank text default '',
  payment_account text default '',
  payment_iban text default '',
  payment_note text default '',
  invoice_status text not null default 'not_issued',
  invoice_number text default '',
  invoice_issued_at timestamptz,
  invoice_seller_name text default '',
  invoice_vat_number text default '',
  invoice_vat_rate numeric default 15,
  invoice_vat_amount numeric default 0,
  invoice_qr_payload text default '',
  invoice_phase text default '',
  items jsonb not null default '[]'::jsonb,
  notes text default '',
  terms text default '',
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_uid, quote_number)
);

create table if not exists public.whatsapp_messages (
  id text primary key default ('wam_' || replace(gen_random_uuid()::text, '-', '')),
  owner_uid text,
  type text,
  provider text,
  direction text check (direction in ('inbound', 'outbound')),
  from_phone text,
  to_phone text,
  message text,
  template_name text,
  message_id text,
  status text,
  installation_id text,
  booking_id text,
  metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.maintenance_history (
  id text primary key default ('mh_' || replace(gen_random_uuid()::text, '-', '')),
  installation_id text,
  customer_id text,
  action text,
  old_value text,
  new_value text,
  performed_by text,
  notes text,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.escalations (
  id text primary key default ('esc_' || replace(gen_random_uuid()::text, '-', '')),
  owner_uid text,
  installation_id text,
  customer_id text,
  customer_name text,
  customer_phone text,
  product_name text,
  original_maintenance_date date,
  remind_count integer default 0,
  last_reminded_at timestamptz,
  status text default 'active' check (status in ('active', 'resolved', 'dismissed')),
  assigned_to text,
  notes text default '',
  resolved_at timestamptz,
  resolved_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists customers_store_customer_idx on public.customers(owner_uid, store_provider, store_customer_id);
create index if not exists products_store_product_idx on public.products(owner_uid, store_provider, store_product_id);
create index if not exists quotes_owner_created_idx on public.quotes(owner_uid, created_at desc);
create index if not exists quotes_owner_status_idx on public.quotes(owner_uid, status, created_at desc);
create index if not exists quotes_owner_followup_idx on public.quotes(owner_uid, follow_up_date);
create index if not exists whatsapp_messages_owner_created_idx on public.whatsapp_messages(owner_uid, created_at desc);
create index if not exists whatsapp_messages_phone_idx on public.whatsapp_messages(from_phone, to_phone);
create index if not exists whatsapp_messages_message_id_idx on public.whatsapp_messages(message_id);
create index if not exists maintenance_history_installation_idx on public.maintenance_history(installation_id, created_at desc);
create index if not exists maintenance_history_customer_idx on public.maintenance_history(customer_id, created_at desc);
create index if not exists escalations_owner_status_idx on public.escalations(owner_uid, status, created_at desc);
create index if not exists store_webhook_events_payload_hash_idx on public.store_webhook_events(payload_hash);

drop trigger if exists quotes_touch_updated_at on public.quotes;
create trigger quotes_touch_updated_at before update on public.quotes
for each row execute function public.touch_updated_at();

drop trigger if exists whatsapp_messages_touch_updated_at on public.whatsapp_messages;
create trigger whatsapp_messages_touch_updated_at before update on public.whatsapp_messages
for each row execute function public.touch_updated_at();

drop trigger if exists escalations_touch_updated_at on public.escalations;
create trigger escalations_touch_updated_at before update on public.escalations
for each row execute function public.touch_updated_at();

alter table public.quotes enable row level security;
alter table public.whatsapp_messages enable row level security;
alter table public.maintenance_history enable row level security;
alter table public.escalations enable row level security;

drop policy if exists quotes_owner_access on public.quotes;
drop policy if exists whatsapp_messages_owner_access on public.whatsapp_messages;
drop policy if exists maintenance_history_owner_access on public.maintenance_history;
drop policy if exists escalations_owner_access on public.escalations;

create policy quotes_owner_access on public.quotes
  for all using (owner_uid = (select auth.uid())::text) with check (owner_uid = (select auth.uid())::text);
create policy whatsapp_messages_owner_access on public.whatsapp_messages
  for all using (owner_uid = (select auth.uid())::text) with check (owner_uid = (select auth.uid())::text);
create policy maintenance_history_owner_access on public.maintenance_history
  for all using (
    exists (
      select 1 from public.installations i
      where i.id = maintenance_history.installation_id
        and i.owner_uid = (select auth.uid())::text
    )
  ) with check (
    exists (
      select 1 from public.installations i
      where i.id = maintenance_history.installation_id
        and i.owner_uid = (select auth.uid())::text
    )
  );
create policy escalations_owner_access on public.escalations
  for all using (owner_uid = (select auth.uid())::text) with check (owner_uid = (select auth.uid())::text);
