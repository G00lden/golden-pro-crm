import {
  canApplyOperationalInvoiceStatus,
  invoiceIsMutableDraft,
  type InvoiceStatus,
} from "../shared/invoiceLifecycle";

export type LocalInvoiceLedgerRecord = {
  id: string;
  invoice_number?: unknown;
  document_kind?: unknown;
  sequence_no?: unknown;
  sequenceNo?: unknown;
  issued_at?: unknown;
  issuedAt?: unknown;
  idempotency_key?: unknown;
  idempotencyKey?: unknown;
  source_invoice_id?: unknown;
  sourceInvoiceId?: unknown;
  adjustment_scope?: unknown;
  adjustmentScope?: unknown;
  status?: unknown;
  paid_at?: unknown;
  paidAt?: unknown;
  updatedAt?: unknown;
  updated_at?: unknown;
};

export type LocalInvoiceLedgerLockManager = {
  request: <T>(name: string, callback: () => T | Promise<T>) => Promise<T>;
};

type LedgerMutationOptions<TData, TInvoice extends LocalInvoiceLedgerRecord, TResult> = {
  locks: LocalInvoiceLedgerLockManager;
  lockName: string;
  load: () => TData;
  save: (data: TData) => void;
  invoices: (data: TData) => TInvoice[];
  getSequence: (data: TData) => unknown;
  setSequence: (data: TData, value: number) => void;
  mutate: (data: TData, allocateSequence: () => number) => TResult | Promise<TResult>;
};

const OPERATIONAL_FIELDS = new Set([
  "status",
  "paid_at",
  "paidAt",
  "updated_at",
  "updatedAt",
]);

function recordValue(record: LocalInvoiceLedgerRecord, snake: keyof LocalInvoiceLedgerRecord, camel: keyof LocalInvoiceLedgerRecord) {
  return record[snake] ?? record[camel];
}

function positiveSequence(record: LocalInvoiceLedgerRecord) {
  const explicit = Number(recordValue(record, "sequence_no", "sequenceNo"));
  if (Number.isSafeInteger(explicit) && explicit > 0) return explicit;
  const match = String(record.invoice_number ?? "").match(/^(?:INV|CN)-.+-(\d+)$/i);
  const parsed = match ? Number(match[1]) : 0;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function safeStoredSequence(value: unknown) {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("عداد مستندات الفواتير المحلي غير صالح؛ أُوقفت الكتابة لحماية التسلسل.");
  }
  return parsed;
}

function maxRecordSequence(records: LocalInvoiceLedgerRecord[]) {
  return records.reduce((maximum, record) => Math.max(maximum, positiveSequence(record)), 0);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]),
  );
}

function immutableValue(record: LocalInvoiceLedgerRecord) {
  return JSON.stringify(canonicalValue(Object.fromEntries(
    Object.entries(record as Record<string, unknown>)
      .filter(([key]) => !OPERATIONAL_FIELDS.has(key)),
  )));
}

function cloneInvoices<TInvoice extends LocalInvoiceLedgerRecord>(records: TInvoice[]): TInvoice[] {
  return JSON.parse(JSON.stringify(records)) as TInvoice[];
}

function assertOperationalChange(before: LocalInvoiceLedgerRecord, after: LocalInvoiceLedgerRecord) {
  const previousStatus = String(before.status || "draft") as InvoiceStatus;
  const nextStatus = String(after.status || "draft") as InvoiceStatus;
  if (
    previousStatus !== nextStatus
    && !canApplyOperationalInvoiceStatus(before, nextStatus)
  ) {
    throw new Error("تغيرت حالة فاتورة مصدرة بطريقة غير مسموحة أثناء الكتابة المحلية.");
  }

  const previousPaidAt = String(recordValue(before, "paid_at", "paidAt") || "");
  const nextPaidAt = String(recordValue(after, "paid_at", "paidAt") || "");
  if (
    previousPaidAt !== nextPaidAt
    && (nextStatus !== "paid" || previousStatus === nextStatus || Boolean(previousPaidAt))
  ) {
    throw new Error("لا يمكن تغيير وقت دفع فاتورة مصدرة خارج انتقال الدفع الأول.");
  }
}

function assertUniqueLedgerIdentities(records: LocalInvoiceLedgerRecord[]) {
  const sequences = new Map<number, string>();
  const idempotencyKeys = new Map<string, string>();
  const fullCredits = new Map<string, string>();

  for (const record of records) {
    const sequence = positiveSequence(record);
    if (sequence > 0) {
      const duplicate = sequences.get(sequence);
      if (duplicate && duplicate !== record.id) {
        throw new Error("تعارض رقم تسلسل بين مستندين ماليين محليين؛ أُوقفت الكتابة.");
      }
      sequences.set(sequence, record.id);
    }

    const idempotencyKey = String(recordValue(record, "idempotency_key", "idempotencyKey") || "").trim();
    if (idempotencyKey) {
      const duplicate = idempotencyKeys.get(idempotencyKey);
      if (duplicate && duplicate !== record.id) {
        throw new Error("تكرر مفتاح منع الازدواج في مستندات الفواتير المحلية.");
      }
      idempotencyKeys.set(idempotencyKey, record.id);
    }

    const documentKind = String(record.document_kind || "invoice");
    const adjustmentScope = String(recordValue(record, "adjustment_scope", "adjustmentScope") || "");
    const sourceInvoiceId = String(recordValue(record, "source_invoice_id", "sourceInvoiceId") || "").trim();
    if (documentKind === "credit_note" && adjustmentScope === "full" && sourceInvoiceId) {
      const duplicate = fullCredits.get(sourceInvoiceId);
      if (duplicate && duplicate !== record.id) {
        throw new Error("سبق إنشاء إشعار دائن كامل لهذه الفاتورة في السجل المحلي.");
      }
      fullCredits.set(sourceInvoiceId, record.id);
    }
  }
}

function assertLedgerMutation<TInvoice extends LocalInvoiceLedgerRecord>(
  beforeRecords: TInvoice[],
  afterRecords: TInvoice[],
  allocatedSequences: Set<number>,
) {
  const beforeById = new Map(beforeRecords.map((record) => [record.id, record]));
  const afterById = new Map(afterRecords.map((record) => [record.id, record]));
  const fullyCreditedSources = new Set(afterRecords
    .filter((record) =>
      String(record.document_kind || "invoice") === "credit_note"
      && String(recordValue(record, "adjustment_scope", "adjustmentScope") || "") === "full")
    .map((record) => String(recordValue(record, "source_invoice_id", "sourceInvoiceId") || "").trim())
    .filter(Boolean));

  for (const before of beforeRecords) {
    if (invoiceIsMutableDraft(before)) continue;
    const after = afterById.get(before.id);
    if (!after) {
      throw new Error("لا يمكن حذف فاتورة مصدرة أو إشعار دائن من السجل المحلي.");
    }
    if (immutableValue(before) !== immutableValue(after)) {
      throw new Error("لا يمكن تعديل البيانات المالية أو الضريبية لمستند مصدر في السجل المحلي.");
    }
    if (fullyCreditedSources.has(before.id) && before.status !== after.status) {
      throw new Error("لا يمكن تغيير حالة فاتورة مرتبطة بإشعار دائن كامل في السجل المحلي.");
    }
    assertOperationalChange(before, after);
  }

  for (const after of afterRecords) {
    const before = beforeById.get(after.id);
    const becameIssued = !invoiceIsMutableDraft(after)
      && (!before || invoiceIsMutableDraft(before));
    if (!becameIssued) continue;

    const sequence = positiveSequence(after);
    const issuedAt = String(recordValue(after, "issued_at", "issuedAt") || "").trim();
    if (!issuedAt || sequence < 1 || !allocatedSequences.has(sequence)) {
      throw new Error("لا يمكن إصدار مستند محلي دون هوية إصدار ورقم مخصص داخل القفل.");
    }
  }

  assertUniqueLedgerIdentities(afterRecords);
}

/**
 * Runs a complete local invoice-ledger mutation under one origin-wide Web Lock.
 * The fresh state is loaded only after acquiring the lock, immutable documents
 * are compared before persistence, and the durable sequence can only increase.
 */
export async function mutateLocalInvoiceLedger<
  TData,
  TInvoice extends LocalInvoiceLedgerRecord,
  TResult,
>(options: LedgerMutationOptions<TData, TInvoice, TResult>) {
  return options.locks.request(options.lockName, async () => {
    const data = options.load();
    const beforeRecords = cloneInvoices(options.invoices(data));
    const baseline = Math.max(
      safeStoredSequence(options.getSequence(data)),
      maxRecordSequence(beforeRecords),
    );
    let lastAllocated = baseline;
    const allocatedSequences = new Set<number>();
    const allocateSequence = () => {
      if (lastAllocated >= Number.MAX_SAFE_INTEGER) {
        throw new Error("نفد نطاق أرقام تسلسل الفواتير المحلية الآمن.");
      }
      lastAllocated += 1;
      allocatedSequences.add(lastAllocated);
      return lastAllocated;
    };

    const result = await options.mutate(data, allocateSequence);
    const afterRecords = options.invoices(data);
    assertLedgerMutation(beforeRecords, afterRecords, allocatedSequences);
    const persistedSequence = Math.max(
      baseline,
      lastAllocated,
      safeStoredSequence(options.getSequence(data)),
      maxRecordSequence(afterRecords),
    );
    options.setSequence(data, persistedSequence);
    options.save(data);
    return result;
  });
}
