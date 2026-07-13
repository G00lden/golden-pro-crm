export type CanonicalInvoiceItem = {
  product_id: string | null;
  product_sku: string;
  description: string;
  quantity: number;
  unit_price: number;
  total: number;
  vat_excluded: boolean;
};

function invoiceItemArray(value: unknown): unknown[] | null {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  return Array.isArray(candidate) ? candidate : null;
}

function normalizedIdentity(row: Record<string, unknown>) {
  const productId = row.product_id ?? row.productId;
  return {
    product_id: productId === undefined || productId === null || String(productId).trim() === ""
      ? null
      : String(productId).trim(),
    product_sku: String(row.product_sku ?? row.productSku ?? "").trim(),
  };
}

function vatExcluded(value: unknown) {
  return !(value === false || value === 0 || value === "false");
}

/**
 * Parses the complete line set as one financial invariant. A single malformed
 * line makes the whole result unverifiable so legacy header totals are never
 * partially recalculated and no tax QR can be produced from invented zeros.
 */
export function verifiableInvoiceItems(value: unknown): CanonicalInvoiceItem[] | null {
  const raw = invoiceItemArray(value);
  if (!raw?.length) return null;

  const items: CanonicalInvoiceItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    const description = typeof row.description === "string" ? row.description.trim() : "";
    const quantity = row.quantity;
    const unitPrice = row.unit_price ?? row.unitPrice;
    if (
      !description
      || typeof quantity !== "number"
      || !Number.isFinite(quantity)
      || quantity <= 0
      || typeof unitPrice !== "number"
      || !Number.isFinite(unitPrice)
      || unitPrice < 0
    ) {
      return null;
    }
    const total = quantity * unitPrice;
    if (!Number.isFinite(total)) return null;
    items.push({
      ...normalizedIdentity(row),
      description,
      quantity,
      unit_price: unitPrice,
      total,
      vat_excluded: vatExcluded(row.vat_excluded),
    });
  }
  return items;
}

/**
 * Tolerant display adapter for old records. It may expose missing numbers as
 * zero to keep the UI readable, but must never be used as proof that an
 * invoice is financially verifiable.
 */
export function displayInvoiceItems(value: unknown): CanonicalInvoiceItem[] {
  const raw = invoiceItemArray(value) ?? [];
  return raw
    .map((item) => {
      const row = item && typeof item === "object" && !Array.isArray(item)
        ? item as Record<string, unknown>
        : {};
      const parsedQuantity = Number(row.quantity);
      const parsedUnitPrice = Number(row.unit_price ?? row.unitPrice);
      const quantity = Number.isFinite(parsedQuantity) ? Math.max(0, parsedQuantity) : 0;
      const unitPrice = Number.isFinite(parsedUnitPrice) ? Math.max(0, parsedUnitPrice) : 0;
      return {
        ...normalizedIdentity(row),
        description: String(row.description ?? "").trim(),
        quantity,
        unit_price: unitPrice,
        total: quantity * unitPrice,
        vat_excluded: vatExcluded(row.vat_excluded),
      };
    })
    .filter((item) => item.description || item.quantity > 0 || item.unit_price > 0);
}
