alter table public.maintenance_requests
  add column if not exists product_category text not null default '',
  add column if not exists product_image_url text not null default '',
  add column if not exists customer_latitude double precision,
  add column if not exists customer_longitude double precision,
  add column if not exists location_accuracy double precision,
  add column if not exists location_url text not null default '',
  add column if not exists phone_verified_at timestamptz,
  add column if not exists attachment_count integer not null default 0 check (attachment_count between 0 and 5);

create table if not exists public.maintenance_portal_settings (
  id text primary key,
  owner_uid text not null unique,
  slot_times jsonb not null default '["09:00","11:00","14:00","16:00"]'::jsonb,
  closed_weekdays jsonb not null default '[5]'::jsonb,
  booking_horizon_days integer not null default 21 check (booking_horizon_days between 1 and 60),
  slot_capacity integer not null default 1 check (slot_capacity between 1 and 20),
  min_lead_hours integer not null default 2 check (min_lead_hours between 0 and 72),
  location_required boolean not null default true,
  attachments_enabled boolean not null default true,
  whatsapp_verification_required boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.maintenance_phone_verifications (
  id text primary key,
  owner_uid text not null,
  phone_hash text not null,
  code_hash text not null,
  token_hash text,
  status text not null default 'pending' check (status in ('pending','verified','consumed','invalid','expired')),
  attempts integer not null default 0,
  provider_message_id text,
  expires_at timestamptz not null,
  token_expires_at timestamptz,
  verified_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.maintenance_request_attachments (
  id text primary key,
  owner_uid text not null,
  verification_id text not null references public.maintenance_phone_verifications(id) on delete restrict,
  request_id text references public.maintenance_requests(id) on delete restrict,
  kind text not null check (kind in ('image','video')),
  media_type text not null,
  byte_size integer not null check (byte_size > 0 and byte_size <= 26214400),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  storage_ref text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists maintenance_verifications_phone_created_idx on public.maintenance_phone_verifications(owner_uid, phone_hash, created_at desc);
create index if not exists maintenance_attachments_verification_idx on public.maintenance_request_attachments(verification_id, created_at);
create index if not exists maintenance_attachments_request_idx on public.maintenance_request_attachments(request_id, created_at);

alter table public.maintenance_portal_settings enable row level security;
alter table public.maintenance_phone_verifications enable row level security;
alter table public.maintenance_request_attachments enable row level security;

create policy maintenance_portal_settings_owner_access on public.maintenance_portal_settings for all using (owner_uid = (select auth.uid())::text) with check (owner_uid = (select auth.uid())::text);
create policy maintenance_verifications_owner_access on public.maintenance_phone_verifications for all using (owner_uid = (select auth.uid())::text) with check (owner_uid = (select auth.uid())::text);
create policy maintenance_attachments_owner_access on public.maintenance_request_attachments for all using (owner_uid = (select auth.uid())::text) with check (owner_uid = (select auth.uid())::text);
