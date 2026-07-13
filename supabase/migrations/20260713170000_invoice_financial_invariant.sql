-- Reconcile legacy invoice headers from their JSON line items. New writes use
-- the same discount-before-VAT invariant in the API. Rows without verifiable
-- items are deliberately left untouched so historical amounts are not guessed.
drop trigger if exists invoices_touch_updated_at on public.invoices;

with eligible as (
  select
    invoice.id,
    invoice.items,
    case when invoice.discount_mode = 'percent' then 'percent' else 'fixed' end as discount_mode,
    case
      when invoice.discount_mode = 'percent' then greatest(coalesce(invoice.discount_value, 0), 0)
      when coalesce(invoice.discount_value, 0) > 0 then greatest(invoice.discount_value, 0)
      else greatest(coalesce(invoice.discount, 0), 0)
    end as discount_input,
    least(100, greatest(coalesce(invoice.vat_percent, 15), 0)) as vat_percent,
    round(greatest(coalesce(invoice.additional_fee, 0), 0), 2) as additional_fee
  from public.invoices as invoice
  where jsonb_typeof(invoice.items) = 'array'
    and jsonb_array_length(case
      when jsonb_typeof(invoice.items) = 'array' then invoice.items
      else '[]'::jsonb
    end) > 0
    and not exists (
      select 1
      from jsonb_array_elements(case
        when jsonb_typeof(invoice.items) = 'array' then invoice.items
        else '[]'::jsonb
      end) as candidate(value)
      where jsonb_typeof(candidate.value) is distinct from 'object'
        or jsonb_typeof(candidate.value -> 'description') is distinct from 'string'
        or nullif(btrim(candidate.value ->> 'description'), '') is null
        or case
          when jsonb_typeof(candidate.value -> 'quantity') = 'number'
            then (candidate.value ->> 'quantity')::numeric <= 0
          else true
        end
        or case
          when jsonb_typeof(coalesce(
            nullif(candidate.value -> 'unit_price', 'null'::jsonb),
            candidate.value -> 'unitPrice'
          )) = 'number'
            then coalesce(candidate.value ->> 'unit_price', candidate.value ->> 'unitPrice')::numeric < 0
          else true
        end
    )
), line_values as (
  select
    eligible.id,
    eligible.discount_mode,
    eligible.discount_input,
    eligible.vat_percent,
    eligible.additional_fee,
    sum(
      case
        when lower(coalesce(item.value ->> 'vat_excluded', 'true')) in ('false', '0')
          and eligible.vat_percent > 0
          then numbers.quantity * numbers.unit_price / (1 + eligible.vat_percent / 100)
        else numbers.quantity * numbers.unit_price
      end
    ) as subtotal_raw
  from eligible
  cross join lateral jsonb_array_elements(eligible.items) as item(value)
  cross join lateral (
    select
      case
        when jsonb_typeof(item.value -> 'quantity') = 'number'
          then greatest((item.value ->> 'quantity')::numeric, 0)
        else 0
      end as quantity,
      case
        when jsonb_typeof(coalesce(
          nullif(item.value -> 'unit_price', 'null'::jsonb),
          item.value -> 'unitPrice'
        )) = 'number'
          then greatest(coalesce(item.value ->> 'unit_price', item.value ->> 'unitPrice')::numeric, 0)
        else 0
      end as unit_price
  ) as numbers
  group by
    eligible.id,
    eligible.discount_mode,
    eligible.discount_input,
    eligible.vat_percent,
    eligible.additional_fee
), discounted as (
  select
    line_values.*,
    least(
      subtotal_raw,
      case
        when discount_mode = 'percent'
          then subtotal_raw * least(100, discount_input) / 100
        else discount_input
      end
    ) as discount_raw
  from line_values
), canonical as (
  select
    id,
    round(subtotal_raw, 2) as subtotal,
    round(discount_raw, 2) as discount,
    discount_mode,
    round(discount_input, 2) as discount_value,
    vat_percent,
    round((subtotal_raw - discount_raw) * vat_percent / 100, 2) as vat_amount,
    additional_fee,
    round(subtotal_raw - discount_raw, 2) as total_without_vat,
    round(
      (subtotal_raw - discount_raw)
        + ((subtotal_raw - discount_raw) * vat_percent / 100)
        + additional_fee,
      2
    ) as total_with_vat
  from discounted
)
update public.invoices as invoice
set
  subtotal = canonical.subtotal,
  discount = canonical.discount,
  discount_mode = canonical.discount_mode,
  discount_value = canonical.discount_value,
  vat = canonical.vat_amount,
  vat_percent = canonical.vat_percent,
  vat_amount = canonical.vat_amount,
  additional_fee = canonical.additional_fee,
  total_without_vat = canonical.total_without_vat,
  total_with_vat = canonical.total_with_vat
from canonical
where invoice.id = canonical.id
  and (
    invoice.subtotal is distinct from canonical.subtotal
    or invoice.discount is distinct from canonical.discount
    or invoice.discount_mode is distinct from canonical.discount_mode
    or invoice.discount_value is distinct from canonical.discount_value
    or invoice.vat is distinct from canonical.vat_amount
    or invoice.vat_percent is distinct from canonical.vat_percent
    or invoice.vat_amount is distinct from canonical.vat_amount
    or invoice.additional_fee is distinct from canonical.additional_fee
    or invoice.total_without_vat is distinct from canonical.total_without_vat
    or invoice.total_with_vat is distinct from canonical.total_with_vat
  );

create trigger invoices_touch_updated_at before update on public.invoices
for each row execute function public.touch_updated_at();
