type FilterOp = "==" | "<=" | ">=" | "<" | ">";

type Filter = {
  field: string;
  op: FilterOp;
  value: unknown;
};

type Sort = {
  field: string;
  direction?: "asc" | "desc";
};

const POSTGREST_PAGE_SIZE = 1_000;

const collectionPrefixes: Record<string, string> = {
  customers: "cust",
  products: "prod",
  installations: "inst",
  technicians: "tech",
  bookings: "book",
  reminders: "rem",
  store_orders: "store",
  store_webhook_events: "swe",
  salla_order_inbox: "soi",
  salla_order_commands: "soc",
  technician_notifications: "tn",
  fieldtech_events: "ftev",
  fieldtech_job_states: "ftjs",
  fieldtech_technician_locations: "ftloc",
};

const primaryKeyByTable: Record<string, string> = {
  settings: "owner_uid",
};

const fieldToColumn: Record<string, string> = {
  createdBy: "owner_uid",
  ownerUid: "owner_uid",
  createdAt: "created_at",
  updatedAt: "updated_at",
  maxDaily: "max_daily",
  merchantId: "merchant_id",
  remoteOrderId: "remote_order_id",
  payloadHash: "payload_hash",
  receivedAt: "received_at",
  processedAt: "processed_at",
  nextAttemptAt: "next_attempt_at",
  errorCode: "error_code",
  orderDocId: "order_doc_id",
  commandType: "command_type",
  desiredHash: "desired_hash",
  attemptCount: "attempt_count",
  beforeHash: "before_hash",
  afterHash: "after_hash",
  resultStatus: "result_status",
  lastError: "last_error",
  actorUid: "actor_uid",
  completedAt: "completed_at",
  leaseToken: "lease_token",
  remoteStatusId: "remote_status_id",
  remoteStatusName: "remote_status_name",
  remoteStatusSlug: "remote_status_slug",
  remoteUpdatedAt: "remote_updated_at",
  remoteSyncedAt: "remote_synced_at",
  syncOrigin: "sync_origin",
  remoteDeletedAt: "remote_deleted_at",
  documentKind: "document_kind",
  sequenceNo: "sequence_no",
  issuedAt: "issued_at",
  sourceInvoiceId: "source_invoice_id",
  adjustmentKind: "adjustment_kind",
  adjustmentScope: "adjustment_scope",
  adjustmentReason: "adjustment_reason",
  idempotencyKey: "idempotency_key",
};

const columnToField: Record<string, string> = {
  owner_uid: "createdBy",
  created_at: "createdAt",
  updated_at: "updatedAt",
  max_daily: "maxDaily",
  merchant_id: "merchantId",
  remote_order_id: "remoteOrderId",
  payload_hash: "payloadHash",
  received_at: "receivedAt",
  processed_at: "processedAt",
  next_attempt_at: "nextAttemptAt",
  error_code: "errorCode",
  order_doc_id: "orderDocId",
  command_type: "commandType",
  desired_hash: "desiredHash",
  attempt_count: "attemptCount",
  before_hash: "beforeHash",
  after_hash: "afterHash",
  result_status: "resultStatus",
  last_error: "lastError",
  actor_uid: "actorUid",
  completed_at: "completedAt",
  lease_token: "leaseToken",
  remote_status_id: "remoteStatusId",
  remote_status_name: "remoteStatusName",
  remote_status_slug: "remoteStatusSlug",
  remote_updated_at: "remoteUpdatedAt",
  remote_synced_at: "remoteSyncedAt",
  sync_origin: "syncOrigin",
  remote_deleted_at: "remoteDeletedAt",
  document_kind: "documentKind",
  sequence_no: "sequenceNo",
  issued_at: "issuedAt",
  source_invoice_id: "sourceInvoiceId",
  adjustment_kind: "adjustmentKind",
  adjustment_scope: "adjustmentScope",
  adjustment_reason: "adjustmentReason",
  idempotency_key: "idempotencyKey",
};

function configured() {
  return Boolean(process.env.SUPABASE_URL && serviceKey());
}

function serviceKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || "";
}

function requireConfig() {
  const url = process.env.SUPABASE_URL;
  const key = serviceKey();
  if (!url || !key) {
    throw new Error(
      "Supabase is selected but SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.",
    );
  }
  return { url: url.replace(/\/$/, ""), key };
}

function columnName(field: string) {
  return fieldToColumn[field] || field;
}

function fieldName(column: string) {
  return columnToField[column] || column;
}

function toDbRecord(data: Record<string, unknown>, table: string, id?: string) {
  const record: Record<string, unknown> = {};
  const primaryKey = primaryKeyByTable[table] || "id";
  if (id) record[primaryKey] = id;

  for (const [key, value] of Object.entries(data || {})) {
    if (value === undefined) continue;
    if (key === "id" && primaryKey !== "id") continue;
    record[columnName(key)] = value;
  }

  if (table === "settings" && !record.owner_uid && id) record.owner_uid = id;
  return record;
}

function fromDbRecord<T = Record<string, unknown>>(row: Record<string, unknown> | null): T {
  if (!row) return {} as T;
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    record[fieldName(key)] = value;
  }
  return record as T;
}

function prefixFor(collection: string) {
  return collectionPrefixes[collection] || collection.slice(0, 4) || "doc";
}

function newId(collection: string) {
  return `${prefixFor(collection)}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function normalizedCounterInput(ownerUid: string, namespace: string, minimumNext: number) {
  const owner = String(ownerUid || "").trim();
  const series = String(namespace || "").trim();
  if (!owner || owner.length > 256) throw new Error("Counter owner UID is invalid.");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(series)) {
    throw new Error("Counter namespace is invalid.");
  }
  if (!Number.isSafeInteger(minimumNext) || minimumNext < 1) {
    throw new Error("Counter minimumNext must be a positive safe integer.");
  }
  return { owner, series, minimumNext };
}

function postgrestOp(op: FilterOp) {
  if (op === "==") return "eq";
  if (op === "<=") return "lte";
  if (op === ">=") return "gte";
  if (op === "<") return "lt";
  return "gt";
}

// Security (C1): never interpolate raw filter values into a PostgREST query.
// Quote string literals and escape embedded quotes/backslashes so attacker
// input cannot inject extra operators (e.g. ".or=(...)") and break the
// owner_uid tenant filter. URLSearchParams.toString() additionally
// percent-encodes the result.
function formatFilterValue(op: FilterOp, value: unknown): string {
  const prefix = `${postgrestOp(op)}.`;
  if (value === null || value === undefined) {
    return op === "==" ? "is.null" : `${prefix}null`;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return `${prefix}${value}`;
  }
  const escaped = String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `${prefix}"${escaped}"`;
}

async function request<T>(
  table: string,
  params: URLSearchParams,
  init: RequestInit = {},
): Promise<T> {
  const { url, key } = requireConfig();
  const query = params.toString();
  const response = await fetch(`${url}/rest/v1/${table}${query ? `?${query}` : ""}`, {
    ...init,
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Supabase ${response.status}: ${body || response.statusText}`);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function allocateCounter(ownerUid: string, namespace: string, minimumNext = 1) {
  const input = normalizedCounterInput(ownerUid, namespace, minimumNext);
  const raw = await request<unknown>("rpc/allocate_invoice_sequence", new URLSearchParams(), {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      p_owner_uid: input.owner,
      p_series: input.series,
      p_minimum_next: input.minimumNext,
    }),
  });
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  const value = Number(candidate);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Supabase returned an invalid counter allocation.");
  }
  return value;
}

class SupabaseDocSnapshot {
  public ref: SupabaseDocRef;

  constructor(
    table: string,
    public id: string,
    private row: Record<string, unknown> | null,
  ) {
    this.ref = new SupabaseDocRef(table, id);
  }

  get exists() {
    return Boolean(this.row);
  }

  data() {
    return fromDbRecord(this.row);
  }
}

class SupabaseQuerySnapshot {
  constructor(public docs: SupabaseDocSnapshot[]) {}

  get size() {
    return this.docs.length;
  }

  get empty() {
    return this.docs.length === 0;
  }
}

class SupabaseDocRef {
  constructor(
    public table: string,
    public id: string,
  ) {}

  private primaryKey() {
    return primaryKeyByTable[this.table] || "id";
  }

  async get() {
    const params = new URLSearchParams({ select: "*" });
    params.append(this.primaryKey(), formatFilterValue("==", this.id));
    params.set("limit", "1");
    const rows = await request<Record<string, unknown>[]>(this.table, params);
    return new SupabaseDocSnapshot(this.table, this.id, rows[0] || null);
  }

  async set(data: Record<string, unknown>, options?: { merge?: boolean }) {
    if (options?.merge) {
      const patchParams = new URLSearchParams();
      patchParams.append(this.primaryKey(), formatFilterValue("==", this.id));
      const patched = await request<Record<string, unknown>[]>(this.table, patchParams, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(toDbRecord(data, this.table)),
      });
      if (patched.length) return;
    }

    const params = new URLSearchParams();
    params.set("on_conflict", this.primaryKey());
    await request<Record<string, unknown>[]>(this.table, params, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify([toDbRecord(data, this.table, this.id)]),
    });
  }

  async create(data: Record<string, unknown>) {
    try {
      await request<Record<string, unknown>[]>(this.table, new URLSearchParams(), {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify([toDbRecord(data, this.table, this.id)]),
      });
    } catch (error) {
      if (/Supabase 409:|duplicate key|already exists/i.test(error instanceof Error ? error.message : String(error))) {
        const conflict = new Error(`Document ${this.id} already exists.`) as Error & { code?: string };
        conflict.code = "ALREADY_EXISTS";
        throw conflict;
      }
      throw error;
    }
  }

  async compareAndSet(expected: Record<string, unknown>, data: Record<string, unknown>) {
    const params = new URLSearchParams();
    params.append(this.primaryKey(), formatFilterValue("==", this.id));
    for (const [field, value] of Object.entries(expected)) {
      params.append(columnName(field), formatFilterValue("==", value));
    }
    const rows = await request<Record<string, unknown>[]>(this.table, params, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(toDbRecord(data, this.table)),
    });
    return rows.length === 1;
  }

  async update(data: Record<string, unknown>) {
    const params = new URLSearchParams();
    params.append(this.primaryKey(), formatFilterValue("==", this.id));
    await request(this.table, params, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(toDbRecord(data, this.table)),
    });
  }

  async delete() {
    const params = new URLSearchParams();
    params.append(this.primaryKey(), formatFilterValue("==", this.id));
    await request(this.table, params, {
      method: "DELETE",
      headers: { Prefer: "return=minimal" },
    });
  }
}

class SupabaseCollectionRef {
  private filters: Filter[] = [];
  private sorts: Sort[] = [];
  private maxRows?: number;

  constructor(public table: string) {}

  doc(id = newId(this.table)) {
    return new SupabaseDocRef(this.table, id);
  }

  async add(data: Record<string, unknown>) {
    const ref = this.doc();
    await ref.set(data);
    return ref;
  }

  where(field: string, op: FilterOp, value: unknown) {
    const next = this.clone();
    next.filters.push({ field, op, value });
    return next;
  }

  orderBy(field: string, direction: "asc" | "desc" = "asc") {
    const next = this.clone();
    next.sorts.push({ field, direction });
    return next;
  }

  limit(count: number) {
    const next = this.clone();
    next.maxRows = count;
    return next;
  }

  async get() {
    const baseParams = new URLSearchParams({ select: "*" });
    for (const filter of this.filters) {
      baseParams.append(columnName(filter.field), formatFilterValue(filter.op, filter.value));
    }
    if (this.sorts.length) {
      baseParams.set(
        "order",
        this.sorts.map((sort) => `${columnName(sort.field)}.${sort.direction || "asc"}`).join(","),
      );
    }

    const primaryKey = primaryKeyByTable[this.table] || "id";
    const requestedRows = Number.isFinite(this.maxRows)
      ? Math.max(0, Math.trunc(this.maxRows || 0))
      : undefined;
    let rows: Record<string, unknown>[];

    if (requestedRows && requestedRows > POSTGREST_PAGE_SIZE) {
      rows = [];
      // PostgREST commonly caps one response at 1,000 rows even if a larger
      // limit is requested. Fetch bounded sequential pages so repository scans
      // and fallback counts can safely reach their explicit 10,000-row guard.
      // A primary-key order makes offsets deterministic when no caller order
      // was supplied.
      const order = baseParams.get("order");
      if (!order) {
        baseParams.set("order", `${primaryKey}.asc`);
      } else if (!order.split(",").some((entry) => entry.startsWith(`${primaryKey}.`))) {
        baseParams.set("order", `${order},${primaryKey}.asc`);
      }
      while (rows.length < requestedRows) {
        const batchSize = Math.min(POSTGREST_PAGE_SIZE, requestedRows - rows.length);
        const params = new URLSearchParams(baseParams);
        params.set("limit", String(batchSize));
        params.set("offset", String(rows.length));
        const batch = await request<Record<string, unknown>[]>(this.table, params);
        rows.push(...batch);
        if (batch.length < batchSize) break;
      }
    } else {
      const params = new URLSearchParams(baseParams);
      if (requestedRows) params.set("limit", String(requestedRows));
      rows = await request<Record<string, unknown>[]>(this.table, params);
    }

    return new SupabaseQuerySnapshot(
      rows.map((row) => new SupabaseDocSnapshot(this.table, String(row[primaryKey]), row)),
    );
  }

  private clone() {
    const next = new SupabaseCollectionRef(this.table);
    next.filters = [...this.filters];
    next.sorts = [...this.sorts];
    next.maxRows = this.maxRows;
    return next;
  }
}

class SupabaseWriteBatch {
  private operations: Array<() => Promise<void>> = [];

  set(ref: SupabaseDocRef, data: Record<string, unknown>, options?: { merge?: boolean }) {
    this.operations.push(() => ref.set(data, options));
  }

  update(ref: SupabaseDocRef, data: Record<string, unknown>) {
    this.operations.push(() => ref.update(data));
  }

  async commit() {
    for (const operation of this.operations) await operation();
  }
}

export function createSupabaseFirestoreAdapter() {
  return {
    configured,
    allocateCounter,
    collection(table: string) {
      return new SupabaseCollectionRef(table);
    },
    batch() {
      return new SupabaseWriteBatch();
    },
  };
}
