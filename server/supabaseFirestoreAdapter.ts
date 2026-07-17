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

const collectionPrefixes: Record<string, string> = {
  customers: "cust",
  products: "prod",
  installations: "inst",
  technicians: "tech",
  bookings: "book",
  reminders: "rem",
  store_orders: "store",
  store_webhook_events: "swe",
  technician_notifications: "tn",
  customer_assets: "asset",
  service_cycles: "cycle",
  asset_events: "aevt",
  marketing_campaigns: "camp",
  odoo_import_runs: "odoo",
  replacement_links: "repl",
  fieldtech_events: "ftev",
  fieldtech_job_states: "ftjs",
  fieldtech_technician_locations: "ftloc",
};

const primaryKeyByTable: Record<string, string> = {
  settings: "owner_uid",
};

const fieldToColumn: Record<string, string> = {
  createdBy: "owner_uid",
  createdAt: "created_at",
  updatedAt: "updated_at",
  maxDaily: "max_daily",
};

const columnToField: Record<string, string> = {
  owner_uid: "createdBy",
  created_at: "createdAt",
  updated_at: "updatedAt",
  max_daily: "maxDaily",
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

  async set(data: Record<string, unknown>, _options?: { merge?: boolean }) {
    const params = new URLSearchParams();
    params.set("on_conflict", this.primaryKey());
    await request<Record<string, unknown>[]>(this.table, params, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify([toDbRecord(data, this.table, this.id)]),
    });
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
    const params = new URLSearchParams({ select: "*" });
    for (const filter of this.filters) {
      params.append(columnName(filter.field), formatFilterValue(filter.op, filter.value));
    }
    if (this.sorts.length) {
      params.set(
        "order",
        this.sorts.map((sort) => `${columnName(sort.field)}.${sort.direction || "asc"}`).join(","),
      );
    }
    if (this.maxRows) params.set("limit", String(this.maxRows));

    const rows = await request<Record<string, unknown>[]>(this.table, params);
    const primaryKey = primaryKeyByTable[this.table] || "id";
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
    collection(table: string) {
      return new SupabaseCollectionRef(table);
    },
    batch() {
      return new SupabaseWriteBatch();
    },
  };
}
