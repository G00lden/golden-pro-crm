alter table public.invoices
  add column if not exists additional_fee numeric not null default 0;

alter table public.invoices drop constraint if exists invoices_additional_fee_non_negative;
alter table public.invoices
  add constraint invoices_additional_fee_non_negative
  check (additional_fee >= 0);

comment on column public.invoices.additional_fee is
  'Non-VAT fee applied after document VAT; preserved when a quote becomes an invoice.';
