import type { Express, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AuthedRequest } from "./auth";
import db from "./db";
import { logError, logEvent } from "./logger";
import { captureCrmStageAttribution } from "./tiktokAttribution";

export const INVOICE_PAYMENT_METHODS = ["cash", "card", "bank_transfer", "tap", "other"] as const;
export type InvoicePaymentMethod = (typeof INVOICE_PAYMENT_METHODS)[number];
export type InvoicePaymentEntryType = "collection" | "reversal";

type InvoiceRow = {
  id: string;
  owner_uid: string;
  invoice_number: string;
  customer_name: string;
  customer_phone: string;
  document_kind: "invoice" | "credit_note";
  issued_at: string | null;
  status: string;
  total_with_vat: number;
  currency: string;
  paid_at: string | null;
  has_full_credit: number;
};

type EntryRow = {
  id: string;
  owner_uid: string;
  invoice_id: string;
  entry_type: InvoicePaymentEntryType;
  method: InvoicePaymentMethod;
  amount_minor: number;
  currency: string;
  reference: string;
  note: string;
  source_payment_id: string | null;
  reverses_entry_id: string | null;
  idempotency_key: string;
  recorded_by: string;
  occurred_at: string;
  created_at: string;
  invoice_number?: string;
  customer_name?: string;
  reversed?: number;
};

type InvoicePaymentError = Error & { status?: number };

const manualCollectionSchema = z.object({
  amount: z.coerce.number().finite().positive().max(1_000_000_000),
  method: z.enum(["cash", "card", "bank_transfer", "other"]),
  reference: z.string().trim().max(160).optional(),
  note: z.string().trim().max(1000).optional(),
  occurred_at: z.string().datetime({ offset: true }).optional(),
});

const reversalSchema = z.object({
  reason: z.string().trim().min(3).max(1000),
});

function ledgerError(status: number, message: string): InvoicePaymentError {
  const error = new Error(message) as InvoicePaymentError;
  error.status = status;
  return error;
}

function asyncRoute(handler: (req: Request, res: Response) => Promise<unknown> | unknown) {
  return (req: Request, res: Response) => {
    Promise.resolve().then(() => handler(req, res)).catch((error) => {
      const status = Number((error as InvoicePaymentError)?.status);
      const responseStatus = Number.isInteger(status) && status >= 400 && status < 600 ? status : 500;
      if (responseStatus >= 500) logError("invoice_payment.unhandled", error);
      res.status(responseStatus).json({
        error: responseStatus < 500
          ? (error instanceof Error ? error.message : String(error))
          : "حدث خطأ داخلي أثناء معالجة سجل التحصيل.",
      });
    });
  };
}

function userId(req: Request): string {
  return (req as AuthedRequest).user.uid;
}

function nowIso() {
  return new Date().toISOString();
}

function moneyToMinor(value: unknown): number {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw ledgerError(400, "مبلغ الدفعة يجب أن يكون أكبر من صفر.");
  }
  const minor = Math.round(amount * 100);
  if (!Number.isSafeInteger(minor) || Math.abs(amount * 100 - minor) > 0.000_001) {
    throw ledgerError(400, "مبلغ الدفعة يقبل منزلتين عشريتين كحد أقصى.");
  }
  return minor;
}

function invoiceTotalMinor(invoice: Pick<InvoiceRow, "total_with_vat">): number {
  const minor = Math.round(Number(invoice.total_with_vat || 0) * 100);
  if (!Number.isSafeInteger(minor) || minor <= 0) {
    throw ledgerError(409, "إجمالي الفاتورة غير صالح لتسجيل دفعة.");
  }
  return minor;
}

function getInvoice(ownerUid: string, invoiceId: string): InvoiceRow | undefined {
  return db.prepare(`
    SELECT invoice.id, invoice.owner_uid, invoice.invoice_number, invoice.customer_name,
           invoice.customer_phone, invoice.document_kind, invoice.issued_at, invoice.status,
           invoice.total_with_vat, invoice.currency, invoice.paid_at,
           EXISTS(
             SELECT 1
             FROM invoices credit
             WHERE credit.owner_uid = invoice.owner_uid
               AND credit.source_invoice_id = invoice.id
               AND credit.document_kind = 'credit_note'
               AND credit.adjustment_scope = 'full'
           ) AS has_full_credit
    FROM invoices invoice
    WHERE invoice.owner_uid = ? AND invoice.id = ?
    LIMIT 1
  `).get(ownerUid, invoiceId) as InvoiceRow | undefined;
}

function getEntry(ownerUid: string, entryId: string): EntryRow | undefined {
  return db.prepare(`
    SELECT entry.*,
           invoice.invoice_number,
           invoice.customer_name,
           EXISTS(
             SELECT 1 FROM invoice_payment_entries reversal
             WHERE reversal.reverses_entry_id = entry.id
           ) AS reversed
    FROM invoice_payment_entries entry
    JOIN invoices invoice
      ON invoice.id = entry.invoice_id
     AND invoice.owner_uid = entry.owner_uid
    WHERE entry.owner_uid = ? AND entry.id = ?
    LIMIT 1
  `).get(ownerUid, entryId) as EntryRow | undefined;
}

function getEntryByIdempotency(ownerUid: string, idempotencyKey: string): EntryRow | undefined {
  return db.prepare(`
    SELECT * FROM invoice_payment_entries
    WHERE owner_uid = ? AND idempotency_key = ?
    LIMIT 1
  `).get(ownerUid, idempotencyKey) as EntryRow | undefined;
}

function invoiceCollectedMinor(ownerUid: string, invoiceId: string): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(
      CASE WHEN entry_type = 'collection' THEN amount_minor ELSE -amount_minor END
    ), 0) AS collected_minor
    FROM invoice_payment_entries
    WHERE owner_uid = ? AND invoice_id = ?
  `).get(ownerUid, invoiceId) as { collected_minor?: number } | undefined;
  return Number(row?.collected_minor || 0);
}

export function invoiceOutstandingAmount(ownerUid: string, invoiceId: string): number {
  const invoice = getInvoice(ownerUid, invoiceId);
  if (!invoice) throw ledgerError(404, "الفاتورة غير موجودة أو لا تملك صلاحية الوصول إليها.");
  return Math.max(0, invoiceTotalMinor(invoice) - invoiceCollectedMinor(ownerUid, invoiceId)) / 100;
}

function normalizeCurrency(value: unknown): string {
  const currency = String(value || "SAR").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw ledgerError(409, "عملة الفاتورة غير صالحة.");
  return currency;
}

function publicEntry(row: EntryRow) {
  const sign = row.entry_type === "collection" ? 1 : -1;
  return {
    id: row.id,
    invoice_id: row.invoice_id,
    invoice_number: String(row.invoice_number || ""),
    customer_name: String(row.customer_name || ""),
    entry_type: row.entry_type,
    method: row.method,
    amount: row.amount_minor / 100,
    signed_amount: sign * row.amount_minor / 100,
    currency: row.currency,
    reference: row.reference || "",
    note: row.note || "",
    source: row.source_payment_id ? "tap" : "manual",
    reverses_entry_id: row.reverses_entry_id,
    reversible: row.entry_type === "collection" && !row.source_payment_id && !Boolean(row.reversed),
    recorded_by: row.recorded_by || "",
    occurred_at: row.occurred_at,
    created_at: row.created_at,
  };
}

function reconcileInvoicePaidState(invoice: InvoiceRow, collectedMinor: number): {
  becamePaid: boolean;
  reopened: boolean;
} {
  const totalMinor = invoiceTotalMinor(invoice);
  const now = nowIso();
  if (collectedMinor >= totalMinor && ["issued", "sent"].includes(invoice.status) && !invoice.has_full_credit) {
    const changed = db.prepare(`
      UPDATE invoices
      SET status = 'paid', paid_at = COALESCE(NULLIF(paid_at, ''), ?), updated_at = ?
      WHERE owner_uid = ? AND id = ?
        AND document_kind = 'invoice'
        AND issued_at IS NOT NULL
        AND status IN ('issued', 'sent')
    `).run(now, now, invoice.owner_uid, invoice.id);
    return { becamePaid: changed.changes === 1, reopened: false };
  }
  if (collectedMinor < totalMinor && invoice.status === "paid" && !invoice.has_full_credit) {
    const changed = db.prepare(`
      UPDATE invoices
      SET status = 'issued', paid_at = NULL, updated_at = ?
      WHERE owner_uid = ? AND id = ? AND status = 'paid'
    `).run(now, invoice.owner_uid, invoice.id);
    return { becamePaid: false, reopened: changed.changes === 1 };
  }
  return { becamePaid: false, reopened: false };
}

function capturePaidAttribution(invoice: InvoiceRow) {
  try {
    const current = getInvoice(invoice.owner_uid, invoice.id) || invoice;
    captureCrmStageAttribution({
      ownerUid: current.owner_uid,
      entityId: current.id,
      phone: current.customer_phone,
      stage: "paid",
      amount: Number(current.total_with_vat || 0),
      currency: normalizeCurrency(current.currency),
      contentName: current.invoice_number,
      occurredAt: current.paid_at || nowIso(),
    });
  } catch (error) {
    logError("invoice_payment.attribution_failed", error, { invoiceId: invoice.id });
  }
}

export function invoicePaymentStoreSupported(
  provider = process.env.DATA_PROVIDER || process.env.DB_PROVIDER || "firebase",
) {
  return String(provider).trim().toLowerCase() === "sqlite";
}

export function recordInvoiceCollection(input: {
  ownerUid: string;
  invoiceId: string;
  amount: number;
  method: Exclude<InvoicePaymentMethod, "tap">;
  reference?: string;
  note?: string;
  occurredAt?: string;
  idempotencyKey: string;
  recordedBy: string;
}) {
  if (!invoicePaymentStoreSupported()) {
    throw ledgerError(503, "سجل تحصيل الفواتير متاح حالياً مع تخزين SQLite فقط.");
  }
  if (!/^[A-Za-z0-9:_-]{8,160}$/.test(input.idempotencyKey)) {
    throw ledgerError(400, "مفتاح منع تكرار الدفعة مفقود أو غير صالح.");
  }
  if (!INVOICE_PAYMENT_METHODS.includes(input.method)) {
    throw ledgerError(400, "طريقة الدفع اليدوية غير مدعومة.");
  }
  const amountMinor = moneyToMinor(input.amount);
  const occurredAt = input.occurredAt || nowIso();
  if (!Number.isFinite(Date.parse(occurredAt))) throw ledgerError(400, "تاريخ الدفعة غير صالح.");
  let becamePaid = false;
  const result = db.transaction(() => {
    const existingEntry = getEntryByIdempotency(input.ownerUid, input.idempotencyKey);
    if (existingEntry) {
      if (
        existingEntry.entry_type !== "collection"
        || existingEntry.invoice_id !== input.invoiceId
        || existingEntry.amount_minor !== amountMinor
        || existingEntry.method !== input.method
      ) {
        throw ledgerError(409, "مفتاح منع التكرار مستخدم لعملية تحصيل مختلفة.");
      }
      return { entry: getEntry(input.ownerUid, existingEntry.id) || existingEntry, replay: true };
    }

    const invoice = getInvoice(input.ownerUid, input.invoiceId);
    if (!invoice) throw ledgerError(404, "الفاتورة غير موجودة أو لا تملك صلاحية الوصول إليها.");
    if (invoice.document_kind !== "invoice" || !invoice.issued_at || invoice.status === "draft") {
      throw ledgerError(409, "لا يمكن تسجيل دفعة لمسودة أو إشعار دائن.");
    }
    if (invoice.has_full_credit || ["cancelled", "refunded"].includes(invoice.status)) {
      throw ledgerError(409, "لا يمكن تسجيل دفعة لفاتورة ملغية أو مستردة.");
    }
    const providerPaymentInFlight = db.prepare(`
      SELECT id
      FROM payments
      WHERE owner_uid = ?
        AND invoice_id = ?
        AND status IN ('creating', 'pending')
      LIMIT 1
    `).get(input.ownerUid, input.invoiceId) as { id?: string } | undefined;
    if (providerPaymentInFlight?.id) {
      throw ledgerError(409, "يوجد دفع Tap قيد المعالجة لهذه الفاتورة؛ طابق نتيجته قبل تسجيل تحصيل يدوي.");
    }
    const totalMinor = invoiceTotalMinor(invoice);
    const beforeMinor = invoiceCollectedMinor(input.ownerUid, input.invoiceId);
    const outstandingMinor = Math.max(0, totalMinor - beforeMinor);
    if (outstandingMinor <= 0) throw ledgerError(409, "الفاتورة مسددة بالكامل بالفعل.");
    if (amountMinor > outstandingMinor) {
      throw ledgerError(409, `المبلغ أكبر من المتبقي على الفاتورة (${(outstandingMinor / 100).toFixed(2)} ${normalizeCurrency(invoice.currency)}).`);
    }

    const id = `ip_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    db.prepare(`
      INSERT INTO invoice_payment_entries (
        id, owner_uid, invoice_id, entry_type, method, amount_minor, currency,
        reference, note, source_payment_id, reverses_entry_id, idempotency_key,
        recorded_by, occurred_at, created_at
      ) VALUES (?, ?, ?, 'collection', ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)
    `).run(
      id,
      input.ownerUid,
      input.invoiceId,
      input.method,
      amountMinor,
      normalizeCurrency(invoice.currency),
      String(input.reference || "").trim(),
      String(input.note || "").trim(),
      input.idempotencyKey,
      String(input.recordedBy || "").trim(),
      occurredAt,
      nowIso(),
    );
    const state = reconcileInvoicePaidState(invoice, beforeMinor + amountMinor);
    becamePaid = state.becamePaid;
    return { entry: getEntry(input.ownerUid, id)!, replay: false };
  })();

  const invoice = getInvoice(input.ownerUid, input.invoiceId)!;
  const collectedMinor = invoiceCollectedMinor(input.ownerUid, input.invoiceId);
  const totalMinor = invoiceTotalMinor(invoice);
  if (becamePaid) capturePaidAttribution(invoice);
  if (!result.replay) {
    logEvent("info", "invoice_payment.recorded", {
      entryId: result.entry.id,
      invoiceId: input.invoiceId,
      method: input.method,
      amount: amountMinor / 100,
    });
  }
  return {
    entry: publicEntry(result.entry),
    invoice: {
      id: invoice.id,
      status: invoice.status,
      paid_at: invoice.paid_at,
      total: totalMinor / 100,
      collected: collectedMinor / 100,
      outstanding: Math.max(0, totalMinor - collectedMinor) / 100,
      currency: normalizeCurrency(invoice.currency),
    },
    idempotent_replay: result.replay,
  };
}

export function recordRemainingInvoiceCollection(input: {
  ownerUid: string;
  invoiceId: string;
  method?: Exclude<InvoicePaymentMethod, "tap">;
  reference?: string;
  note?: string;
  idempotencyKey: string;
  recordedBy: string;
}) {
  const invoice = getInvoice(input.ownerUid, input.invoiceId);
  if (!invoice) throw ledgerError(404, "الفاتورة غير موجودة أو لا تملك صلاحية الوصول إليها.");
  const outstandingMinor = Math.max(
    0,
    invoiceTotalMinor(invoice) - invoiceCollectedMinor(input.ownerUid, input.invoiceId),
  );
  if (outstandingMinor <= 0) {
    const current = getInvoice(input.ownerUid, input.invoiceId)!;
    const state = reconcileInvoicePaidState(current, invoiceTotalMinor(current));
    if (state.becamePaid) capturePaidAttribution(current);
    return {
      entry: null,
      invoice: {
        id: current.id,
        status: getInvoice(input.ownerUid, input.invoiceId)?.status || current.status,
        paid_at: getInvoice(input.ownerUid, input.invoiceId)?.paid_at || current.paid_at,
        total: invoiceTotalMinor(current) / 100,
        collected: invoiceTotalMinor(current) / 100,
        outstanding: 0,
        currency: normalizeCurrency(current.currency),
      },
      idempotent_replay: true,
    };
  }
  return recordInvoiceCollection({
    ...input,
    amount: outstandingMinor / 100,
    method: input.method || "other",
  });
}

export function reverseInvoiceCollection(input: {
  ownerUid: string;
  entryId: string;
  reason: string;
  idempotencyKey: string;
  recordedBy: string;
}) {
  if (!/^[A-Za-z0-9:_-]{8,160}$/.test(input.idempotencyKey)) {
    throw ledgerError(400, "مفتاح منع تكرار عكس الدفعة مفقود أو غير صالح.");
  }
  const result = db.transaction(() => {
    const replay = getEntryByIdempotency(input.ownerUid, input.idempotencyKey);
    if (replay) {
      if (replay.entry_type !== "reversal" || replay.reverses_entry_id !== input.entryId) {
        throw ledgerError(409, "مفتاح منع التكرار مستخدم لعملية مختلفة.");
      }
      return { entry: getEntry(input.ownerUid, replay.id) || replay, replay: true };
    }
    const original = getEntry(input.ownerUid, input.entryId);
    if (!original) throw ledgerError(404, "عملية التحصيل غير موجودة.");
    if (original.entry_type !== "collection") throw ledgerError(409, "يمكن عكس عملية تحصيل أصلية فقط.");
    if (original.source_payment_id) {
      throw ledgerError(409, "دفعة Tap لا تُعكس يدوياً؛ نفّذ الاسترداد من بوابة الدفع ثم طابق الإشعار.");
    }
    if (original.reversed) throw ledgerError(409, "تم عكس عملية التحصيل مسبقاً.");
    const invoice = getInvoice(input.ownerUid, original.invoice_id);
    if (!invoice) throw ledgerError(404, "الفاتورة المرتبطة بالعملية غير موجودة.");
    const id = `ipr_${randomUUID().replace(/-/g, "").slice(0, 23)}`;
    const occurredAt = nowIso();
    db.prepare(`
      INSERT INTO invoice_payment_entries (
        id, owner_uid, invoice_id, entry_type, method, amount_minor, currency,
        reference, note, source_payment_id, reverses_entry_id, idempotency_key,
        recorded_by, occurred_at, created_at
      ) VALUES (?, ?, ?, 'reversal', ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.ownerUid,
      original.invoice_id,
      original.method,
      original.amount_minor,
      original.currency,
      original.reference || "",
      input.reason.trim(),
      original.id,
      input.idempotencyKey,
      String(input.recordedBy || "").trim(),
      occurredAt,
      occurredAt,
    );
    const collectedMinor = invoiceCollectedMinor(input.ownerUid, original.invoice_id);
    reconcileInvoicePaidState(invoice, collectedMinor);
    return { entry: getEntry(input.ownerUid, id)!, replay: false };
  })();
  const invoice = getInvoice(input.ownerUid, result.entry.invoice_id)!;
  const collectedMinor = invoiceCollectedMinor(input.ownerUid, invoice.id);
  const totalMinor = invoiceTotalMinor(invoice);
  if (!result.replay) {
    logEvent("info", "invoice_payment.reversed", {
      entryId: result.entry.id,
      reversesEntryId: input.entryId,
      invoiceId: invoice.id,
      amount: result.entry.amount_minor / 100,
    });
  }
  return {
    entry: publicEntry(result.entry),
    invoice: {
      id: invoice.id,
      status: invoice.status,
      paid_at: invoice.paid_at,
      total: totalMinor / 100,
      collected: collectedMinor / 100,
      outstanding: Math.max(0, totalMinor - collectedMinor) / 100,
      currency: normalizeCurrency(invoice.currency),
    },
    idempotent_replay: result.replay,
  };
}

export function reverseManualCollectionsForInvoiceCorrection(input: {
  ownerUid: string;
  invoiceId: string;
  reason: string;
  correctionKind: "cancellation" | "refund";
  recordedBy: string;
}) {
  return db.transaction(() => {
    const providerConflict = db.prepare(`
      SELECT 1
      FROM payments
      WHERE owner_uid = ? AND invoice_id = ?
        AND status IN ('creating', 'pending', 'completed')
      LIMIT 1
    `).get(input.ownerUid, input.invoiceId);
    if (providerConflict) {
      throw ledgerError(
        409,
        "لا يمكن إنشاء إشعار دائن بينما توجد عملية Tap قيد التنفيذ أو مكتملة؛ عالجها أو استردها في بوابة الدفع أولاً.",
      );
    }
    const invoice = getInvoice(input.ownerUid, input.invoiceId);
    if (!invoice) throw ledgerError(404, "الفاتورة غير موجودة أو لا تملك صلاحية الوصول إليها.");
    const entries = db.prepare(`
      SELECT entry.*
      FROM invoice_payment_entries entry
      WHERE entry.owner_uid = ?
        AND entry.invoice_id = ?
        AND entry.entry_type = 'collection'
        AND entry.source_payment_id IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM invoice_payment_entries reversal
          WHERE reversal.reverses_entry_id = entry.id
        )
      ORDER BY entry.occurred_at, entry.created_at, entry.id
    `).all(input.ownerUid, input.invoiceId) as EntryRow[];
    const occurredAt = nowIso();
    for (const entry of entries) {
      const idempotencyKey = `credit:${input.correctionKind}:${input.invoiceId}:${entry.id}`;
      if (getEntryByIdempotency(input.ownerUid, idempotencyKey)) continue;
      db.prepare(`
        INSERT INTO invoice_payment_entries (
          id, owner_uid, invoice_id, entry_type, method, amount_minor, currency,
          reference, note, source_payment_id, reverses_entry_id, idempotency_key,
          recorded_by, occurred_at, created_at
        ) VALUES (?, ?, ?, 'reversal', ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
      `).run(
        `ipr_${randomUUID().replace(/-/g, "").slice(0, 23)}`,
        input.ownerUid,
        input.invoiceId,
        entry.method,
        entry.amount_minor,
        entry.currency,
        entry.reference || "",
        input.reason.trim(),
        entry.id,
        idempotencyKey,
        input.recordedBy,
        occurredAt,
        occurredAt,
      );
    }
    if (entries.length) {
      logEvent("info", "invoice_payment.correction_reversals_recorded", {
        invoiceId: input.invoiceId,
        correctionKind: input.correctionKind,
        count: entries.length,
      });
    }
    return entries.length;
  })();
}

export function syncCompletedTapPayment(payment: {
  id: string;
  owner_uid: string;
  invoice_id: string;
  amount: number;
  currency: string;
  tap_charge_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}) {
  if (payment.status !== "completed" || !payment.invoice_id) return false;
  const amountMinor = moneyToMinor(payment.amount);
  const invoice = getInvoice(payment.owner_uid, payment.invoice_id);
  if (!invoice) throw ledgerError(409, "الفاتورة المرتبطة بدفعة Tap غير موجودة.");
  const result = db.prepare(`
    INSERT OR IGNORE INTO invoice_payment_entries (
      id, owner_uid, invoice_id, entry_type, method, amount_minor, currency,
      reference, note, source_payment_id, reverses_entry_id, idempotency_key,
      recorded_by, occurred_at, created_at
    ) VALUES (?, ?, ?, 'collection', 'tap', ?, ?, ?, ?, ?, NULL, ?, 'tap', ?, ?)
  `).run(
    `ip_tap_${payment.id}`,
    payment.owner_uid,
    payment.invoice_id,
    amountMinor,
    normalizeCurrency(payment.currency),
    payment.tap_charge_id || "",
    "دفعة Tap مؤكدة",
    payment.id,
    `tap:${payment.id}`,
    payment.updated_at || payment.created_at || nowIso(),
    payment.created_at || nowIso(),
  );
  return result.changes === 1;
}

export function syncCancelledTapPayment(payment: {
  id: string;
  owner_uid: string;
  invoice_id: string;
  amount: number;
  currency: string;
  tap_charge_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}) {
  if (payment.status !== "cancelled" || !payment.invoice_id) return false;
  return db.transaction(() => {
    const collection = db.prepare(`
      SELECT *
      FROM invoice_payment_entries
      WHERE owner_uid = ?
        AND source_payment_id = ?
        AND entry_type = 'collection'
      LIMIT 1
    `).get(payment.owner_uid, payment.id) as EntryRow | undefined;
    if (!collection) return false;
    const existing = db.prepare(`
      SELECT id
      FROM invoice_payment_entries
      WHERE owner_uid = ? AND reverses_entry_id = ?
      LIMIT 1
    `).get(payment.owner_uid, collection.id) as { id?: string } | undefined;
    if (existing?.id) return false;

    const now = payment.updated_at || nowIso();
    const result = db.prepare(`
      INSERT OR IGNORE INTO invoice_payment_entries (
        id, owner_uid, invoice_id, entry_type, method, amount_minor, currency,
        reference, note, source_payment_id, reverses_entry_id, idempotency_key,
        recorded_by, occurred_at, created_at
      ) VALUES (?, ?, ?, 'reversal', 'tap', ?, ?, ?, ?, ?, ?, ?, 'tap', ?, ?)
    `).run(
      `ipr_tap_${payment.id}`,
      payment.owner_uid,
      payment.invoice_id,
      collection.amount_minor,
      collection.currency,
      payment.tap_charge_id || collection.reference || "",
      "عكس دفعة Tap بعد استردادها أو إلغائها من المزود",
      payment.id,
      collection.id,
      `tap-reversal:${payment.id}`,
      now,
      now,
    );
    if (result.changes !== 1) return false;

    const invoice = getInvoice(payment.owner_uid, payment.invoice_id);
    if (invoice) {
      reconcileInvoicePaidState(
        invoice,
        invoiceCollectedMinor(payment.owner_uid, payment.invoice_id),
      );
    }
    logEvent("info", "invoice_payment.tap_reversed", {
      paymentId: payment.id,
      invoiceId: payment.invoice_id,
      collectionEntryId: collection.id,
    });
    return true;
  })();
}

export function invoicePaymentOverview(ownerUid: string, limit = 50) {
  const safeLimit = Math.min(200, Math.max(1, Math.trunc(limit || 50)));
  const rows = db.prepare(`
    SELECT entry.*,
           invoice.invoice_number,
           invoice.customer_name,
           EXISTS(
             SELECT 1 FROM invoice_payment_entries reversal
             WHERE reversal.reverses_entry_id = entry.id
           ) AS reversed
    FROM invoice_payment_entries entry
    JOIN invoices invoice
      ON invoice.id = entry.invoice_id
     AND invoice.owner_uid = entry.owner_uid
    WHERE entry.owner_uid = ?
    ORDER BY entry.occurred_at DESC, entry.created_at DESC, entry.id DESC
    LIMIT ?
  `).all(ownerUid, safeLimit) as EntryRow[];

  const all = db.prepare(`
    SELECT entry_type, method, amount_minor, currency
    FROM invoice_payment_entries
    WHERE owner_uid = ?
  `).all(ownerUid) as Array<Pick<EntryRow, "entry_type" | "method" | "amount_minor" | "currency">>;

  const currencyMap = new Map<string, {
    balanceMinor: number;
    collectedMinor: number;
    reversedMinor: number;
    count: number;
    byMethod: Record<InvoicePaymentMethod, number>;
  }>();
  for (const row of all) {
    const currency = normalizeCurrency(row.currency);
    const current = currencyMap.get(currency) || {
      balanceMinor: 0,
      collectedMinor: 0,
      reversedMinor: 0,
      count: 0,
      byMethod: { cash: 0, card: 0, bank_transfer: 0, tap: 0, other: 0 },
    };
    const signedMinor = row.entry_type === "collection" ? row.amount_minor : -row.amount_minor;
    current.balanceMinor += signedMinor;
    current.collectedMinor += row.entry_type === "collection" ? row.amount_minor : 0;
    current.reversedMinor += row.entry_type === "reversal" ? row.amount_minor : 0;
    current.count += 1;
    current.byMethod[row.method] += signedMinor;
    currencyMap.set(currency, current);
  }

  const invoiceRows = db.prepare(`
    SELECT invoice.id AS invoice_id,
           invoice.total_with_vat,
           invoice.currency,
           COALESCE(SUM(
             CASE
               WHEN entry.entry_type = 'collection' THEN entry.amount_minor
               WHEN entry.entry_type = 'reversal' THEN -entry.amount_minor
               ELSE 0
             END
           ), 0) AS collected_minor
    FROM invoices invoice
    LEFT JOIN invoice_payment_entries entry
      ON entry.owner_uid = invoice.owner_uid
     AND entry.invoice_id = invoice.id
    WHERE invoice.owner_uid = ? AND invoice.document_kind = 'invoice'
    GROUP BY invoice.id, invoice.total_with_vat, invoice.currency
  `).all(ownerUid) as Array<{
    invoice_id: string;
    total_with_vat: number;
    currency: string;
    collected_minor: number;
  }>;

  const invoice_totals = Object.fromEntries(invoiceRows.map((row) => {
    const totalMinor = Math.max(0, Math.round(Number(row.total_with_vat || 0) * 100));
    const collectedMinor = Math.max(0, Number(row.collected_minor || 0));
    return [row.invoice_id, {
      total: totalMinor / 100,
      collected: collectedMinor / 100,
      outstanding: Math.max(0, totalMinor - collectedMinor) / 100,
      currency: normalizeCurrency(row.currency),
    }];
  }));

  const currencies = [...currencyMap.entries()]
    .sort(([left], [right]) => left === "SAR" ? -1 : right === "SAR" ? 1 : left.localeCompare(right))
    .map(([currency, value]) => ({
      currency,
      balance: value.balanceMinor / 100,
      collected: value.collectedMinor / 100,
      reversed: value.reversedMinor / 100,
      transaction_count: value.count,
      by_method: Object.fromEntries(
        Object.entries(value.byMethod).map(([method, amountMinor]) => [method, amountMinor / 100]),
      ),
    }));

  return {
    data: rows.map(publicEntry),
    summary: currencies.find((item) => item.currency === "SAR") || {
      currency: "SAR",
      balance: 0,
      collected: 0,
      reversed: 0,
      transaction_count: 0,
      by_method: { cash: 0, card: 0, bank_transfer: 0, tap: 0, other: 0 },
    },
    currencies,
    invoice_totals,
  };
}

export function registerInvoicePaymentRoutes(app: Express) {
  app.get("/api/invoice-payments", asyncRoute((req, res) => {
    if (!invoicePaymentStoreSupported()) {
      throw ledgerError(503, "سجل تحصيل الفواتير متاح حالياً مع تخزين SQLite فقط.");
    }
    const limit = Number(req.query.limit || 50);
    res.json(invoicePaymentOverview(userId(req), Number.isFinite(limit) ? limit : 50));
  }));

  app.post("/api/invoices/:id/payments", asyncRoute((req, res) => {
    const parsed = manualCollectionSchema.safeParse(req.body);
    if (!parsed.success) throw ledgerError(400, "بيانات عملية التحصيل غير صالحة.");
    const idempotencyKey = String(req.get("Idempotency-Key") || "").trim();
    const result = recordInvoiceCollection({
      ownerUid: userId(req),
      invoiceId: String(req.params.id || "").trim(),
      amount: parsed.data.amount,
      method: parsed.data.method,
      reference: parsed.data.reference,
      note: parsed.data.note,
      occurredAt: parsed.data.occurred_at,
      idempotencyKey,
      recordedBy: userId(req),
    });
    res.status(result.idempotent_replay ? 200 : 201).json(result);
  }));

  app.post("/api/invoice-payments/:id/reverse", asyncRoute((req, res) => {
    const parsed = reversalSchema.safeParse(req.body);
    if (!parsed.success) throw ledgerError(400, "سبب عكس عملية التحصيل مطلوب.");
    const idempotencyKey = String(req.get("Idempotency-Key") || "").trim();
    res.json(reverseInvoiceCollection({
      ownerUid: userId(req),
      entryId: String(req.params.id || "").trim(),
      reason: parsed.data.reason,
      idempotencyKey,
      recordedBy: userId(req),
    }));
  }));
}
