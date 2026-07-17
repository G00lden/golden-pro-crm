import db from "./db";
import crypto from "crypto";

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
  salla_order_inbox: "soi",
  salla_order_commands: "soc",
  technician_notifications: "tn",
  quotes: "quote",
  invoices: "inv",
  crm_deals: "deal",
  crm_tasks: "task",
  crm_notes: "note",
  audit_logs: "audit",
  fieldtech_events: "ftev",
  fieldtech_job_states: "ftjs",
  fieldtech_technician_locations: "ftloc",
};

const primaryKeyByTable: Record<string, string> = {
  settings: "owner_uid",
};

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

/**
 * Allocates one durable sequence value. BEGIN IMMEDIATE serializes independent
 * SQLite connections before the UPSERT, while RETURNING keeps read/write in the
 * same statement. A rolled-back document write never makes this value reusable.
 */
export function allocateSqliteCounter(
  database: typeof db,
  ownerUid: string,
  namespace: string,
  minimumNext = 1,
) {
  const input = normalizedCounterInput(ownerUid, namespace, minimumNext);
  const allocate = database.prepare(`
    INSERT INTO invoice_sequences (owner_uid, series, last_value, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(owner_uid, series) DO UPDATE SET
      last_value = MAX(invoice_sequences.last_value + 1, excluded.last_value),
      updated_at = excluded.updated_at
    RETURNING last_value
  `);
  const transaction = database.transaction(() => {
    const row = allocate.get(input.owner, input.series, input.minimumNext) as { last_value?: unknown } | undefined;
    const value = Number(row?.last_value);
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error("Allocated counter value is outside the safe integer range.");
    }
    return value;
  });
  return transaction.immediate();
}

function sqlOp(op: FilterOp): string {
  switch (op) {
    case "==": return "=";
    case "<=": return "<=";
    case ">=": return ">=";
    case "<": return "<";
    case ">": return ">";
  }
}

// Validate a column against the REAL schema of the table it will be used on.
// This both prevents SQL injection (only actual columns pass) and — unlike the
// old hand-maintained allow-list — never rejects a legitimate column that the
// list simply forgot (e.g. invoice_id, technician_phone, order_item_type). The
// column set is read once per table via PRAGMA and cached.
const tableColumnsCache = new Map<string, Set<string>>();

function tableColumns(table: string): Set<string> {
  let cols = tableColumnsCache.get(table);
  if (!cols) {
    // Table names come from server-side collection() calls, never user input,
    // but guard the identifier before it reaches PRAGMA regardless.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) return new Set();
    const info = db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as Array<{ name: string }>;
    cols = new Set(info.map((c) => c.name));
    tableColumnsCache.set(table, cols);
  }
  return cols;
}

function isValidColumn(table: string, field: string): boolean {
  return tableColumns(table).has(field);
}

// ==========================================
// SQLiteDocSnapshot
// ==========================================
class SqliteDocSnapshot {
  public ref: SqliteDocRef;

  constructor(
    table: string,
    public id: string,
    private row: Record<string, unknown> | null,
  ) {
    this.ref = new SqliteDocRef(table, id);
  }

  get exists() {
    return Boolean(this.row);
  }

  data() {
    if (!this.row) return {};
    // Surface both the original column names AND the camelCase field aliases
    // expected by Firestore-style consumers (e.g. ownership checks that read
    // `createdBy` rather than `owner_uid`). Existing call sites that read
    // snake_case columns keep working.
    const row = Object.fromEntries(
      Object.entries(this.row).map(([column, value]) => [column, deserializeValue(column, value)]),
    ) as Record<string, unknown>;
    const aliases: Array<[string, string]> = [
      ["owner_uid", "createdBy"],
      ["created_at", "createdAt"],
      ["updated_at", "updatedAt"],
      ["merchant_id", "merchantId"],
      ["event_type", "eventType"],
      ["remote_order_id", "remoteOrderId"],
      ["payload_hash", "payloadHash"],
      ["received_at", "receivedAt"],
      ["processed_at", "processedAt"],
      ["next_attempt_at", "nextAttemptAt"],
      ["error_code", "errorCode"],
      ["order_doc_id", "orderDocId"],
      ["command_type", "commandType"],
      ["desired_hash", "desiredHash"],
      ["attempt_count", "attemptCount"],
      ["before_hash", "beforeHash"],
      ["after_hash", "afterHash"],
      ["result_status", "resultStatus"],
      ["last_error", "lastError"],
      ["actor_uid", "actorUid"],
      ["completed_at", "completedAt"],
      ["lease_token", "leaseToken"],
      ["remind_type", "reminder_type"],
      ["remote_status_id", "remoteStatusId"],
      ["remote_status_name", "remoteStatusName"],
      ["remote_status_slug", "remoteStatusSlug"],
      ["remote_updated_at", "remoteUpdatedAt"],
      ["remote_synced_at", "remoteSyncedAt"],
      ["sync_origin", "syncOrigin"],
      ["remote_deleted_at", "remoteDeletedAt"],
      ["document_kind", "documentKind"],
      ["sequence_no", "sequenceNo"],
      ["issued_at", "issuedAt"],
      ["source_invoice_id", "sourceInvoiceId"],
      ["adjustment_kind", "adjustmentKind"],
      ["adjustment_scope", "adjustmentScope"],
      ["adjustment_reason", "adjustmentReason"],
      ["idempotency_key", "idempotencyKey"],
    ];
    for (const [col, alias] of aliases) {
      if (row[col] !== undefined && row[alias] === undefined) {
        row[alias] = row[col];
      }
    }
    return row;
  }
}

// ==========================================
// SqliteQuerySnapshot
// ==========================================
class SqliteQuerySnapshot {
  constructor(public docs: SqliteDocSnapshot[]) {}

  get size() {
    return this.docs.length;
  }

  get empty() {
    return this.docs.length === 0;
  }
}

const fieldToColumn: Record<string, string> = {
  createdBy: "owner_uid",
  createdAt: "created_at",
  updatedAt: "updated_at",
  bookingId: "booking_id",
  customerId: "customer_id",
  productId: "product_id",
  technicianId: "technician_id",
  installationId: "installation_id",
  customerName: "customer_name",
  customerPhone: "customer_phone",
  productName: "product_name",
  productSku: "product_sku",
  technicianName: "technician_name",
  storeOrderId: "store_order_id",
  bookingType: "booking_type",
  installationStatus: "installation_status",
  nextMaintenance: "next_maintenance",
  installDate: "install_date",
  completedDate: "completed_date",
  lastRemindAt: "last_remind_at",
  lastRemindAttemptAt: "last_remind_attempt_at",
  remindCount: "remind_count",
  nextRemindType: "next_remind_type",
  // reminderEngine uses the Firestore name while the established SQLite
  // schema and maintenance lifecycle use remind_type.
  reminder_type: "remind_type",
  intervalMonths: "interval_months",
  maxDaily: "max_daily",
  remindText: "remind_text",
  productType: "product_type",
  storeProvider: "store_provider",
  storeProductId: "store_product_id",
  salePrice: "sale_price",
  imageUrl: "image_url",
  stockQuantity: "stock_quantity",
  storeStatus: "store_status",
  catalogVisible: "catalog_visible",
  lastSyncedAt: "last_synced_at",
  notificationType: "notification_type",
  orderStatus: "order_status",
  technicianPhone: "technician_phone",
  storeOrderNumber: "store_order_number",
  orderItemType: "order_item_type",
  sentAt: "sent_at",
  eventType: "event_type",
  eventId: "event_id",
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
  rawBody: "raw_body",
  ownerUid: "owner_uid",
  quoteNumber: "quote_number",
  issueDate: "issue_date",
  validUntil: "valid_until",
  followUpDate: "follow_up_date",
  customerCity: "customer_city",
  confirmedAt: "confirmed_at",
  paymentMethod: "payment_method",
  paymentDownPercent: "payment_down_percent",
  paymentFinalPercent: "payment_final_percent",
  paymentDownText: "payment_down_text",
  paymentFinalText: "payment_final_text",
  paymentBank: "payment_bank",
  paymentAccount: "payment_account",
  paymentIban: "payment_iban",
  paymentNote: "payment_note",
  invoiceNumber: "invoice_number",
  documentKind: "document_kind",
  sequenceNo: "sequence_no",
  issuedAt: "issued_at",
  sourceInvoiceId: "source_invoice_id",
  adjustmentKind: "adjustment_kind",
  adjustmentScope: "adjustment_scope",
  adjustmentReason: "adjustment_reason",
  idempotencyKey: "idempotency_key",
  quoteId: "quote_id",
  invoiceId: "invoice_id",
  expectedClose: "expected_close",
  assignedTo: "assigned_to",
  relatedType: "related_type",
  relatedId: "related_id",
  completedAt: "completed_at",
  leaseToken: "lease_token",
  actorUid: "actor_uid",
  entityType: "entity_type",
  entityId: "entity_id",
  beforeData: "before_data",
  afterData: "after_data",
  customerVat: "customer_vat",
  dueDate: "due_date",
  paidAt: "paid_at",
  vatPercent: "vat_percent",
  vatAmount: "vat_amount",
  totalWithoutVat: "total_without_vat",
  totalWithVat: "total_with_vat",
  sellerName: "seller_name",
  sellerVat: "seller_vat",
  sellerVatNumber: "seller_vat_number",
  sellerAddress: "seller_address",
  qrCode: "qr_code",
  remoteStatusId: "remote_status_id",
  remoteStatusName: "remote_status_name",
  remoteStatusSlug: "remote_status_slug",
  remoteUpdatedAt: "remote_updated_at",
  remoteSyncedAt: "remote_synced_at",
  syncOrigin: "sync_origin",
  remoteDeletedAt: "remote_deleted_at",
};

const jsonColumns = new Set([
  "booking_ids",
  "installation_ids",
  "items",
  "metadata",
  "before_data",
  "after_data",
  "order_types",
  "order_tags",
  "customer_groups",
  "permissions",
  "product_ids",
  "payload",
  "categories",
  "image_urls",
  "variants",
]);

function mapToColumn(key: string): string {
  return fieldToColumn[key] || key;
}

function serializeValue(value: unknown) {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (
    value &&
    typeof value === "object" &&
    !Buffer.isBuffer(value) &&
    !(value instanceof Date)
  ) {
    return JSON.stringify(value);
  }
  return value;
}

function deserializeValue(column: string, value: unknown) {
  if (!jsonColumns.has(column) || typeof value !== "string" || !value.trim()) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function mapRecord(record: Record<string, unknown>, table?: string): Record<string, unknown> {
  // Skip the 'id' column ONLY for tables whose primary key is not 'id' (i.e.
  // settings, keyed by owner_uid). The previous heuristic — skip 'id' whenever
  // the payload carried an owner_uid field — fired for EVERY table, so add()
  // with an owner_uid dropped the generated id and inserted a NULL primary key.
  const skipId = table
    ? (primaryKeyByTable[table] || "id") !== "id"
    : Boolean(record["owner_uid"]);
  const mapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue;
    const col = mapToColumn(key);
    if (col === "id" && skipId) continue;
    mapped[col] = serializeValue(value);
  }
  return mapped;
}

// ==========================================
// SqliteDocRef
// ==========================================
class SqliteDocRef {
  constructor(
    public table: string,
    public id: string,
  ) {}

  private primaryKey() {
    return primaryKeyByTable[this.table] || "id";
  }

  async get() {
    const pk = this.primaryKey();
    const row = db.prepare(`SELECT * FROM "${this.table}" WHERE "${pk}" = ? LIMIT 1`).get(this.id) as Record<string, unknown> | undefined;
    return new SqliteDocSnapshot(this.table, this.id, row || null);
  }

  async set(data: Record<string, unknown>, _options?: { merge?: boolean }) {
    const pk = this.primaryKey();
    const existing = this._getRaw();
    const mapped = mapRecord(data, this.table);
    if (existing && _options?.merge) {
      const merged = mapRecord({ ...existing, ...data }, this.table);
      this._upsert(merged);
    } else {
      const record = { [pk]: this.id, ...mapped };
      this._upsert(record);
    }
  }

  async create(data: Record<string, unknown>) {
    const pk = this.primaryKey();
    const record = { [pk]: this.id, ...mapRecord(data, this.table) };
    const keys = Object.keys(record);
    const placeholders = keys.map(() => "?").join(", ");
    const quotedKeys = keys.map((key) => `"${key}"`).join(", ");
    try {
      db.prepare(`INSERT INTO "${this.table}" (${quotedKeys}) VALUES (${placeholders})`)
        .run(...keys.map((key) => record[key]));
    } catch (error) {
      const code = String((error as { code?: unknown })?.code || "");
      const message = error instanceof Error ? error.message : String(error);
      // Preserve named trigger failures: they describe lifecycle conflicts,
      // whereas only primary-key/unique collisions mean this document exists.
      if (code.startsWith("SQLITE_CONSTRAINT") && /UNIQUE constraint failed|PRIMARY KEY/i.test(message)) {
        const conflict = new Error(`Document ${this.id} already exists.`) as Error & { code?: string };
        conflict.code = "ALREADY_EXISTS";
        throw conflict;
      }
      throw error;
    }
  }

  async compareAndSet(expected: Record<string, unknown>, data: Record<string, unknown>) {
    const pk = this.primaryKey();
    const mappedExpected = mapRecord(expected, this.table);
    const mappedData = mapRecord(data, this.table);
    const updateKeys = Object.keys(mappedData).filter((key) => key !== pk && isValidColumn(this.table, key));
    const expectedKeys = Object.keys(mappedExpected).filter((key) => key !== pk && isValidColumn(this.table, key));
    if (!updateKeys.length) return false;
    const setClause = updateKeys.map((key) => `"${key}" = ?`).join(", ");
    const whereClause = expectedKeys.map((key) => mappedExpected[key] === null
      ? `"${key}" IS NULL`
      : `"${key}" = ?`).join(" AND ");
    const values = updateKeys.map((key) => mappedData[key]);
    values.push(this.id);
    for (const key of expectedKeys) {
      if (mappedExpected[key] !== null) values.push(mappedExpected[key]);
    }
    const result = db.prepare(
      `UPDATE "${this.table}" SET ${setClause} WHERE "${pk}" = ?${whereClause ? ` AND ${whereClause}` : ""}`,
    ).run(...values);
    return result.changes === 1;
  }

  async update(data: Record<string, unknown>) {
    const pk = this.primaryKey();
    const existing = this._getRaw();
    if (!existing) return;
    const mapped = mapRecord({ ...existing, ...data, updated_at: new Date().toISOString() }, this.table);
    const keys = Object.keys(mapped).filter((k) => k !== pk);
    const setClause = keys.map((k) => `"${k}" = ?`).join(", ");
    const values = keys.map((k) => mapped[k]);
    values.push(this.id);
    db.prepare(`UPDATE "${this.table}" SET ${setClause} WHERE "${pk}" = ?`).run(...values);
  }

  async delete() {
    const pk = this.primaryKey();
    db.prepare(`DELETE FROM "${this.table}" WHERE "${pk}" = ?`).run(this.id);
  }

  private _getRaw(): Record<string, unknown> | null {
    const pk = this.primaryKey();
    return (db.prepare(`SELECT * FROM "${this.table}" WHERE "${pk}" = ?`).get(this.id) as Record<string, unknown>) || null;
  }

  private _upsert(record: Record<string, unknown>) {
    const pk = primaryKeyByTable[this.table] || "id";
    const keys = Object.keys(record);
    const values = keys.map((k) => record[k]);

    const updateCols = keys
      .filter((k) => k !== pk)
      .map((k) => `"${k}" = EXCLUDED."${k}"`)
      .join(", ");

    db.prepare(
      `INSERT INTO "${this.table}" ("${pk}", ${keys.filter((k) => k !== pk).map((k) => `"${k}"`).join(", ")})
       VALUES (?, ${keys.filter((k) => k !== pk).map(() => "?").join(", ")})
       ON CONFLICT("${pk}") DO UPDATE SET ${updateCols}`
    ).run(this.id, ...values.filter((_, i) => keys[i] !== pk));
  }
}
class SqliteCollectionRef {
  private filters: Filter[] = [];
  private sorts: Sort[] = [];
  private maxRows?: number;

  constructor(public table: string) {}

  doc(id = newId(this.table)) {
    return new SqliteDocRef(this.table, id);
  }

  async add(data: Record<string, unknown>) {
    const ref = this.doc();
    // Apply the same Firestore→SQLite column mapping as set()/update() so
    // callers that pass camelCase aliases (createdBy, customerName, ...) do
    // not blow up with "no such column" SQLITE_ERRORs.
    const record = mapRecord({ id: ref.id, ...data }, this.table);
    const keys = Object.keys(record);
    const placeholders = keys.map(() => "?").join(", ");
    const quotedKeys = keys.map((k) => `"${k}"`).join(", ");
    db.prepare(
      `INSERT INTO "${this.table}" (${quotedKeys}) VALUES (${placeholders})`,
    ).run(...keys.map((k) => record[k]));
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
    let sql = `SELECT * FROM "${this.table}"`;
    const params: unknown[] = [];

    if (this.filters.length > 0) {
      const conditions = this.filters
        .map((f) => {
          // Map Firestore field names to SQL columns via the full alias map (not
          // just the 3 hard-coded aliases) so any camelCase field resolves.
          const col = mapToColumn(f.field);
          if (!isValidColumn(this.table, col)) {
            throw new Error(`Invalid column: ${col}`);
          }
          if (f.op === "==") {
            params.push(f.value);
            return `"${col}" = ?`;
          }
          params.push(f.value);
          return `"${col}" ${sqlOp(f.op)} ?`;
        })
        .join(" AND ");
      sql += ` WHERE ${conditions}`;
    }

    if (this.sorts.length > 0) {
      const orderClauses = this.sorts.map((s) => {
        // Mirror the WHERE-clause alias mapping (full map) — otherwise
        // orderBy("customerId") emits ORDER BY "customerId" (no such column).
        const col = mapToColumn(s.field);
        if (!isValidColumn(this.table, col)) {
          throw new Error(`Invalid column: ${col}`);
        }
        return `"${col}" ${s.direction === "desc" ? "DESC" : "ASC"}`;
      });
      sql += ` ORDER BY ${orderClauses.join(", ")}`;
    }

    if (this.maxRows) {
      sql += ` LIMIT ${this.maxRows}`;
    }

    const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
    const primaryKey = primaryKeyByTable[this.table] || "id";
    return new SqliteQuerySnapshot(
      rows.map((row) => new SqliteDocSnapshot(this.table, String(row[primaryKey]), row)),
    );
  }

  private clone() {
    const next = new SqliteCollectionRef(this.table);
    next.filters = [...this.filters];
    next.sorts = [...this.sorts];
    next.maxRows = this.maxRows;
    return next;
  }
}

// ==========================================
// SqliteWriteBatch
// ==========================================
class SqliteWriteBatch {
  private operations: Array<() => void> = [];

  set(ref: SqliteDocRef, data: Record<string, unknown>, options?: { merge?: boolean }) {
    this.operations.push(() => ref.set(data, options));
  }

  update(ref: SqliteDocRef, data: Record<string, unknown>) {
    this.operations.push(() => ref.update(data));
  }

  commit() {
    const txn = db.transaction(() => {
      for (const op of this.operations) op();
    });
    txn();
  }
}

// ==========================================
// Factory
// ==========================================
export function createSqliteFirestoreAdapter() {
  return {
    async allocateCounter(ownerUid: string, namespace: string, minimumNext = 1) {
      return allocateSqliteCounter(db, ownerUid, namespace, minimumNext);
    },
    collection(table: string) {
      return new SqliteCollectionRef(table);
    },
    batch() {
      return new SqliteWriteBatch();
    },
  };
}
