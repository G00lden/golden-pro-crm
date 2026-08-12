alter table public.store_orders
  add column if not exists customer_city text,
  add column if not exists subtotal numeric,
  add column if not exists shipping numeric,
  add column if not exists tax numeric,
  add column if not exists discount numeric,
  add column if not exists currency text not null default 'SAR',
  add column if not exists coupon text,
  add column if not exists payment_status text,
  add column if not exists payment_type_group text,
  add column if not exists payment_method text,
  add column if not exists attribution jsonb not null default '{}'::jsonb,
  add column if not exists analytics jsonb not null default '{}'::jsonb;

comment on column public.store_orders.payment_method is
  'Private CRM-only payment method label. Never forward this value to Google Analytics or Ads.';
comment on column public.store_orders.attribution is
  'Private browser attribution identifiers captured at checkout for GA4 and Ads matching.';
comment on column public.store_orders.analytics is
  'Auditable delivery states for GA4 validation/collection and Google Ads matching.';
