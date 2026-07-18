create table if not exists public.fieldtech_events (
  id text primary key,
  owner_uid text not null,
  event_type text not null,
  entity_id text not null,
  processed_at timestamptz not null default now()
);

create table if not exists public.fieldtech_job_states (
  id text primary key,
  owner_uid text not null,
  booking_id text not null,
  technician_id text not null,
  app_status text not null,
  completion_note text not null default '',
  occurred_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.fieldtech_technician_locations (
  id text primary key,
  owner_uid text not null,
  technician_id text not null,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  accuracy double precision not null default 0 check (accuracy between 0 and 10000),
  recorded_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create index if not exists fieldtech_events_owner_idx
  on public.fieldtech_events(owner_uid, processed_at desc);
create index if not exists fieldtech_job_states_owner_idx
  on public.fieldtech_job_states(owner_uid, updated_at desc);
create index if not exists fieldtech_locations_owner_idx
  on public.fieldtech_technician_locations(owner_uid, recorded_at desc);

alter table public.fieldtech_events enable row level security;
alter table public.fieldtech_job_states enable row level security;
alter table public.fieldtech_technician_locations enable row level security;

drop policy if exists fieldtech_events_owner_access on public.fieldtech_events;
drop policy if exists fieldtech_job_states_owner_access on public.fieldtech_job_states;
drop policy if exists fieldtech_locations_owner_access on public.fieldtech_technician_locations;

create policy fieldtech_events_owner_access on public.fieldtech_events
  for all using (owner_uid = (select auth.uid())::text)
  with check (owner_uid = (select auth.uid())::text);
create policy fieldtech_job_states_owner_access on public.fieldtech_job_states
  for all using (owner_uid = (select auth.uid())::text)
  with check (owner_uid = (select auth.uid())::text);
create policy fieldtech_locations_owner_access on public.fieldtech_technician_locations
  for all using (owner_uid = (select auth.uid())::text)
  with check (owner_uid = (select auth.uid())::text);
