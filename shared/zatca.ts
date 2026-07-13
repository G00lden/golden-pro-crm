export type InvoiceTaxType = "simplified" | "tax";
export type InvoiceTaxTypeInput = InvoiceTaxType | "auto" | undefined | null;

export type ZatcaQrInput = {
  sellerName: string;
  vatNumber: string;
  timestamp: string;
  total: number;
  vatTotal: number;
};

export type InvoiceQrTimestampInput = {
  issueDate?: unknown;
  createdAt?: unknown;
};

export class ZatcaQrValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZatcaQrValidationError";
  }
}

export function normalizeVatNumber(value: unknown) {
  return String(value ?? "").trim().replace(/\s/g, "");
}

export function isSaudiVatNumber(value: unknown) {
  return /^\d{15}$/.test(normalizeVatNumber(value));
}

function normalizeIsoTimestamp(value: unknown) {
  const parsed = new Date(String(value || ""));
  return Number.isNaN(parsed.getTime())
    ? ""
    : parsed.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function normalizeIssueDate(value: unknown) {
  const candidate = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return "";
  const parsed = new Date(`${candidate}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate
    ? candidate
    : "";
}

/**
 * ZATCA tag 3 and the human-readable invoice date must describe the same day.
 * Existing records keep their original creation time-of-day; only the date
 * component is taken from the explicitly printed issue_date.
 */
export function invoiceQrTimestamp(input: InvoiceQrTimestampInput) {
  const rawIssueDate = String(input.issueDate || "").trim();
  const issueDate = normalizeIssueDate(input.issueDate);
  const createdAt = normalizeIsoTimestamp(input.createdAt);
  if (!rawIssueDate || !issueDate) {
    throw new ZatcaQrValidationError("تاريخ إصدار الفاتورة غير صالح لإنشاء رمز QR.");
  }
  return `${issueDate}T${createdAt ? createdAt.slice(11) : "00:00:00Z"}`;
}

export function cleanInvoiceTerms(value: unknown) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      const normalized = line.replace(/[.،,:؛\-–—]/g, " ").replace(/\s+/g, " ").trim();
      return !/^(?:فاتورة ضريبية مبسطة )?(?:الكود )?متوافقة? مع (?:هيئة )?(?:الزكاة والدخل )?(?:زاتكا|zatca)$/i.test(normalized);
    })
    .join("\n");
}

/** B2C is simplified at any value; B2B may be simplified only below SAR 1,000. */
export function resolveInvoiceTaxType(input: {
  requested?: InvoiceTaxTypeInput;
  buyerVat?: unknown;
  taxableAmount?: unknown;
}): InvoiceTaxType {
  const taxableAmount = Math.max(0, Number(input.taxableAmount || 0));
  const taxInvoiceRequired = isSaudiVatNumber(input.buyerVat) && taxableAmount >= 1000;
  if (taxInvoiceRequired || input.requested === "tax") return "tax";
  return "simplified";
}

export function zatcaQrFields(input: ZatcaQrInput) {
  return [
    { tag: 1, label: "Seller name", value: String(input.sellerName || "").trim() },
    { tag: 2, label: "VAT registration number", value: normalizeVatNumber(input.vatNumber) },
    { tag: 3, label: "Invoice timestamp", value: String(input.timestamp || "").trim() },
    { tag: 4, label: "Invoice total including VAT", value: Number(input.total || 0).toFixed(2) },
    { tag: 5, label: "VAT total", value: Number(input.vatTotal || 0).toFixed(2) },
  ];
}

export function assertValidZatcaQrInput(input: ZatcaQrInput) {
  const sellerName = String(input.sellerName || "").trim();
  if (!sellerName) {
    throw new ZatcaQrValidationError("اسم البائع مطلوب لإنشاء رمز QR.");
  }
  if (!isSaudiVatNumber(input.vatNumber)) {
    throw new ZatcaQrValidationError("الرقم الضريبي للبائع يجب أن يتكون من 15 رقمًا.");
  }
  const timestamp = String(input.timestamp || "").trim();
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(timestamp) ||
    normalizeIsoTimestamp(timestamp) !== timestamp
  ) {
    throw new ZatcaQrValidationError("تاريخ ووقت إصدار الفاتورة غير صالحين لإنشاء رمز QR.");
  }
  const total = Number(input.total);
  const vatTotal = Number(input.vatTotal);
  if (!Number.isFinite(total) || total < 0 || !Number.isFinite(vatTotal) || vatTotal < 0 || vatTotal > total) {
    throw new ZatcaQrValidationError("إجمالي الفاتورة أو إجمالي الضريبة غير صالح لإنشاء رمز QR.");
  }

  const encoder = new TextEncoder();
  for (const field of zatcaQrFields({ ...input, sellerName, timestamp, total, vatTotal })) {
    if (encoder.encode(field.value).length > 255) {
      const arabicLabel = ({
        1: "اسم البائع",
        2: "الرقم الضريبي للبائع",
        3: "تاريخ ووقت الفاتورة",
        4: "إجمالي الفاتورة شامل الضريبة",
        5: "إجمالي الضريبة",
      } as Record<number, string>)[field.tag] || field.label;
      throw new ZatcaQrValidationError(`الحقل «${arabicLabel}» يتجاوز حد ZATCA البالغ 255 UTF-8 bytes.`);
    }
  }
}

export function generateZatcaQrBase64(input: ZatcaQrInput) {
  assertValidZatcaQrInput(input);
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  for (const field of zatcaQrFields(input)) {
    const value = Array.from(encoder.encode(field.value));
    bytes.push(field.tag, value.length, ...value);
  }
  return btoa(String.fromCharCode(...bytes));
}
