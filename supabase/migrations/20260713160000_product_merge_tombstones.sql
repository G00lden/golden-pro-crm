alter table public.products
  add column if not exists merged_into text,
  add column if not exists merged_at timestamptz;

create index if not exists products_owner_merged_into_idx
  on public.products(owner_uid, merged_into);
