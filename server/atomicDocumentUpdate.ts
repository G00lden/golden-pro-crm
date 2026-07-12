import { adminDb } from "./firebaseAdmin";

type UnknownRecord = Record<string, unknown>;

type AtomicDocumentRef = {
  compareAndSet?: (expected: UnknownRecord, data: UnknownRecord) => Promise<boolean>;
};

function valuesMatch(current: UnknownRecord, expected: UnknownRecord) {
  return Object.entries(expected).every(([key, value]) => {
    const actual = current[key];
    if (value === null || value === undefined) return actual === null || actual === undefined;
    return actual === value;
  });
}

/**
 * Atomically patches a document only when the observed lease fields still
 * match. SQLite and Supabase provide a native conditional UPDATE; Firestore
 * uses a transaction. This prevents an expired worker from overwriting the
 * worker that reclaimed the lease.
 */
export async function compareAndSetDocument(
  ref: unknown,
  expected: UnknownRecord,
  data: UnknownRecord,
) {
  const atomicRef = ref as AtomicDocumentRef;
  if (typeof atomicRef.compareAndSet === "function") {
    return atomicRef.compareAndSet(expected, data);
  }

  const firestore = adminDb as unknown as {
    runTransaction?: <T>(callback: (transaction: {
      get: (document: unknown) => Promise<{ exists: boolean; data: () => UnknownRecord }>;
      update: (document: unknown, patch: UnknownRecord) => void;
    }) => Promise<T>) => Promise<T>;
  };
  if (typeof firestore.runTransaction !== "function") {
    throw new Error("The configured database does not support atomic document updates.");
  }
  return firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists || !valuesMatch(snapshot.data() || {}, expected)) return false;
    transaction.update(ref, data);
    return true;
  });
}
