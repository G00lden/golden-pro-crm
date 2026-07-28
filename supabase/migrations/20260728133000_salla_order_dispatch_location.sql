alter table if exists public.store_orders
  add column if not exists customer_latitude double precision,
  add column if not exists customer_longitude double precision,
  add column if not exists location_url text,
  add column if not exists shipment_id text,
  add column if not exists shipment_labels jsonb default '[]'::jsonb,
  add column if not exists tracking_number text,
  add column if not exists tracking_link text,
  add column if not exists salla_admin_url text,
  add column if not exists salla_customer_url text;

alter table if exists public.installations
  add column if not exists customer_latitude double precision,
  add column if not exists customer_longitude double precision,
  add column if not exists location_url text;

alter table if exists public.bookings
  add column if not exists customer_latitude double precision,
  add column if not exists customer_longitude double precision,
  add column if not exists location_url text;

alter table if exists public.store_orders
  drop constraint if exists store_orders_customer_latitude_check,
  add constraint store_orders_customer_latitude_check
    check (customer_latitude is null or customer_latitude between -90 and 90),
  drop constraint if exists store_orders_customer_longitude_check,
  add constraint store_orders_customer_longitude_check
    check (customer_longitude is null or customer_longitude between -180 and 180);

alter table if exists public.bookings
  drop constraint if exists bookings_customer_latitude_check,
  add constraint bookings_customer_latitude_check
    check (customer_latitude is null or customer_latitude between -90 and 90),
  drop constraint if exists bookings_customer_longitude_check,
  add constraint bookings_customer_longitude_check
    check (customer_longitude is null or customer_longitude between -180 and 180);
