create extension if not exists pgcrypto;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.customers (
  id text primary key default ('cust_' || replace(gen_random_uuid()::text, '-', '')),
  owner_uid text not null,
  name text not null,
  phone text not null,
  city text,
  source text not null default 'manual' check (source in ('manual', 'salla')),
  store_provider text,
  store_customer_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_uid, phone)
);

create table if not exists public.products (
  id text primary key default ('prod_' || replace(gen_random_uuid()::text, '-', '')),
  owner_uid text not null,
  name text not null,
  interval_months integer not null default 3 check (interval_months > 0),
  category text,
  sku text,
  remind_text text,
  source text not null default 'manual' check (source in ('manual', 'salla')),
  product_type text not null default 'install_maintenance'
    check (product_type in ('sale_only', 'install_maintenance', 'maintenance_existing', 'external_maintenance', 'needs_review')),
  store_product_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists products_owner_sku_unique
  on public.products(owner_uid, sku)
  where sku is not null and sku <> '';

create table if not exists public.installations (
  id text primary key default ('inst_' || replace(gen_random_uuid()::text, '-', '')),
  owner_uid text not null,
  customer_id text references public.customers(id) on delete set null,
  customer_name text not null,
  customer_phone text not null,
  product_id text references public.products(id) on delete set null,
  product_name text not null,
  product_sku text,
  install_date date not null,
  next_maintenance date not null,
  remind_count integer not null default 0 check (remind_count >= 0),
  next_remind_type text check (next_remind_type in ('first', 'second', 'last')),
  label text,
  status text not null default 'active'
    check (status in ('pending_installation', 'pending_external_service', 'active', 'completed', 'cancelled')),
  completed_date date,
  last_remind_at timestamptz,
  last_remind_attempt_at timestamptz,
  source text not null default 'manual' check (source in ('manual', 'salla')),
  store_order_id text,
  store_order_number text,
  order_item_type text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.technicians (
  id text primary key default ('tech_' || replace(gen_random_uuid()::text, '-', '')),
  owner_uid text not null,
  name text not null,
  phone text not null,
  specialty text,
  max_daily integer not null default 4 check (max_daily > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.bookings (
  id text primary key default ('book_' || replace(gen_random_uuid()::text, '-', '')),
  owner_uid text not null,
  installation_id text references public.installations(id) on delete set null,
  customer_id text references public.customers(id) on delete set null,
  customer_name text not null,
  customer_phone text,
  product_id text references public.products(id) on delete set null,
  product_name text not null,
  technician_id text references public.technicians(id) on delete set null,
  tech_name text not null,
  date date not null,
  scheduled_time text not null,
  status text not null default 'confirmed' check (status in ('confirmed', 'completed', 'cancelled')),
  booking_type text not null default 'maintenance' check (booking_type in ('installation', 'maintenance', 'external_maintenance')),
  source text not null default 'manual' check (source in ('manual', 'salla')),
  store_order_id text,
  store_order_number text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.reminders (
  id text primary key default ('rem_' || replace(gen_random_uuid()::text, '-', '')),
  owner_uid text not null,
  installation_id text references public.installations(id) on delete set null,
  customer_id text references public.customers(id) on delete set null,
  customer_name text,
  customer_phone text,
  product_id text references public.products(id) on delete set null,
  product_name text,
  message text not null,
  reminder_type text,
  status text not null,
  trigger text,
  sent_at timestamptz not null default now(),
  error text,
  whatsapp_jid text,
  whatsapp_message_id text,
  created_at timestamptz not null default now()
);

create table if not exists public.settings (
  owner_uid text primary key,
  techs integer not null default 3,
  jobs_per_tech integer not null default 4,
  response_rate integer not null default 50,
  max_daily integer not null default 24,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.store_orders (
  id text primary key default ('store_' || replace(gen_random_uuid()::text, '-', '')),
  owner_uid text not null,
  source text not null default 'salla',
  provider text not null default 'salla',
  event_type text,
  order_id text not null,
  order_number text,
  status text,
  journey_status text not null default 'received'
    check (journey_status in ('received', 'sale_recorded', 'installation_created', 'awaiting_schedule', 'booking_created', 'maintenance_matched', 'needs_review', 'completed', 'cancelled')),
  current_step text,
  customer_id text,
  customer_name text,
  customer_phone text,
  product_ids text[] not null default '{}',
  installation_ids text[] not null default '{}',
  booking_ids text[] not null default '{}',
  order_types text[] not null default '{}',
  items jsonb not null default '[]'::jsonb,
  scheduled_date date,
  scheduled_time text,
  order_date date,
  total numeric,
  imported_at timestamptz not null default now(),
  last_event_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_uid, provider, order_id)
);

create table if not exists public.store_webhook_events (
  id text primary key,
  owner_uid text not null,
  provider text not null default 'salla',
  event_type text,
  event_id text not null,
  order_id text,
  order_number text,
  status text not null default 'received',
  auth_mode text,
  raw_payload jsonb,
  imported jsonb,
  error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, event_id)
);

create table if not exists public.technician_notifications (
  id text primary key default ('tn_' || replace(gen_random_uuid()::text, '-', '')),
  owner_uid text not null,
  booking_id text references public.bookings(id) on delete set null,
  technician_id text references public.technicians(id) on delete set null,
  technician_name text,
  technician_phone text,
  customer_id text references public.customers(id) on delete set null,
  customer_name text,
  customer_phone text,
  product_id text references public.products(id) on delete set null,
  product_name text,
  message text not null,
  trigger text,
  status text not null,
  sent_at timestamptz not null default now(),
  error text,
  whatsapp_jid text,
  whatsapp_message_id text,
  whatsapp_provider text,
  created_at timestamptz not null default now()
);

create index if not exists customers_owner_name_idx on public.customers(owner_uid, name);
create index if not exists products_owner_name_idx on public.products(owner_uid, name);
create index if not exists installations_owner_due_idx on public.installations(owner_uid, status, next_maintenance);
create index if not exists installations_owner_phone_sku_idx on public.installations(owner_uid, customer_phone, product_sku, status);
create index if not exists bookings_owner_date_time_idx on public.bookings(owner_uid, date, scheduled_time);
create index if not exists reminders_owner_sent_idx on public.reminders(owner_uid, sent_at desc);
create index if not exists store_orders_owner_imported_idx on public.store_orders(owner_uid, imported_at desc);
create index if not exists store_orders_owner_journey_idx on public.store_orders(owner_uid, journey_status, imported_at desc);
create index if not exists store_webhook_events_owner_received_idx on public.store_webhook_events(owner_uid, received_at desc);

drop trigger if exists customers_touch_updated_at on public.customers;
create trigger customers_touch_updated_at before update on public.customers
for each row execute function public.touch_updated_at();

drop trigger if exists products_touch_updated_at on public.products;
create trigger products_touch_updated_at before update on public.products
for each row execute function public.touch_updated_at();

drop trigger if exists installations_touch_updated_at on public.installations;
create trigger installations_touch_updated_at before update on public.installations
for each row execute function public.touch_updated_at();

drop trigger if exists technicians_touch_updated_at on public.technicians;
create trigger technicians_touch_updated_at before update on public.technicians
for each row execute function public.touch_updated_at();

drop trigger if exists bookings_touch_updated_at on public.bookings;
create trigger bookings_touch_updated_at before update on public.bookings
for each row execute function public.touch_updated_at();

drop trigger if exists settings_touch_updated_at on public.settings;
create trigger settings_touch_updated_at before update on public.settings
for each row execute function public.touch_updated_at();

drop trigger if exists store_orders_touch_updated_at on public.store_orders;
create trigger store_orders_touch_updated_at before update on public.store_orders
for each row execute function public.touch_updated_at();

drop trigger if exists store_webhook_events_touch_updated_at on public.store_webhook_events;
create trigger store_webhook_events_touch_updated_at before update on public.store_webhook_events
for each row execute function public.touch_updated_at();

alter table public.customers enable row level security;
alter table public.products enable row level security;
alter table public.installations enable row level security;
alter table public.technicians enable row level security;
alter table public.bookings enable row level security;
alter table public.reminders enable row level security;
alter table public.settings enable row level security;
alter table public.store_orders enable row level security;
alter table public.store_webhook_events enable row level security;
alter table public.technician_notifications enable row level security;

create policy customers_owner_access on public.customers
  for all using (owner_uid = auth.uid()::text) with check (owner_uid = auth.uid()::text);
create policy products_owner_access on public.products
  for all using (owner_uid = auth.uid()::text) with check (owner_uid = auth.uid()::text);
create policy installations_owner_access on public.installations
  for all using (owner_uid = auth.uid()::text) with check (owner_uid = auth.uid()::text);
create policy technicians_owner_access on public.technicians
  for all using (owner_uid = auth.uid()::text) with check (owner_uid = auth.uid()::text);
create policy bookings_owner_access on public.bookings
  for all using (owner_uid = auth.uid()::text) with check (owner_uid = auth.uid()::text);
create policy reminders_owner_access on public.reminders
  for all using (owner_uid = auth.uid()::text) with check (owner_uid = auth.uid()::text);
create policy settings_owner_access on public.settings
  for all using (owner_uid = auth.uid()::text) with check (owner_uid = auth.uid()::text);
create policy store_orders_owner_access on public.store_orders
  for all using (owner_uid = auth.uid()::text) with check (owner_uid = auth.uid()::text);
create policy store_webhook_events_owner_access on public.store_webhook_events
  for all using (owner_uid = auth.uid()::text) with check (owner_uid = auth.uid()::text);
create policy technician_notifications_owner_access on public.technician_notifications
  for all using (owner_uid = auth.uid()::text) with check (owner_uid = auth.uid()::text);
