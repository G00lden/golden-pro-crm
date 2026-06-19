import { adminDb } from "./firebaseAdmin";

export async function ownedCount(collection: string, uid: string, configure?: (ref: any) => any) {
  try {
    const baseRef = adminDb.collection(collection).where("createdBy", "==", uid);
    const ref = configure ? configure(baseRef) : baseRef;
    const snap = await ref.limit(500).get();
    return { count: snap.docs.length, error: null as string | null };
  } catch (error) {
    return {
      count: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
