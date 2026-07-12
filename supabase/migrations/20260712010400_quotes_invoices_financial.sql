create table if not exists public.quotes (
  id text primary key default ('quote_' || replace(gen_random_uuid()::text, '-', '')),
  owner_uid text not null,
  quote_number text not null,
  customer_id text,
  customer_name text not null default '',
  customer_phone text default '',
  customer_city text default '',
  customer_vat text default '',
  title text default '',
  status text not null default 'issued',
  issue_date date not null default current_date,
  valid_until date,
  follow_up_date date,
  subtotal numeric not null default 0,
  discount numeric not null default 0,
  discount_mode text not null default 'fixed' check (discount_mode in ('fixed', 'percent')),
  discount_value numeric not null default 0,
  tax numeric not null default 0,
  vat_percent numeric not null default 15 check (vat_percent between 0 and 100),
  vat_amount numeric not null default 0,
  total_without_vat numeric not null default 0,
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
  installments jsonb not null default '[]'::jsonb,
  items jsonb not null default '[]'::jsonb,
  notes text default '',
  terms text default '',
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_uid, quote_number)
);

create table if not exists public.invoices (
  id text primary key default ('inv_' || replace(gen_random_uuid()::text, '-', '')),
  owner_uid text not null,
  invoice_number text not null,
  quote_id text,
  customer_id text,
  customer_name text not null default '',
  customer_phone text default '',
  customer_city text default '',
  customer_vat text default '',
  title text default '',
  status text not null default 'issued',
  issue_date date not null default current_date,
  due_date date,
  paid_at timestamptz,
  payment_method text default '',
  subtotal numeric not null default 0,
  discount numeric not null default 0,
  vat numeric not null default 0,
  vat_percent numeric not null default 15 check (vat_percent between 0 and 100),
  vat_amount numeric not null default 0,
  total_without_vat numeric not null default 0,
  total_with_vat numeric not null default 0,
  currency text not null default 'SAR',
  items jsonb not null default '[]'::jsonb,
  notes text default '',
  terms text default '',
  seller_name text default '',
  seller_vat text default '',
  seller_vat_number text default '',
  seller_address text default '',
  qr_code text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_uid, invoice_number)
);

alter table public.quotes add column if not exists customer_vat text default '';
alter table public.quotes add column if not exists discount_mode text not null default 'fixed';
alter table public.quotes add column if not exists discount_value numeric not null default 0;
alter table public.quotes add column if not exists vat_percent numeric not null default 15;
alter table public.quotes add column if not exists vat_amount numeric not null default 0;
alter table public.quotes add column if not exists total_without_vat numeric not null default 0;
alter table public.quotes add column if not exists installments jsonb not null default '[]'::jsonb;

create index if not exists quotes_owner_created_idx on public.quotes(owner_uid, created_at desc);
create index if not exists quotes_owner_status_idx on public.quotes(owner_uid, status, created_at desc);
create index if not exists quotes_owner_follow_up_idx on public.quotes(owner_uid, follow_up_date);
create index if not exists invoices_owner_created_idx on public.invoices(owner_uid, created_at desc);
create index if not exists invoices_owner_status_idx on public.invoices(owner_uid, status, created_at desc);

drop trigger if exists quotes_touch_updated_at on public.quotes;
create trigger quotes_touch_updated_at before update on public.quotes
for each row execute function public.touch_updated_at();

drop trigger if exists invoices_touch_updated_at on public.invoices;
create trigger invoices_touch_updated_at before update on public.invoices
for each row execute function public.touch_updated_at();

alter table public.quotes enable row level security;
alter table public.invoices enable row level security;

drop policy if exists quotes_owner_access on public.quotes;
drop policy if exists invoices_owner_access on public.invoices;

create policy quotes_owner_access on public.quotes
  for all using (owner_uid = (select auth.uid())::text)
  with check (owner_uid = (select auth.uid())::text);

create policy invoices_owner_access on public.invoices
  for all using (owner_uid = (select auth.uid())::text)
  with check (owner_uid = (select auth.uid())::text);
