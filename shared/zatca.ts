export type InvoiceTaxType = "simplified" | "tax";
export type InvoiceTaxTypeInput = InvoiceTaxType | "auto" | undefined | null;

export type ZatcaQrInput = {
  sellerName: string;
  vatNumber: string;
  timestamp: string;
  total: number;
  vatTotal: number;
};

export function normalizeVatNumber(value: unknown) {
  return String(value ?? "").trim().replace(/\s/g, "");
}

export function isSaudiVatNumber(value: unknown) {
  return /^\d{15}$/.test(normalizeVatNumber(value));
}

/** B2C is simplified at any value; B2B may be simplified only below SAR 1,000. */
export function resolveInvoiceTaxType(input: {
  requested?: InvoiceTaxTypeInput;
  buyerVat?: unknown;
  taxableAmount?: unknown;
}): InvoiceTaxType {
  if (input.requested === "simplified" || input.requested === "tax") return input.requested;
  const taxableAmount = Math.max(0, Number(input.taxableAmount || 0));
  return isSaudiVatNumber(input.buyerVat) && taxableAmount >= 1000 ? "tax" : "simplified";
}

export function zatcaQrFields(input: ZatcaQrInput) {
  return [
    { tag: 1, label: "Seller name", value: input.sellerName },
    { tag: 2, label: "VAT registration number", value: normalizeVatNumber(input.vatNumber) },
    { tag: 3, label: "Invoice timestamp", value: input.timestamp },
    { tag: 4, label: "Invoice total including VAT", value: Number(input.total || 0).toFixed(2) },
    { tag: 5, label: "VAT total", value: Number(input.vatTotal || 0).toFixed(2) },
  ];
}

export function generateZatcaQrBase64(input: ZatcaQrInput) {
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  for (const field of zatcaQrFields(input)) {
    const value = Array.from(encoder.encode(field.value));
    if (value.length > 255) {
      throw new Error(`${field.label} exceeds the ZATCA TLV limit of 255 UTF-8 bytes.`);
    }
    bytes.push(field.tag, value.length, ...value);
  }
  return btoa(String.fromCharCode(...bytes));
}
