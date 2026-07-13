export type InvoiceStatus = "draft" | "issued" | "sent" | "paid" | "cancelled" | "refunded";
export type InvoiceDocumentKind = "invoice" | "credit_note";
export type InvoiceAdjustmentKind = "cancellation" | "refund";

export type InvoiceLifecycleRecord = {
  [key: string]: unknown;
  document_kind?: unknown;
  status?: unknown;
  sequence_no?: unknown;
  issued_at?: unknown;
  source_invoice_id?: unknown;
  adjustment_kind?: unknown;
};

function lifecycleValue(record: InvoiceLifecycleRecord, snake: string, camel: string) {
  return record[snake] ?? record[camel];
}

export function invoiceDocumentKind(record: InvoiceLifecycleRecord): InvoiceDocumentKind {
  return lifecycleValue(record, "document_kind", "documentKind") === "credit_note" ? "credit_note" : "invoice";
}

export function invoiceIsCreditNote(record: InvoiceLifecycleRecord) {
  return invoiceDocumentKind(record) === "credit_note";
}

export function invoiceIsMutableDraft(record: InvoiceLifecycleRecord) {
  return invoiceDocumentKind(record) === "invoice"
    && record.status === "draft"
    && !String(lifecycleValue(record, "issued_at", "issuedAt") || "").trim()
    && !(Number(lifecycleValue(record, "sequence_no", "sequenceNo")) > 0);
}

export function correctionStatus(kind: InvoiceAdjustmentKind): InvoiceStatus {
  return kind === "refund" ? "refunded" : "cancelled";
}

export function correctionKindForStatus(status: InvoiceStatus): InvoiceAdjustmentKind | null {
  if (status === "cancelled") return "cancellation";
  if (status === "refunded") return "refund";
  return null;
}

export function canApplyCorrection(record: InvoiceLifecycleRecord, kind: InvoiceAdjustmentKind) {
  if (invoiceIsCreditNote(record)) return false;
  if (kind === "refund") return record.status === "paid";
  return record.status === "issued" || record.status === "sent";
}

export function canApplyOperationalInvoiceStatus(
  record: InvoiceLifecycleRecord,
  next: InvoiceStatus,
) {
  if (invoiceIsCreditNote(record)) return false;
  const current = String(record.status || "draft") as InvoiceStatus;
  if (current === next) return true;
  if (current === "draft") return next === "issued";
  if (current === "issued") return next === "sent" || next === "paid";
  if (current === "sent") return next === "paid";
  return false;
}

export function deriveInvoiceStatuses<T extends InvoiceLifecycleRecord>(records: T[]): T[] {
  const corrections = new Map<string, InvoiceStatus>();
  for (const record of records) {
    if (!invoiceIsCreditNote(record)) continue;
    const sourceId = String(lifecycleValue(record, "source_invoice_id", "sourceInvoiceId") || "").trim();
    const kind = lifecycleValue(record, "adjustment_kind", "adjustmentKind") === "refund" ? "refund" : "cancellation";
    if (sourceId) corrections.set(sourceId, correctionStatus(kind));
  }
  return records.map((record) => {
    const id = String((record as T & { id?: unknown }).id || "").trim();
    const derived = id && !invoiceIsCreditNote(record) ? corrections.get(id) : undefined;
    return derived ? { ...record, status: derived } : record;
  });
}

export function invoiceLedgerSign(record: InvoiceLifecycleRecord) {
  return invoiceIsCreditNote(record) ? -1 : 1;
}
