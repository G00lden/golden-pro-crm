create table if not exists public.maintenance_requests (
  id text primary key,
  owner_uid text not null,
  request_number text not null,
  client_request_id text not null,
  status text not null default 'new'
    check (status in ('new', 'approved', 'scheduled', 'in_progress', 'closed', 'rejected', 'cancelled')),
  customer_id text,
  customer_name text not null default '',
  customer_phone text not null default '',
  city text not null default '',
  address text not null default '',
  service_type text not null default 'general',
  product_id text,
  product_name text not null default '',
  installation_id text,
  issue_description text not null default '',
  warranty_status text not null default 'unknown',
  invoice_number text not null default '',
  preferred_date date,
  preferred_time text,
  scheduled_date date,
  scheduled_time text,
  technician_id text,
  technician_name text,
  booking_id text,
  customer_change_requested boolean not null default false,
  customer_change_note text not null default '',
  resolution_note text not null default '',
  completion_override_reason text not null default '',
  portal_token_version integer not null default 1 check (portal_token_version > 0),
  portal_access_revoked_at timestamptz,
  rejection_reason text not null default '',
  cancellation_reason text not null default '',
  source text not null default 'maintenance_portal',
  accepted_terms_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_uid, request_number),
  unique (owner_uid, client_request_id)
);

create table if not exists public.maintenance_request_events (
  id text primary key,
  owner_uid text not null,
  request_id text not null references public.maintenance_requests(id) on delete restrict,
  request_number text not null,
  action text not null,
  actor_type text not null check (actor_type in ('customer', 'operator', 'technician', 'system')),
  actor_uid text,
  from_status text,
  to_status text,
  message text not null default '',
  customer_visible boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists maintenance_requests_owner_created_idx
  on public.maintenance_requests(owner_uid, created_at desc);
create index if not exists maintenance_requests_owner_status_idx
  on public.maintenance_requests(owner_uid, status, updated_at desc);
create index if not exists maintenance_requests_booking_idx
  on public.maintenance_requests(booking_id);
create index if not exists maintenance_request_events_request_idx
  on public.maintenance_request_events(request_id, created_at);

alter table public.maintenance_requests
  add column if not exists portal_token_version integer not null default 1;
alter table public.maintenance_requests
  add column if not exists portal_access_revoked_at timestamptz;
alter table public.maintenance_requests
  add column if not exists completion_override_reason text not null default '';

alter table public.fieldtech_job_states
  add column if not exists before_photo_ref text,
  add column if not exists before_photo_sha256 text,
  add column if not exists before_photo_captured_at timestamptz,
  add column if not exists after_photo_ref text,
  add column if not exists after_photo_sha256 text,
  add column if not exists after_photo_captured_at timestamptz,
  add column if not exists signature_ref text,
  add column if not exists signature_sha256 text,
  add column if not exists signature_captured_at timestamptz,
  add column if not exists evidence_complete boolean not null default false;

alter table public.bookings
  add column if not exists customer_address text not null default '',
  add column if not exists notes text not null default '',
  add column if not exists parts jsonb not null default '[]'::jsonb,
  add column if not exists fieldtech_require_before_photo boolean not null default true,
  add column if not exists fieldtech_require_after_photo boolean not null default true,
  add column if not exists fieldtech_require_signature boolean not null default true;

-- The initial CRM schema only admitted manual/Salla bookings. Maintenance
-- assignments use their own explicit source and must not fail at commit time.
alter table public.bookings drop constraint if exists bookings_source_check;
alter table public.bookings
  add constraint bookings_source_check
  check (source in ('manual', 'salla', 'maintenance_portal'));

create or replace function public.apply_maintenance_request_mutation(
  p_request_id text,
  p_owner_uid text,
  p_expected_status text,
  p_request_patch jsonb,
  p_event_id text,
  p_event jsonb,
  p_booking_id text default null,
  p_booking jsonb default null,
  p_capacity jsonb default null
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.maintenance_requests%rowtype;
  v_booking public.bookings%rowtype;
  v_active_count integer;
begin
  select * into v_request
    from public.maintenance_requests
   where id = p_request_id and owner_uid = p_owner_uid
   for update;
  if not found then return 'request_not_found'; end if;
  if v_request.status <> p_expected_status then return 'request_conflict'; end if;

  if p_booking_id is not null and p_booking is not null then
    select * into v_booking from public.bookings where id = p_booking_id for update;
    if found and v_booking.owner_uid <> p_owner_uid then return 'booking_owner_conflict'; end if;
    if p_capacity is not null then
      perform pg_advisory_xact_lock(hashtextextended(
        p_owner_uid || ':' || (p_capacity->>'technician_id') || ':' || (p_capacity->>'date'),
        0
      ));
      if exists (
        select 1 from public.bookings
         where owner_uid = p_owner_uid
           and technician_id = p_capacity->>'technician_id'
           and date = (p_capacity->>'date')::date
           and id <> p_capacity->>'exclude_booking_id'
           and status <> 'cancelled'
           and scheduled_time = p_capacity->>'scheduled_time'
      ) then return 'booking_time_conflict'; end if;
      select count(*) into v_active_count from public.bookings
       where owner_uid = p_owner_uid
         and technician_id = p_capacity->>'technician_id'
         and date = (p_capacity->>'date')::date
         and id <> p_capacity->>'exclude_booking_id'
         and status <> 'cancelled';
      if v_active_count >= (p_capacity->>'max_daily')::integer then
        return 'booking_capacity_exceeded';
      end if;
    end if;
    if not found then
      v_booking.id := p_booking_id;
      v_booking.owner_uid := p_owner_uid;
    end if;
    v_booking := jsonb_populate_record(v_booking, p_booking);
    v_booking.id := p_booking_id;
    v_booking.owner_uid := p_owner_uid;
    insert into public.bookings select (v_booking).*
    on conflict (id) do update set
      owner_uid = excluded.owner_uid,
      installation_id = excluded.installation_id,
      customer_id = excluded.customer_id,
      customer_name = excluded.customer_name,
      customer_phone = excluded.customer_phone,
      product_id = excluded.product_id,
      product_name = excluded.product_name,
      technician_id = excluded.technician_id,
      tech_name = excluded.tech_name,
      date = excluded.date,
      scheduled_time = excluded.scheduled_time,
      status = excluded.status,
      booking_type = excluded.booking_type,
      source = excluded.source,
      store_order_id = excluded.store_order_id,
      store_order_number = excluded.store_order_number,
      completed_at = excluded.completed_at,
      customer_address = excluded.customer_address,
      notes = excluded.notes,
      parts = excluded.parts,
      fieldtech_require_before_photo = excluded.fieldtech_require_before_photo,
      fieldtech_require_after_photo = excluded.fieldtech_require_after_photo,
      fieldtech_require_signature = excluded.fieldtech_require_signature,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at;
  end if;

  v_request := jsonb_populate_record(v_request, p_request_patch);
  update public.maintenance_requests set
    status = v_request.status,
    preferred_date = v_request.preferred_date,
    preferred_time = v_request.preferred_time,
    scheduled_date = v_request.scheduled_date,
    scheduled_time = v_request.scheduled_time,
    technician_id = v_request.technician_id,
    technician_name = v_request.technician_name,
    booking_id = v_request.booking_id,
    customer_change_requested = v_request.customer_change_requested,
    customer_change_note = v_request.customer_change_note,
    resolution_note = v_request.resolution_note,
    completion_override_reason = v_request.completion_override_reason,
    portal_token_version = v_request.portal_token_version,
    portal_access_revoked_at = v_request.portal_access_revoked_at,
    rejection_reason = v_request.rejection_reason,
    cancellation_reason = v_request.cancellation_reason,
    closed_at = v_request.closed_at,
    updated_at = v_request.updated_at
  where id = p_request_id and owner_uid = p_owner_uid and status = p_expected_status;
  if not found then return 'request_conflict'; end if;

  insert into public.maintenance_request_events (
    id, owner_uid, request_id, request_number, action, actor_type, actor_uid,
    from_status, to_status, message, customer_visible, metadata, created_at, updated_at
  ) values (
    p_event_id,
    p_owner_uid,
    p_event->>'request_id',
    p_event->>'request_number',
    p_event->>'action',
    p_event->>'actor_type',
    nullif(p_event->>'actor_uid', ''),
    nullif(p_event->>'from_status', ''),
    nullif(p_event->>'to_status', ''),
    coalesce(p_event->>'message', ''),
    coalesce((p_event->>'customer_visible')::boolean, true),
    coalesce(p_event->'metadata', '{}'::jsonb),
    coalesce((p_event->>'created_at')::timestamptz, now()),
    coalesce((p_event->>'updated_at')::timestamptz, now())
  );
  return 'applied';
end;
$$;

revoke all on function public.apply_maintenance_request_mutation(text, text, text, jsonb, text, jsonb, text, jsonb, jsonb) from public;
grant execute on function public.apply_maintenance_request_mutation(text, text, text, jsonb, text, jsonb, text, jsonb, jsonb) to service_role;

alter table public.maintenance_requests enable row level security;
alter table public.maintenance_request_events enable row level security;

drop policy if exists maintenance_requests_owner_access on public.maintenance_requests;
drop policy if exists maintenance_request_events_owner_access on public.maintenance_request_events;

create policy maintenance_requests_owner_access on public.maintenance_requests
  for all using (owner_uid = (select auth.uid())::text)
  with check (owner_uid = (select auth.uid())::text);

create policy maintenance_request_events_owner_access on public.maintenance_request_events
  for all using (owner_uid = (select auth.uid())::text)
  with check (owner_uid = (select auth.uid())::text);
