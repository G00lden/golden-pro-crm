alter table if exists public.customers
  add column if not exists address text,
  add column if not exists customer_address text;

alter table if exists public.installations
  add column if not exists customer_address text,
  add column if not exists store_order_id text,
  add column if not exists store_order_number text,
  add column if not exists order_item_type text;

alter table if exists public.bookings
  add column if not exists customer_address text,
  add column if not exists notes text default '',
  add column if not exists parts jsonb default '[]'::jsonb;

alter table if exists public.store_orders
  add column if not exists customer_city text,
  add column if not exists customer_address text;
