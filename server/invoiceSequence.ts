import { adminDb } from "./firebaseAdmin";

export const INVOICE_SEQUENCE_SERIES = "tax_documents";

export function historicalInvoiceSequence(record: Record<string, unknown>) {
  const stored = Number(record.sequence_no ?? record.sequenceNo ?? 0);
  if (Number.isSafeInteger(stored) && stored > 0) return stored;
  const match = String(record.invoice_number ?? record.invoiceNumber ?? "")
    .trim()
    .match(/^(?:INV|CN)-.+-(\d+)$/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function invoiceSequenceDocumentId(ownerUid: string) {
  return `${encodeURIComponent(ownerUid)}__${INVOICE_SEQUENCE_SERIES}`;
}

type CounterSnapshot = {
  exists: boolean;
  data: () => Record<string, unknown>;
};

type CounterDocument = unknown;

type CounterTransaction = {
  get: (document: CounterDocument) => Promise<CounterSnapshot>;
  set: (
    document: CounterDocument,
    data: Record<string, unknown>,
    options?: { merge?: boolean },
  ) => void;
};

export type InvoiceSequenceDatabase = {
  allocateCounter?: (
    ownerUid: string,
    namespace: string,
    minimumNext: number,
  ) => Promise<number> | number;
  collection?: (name: string) => {
    doc: (id: string) => CounterDocument;
  };
  runTransaction?: <T>(callback: (transaction: CounterTransaction) => Promise<T>) => Promise<T>;
};

function normalizedInput(ownerUid: string, minimumNext: number) {
  const owner = String(ownerUid || "").trim();
  if (!owner || owner.length > 256) throw new Error("Invoice sequence owner UID is invalid.");
  if (!Number.isSafeInteger(minimumNext) || minimumNext < 1) {
    throw new Error("Invoice sequence minimumNext must be a positive safe integer.");
  }
  return { owner, minimumNext };
}

function verifiedAllocation(value: unknown) {
  const allocation = Number(value);
  if (!Number.isSafeInteger(allocation) || allocation < 1) {
    throw new Error("The database returned an invalid invoice sequence allocation.");
  }
  return allocation;
}

/**
 * Provider-independent implementation. SQLite and Supabase expose a native
 * allocation primitive; Firestore falls back to its serializable transaction.
 */
export async function allocateInvoiceSequenceWithDatabase(
  database: InvoiceSequenceDatabase,
  ownerUid: string,
  minimumNext = 1,
) {
  const input = normalizedInput(ownerUid, minimumNext);
  if (typeof database.allocateCounter === "function") {
    return verifiedAllocation(
      await database.allocateCounter(input.owner, INVOICE_SEQUENCE_SERIES, input.minimumNext),
    );
  }

  if (typeof database.collection !== "function" || typeof database.runTransaction !== "function") {
    throw new Error("The configured database does not support atomic invoice sequences.");
  }

  const documentId = invoiceSequenceDocumentId(input.owner);
  const reference = database.collection("invoice_sequences").doc(documentId);
  return database.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const current = snapshot.exists ? snapshot.data() || {} : {};
    if (
      snapshot.exists
      && (current.owner_uid !== input.owner || current.series !== INVOICE_SEQUENCE_SERIES)
    ) {
      throw new Error("Invoice sequence identity mismatch.");
    }

    const lastValue = snapshot.exists ? Number(current.last_value) : 0;
    if (!Number.isSafeInteger(lastValue) || lastValue < 0) {
      throw new Error("Stored invoice sequence is invalid.");
    }
    const allocation = Math.max(lastValue + 1, input.minimumNext);
    verifiedAllocation(allocation);
    transaction.set(reference, {
      owner_uid: input.owner,
      series: INVOICE_SEQUENCE_SERIES,
      last_value: allocation,
      updated_at: new Date().toISOString(),
    }, { merge: true });
    return allocation;
  });
}

export async function allocateInvoiceSequence(ownerUid: string, minimumNext = 1) {
  const database = adminDb as unknown as InvoiceSequenceDatabase;
  const firestoreDatabase = adminDb as unknown as {
    collection: (name: string) => {
      doc: (id: string) => {
        get?: () => Promise<{ exists: boolean; data: () => Record<string, unknown> }>;
      };
      where?: (field: string, operator: string, value: unknown) => {
        get: () => Promise<{ docs: Array<{ data: () => Record<string, unknown> }> }>;
      };
    };
  };
  let safeMinimum = minimumNext;
  if (typeof database.allocateCounter !== "function" && typeof firestoreDatabase.collection === "function") {
    const counter = firestoreDatabase.collection("invoice_sequences").doc(invoiceSequenceDocumentId(ownerUid));
    const counterSnapshot = typeof counter.get === "function" ? await counter.get() : null;
    if (!counterSnapshot?.exists) {
      const invoices = firestoreDatabase.collection("invoices");
      if (typeof invoices.where === "function") {
        const snapshot = await invoices.where("createdBy", "==", ownerUid).get();
        let highest = 0;
        for (const document of snapshot.docs) {
          const record = document.data() || {};
          const sequence = historicalInvoiceSequence(record);
          if (sequence !== null && sequence > highest) highest = sequence;
        }
        safeMinimum = Math.max(safeMinimum, highest + 1);
      }
    }
  }
  return allocateInvoiceSequenceWithDatabase(
    database,
    ownerUid,
    safeMinimum,
  );
}
