alter table public.maintenance_requests
  add column if not exists request_type text not null default 'repair',
  add column if not exists maintenance_kind text not null default '',
  add column if not exists maintenance_kit_id text not null default '',
  add column if not exists maintenance_kit_name text not null default '',
  add column if not exists maintenance_kit_category text not null default '',
  add column if not exists maintenance_kit_sku text not null default '';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'maintenance_requests_request_type_check'
      and conrelid = 'public.maintenance_requests'::regclass
  ) then
    alter table public.maintenance_requests
      add constraint maintenance_requests_request_type_check
      check (request_type in ('repair', 'periodic'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'maintenance_requests_maintenance_kind_check'
      and conrelid = 'public.maintenance_requests'::regclass
  ) then
    alter table public.maintenance_requests
      add constraint maintenance_requests_maintenance_kind_check
      check (maintenance_kind in ('', 'filter_change', 'cooling_cells'));
  end if;
end $$;
