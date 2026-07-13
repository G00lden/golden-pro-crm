-- Persist the Salla fields used by the order/customer filter experience.
-- Keeping these fields in the local projection means opening or changing a
-- filter never calls Salla and cannot create remote writes.

alter table public.store_orders
  add column if not exists order_created_at timestamptz,
  add column if not exists order_timezone text,
  add column if not exists payment_method text,
  add column if not exists shipping_company text,
  add column if not exists shipment_status text,
  add column if not exists country text,
  add column if not exists sales_channel text,
  add column if not exists assigned_employee text,
  add column if not exists pickup_branch text,
  add column if not exists order_tags jsonb not null default '[]'::jsonb,
  add column if not exists is_read boolean,
  add column if not exists is_price_quote boolean,
  add column if not exists metadata_contract_version integer not null default 1;

create index if not exists store_orders_owner_created_idx
  on public.store_orders(owner_uid, order_created_at desc);
create index if not exists store_orders_owner_status_created_idx
  on public.store_orders(owner_uid, remote_status_slug, order_created_at desc);

alter table public.customers
  add column if not exists email text,
  add column if not exists country text,
  add column if not exists gender text,
  add column if not exists location text,
  add column if not exists customer_groups jsonb not null default '[]'::jsonb,
  add column if not exists is_blocked boolean,
  add column if not exists block_reason text,
  add column if not exists remote_created_at timestamptz,
  add column if not exists remote_updated_at timestamptz,
  add column if not exists remote_timezone text;

create index if not exists customers_owner_source_created_idx
  on public.customers(owner_uid, store_provider, created_at desc);
create index if not exists customers_owner_city_name_idx
  on public.customers(owner_uid, city, name);
