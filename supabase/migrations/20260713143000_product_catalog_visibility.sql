alter table public.products
  add column if not exists catalog_visible boolean not null default true;

create index if not exists products_owner_catalog_visible_idx
  on public.products(owner_uid, catalog_visible, source);
