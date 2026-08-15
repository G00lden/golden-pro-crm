alter table public.store_orders
  add column if not exists checkout_id text,
  add column if not exists analytics_reservation_mode text,
  add column if not exists attribution_claim_id text,
  add column if not exists attribution_claimed_at timestamptz;

create table if not exists public.storefront_attribution_claims (
  id text primary key,
  owner_uid text not null,
  provider text not null default 'salla',
  checkout_id text not null,
  claim_nonce_hash text,
  claim_token_hash text,
  attribution_hash text,
  attribution jsonb not null default '{}'::jsonb,
  status text not null default 'issued',
  authoritative_order_id text,
  order_id text,
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint storefront_attribution_claims_owner_checkout_unique unique (owner_uid, checkout_id)
);

create index if not exists storefront_attribution_claims_expiry_idx
  on public.storefront_attribution_claims (expires_at);

alter table public.storefront_attribution_claims enable row level security;

drop policy if exists storefront_attribution_claims_owner_access on public.storefront_attribution_claims;
create policy storefront_attribution_claims_owner_access
  on public.storefront_attribution_claims
  using (owner_uid = auth.uid()::text)
  with check (owner_uid = auth.uid()::text);

comment on table public.storefront_attribution_claims is
  'Short-lived, server-signed checkout attribution claims. Customer PII is prohibited.';
