alter table public.invoices
  add column if not exists discount_mode text not null default 'fixed',
  add column if not exists discount_value numeric not null default 0,
  add column if not exists invoice_type text not null default '';

alter table public.invoices drop constraint if exists invoices_discount_mode_check;
alter table public.invoices
  add constraint invoices_discount_mode_check
  check (discount_mode in ('fixed', 'percent'));

alter table public.invoices drop constraint if exists invoices_invoice_type_check;
alter table public.invoices
  add constraint invoices_invoice_type_check
  check (invoice_type in ('', 'simplified', 'tax'));

comment on column public.invoices.invoice_type is
  'Resolved human-readable invoice type: simplified (usually B2C) or tax (B2B).';
