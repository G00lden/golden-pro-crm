alter table public.products
  add column if not exists store_provider text,
  add column if not exists price numeric,
  add column if not exists sale_price numeric,
  add column if not exists currency text not null default 'SAR',
  add column if not exists image_url text,
  add column if not exists image_urls jsonb not null default '[]'::jsonb,
  add column if not exists stock_quantity numeric,
  add column if not exists store_status text,
  add column if not exists description text not null default '',
  add column if not exists store_url text,
  add column if not exists store_admin_url text,
  add column if not exists store_product_type text,
  add column if not exists categories jsonb not null default '[]'::jsonb,
  add column if not exists variants jsonb not null default '[]'::jsonb,
  add column if not exists is_available boolean not null default true,
  add column if not exists unlimited_quantity boolean not null default false,
  add column if not exists last_synced_at timestamptz;

create index if not exists products_owner_store_product_idx
  on public.products(owner_uid, store_provider, store_product_id);
