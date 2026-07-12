alter table public.customers
  add column if not exists customer_type text not null default 'unknown',
  add column if not exists odoo_id text;

alter table public.products
  add column if not exists service_mode text not null default 'none',
  add column if not exists policy_active boolean not null default false,
  add column if not exists service_tasks jsonb not null default '[]'::jsonb,
  add column if not exists compatibility_group text not null default '',
  add column if not exists warranty_months integer not null default 0,
  add column if not exists warranty_enabled boolean not null default false,
  add column if not exists reminder_media_type text not null default 'none',
  add column if not exists reminder_media_url text not null default '',
  add column if not exists reminder_cta text not null default 'auto';

alter table public.reminders
  add column if not exists asset_id text,
  add column if not exists service_cycle_id text;

create table if not exists public.customer_assets (
  id text primary key,
  owner_uid text not null,
  asset_code text not null,
  status text not null default 'unassigned',
  origin text not null default 'sold',
  customer_id text references public.customers(id) on delete set null,
  customer_name text not null default '',
  customer_phone text not null default '',
  product_id text references public.products(id) on delete set null,
  product_name text not null default '',
  product_sku text not null default '',
  manufacturer_serial text not null default '',
  location_label text not null default '',
  purchase_date date,
  installation_date date,
  warranty_months integer not null default 0,
  warranty_start date,
  warranty_end date,
  store_provider text,
  store_order_id text,
  store_order_number text,
  store_item_index integer,
  store_order_item_key text,
  source text not null default 'manual',
  notes text not null default '',
  activated_at timestamptz,
  activated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_uid, asset_code)
);

create unique index if not exists customer_assets_owner_serial_idx
  on public.customer_assets(owner_uid, manufacturer_serial)
  where manufacturer_serial <> '';
create index if not exists customer_assets_owner_status_idx
  on public.customer_assets(owner_uid, status, created_at desc);
create index if not exists customer_assets_customer_idx
  on public.customer_assets(owner_uid, customer_id, status);

create table if not exists public.service_cycles (
  id text primary key,
  owner_uid text not null,
  asset_id text not null references public.customer_assets(id) on delete cascade,
  customer_id text references public.customers(id) on delete set null,
  customer_name text not null default '',
  customer_phone text not null default '',
  product_id text references public.products(id) on delete set null,
  product_name text not null default '',
  task_key text not null,
  task_name text not null,
  status text not null default 'active',
  start_date date not null,
  due_date date not null,
  interval_value integer not null default 1,
  interval_unit text not null default 'months',
  lead_days integer not null default 14,
  reminder_template text not null default '',
  reminder_media_type text not null default 'none',
  reminder_media_url text not null default '',
  reminder_cta text not null default 'auto',
  reminder_count integer not null default 0,
  intensive_count integer not null default 0,
  last_reminder_at timestamptz,
  next_reminder_at date,
  completed_at timestamptz,
  completed_by text,
  completion_notes text not null default '',
  source_cycle_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists service_cycles_owner_due_idx
  on public.service_cycles(owner_uid, status, due_date);
create index if not exists service_cycles_next_reminder_idx
  on public.service_cycles(status, next_reminder_at);
create index if not exists service_cycles_asset_idx
  on public.service_cycles(owner_uid, asset_id, status);

create table if not exists public.asset_events (
  id text primary key,
  owner_uid text not null,
  asset_id text not null references public.customer_assets(id) on delete cascade,
  service_cycle_id text references public.service_cycles(id) on delete set null,
  event_type text not null,
  summary text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  performed_by text,
  created_at timestamptz not null default now()
);
create index if not exists asset_events_asset_idx
  on public.asset_events(owner_uid, asset_id, created_at desc);

create table if not exists public.marketing_campaigns (
  id text primary key,
  owner_uid text not null,
  name text not null,
  status text not null default 'draft',
  message text not null default '',
  media_type text not null default 'none',
  media_url text not null default '',
  selected_customer_ids jsonb not null default '[]'::jsonb,
  selected_product_ids jsonb not null default '[]'::jsonb,
  sent_count integer not null default 0,
  failed_count integer not null default 0,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists marketing_campaigns_owner_idx
  on public.marketing_campaigns(owner_uid, created_at desc);

create table if not exists public.odoo_import_runs (
  id text primary key,
  owner_uid text not null,
  mode text not null,
  status text not null default 'preview',
  imported integer not null default 0,
  updated integer not null default 0,
  failed integer not null default 0,
  summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists odoo_import_runs_owner_idx
  on public.odoo_import_runs(owner_uid, created_at desc);

create table if not exists public.replacement_links (
  id text primary key,
  owner_uid text not null,
  customer_id text,
  customer_name text default '',
  customer_phone text default '',
  product_id text not null,
  product_name text default '',
  compatibility_group text default '',
  candidate_asset_ids jsonb not null default '[]'::jsonb,
  selected_asset_id text,
  status text not null default 'pending',
  purchase_date date,
  store_order_id text,
  store_order_number text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists replacement_links_owner_status_idx
  on public.replacement_links(owner_uid, status, created_at desc);

alter table public.customer_assets enable row level security;
alter table public.service_cycles enable row level security;
alter table public.asset_events enable row level security;
alter table public.marketing_campaigns enable row level security;
alter table public.odoo_import_runs enable row level security;
alter table public.replacement_links enable row level security;

drop policy if exists customer_assets_owner_access on public.customer_assets;
create policy customer_assets_owner_access on public.customer_assets
  for all using (owner_uid = auth.uid()::text) with check (owner_uid = auth.uid()::text);
drop policy if exists service_cycles_owner_access on public.service_cycles;
create policy service_cycles_owner_access on public.service_cycles
  for all using (owner_uid = auth.uid()::text) with check (owner_uid = auth.uid()::text);
drop policy if exists asset_events_owner_access on public.asset_events;
create policy asset_events_owner_access on public.asset_events
  for all using (owner_uid = auth.uid()::text) with check (owner_uid = auth.uid()::text);
drop policy if exists marketing_campaigns_owner_access on public.marketing_campaigns;
create policy marketing_campaigns_owner_access on public.marketing_campaigns
  for all using (owner_uid = auth.uid()::text) with check (owner_uid = auth.uid()::text);
drop policy if exists odoo_import_runs_owner_access on public.odoo_import_runs;
create policy odoo_import_runs_owner_access on public.odoo_import_runs
  for all using (owner_uid = auth.uid()::text) with check (owner_uid = auth.uid()::text);
drop policy if exists replacement_links_owner_access on public.replacement_links;
create policy replacement_links_owner_access on public.replacement_links
  for all using (owner_uid = auth.uid()::text) with check (owner_uid = auth.uid()::text);
