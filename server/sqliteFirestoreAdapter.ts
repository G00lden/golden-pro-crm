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
  technician_notifications: "tn",
  quotes: "quote",
  invoices: "inv",
  crm_deals: "deal",
  crm_tasks: "task",
  crm_notes: "note",
  audit_logs: "audit",
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

function sqlOp(op: FilterOp): string {
  switch (op) {
    case "==": return "=";
    case "<=": return "<=";
    case ">=": return ">=";
    case "<": return "<";
    case ">": return ">";
  }
}

function isValidColumn(field: string): boolean {
  // Only allow known columns to prevent SQL injection
  const knownFields = [
    "owner_uid", "created_by", "created_at", "updated_at",
    "name", "phone", "city", "source", "notes",
    "email", "status", "date", "scheduled_time",
    "quote_number", "title", "issue_date", "valid_until", "follow_up_date",
    "subtotal", "discount", "tax", "total", "currency", "confirmed_at",
    "invoice_number", "quote_id", "customer_vat", "due_date", "paid_at",
    "payment_method", "vat", "vat_percent", "vat_amount",
    "total_without_vat", "total_with_vat", "seller_name", "seller_vat",
    "seller_vat_number", "seller_address", "qr_code",
    "stage", "amount", "probability", "expected_close", "assigned_to",
    "related_type", "related_id", "priority", "completed_at", "actor_uid",
    "action", "entity_type", "entity_id", "summary", "before_data", "after_data",
    "payment_method", "payment_down_percent", "payment_final_percent",
    "payment_down_text", "payment_final_text", "payment_bank",
    "payment_account", "payment_iban", "payment_note",
    "id", "customer_id", "customer_name", "customer_phone",
    "customer_city",
    "product_id", "product_name", "product_sku",
    "technician_id", "technician_name",
    "installation_id", "installation_label",
    "next_maintenance", "install_date", "completed_date",
    "remind_count", "next_remind_type", "last_remind_at",
    "label", "interval_months", "category", "sku",
    "remind_text", "product_type", "store_provider", "store_product_id",
    "price", "sale_price", "currency", "image_url", "stock_quantity",
    "store_status", "last_synced_at", "max_daily", "specialty",
    "booking_type", "booking_id", "store_order_id",
    "order_status", "installation_status",
    "event_type", "event_id", "raw_body", "processed", "error",
    "notification_type", "channel", "sent_at",
    "message", "techs", "jobs_per_tech", "response_rate", "maxDaily",
    "days_until",
  ];
  return knownFields.includes(field);
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
  lastSyncedAt: "last_synced_at",
  notificationType: "notification_type",
  orderStatus: "order_status",
  technicianPhone: "technician_phone",
  storeOrderNumber: "store_order_number",
  orderItemType: "order_item_type",
  sentAt: "sent_at",
  eventType: "event_type",
  eventId: "event_id",
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
  quoteId: "quote_id",
  invoiceId: "invoice_id",
  expectedClose: "expected_close",
  assignedTo: "assigned_to",
  relatedType: "related_type",
  relatedId: "related_id",
  completedAt: "completed_at",
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
};

const jsonColumns = new Set([
  "booking_ids",
  "installation_ids",
  "items",
  "metadata",
  "before_data",
  "after_data",
  "order_types",
  "permissions",
  "product_ids",
]);

function mapToColumn(key: string): string {
  return fieldToColumn[key] || key;
}

function serializeValue(value: unknown) {
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

function mapRecord(record: Record<string, unknown>): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue;
    const col = mapToColumn(key);
    // Skip 'id' for settings table (uses owner_uid as pk)
    if (col === "id" && record["owner_uid"]) continue;
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
    const mapped = mapRecord(data);
    if (existing && _options?.merge) {
      const merged = mapRecord({ ...existing, ...data });
      this._upsert(merged);
    } else {
      const record = { [pk]: this.id, ...mapped };
      this._upsert(record);
    }
  }

  async update(data: Record<string, unknown>) {
    const pk = this.primaryKey();
    const existing = this._getRaw();
    if (!existing) return;
    const mapped = mapRecord({ ...existing, ...data, updated_at: new Date().toISOString() });
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
    const record = mapRecord({ id: ref.id, ...data });
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
          // Map Firestore field names to SQL columns
          const col = f.field === "createdBy" ? "owner_uid"
            : f.field === "createdAt" ? "created_at"
            : f.field === "updatedAt" ? "updated_at"
            : f.field;
          if (!isValidColumn(col)) {
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
        const col = s.field === "createdBy" ? "owner_uid" : s.field;
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
    collection(table: string) {
      return new SqliteCollectionRef(table);
    },
    batch() {
      return new SqliteWriteBatch();
    },
  };
}
