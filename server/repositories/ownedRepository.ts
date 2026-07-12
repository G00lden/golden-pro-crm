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

export interface AggregateQuerySnapshotLike {
  data: () => { count?: number };
}

export interface AggregateQueryLike {
  get(): Promise<AggregateQuerySnapshotLike>;
}

export interface QueryLike {
  where(field: string, operator: string, value: unknown): QueryLike;
  orderBy(field: string): QueryLike;
  limit(value: number): QueryLike;
  count?(): AggregateQueryLike;
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

export const MAX_OWNED_SCAN_LIMIT = 10_000;

export interface OwnedCount {
  total: number;
  capped: boolean;
}

export interface OwnedPage {
  data: OwnedRecord[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasNext: boolean;
  hasPrevious: boolean;
  capped: boolean;
}

export interface OwnedPageOptions {
  orderField?: string;
  page?: number;
  pageSize?: number;
  maxScan?: number;
}

export interface OwnedRepository {
  list(table: string, uid: string, orderField?: string, limit?: number): Promise<OwnedRecord[]>;
  count(table: string, uid: string, maxScan?: number): Promise<OwnedCount>;
  listPage(table: string, uid: string, options?: OwnedPageOptions): Promise<OwnedPage>;
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

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

function ownedQuery(store: FirestoreLikeStore, table: string, uid: string) {
  return store.collection(table).where("createdBy", "==", uid);
}

export function createOwnedRepository(store: FirestoreLikeStore): OwnedRepository {
  const repository: OwnedRepository = {
    async list(table, uid, orderField, limit = 250) {
      let query = ownedQuery(store, table, uid);
      if (orderField) query = query.orderBy(orderField);
      const safeLimit = boundedInteger(limit, 250, 1, MAX_OWNED_SCAN_LIMIT);
      const snapshot = await query.limit(safeLimit).get();
      return snapshot.docs.map(snapshotData);
    },

    async count(table, uid, maxScan = MAX_OWNED_SCAN_LIMIT) {
      const safeMax = boundedInteger(maxScan, MAX_OWNED_SCAN_LIMIT, 1, MAX_OWNED_SCAN_LIMIT);
      const query = ownedQuery(store, table, uid);

      // Firestore exposes an aggregate count that does not download every row.
      // The SQLite/Supabase-compatible adapters do not, so retain a bounded
      // fallback and fetch one extra record to detect truncation.
      if (typeof query.count === "function") {
        const aggregate = await query.count().get();
        const total = Number(aggregate.data()?.count);
        if (Number.isFinite(total) && total >= 0) {
          return { total: Math.trunc(total), capped: total > safeMax };
        }
      }

      // The extra row is a sentinel only; it is never returned to callers.
      // It lets adapters without aggregate counts distinguish exactly 10,000
      // records from a result that was truncated at the 10,000-record guard.
      const snapshot = await query.limit(safeMax + 1).get();
      const capped = snapshot.size > safeMax;
      return { total: capped ? safeMax : snapshot.size, capped };
    },

    async listPage(table, uid, options = {}) {
      const maxScan = boundedInteger(
        options.maxScan,
        MAX_OWNED_SCAN_LIMIT,
        1,
        MAX_OWNED_SCAN_LIMIT,
      );
      const pageSize = boundedInteger(options.pageSize, 50, 1, Math.min(250, maxScan));
      const count = await repository.count(table, uid, maxScan);
      const accessibleTotal = Math.min(count.total, maxScan);
      const totalPages = Math.max(1, Math.ceil(accessibleTotal / pageSize));
      const page = boundedInteger(options.page, 1, 1, totalPages);
      const start = (page - 1) * pageSize;
      const end = Math.min(start + pageSize, maxScan);
      const leadingRows = end > 0
        ? await repository.list(table, uid, options.orderField, end)
        : [];
      const data = leadingRows.slice(start, end);

      return {
        data,
        total: count.total,
        page,
        pageSize,
        totalPages,
        hasNext: page < totalPages,
        hasPrevious: page > 1,
        capped: count.capped,
      };
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
