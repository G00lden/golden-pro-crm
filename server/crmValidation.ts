import { z } from "zod";
import { isSaudiVatNumber, normalizeVatNumber } from "../shared/zatca";
import { addCalendarMonths } from "../shared/date";

const id = z.string().trim().min(1).max(160);
const shortText = z.string().trim().max(200);
const longText = z.string().trim().max(10_000);
const phone = z.string().trim().min(1).max(32);
const optionalPhone = z.string().trim().max(32).optional();
const isoDate = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
  .refine((value) => {
    try {
      addCalendarMonths(value, 0);
      return true;
    } catch {
      return false;
    }
  }, "Date does not exist");
const optionalDate = isoDate.optional().nullable();
const money = z.coerce.number().finite().min(0).max(1_000_000_000);
const optionalSaudiVat = z.string().trim().max(32).refine(
  (value) => !value || isSaudiVatNumber(value),
  "VAT number must contain exactly 15 digits.",
).transform(normalizeVatNumber).optional();
const zatcaSellerName = z.string().trim().max(300).refine(
  (value) => new TextEncoder().encode(value).length <= 255,
  "Seller name must fit within 255 UTF-8 bytes for the ZATCA QR.",
);

function nonEmptyUpdate<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape).partial().refine((value) => Object.keys(value).length > 0, "At least one field is required.");
}

export const crmIdParamsSchema = z.object({ id });

const customerShape = {
  name: z.string().trim().min(1).max(200),
  phone,
  city: shortText.optional(),
  source: z.enum(["manual", "salla"]).optional(),
  store_provider: shortText.optional(),
  store_customer_id: id.optional().nullable(),
};
export const customerCreateSchema = z.object(customerShape);
export const customerUpdateSchema = nonEmptyUpdate(customerShape);

const productShape = {
  name: z.string().trim().min(1).max(240),
  interval_months: z.coerce.number().int().min(1).max(120),
  category: shortText.optional(),
  sku: z.string().trim().max(120).optional(),
  remind_text: z.string().trim().max(4000).optional(),
  source: z.enum(["manual", "salla"]).optional(),
  store_provider: shortText.optional(),
  store_product_id: id.optional().nullable(),
  price: money.optional().nullable(),
  sale_price: money.optional().nullable(),
  currency: z.string().trim().min(3).max(8).optional(),
  image_url: z.string().url().max(2048).optional().or(z.literal("")),
  stock_quantity: z.coerce.number().finite().min(0).max(1_000_000_000).optional().nullable(),
  store_status: shortText.optional(),
  product_type: z.enum(["sale_only", "install_maintenance", "maintenance_existing", "external_maintenance", "needs_review"]).optional(),
};
export const productCreateSchema = z.object(productShape);
export const productUpdateSchema = nonEmptyUpdate(productShape);

const installationShape = {
  customer_id: id,
  customer_name: z.string().trim().min(1).max(200),
  customer_phone: phone,
  product_id: id,
  product_name: z.string().trim().min(1).max(240),
  product_sku: z.string().trim().max(120).optional(),
  install_date: isoDate,
  next_maintenance: isoDate,
  next_remind_type: z.enum(["first", "second", "last"]).optional().nullable(),
  label: shortText.optional(),
  status: z.enum(["pending_installation", "pending_external_service", "active", "completed", "cancelled"]).optional(),
  source: z.enum(["manual", "salla"]).optional(),
  store_order_id: id.optional(),
  store_order_number: shortText.optional(),
  order_item_type: shortText.optional(),
};
export const installationCreateSchema = z.object(installationShape);
export const installationUpdateSchema = nonEmptyUpdate(installationShape);
export const installationCompleteSchema = z.object({ completedDate: isoDate.optional() });

const technicianShape = {
  name: z.string().trim().min(1).max(200),
  phone,
  specialty: shortText.optional(),
  max_daily: z.coerce.number().int().min(1).max(100).optional(),
};
export const technicianCreateSchema = z.object(technicianShape);
export const technicianUpdateSchema = nonEmptyUpdate(technicianShape);

const bookingShape = {
  installation_id: id.optional(),
  customer_id: id,
  customer_name: z.string().trim().min(1).max(200),
  customer_phone: optionalPhone,
  product_id: id,
  product_name: z.string().trim().min(1).max(240),
  technician_id: id,
  tech_name: z.string().trim().min(1).max(200),
  date: isoDate,
  scheduled_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:MM"),
  status: z.enum(["confirmed", "completed", "cancelled"]).optional(),
  booking_type: z.enum(["installation", "maintenance", "external_maintenance"]).optional(),
  source: z.enum(["manual", "salla"]).optional(),
  store_order_id: id.optional(),
  store_order_number: shortText.optional(),
};
export const bookingCreateSchema = z.object(bookingShape);
export const bookingUpdateSchema = nonEmptyUpdate(bookingShape);

const quoteItemSchema = z.object({
  product_id: id.optional().nullable(),
  product_sku: z.string().trim().max(120).optional(),
  description: z.string().trim().min(1).max(2000),
  quantity: z.coerce.number().finite().min(0.0001).max(1_000_000),
  unit_price: money,
  total: money.optional(),
  vat_excluded: z.boolean().optional(),
});
const installmentSchema = z.object({
  percent: z.coerce.number().finite().gt(0).max(100),
  label: z.string().trim().max(1000).default(""),
  deadline_days: z.coerce.number().int().min(0).max(3650).optional(),
});
const quoteShape = {
  customer_id: id.optional().nullable(),
  customer_name: z.string().trim().min(1).max(200),
  customer_phone: optionalPhone,
  customer_city: shortText.optional(),
  customer_vat: optionalSaudiVat,
  title: z.string().trim().max(500).optional(),
  status: z.enum(["draft", "issued", "confirmed", "declined", "expired", "follow_up"]).optional(),
  issue_date: isoDate.optional(),
  valid_until: optionalDate,
  follow_up_date: optionalDate,
  discount: money.optional(),
  discount_mode: z.enum(["fixed", "percent"]).optional(),
  discount_value: money.optional(),
  tax: money.optional(),
  vat_percent: z.coerce.number().finite().min(0).max(100).optional(),
  currency: z.string().trim().min(3).max(8).optional(),
  payment_method: shortText.optional(),
  payment_down_percent: z.coerce.number().finite().min(0).max(100).optional(),
  payment_final_percent: z.coerce.number().finite().min(0).max(100).optional(),
  payment_down_text: z.string().trim().max(2000).optional(),
  payment_final_text: z.string().trim().max(2000).optional(),
  payment_bank: shortText.optional(),
  payment_account: shortText.optional(),
  payment_iban: z.string().trim().max(64).optional(),
  payment_note: z.string().trim().max(2000).optional(),
  installments: z.array(installmentSchema).min(1).max(6).optional(),
  items: z.array(quoteItemSchema).min(1).max(200),
  notes: longText.optional(),
  terms: longText.optional(),
};
function quoteDiscountBounds(value: z.infer<z.ZodObject<typeof quoteShape>>, context: z.RefinementCtx) {
  if (value.discount_mode === "percent" && Number(value.discount_value ?? value.discount ?? 0) > 100) {
    context.addIssue({ code: "custom", path: ["discount_value"], message: "Percentage discount cannot exceed 100." });
  }
}
export const quoteCreateSchema = z.object(quoteShape).superRefine(quoteDiscountBounds);
export const quoteUpdateSchema = z.object(quoteShape).superRefine(quoteDiscountBounds);
export const quoteStatusSchema = z.object({
  status: z.enum(["draft", "issued", "confirmed", "declined", "expired", "follow_up"]),
  follow_up_date: optionalDate,
});
export const documentSendSchema = z.object({
  phone: z.string().trim().max(32).optional(),
  message: z.string().trim().max(20_000).optional(),
  outboundCode: z.string().trim().max(160).optional(),
});

const invoiceItemSchema = quoteItemSchema.extend({ vat_excluded: z.boolean() });
const invoiceShape = {
  quote_id: id.optional().nullable(),
  customer_id: id.optional().nullable(),
  customer_name: z.string().trim().min(1).max(200),
  customer_phone: optionalPhone,
  customer_city: shortText.optional(),
  customer_vat: optionalSaudiVat,
  title: z.string().trim().max(500).optional(),
  invoice_type: z.enum(["auto", "simplified", "tax"]).optional(),
  status: z.enum(["draft", "issued", "sent", "paid", "cancelled", "refunded"]).optional(),
  issue_date: isoDate.optional(),
  due_date: optionalDate,
  payment_method: shortText.optional(),
  discount: money.optional(),
  discount_mode: z.enum(["fixed", "percent"]).optional(),
  discount_value: money.optional(),
  vat_percent: z.coerce.number().finite().min(0).max(100).optional(),
  additional_fee: money.optional(),
  currency: z.string().trim().min(3).max(8).optional(),
  items: z.array(invoiceItemSchema).min(1).max(200),
  notes: longText.optional(),
  terms: longText.optional(),
  seller_name: zatcaSellerName.optional(),
  seller_vat: optionalSaudiVat,
  seller_vat_number: optionalSaudiVat,
  seller_address: z.string().trim().max(1000).optional(),
};
function invoiceDiscountBounds(value: z.infer<z.ZodObject<typeof invoiceShape>>, context: z.RefinementCtx) {
  if (value.discount_mode === "percent" && Number(value.discount_value ?? value.discount ?? 0) > 100) {
    context.addIssue({ code: "custom", path: ["discount_value"], message: "Percentage discount cannot exceed 100." });
  }
}
export const invoiceCreateSchema = z.object(invoiceShape).superRefine(invoiceDiscountBounds);
export const invoiceUpdateSchema = z.object(invoiceShape).superRefine(invoiceDiscountBounds);
export const invoiceStatusSchema = z.object({
  status: z.enum(["draft", "issued", "sent", "paid", "cancelled", "refunded"]),
});

export const settingsUpdateSchema = z.object({
  techs: z.coerce.number().int().min(0).max(10_000).optional(),
  jobs_per_tech: z.coerce.number().int().min(0).max(10_000).optional(),
  response_rate: z.coerce.number().min(0).max(100).optional(),
  maxDaily: z.coerce.number().int().min(0).max(100_000).optional(),
  seller_name: zatcaSellerName.optional(),
  seller_vat_number: optionalSaudiVat,
  seller_address: z.string().trim().max(1000).optional(),
}).refine((value) => Object.keys(value).length > 0, "At least one setting is required.");

export const demoDataSchema = z.object({ count: z.coerce.number().int().min(1).max(50).optional() });
export const quoteConvertSchema = z.object({
  invoice_type: z.enum(["auto", "simplified", "tax"]).optional(),
  seller_name: zatcaSellerName.optional(),
  seller_vat: optionalSaudiVat,
  seller_vat_number: optionalSaudiVat,
  seller_address: z.string().trim().max(1000).optional(),
});
