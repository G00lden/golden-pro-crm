export type OwnedRecord = Record<string, any> & { id: string };

export interface DocSnapshotLike {
  id: string;
  exists?: boolean;
  data: () => Record<string, unknown>;
}

export interface QuerySnapshotLike {
  docs: DocSnapshotLike[];
  size: number;
}

export interface QueryLike {
  where(field: string, operator: string, value: unknown): QueryLike;
  orderBy(field: string): QueryLike;
  limit(value: number): QueryLike;
  get(): Promise<QuerySnapshotLike>;
}

export interface DocumentLike {
  id: string;
  get(): Promise<DocSnapshotLike>;
  set(data: Record<string, unknown>): Promise<unknown>;
  update(data: Record<string, unknown>): Promise<unknown>;
  delete(): Promise<unknown>;
}

export interface CollectionLike extends QueryLike {
  doc(id?: string): DocumentLike;
}

/** Smallest data-store contract required by owner-scoped CRM operations. */
export interface FirestoreLikeStore {
  collection(name: string): CollectionLike;
}

export interface BlockingReference {
  table: string;
  field: string;
  value: string;
  label: string;
}

export interface OwnedRepository {
  list(table: string, uid: string, orderField?: string, limit?: number): Promise<OwnedRecord[]>;
  get(table: string, id: string, uid: string): Promise<OwnedRecord | null>;
  create(table: string, uid: string, data: Record<string, unknown>): Promise<string>;
  update(table: string, id: string, uid: string, data: Record<string, unknown>): Promise<boolean>;
  delete(table: string, id: string, uid: string): Promise<boolean>;
  countReferencing(table: string, field: string, value: string, uid: string): Promise<number>;
  findBlockingReferences(uid: string, checks: BlockingReference[]): Promise<string | null>;
}

const PROTECTED_UPDATE_FIELDS = ["createdBy", "owner_uid", "id", "createdAt"] as const;

export function nowIso() {
  return new Date().toISOString();
}

export function cleanData<T extends Record<string, unknown>>(value: T) {
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value || {})) {
    if (item !== undefined) copy[key] = item;
  }
  return copy;
}

export function snapshotData(doc: DocSnapshotLike): OwnedRecord {
  return { id: doc.id, ...doc.data() };
}

export function createOwnedRepository(store: FirestoreLikeStore): OwnedRepository {
  const repository: OwnedRepository = {
    async list(table, uid, orderField, limit = 250) {
      let query = store.collection(table).where("createdBy", "==", uid);
      if (orderField) query = query.orderBy(orderField);
      const snapshot = await query.limit(limit).get();
      return snapshot.docs.map(snapshotData);
    },

    async get(table, id, uid) {
      const snapshot = await store.collection(table).doc(id).get();
      if (!snapshot.exists) return null;
      const data = snapshotData(snapshot);
      // SQLite stores ownership as owner_uid; Firestore uses createdBy.
      const owner = data.createdBy ?? data.owner_uid;
      return owner === uid ? data : null;
    },

    async create(table, uid, data) {
      const ref = store.collection(table).doc();
      const timestamp = nowIso();
      await ref.set(cleanData({
        ...data,
        createdBy: uid,
        createdAt: data.createdAt || timestamp,
        updatedAt: timestamp,
      }));
      return ref.id;
    },

    async update(table, id, uid, data) {
      if (!(await repository.get(table, id, uid))) return false;
      const safe = { ...(data || {}) };
      for (const field of PROTECTED_UPDATE_FIELDS) delete safe[field];
      await store.collection(table).doc(id).update(cleanData({ ...safe, updatedAt: nowIso() }));
      return true;
    },

    async delete(table, id, uid) {
      if (!(await repository.get(table, id, uid))) return false;
      await store.collection(table).doc(id).delete();
      return true;
    },

    async countReferencing(table, field, value, uid) {
      const snapshot = await store
        .collection(table)
        .where("createdBy", "==", uid)
        .where(field, "==", value)
        .get();
      return snapshot.size;
    },

    async findBlockingReferences(uid, checks) {
      const blockers: string[] = [];
      for (const check of checks) {
        const count = await repository.countReferencing(
          check.table,
          check.field,
          check.value,
          uid,
        );
        if (count > 0) blockers.push(`${check.label} (${count})`);
      }
      return blockers.length ? blockers.join("، ") : null;
    },
  };

  return repository;
}
