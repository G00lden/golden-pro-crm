import crypto from "node:crypto";
import {
  allocateInvoiceSequenceWithDatabase,
  historicalInvoiceSequence,
  INVOICE_SEQUENCE_SERIES,
  invoiceSequenceDocumentId,
  type InvoiceSequenceDatabase,
} from "./invoiceSequence";

type RecordData = Record<string, unknown>;

type Snapshot = {
  id: string;
  exists?: boolean;
  data: () => RecordData;
};

type QuerySnapshot = {
  docs: Snapshot[];
};

type DocumentReference = {
  id: string;
  get: () => Promise<Snapshot>;
  create?: (data: RecordData) => Promise<unknown>;
  compareAndSet?: unknown;
};

type QueryReference = {
  where: (field: string, operator: string, value: unknown) => QueryReference;
  get: () => Promise<QuerySnapshot>;
};

type CollectionReference = QueryReference & {
  doc: (id: string) => DocumentReference;
};

type Transaction = {
  get: (reference: unknown) => Promise<Snapshot>;
  set: (reference: unknown, data: RecordData, options?: { merge?: boolean }) => void;
  create: (reference: unknown, data: RecordData) => void;
};

export type InvoiceDocumentDatabase = {
  allocateCounter?: InvoiceSequenceDatabase["allocateCounter"];
  collection: (name: string) => CollectionReference;
  runTransaction?: <T>(callback: (transaction: Transaction) => Promise<T>) => Promise<T>;
};

export type InvoiceDocumentBuildContext = {
  sequence: number | null;
  issuedAt: string | null;
};

export type AtomicInvoiceDocumentOptions = {
  ownerUid: string;
  idempotencyKey: string;
  issued: boolean;
  minimumNext?: number;
  legacyIdentity?: { field: string; value: string };
  now?: () => string;
  build: (context: InvoiceDocumentBuildContext) => RecordData;
};

export type AtomicInvoiceDocumentResult = {
  id: string;
  created: boolean;
  data: RecordData & { id: string };
};

function validateInput(options: AtomicInvoiceDocumentOptions) {
  const ownerUid = String(options.ownerUid || "").trim();
  const idempotencyKey = String(options.idempotencyKey || "").trim();
  const minimumNext = options.minimumNext ?? 1;
  if (!ownerUid || ownerUid.length > 256) throw new Error("Invoice owner UID is invalid.");
  if (!idempotencyKey || idempotencyKey.length > 160) throw new Error("Invoice idempotency key is invalid.");
  if (!Number.isSafeInteger(minimumNext) || minimumNext < 1) {
    throw new Error("Invoice minimum sequence must be a positive safe integer.");
  }
  return { ownerUid, idempotencyKey, minimumNext };
}

export function deterministicInvoiceDocumentId(ownerUid: string, idempotencyKey: string) {
  const digest = crypto.createHash("sha256").update(`${ownerUid}\0${idempotencyKey}`).digest("hex");
  return `invoice_${digest.slice(0, 40)}`;
}

function snapshotRecord(snapshot: Snapshot) {
  return { ...(snapshot.data() || {}), id: snapshot.id } as RecordData & { id: string };
}

function validateReplay(snapshot: Snapshot, ownerUid: string, idempotencyKey: string) {
  const record = snapshotRecord(snapshot);
  const owner = String(record.createdBy ?? record.owner_uid ?? "");
  const key = String(record.idempotency_key ?? record.idempotencyKey ?? "");
  if (owner !== ownerUid || key !== idempotencyKey) {
    throw new Error("Deterministic invoice document identity mismatch.");
  }
  return record;
}

async function findLegacyReplay(
  database: InvoiceDocumentDatabase,
  ownerUid: string,
  idempotencyKey: string,
  legacyIdentity?: { field: string; value: string },
) {
  const lookups = [
    { field: "idempotency_key", value: idempotencyKey, requireKey: true },
    ...(legacyIdentity?.value
      ? [{ field: legacyIdentity.field, value: legacyIdentity.value, requireKey: false }]
      : []),
  ];
  for (const lookup of lookups) {
    const snapshot = await database.collection("invoices")
      .where(lookup.field, "==", lookup.value)
      .get();
    const matches = snapshot.docs.filter((document) => {
      const record = document.data() || {};
      return String(record.createdBy ?? record.owner_uid ?? "") === ownerUid;
    });
    if (matches.length > 1) {
      throw new Error(`Multiple legacy invoices match ${lookup.field}; manual ledger repair is required.`);
    }
    if (matches.length === 1) {
      const record = snapshotRecord(matches[0]);
      if (lookup.requireKey) return validateReplay(matches[0], ownerUid, idempotencyKey);
      return record;
    }
  }
  return null;
}

function isAlreadyExists(error: unknown) {
  const code = String((error as { code?: unknown })?.code || "");
  const message = error instanceof Error ? error.message : String(error);
  return code === "ALREADY_EXISTS" || code === "6" || /already exists|duplicate key|unique constraint/i.test(message);
}

function persistedPayload(
  options: AtomicInvoiceDocumentOptions,
  ownerUid: string,
  idempotencyKey: string,
  context: InvoiceDocumentBuildContext,
  timestamp: string,
) {
  return {
    ...options.build(context),
    idempotency_key: idempotencyKey,
    createdBy: ownerUid,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function seedMinimumFromAllFirestoreInvoices(
  database: InvoiceDocumentDatabase,
  ownerUid: string,
  suggestedMinimum: number,
  counterRef: DocumentReference,
) {
  const counter = await counterRef.get();
  if (counter.exists) return suggestedMinimum;

  // This is an unbounded one-time legacy backfill only when the durable counter
  // is absent. Subsequent issuance reads the counter and does not scan invoices.
  const snapshot = await database.collection("invoices")
    .where("createdBy", "==", ownerUid)
    .get();
  let highest = 0;
  for (const document of snapshot.docs) {
    const record = document.data() || {};
    const sequence = historicalInvoiceSequence(record);
    if (sequence !== null && sequence > highest) highest = sequence;
  }
  return Math.max(suggestedMinimum, highest + 1);
}

/**
 * Creates one source invoice for one idempotency key. SQL adapters use their
 * native allocator plus deterministic primary key and unique constraints.
 * Native Firestore creates the counter update and invoice document in the same
 * serializable transaction.
 */
export async function createAtomicInvoiceDocumentWithDatabase(
  database: InvoiceDocumentDatabase,
  options: AtomicInvoiceDocumentOptions,
): Promise<AtomicInvoiceDocumentResult> {
  const { ownerUid, idempotencyKey, minimumNext } = validateInput(options);
  const documentId = deterministicInvoiceDocumentId(ownerUid, idempotencyKey);
  const invoiceRef = database.collection("invoices").doc(documentId);
  const timestamp = (options.now || (() => new Date().toISOString()))();
  const legacyReplay = await findLegacyReplay(
    database,
    ownerUid,
    idempotencyKey,
    options.legacyIdentity,
  );
  if (legacyReplay) {
    return { id: legacyReplay.id, created: false, data: legacyReplay };
  }

  // SQLite and Supabase expose allocateCounter and transactional constraints.
  if (typeof database.allocateCounter === "function") {
    const existing = await invoiceRef.get();
    if (existing.exists) {
      return { id: documentId, created: false, data: validateReplay(existing, ownerUid, idempotencyKey) };
    }
    if (typeof invoiceRef.create !== "function") {
      throw new Error("The configured invoice database cannot create documents atomically.");
    }
    const sequence = options.issued
      ? await allocateInvoiceSequenceWithDatabase(database as InvoiceSequenceDatabase, ownerUid, minimumNext)
      : null;
    const context = { sequence, issuedAt: options.issued ? timestamp : null };
    const payload = persistedPayload(options, ownerUid, idempotencyKey, context, timestamp);
    try {
      await invoiceRef.create(payload);
      return { id: documentId, created: true, data: { id: documentId, ...payload } };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const replay = await invoiceRef.get();
      if (!replay.exists) throw error;
      return { id: documentId, created: false, data: validateReplay(replay, ownerUid, idempotencyKey) };
    }
  }

  if (typeof database.runTransaction !== "function") {
    throw new Error("The configured invoice database does not support Firestore transactions.");
  }

  const counterRef = database.collection("invoice_sequences").doc(invoiceSequenceDocumentId(ownerUid));
  const seededMinimum = options.issued
    ? await seedMinimumFromAllFirestoreInvoices(database, ownerUid, minimumNext, counterRef)
    : minimumNext;

  return database.runTransaction(async (transaction) => {
    const invoiceSnapshot = await transaction.get(invoiceRef);
    const counterSnapshot = options.issued ? await transaction.get(counterRef) : null;
    if (invoiceSnapshot.exists) {
      return {
        id: documentId,
        created: false,
        data: validateReplay(invoiceSnapshot, ownerUid, idempotencyKey),
      };
    }

    let sequence: number | null = null;
    if (options.issued) {
      const current = counterSnapshot?.exists ? counterSnapshot.data() || {} : {};
      if (
        counterSnapshot?.exists
        && (current.owner_uid !== ownerUid || current.series !== INVOICE_SEQUENCE_SERIES)
      ) {
        throw new Error("Invoice sequence identity mismatch.");
      }
      const lastValue = counterSnapshot?.exists ? Number(current.last_value) : 0;
      if (!Number.isSafeInteger(lastValue) || lastValue < 0) {
        throw new Error("Stored invoice sequence is invalid.");
      }
      sequence = Math.max(lastValue + 1, seededMinimum);
      transaction.set(counterRef, {
        owner_uid: ownerUid,
        series: INVOICE_SEQUENCE_SERIES,
        last_value: sequence,
        updated_at: timestamp,
      }, { merge: true });
    }

    const context = { sequence, issuedAt: options.issued ? timestamp : null };
    const payload = persistedPayload(options, ownerUid, idempotencyKey, context, timestamp);
    transaction.create(invoiceRef, payload);
    return { id: documentId, created: true, data: { id: documentId, ...payload } };
  });
}
