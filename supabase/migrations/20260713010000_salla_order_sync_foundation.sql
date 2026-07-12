alter table public.store_orders
  add column if not exists remote_status_id text,
  add column if not exists remote_status_name text,
  add column if not exists remote_status_slug text,
  add column if not exists remote_updated_at timestamptz,
  add column if not exists remote_synced_at timestamptz,
  add column if not exists sync_origin text,
  add column if not exists remote_deleted_at timestamptz;

create table if not exists public.salla_order_inbox (
  id text primary key default ('soi_' || replace(gen_random_uuid()::text, '-', '')),
  owner_uid text not null,
  merchant_id text,
  event_type text not null default '',
  remote_order_id text,
  payload_hash text not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  next_attempt_at timestamptz,
  error_code text,
  error text,
  lease_token text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.salla_order_commands (
  id text primary key default ('soc_' || replace(gen_random_uuid()::text, '-', '')),
  owner_uid text not null,
  order_doc_id text not null,
  remote_order_id text,
  command_type text not null,
  desired_hash text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  before_hash text,
  after_hash text,
  result_status text,
  last_error text,
  actor_uid text,
  lease_token text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table public.salla_order_inbox add column if not exists lease_token text;
alter table public.salla_order_commands add column if not exists lease_token text;

create index if not exists salla_order_inbox_owner_status_idx
  on public.salla_order_inbox(owner_uid, status, received_at);
create index if not exists salla_order_inbox_due_idx
  on public.salla_order_inbox(status, next_attempt_at, received_at);
create index if not exists salla_order_inbox_remote_order_idx
  on public.salla_order_inbox(owner_uid, remote_order_id, received_at desc);

create index if not exists salla_order_commands_owner_status_idx
  on public.salla_order_commands(owner_uid, status, created_at);
create index if not exists salla_order_commands_due_idx
  on public.salla_order_commands(status, updated_at, created_at);
create index if not exists salla_order_commands_order_idx
  on public.salla_order_commands(owner_uid, order_doc_id, created_at desc);
create unique index if not exists salla_order_commands_desired_hash_uidx
  on public.salla_order_commands(owner_uid, order_doc_id, command_type, desired_hash)
  where desired_hash <> '';

drop trigger if exists salla_order_inbox_touch_updated_at on public.salla_order_inbox;
create trigger salla_order_inbox_touch_updated_at
  before update on public.salla_order_inbox
  for each row execute function public.touch_updated_at();

drop trigger if exists salla_order_commands_touch_updated_at on public.salla_order_commands;
create trigger salla_order_commands_touch_updated_at
  before update on public.salla_order_commands
  for each row execute function public.touch_updated_at();

alter table public.salla_order_inbox enable row level security;
alter table public.salla_order_commands enable row level security;

drop policy if exists salla_order_inbox_owner_access on public.salla_order_inbox;
create policy salla_order_inbox_owner_access on public.salla_order_inbox
  for all using (owner_uid = (select auth.uid())::text)
  with check (owner_uid = (select auth.uid())::text);

drop policy if exists salla_order_commands_owner_access on public.salla_order_commands;
create policy salla_order_commands_owner_access on public.salla_order_commands
  for all using (owner_uid = (select auth.uid())::text)
  with check (owner_uid = (select auth.uid())::text);
