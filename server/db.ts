import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { PUBLIC_LEAD_SCHEMA_SQL } from "./publicLeadStorage";
import { calculateDocumentTotals, normalizeVatPercent, type DiscountMode } from "../shared/financial";
import { verifiableInvoiceItems } from "../shared/invoiceItems";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "golden-crm.db");
const TARGET_SCHEMA_VERSION = 10308;
const databaseExistedBeforeStartup = fs.existsSync(DB_PATH);

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent performance
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const schemaVersionBeforeMigration = Number(db.pragma("user_version", { simple: true }) || 0);
if (
  process.env.NODE_ENV === "production" &&
  databaseExistedBeforeStartup &&
  schemaVersionBeforeMigration < TARGET_SCHEMA_VERSION
) {
  const backupDirectory = process.env.DB_MIGRATION_BACKUP_DIR || path.join(dataDir, "backups");
  fs.mkdirSync(backupDirectory, { recursive: true });
  db.pragma("wal_checkpoint(FULL)");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(
    backupDirectory,
    `${path.basename(DB_PATH)}.pre-schema-${TARGET_SCHEMA_VERSION}-${stamp}.bak`,
  );
  fs.copyFileSync(DB_PATH, backupPath, fs.constants.COPYFILE_EXCL);
  console.log(`SQLite pre-migration backup created: ${backupPath}`);
}

// ==========================================
// SCHEMA
// ==========================================
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    email TEXT UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'admin',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );`);

function hasUserColumn(column: string): boolean {
  const rows = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

if (!hasUserColumn("uid")) {
  db.exec("ALTER TABLE users ADD COLUMN uid TEXT");
}
if (!hasUserColumn("permissions")) {
  db.exec("ALTER TABLE users ADD COLUMN permissions TEXT DEFAULT '{}'");
}
if (!hasUserColumn("active")) {
  db.exec("ALTER TABLE users ADD COLUMN active INTEGER DEFAULT 1");
}
if (!hasUserColumn("last_login_at")) {
  db.exec("ALTER TABLE users ADD COLUMN last_login_at TEXT");
}
if (!hasUserColumn("provider")) {
  db.exec("ALTER TABLE users ADD COLUMN provider TEXT DEFAULT 'firebase'");
}

db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_uid ON users(uid) WHERE uid IS NOT NULL AND uid <> ''");
db.exec("CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)");

// store_orders needs imported_at to support storeWebhook orderBy and dedupe
// logic. Original SQLite schema relied on created_at; add the missing column.
function hasStoreOrderColumn(column: string): boolean {
  const rows = db.prepare("PRAGMA table_info(store_orders)").all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

// Lazy-create table first so PRAGMA works.
db.exec(`
  CREATE TABLE IF NOT EXISTS store_orders (
    id TEXT PRIMARY KEY,
    owner_uid TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

for (const col of [
  ["imported_at", "TEXT"],
  ["last_event_at", "TEXT"],
  ["status", "TEXT"],
  ["journey_status", "TEXT DEFAULT 'received'"],
  ["current_step", "TEXT"],
  ["order_id", "TEXT"],
  ["order_number", "TEXT"],
  ["order_date", "TEXT"],
  ["order_created_at", "TEXT"],
  ["order_timezone", "TEXT"],
  ["scheduled_date", "TEXT"],
  ["scheduled_time", "TEXT"],
  ["total", "NUMERIC"],
  ["provider", "TEXT DEFAULT 'salla'"],
  ["source", "TEXT DEFAULT 'salla'"],
  ["event_type", "TEXT"],
  ["items", "TEXT DEFAULT '[]'"],
  ["product_ids", "TEXT DEFAULT '[]'"],
  ["installation_ids", "TEXT DEFAULT '[]'"],
  ["booking_ids", "TEXT DEFAULT '[]'"],
  ["order_types", "TEXT DEFAULT '[]'"],
  ["customer_id", "TEXT"],
  ["remote_status_id", "TEXT"],
  ["remote_status_name", "TEXT"],
  ["remote_status_slug", "TEXT"],
  ["remote_updated_at", "TEXT"],
  ["remote_synced_at", "TEXT"],
  ["sync_origin", "TEXT"],
  ["remote_deleted_at", "TEXT"],
  ["payment_method", "TEXT"],
  ["shipping_company", "TEXT"],
  ["shipment_status", "TEXT"],
  ["country", "TEXT"],
  ["sales_channel", "TEXT"],
  ["assigned_employee", "TEXT"],
  ["pickup_branch", "TEXT"],
  ["order_tags", "TEXT DEFAULT '[]'"],
  ["is_read", "INTEGER"],
  ["is_price_quote", "INTEGER"],
  ["metadata_contract_version", "INTEGER DEFAULT 1"],
  // Columns that ONLY existed in the full CREATE TABLE below (line ~262). Because
  // the shell table above is created first, that CREATE ... IF NOT EXISTS is a
  // no-op, so on a fresh DB these were never created and every store-order
  // upsert threw "no such column: customer_name". Add them here so the ALTER
  // loop materialises the complete schema.
  ["store_order_id", "TEXT"],
  ["customer_name", "TEXT"],
  ["customer_phone", "TEXT"],
  ["customer_city", "TEXT"],
  ["product_name", "TEXT"],
  ["product_sku", "TEXT"],
  ["order_status", "TEXT"],
  ["installation_status", "TEXT DEFAULT 'pending'"],
  ["technician_id", "TEXT"],
  ["technician_name", "TEXT"],
  ["booking_id", "TEXT"],
  ["notes", "TEXT DEFAULT ''"],
] as const) {
  if (!hasStoreOrderColumn(col[0])) {
    db.exec(`ALTER TABLE store_orders ADD COLUMN ${col[0]} ${col[1]}`);
  }
}
db.exec("CREATE INDEX IF NOT EXISTS idx_store_orders_imported ON store_orders(imported_at)");
db.exec("CREATE INDEX IF NOT EXISTS idx_store_orders_owner_created ON store_orders(owner_uid, order_created_at DESC)");
db.exec("CREATE INDEX IF NOT EXISTS idx_store_orders_owner_status_created ON store_orders(owner_uid, remote_status_slug, order_created_at DESC)");

// Durable Salla order synchronization queues. The inbox makes incoming events
// replayable; commands provide an idempotent outbox for changes sent to Salla.
db.exec(`
  CREATE TABLE IF NOT EXISTS salla_order_inbox (
    id TEXT PRIMARY KEY,
    owner_uid TEXT NOT NULL,
    merchant_id TEXT,
    event_type TEXT NOT NULL DEFAULT '',
    remote_order_id TEXT,
    payload_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    received_at TEXT NOT NULL DEFAULT (datetime('now')),
    processed_at TEXT,
    next_attempt_at TEXT,
    error_code TEXT,
    error TEXT,
    lease_token TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS salla_order_commands (
    id TEXT PRIMARY KEY,
    owner_uid TEXT NOT NULL,
    order_doc_id TEXT NOT NULL,
    remote_order_id TEXT,
    command_type TEXT NOT NULL,
    desired_hash TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    before_hash TEXT,
    after_hash TEXT,
    result_status TEXT,
    last_error TEXT,
    actor_uid TEXT,
    lease_token TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_salla_order_inbox_owner_status
    ON salla_order_inbox(owner_uid, status, received_at);
  CREATE INDEX IF NOT EXISTS idx_salla_order_inbox_due
    ON salla_order_inbox(status, next_attempt_at, received_at);
  CREATE INDEX IF NOT EXISTS idx_salla_order_inbox_remote_order
    ON salla_order_inbox(owner_uid, remote_order_id, received_at);

  CREATE INDEX IF NOT EXISTS idx_salla_order_commands_owner_status
    ON salla_order_commands(owner_uid, status, created_at);
  CREATE INDEX IF NOT EXISTS idx_salla_order_commands_due
    ON salla_order_commands(status, updated_at, created_at);
  CREATE INDEX IF NOT EXISTS idx_salla_order_commands_order
    ON salla_order_commands(owner_uid, order_doc_id, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_salla_order_commands_desired_hash
    ON salla_order_commands(owner_uid, order_doc_id, command_type, desired_hash)
    WHERE desired_hash <> '';
`);

for (const table of ["salla_order_inbox", "salla_order_commands"] as const) {
  if (!hasColumn(table, "lease_token")) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN lease_token TEXT`);
  }
}

// bookings + technician_notifications were created with a minimal column set.
// bookingLifecycle / bookingNotifications write to richer columns; the missing
// ones are added AFTER the main schema block below (so the tables exist first —
// running these ALTERs here would fail "no such table" on a fresh database).
function hasColumn(table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

// Admin escalation queue — populated by reminderEngine when a customer goes
// silent past 3 reminders. Distinct from the audit log in maintenance_history.
db.exec(`
  CREATE TABLE IF NOT EXISTS escalations (
    id TEXT PRIMARY KEY,
    installation_id TEXT,
    customer_id TEXT,
    customer_name TEXT,
    customer_phone TEXT,
    product_name TEXT,
    original_maintenance_date TEXT,
    remind_count INTEGER DEFAULT 0,
    last_reminded_at TEXT,
    status TEXT DEFAULT 'active',
    assigned_to TEXT,
    notes TEXT DEFAULT '',
    resolved_at TEXT,
    resolved_by TEXT,
    owner_uid TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_escalations_owner ON escalations(owner_uid, status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_escalations_installation ON escalations(installation_id);
  CREATE INDEX IF NOT EXISTS idx_escalations_status ON escalations(status);
`);

db.exec(`

  CREATE TABLE IF NOT EXISTS settings (
    owner_uid TEXT PRIMARY KEY,
    techs INTEGER DEFAULT 3,
    jobs_per_tech INTEGER DEFAULT 4,
    response_rate INTEGER DEFAULT 50,
    max_daily INTEGER DEFAULT 24,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    owner_uid TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    city TEXT DEFAULT '',
    source TEXT DEFAULT 'manual',
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    owner_uid TEXT NOT NULL,
    name TEXT NOT NULL,
    interval_months INTEGER DEFAULT 1,
    category TEXT DEFAULT '',
    sku TEXT DEFAULT '',
    remind_text TEXT DEFAULT '',
    source TEXT DEFAULT 'manual',
    store_provider TEXT,
    store_product_id TEXT,
    price NUMERIC,
    sale_price NUMERIC,
    currency TEXT DEFAULT 'SAR',
    image_url TEXT,
    image_urls TEXT DEFAULT '[]',
    stock_quantity NUMERIC,
    store_status TEXT,
    description TEXT DEFAULT '',
    store_url TEXT,
    store_admin_url TEXT,
    store_product_type TEXT,
    categories TEXT DEFAULT '[]',
    variants TEXT DEFAULT '[]',
    catalog_visible INTEGER DEFAULT 1,
    is_available INTEGER DEFAULT 1,
    merged_into TEXT,
    merged_at TEXT,
    unlimited_quantity INTEGER DEFAULT 0,
    last_synced_at TEXT,
    product_type TEXT DEFAULT 'install_maintenance',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS installations (
    id TEXT PRIMARY KEY,
    owner_uid TEXT NOT NULL,
    customer_id TEXT,
    customer_name TEXT,
    customer_phone TEXT,
    product_id TEXT,
    product_name TEXT,
    product_sku TEXT,
    label TEXT DEFAULT '',
    install_date TEXT,
    next_maintenance TEXT,
    remind_count INTEGER DEFAULT 0,
    next_remind_type TEXT DEFAULT 'first',
    status TEXT DEFAULT 'active',
    completed_date TEXT,
    last_remind_at TEXT,
    last_remind_attempt_at TEXT,
    source TEXT DEFAULT 'manual',
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS technicians (
    id TEXT PRIMARY KEY,
    owner_uid TEXT NOT NULL,
    name TEXT NOT NULL,
    phone TEXT DEFAULT '',
    specialty TEXT DEFAULT '',
    max_daily INTEGER DEFAULT 4,
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id TEXT PRIMARY KEY,
    owner_uid TEXT NOT NULL,
    installation_id TEXT,
    customer_id TEXT,
    customer_name TEXT,
    customer_phone TEXT,
    product_id TEXT,
    product_name TEXT,
    technician_id TEXT,
    tech_name TEXT,
    date TEXT,
    scheduled_time TEXT,
    status TEXT DEFAULT 'confirmed',
    booking_type TEXT DEFAULT 'maintenance',
    source TEXT DEFAULT 'manual',
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS reminders (
    id TEXT PRIMARY KEY,
    owner_uid TEXT NOT NULL,
    customer_id TEXT,
    customer_phone TEXT,
    customer_name TEXT,
    installation_id TEXT,
    installation_label TEXT,
    product_id TEXT,
    product_name TEXT,
    remind_type TEXT,
    status TEXT DEFAULT 'pending',
    trigger TEXT,
    sent_at TEXT DEFAULT (datetime('now')),
    message TEXT DEFAULT '',
    error TEXT,
    whatsapp_jid TEXT,
    whatsapp_message_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS store_orders (
    id TEXT PRIMARY KEY,
    owner_uid TEXT NOT NULL,
    store_order_id TEXT,
    customer_name TEXT,
    customer_phone TEXT,
    customer_city TEXT,
    product_name TEXT,
    product_sku TEXT,
    order_status TEXT,
    installation_status TEXT DEFAULT 'pending',
    technician_id TEXT,
    technician_name TEXT,
    booking_id TEXT,
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS store_webhook_events (
    id TEXT PRIMARY KEY,
    owner_uid TEXT,
    event_type TEXT,
    event_id TEXT,
    raw_body TEXT,
    processed INTEGER DEFAULT 0,
    error TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS technician_notifications (
    id TEXT PRIMARY KEY,
    technician_id TEXT,
    technician_phone TEXT,
    booking_id TEXT,
    notification_type TEXT,
    channel TEXT DEFAULT 'whatsapp',
    status TEXT DEFAULT 'pending',
    sent_at TEXT,
    error TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Indexes
  CREATE INDEX IF NOT EXISTS idx_customers_owner ON customers(owner_uid);
  CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
  CREATE INDEX IF NOT EXISTS idx_products_owner ON products(owner_uid);
  CREATE INDEX IF NOT EXISTS idx_installations_owner ON installations(owner_uid);
  CREATE INDEX IF NOT EXISTS idx_installations_next ON installations(next_maintenance);
  CREATE INDEX IF NOT EXISTS idx_installations_status ON installations(status);
  CREATE INDEX IF NOT EXISTS idx_technicians_owner ON technicians(owner_uid);
  CREATE INDEX IF NOT EXISTS idx_bookings_owner ON bookings(owner_uid);
  CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(date);
  CREATE INDEX IF NOT EXISTS idx_reminders_owner ON reminders(owner_uid);
  CREATE INDEX IF NOT EXISTS idx_reminders_sent ON reminders(sent_at);
  CREATE INDEX IF NOT EXISTS idx_store_orders_owner ON store_orders(owner_uid);

  -- WhatsApp message log: every outbound template/text + every inbound message
  -- and delivery/read receipt. Powers GET /api/whatsapp/conversations/:phone.
  CREATE TABLE IF NOT EXISTS whatsapp_messages (
    id TEXT PRIMARY KEY,
    type TEXT,
    provider TEXT,
    from_phone TEXT,
    to_phone TEXT,
    message TEXT,
    template_name TEXT,
    message_id TEXT,
    status TEXT,
    direction TEXT,
    installation_id TEXT,
    booking_id TEXT,
    owner_uid TEXT,
    metadata TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_wa_messages_phone ON whatsapp_messages(from_phone, to_phone);
  CREATE INDEX IF NOT EXISTS idx_wa_messages_owner ON whatsapp_messages(owner_uid, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_wa_messages_msgid ON whatsapp_messages(message_id);
  CREATE INDEX IF NOT EXISTS idx_wa_messages_installation ON whatsapp_messages(installation_id);

  -- Maintenance lifecycle history: append-only audit trail (created, completed,
  -- rescheduled, cancelled, reminded, confirmed). Drives getMaintenanceTimeline.
  CREATE TABLE IF NOT EXISTS maintenance_history (
    id TEXT PRIMARY KEY,
    installation_id TEXT,
    customer_id TEXT,
    action TEXT,
    old_value TEXT,
    new_value TEXT,
    performed_by TEXT,
    notes TEXT,
    metadata TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_maint_history_installation ON maintenance_history(installation_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_maint_history_customer ON maintenance_history(customer_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS quotes (
    id TEXT PRIMARY KEY,
    owner_uid TEXT NOT NULL,
    quote_number TEXT NOT NULL,
    customer_id TEXT,
    customer_name TEXT NOT NULL DEFAULT '',
    customer_phone TEXT DEFAULT '',
    customer_city TEXT DEFAULT '',
    customer_vat TEXT DEFAULT '',
    title TEXT DEFAULT '',
    status TEXT DEFAULT 'issued',
    issue_date TEXT DEFAULT (date('now')),
    valid_until TEXT,
    follow_up_date TEXT,
    subtotal NUMERIC DEFAULT 0,
    discount NUMERIC DEFAULT 0,
    discount_mode TEXT DEFAULT 'fixed',
    discount_value NUMERIC DEFAULT 0,
    tax NUMERIC DEFAULT 0,
    vat_percent NUMERIC DEFAULT 15,
    vat_amount NUMERIC DEFAULT 0,
    total_without_vat NUMERIC DEFAULT 0,
    total NUMERIC DEFAULT 0,
    currency TEXT DEFAULT 'SAR',
    payment_method TEXT DEFAULT 'تحويل بنكي',
    payment_down_percent NUMERIC DEFAULT 70,
    payment_final_percent NUMERIC DEFAULT 30,
    payment_down_text TEXT DEFAULT '',
    payment_final_text TEXT DEFAULT '',
    payment_bank TEXT DEFAULT '',
    payment_account TEXT DEFAULT '',
    payment_iban TEXT DEFAULT '',
    payment_note TEXT DEFAULT '',
    installments TEXT DEFAULT '[]',
    items TEXT DEFAULT '[]',
    notes TEXT DEFAULT '',
    terms TEXT DEFAULT '',
    confirmed_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_quotes_owner ON quotes(owner_uid, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes(owner_uid, status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_quotes_follow_up ON quotes(owner_uid, follow_up_date);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_quotes_owner_number ON quotes(owner_uid, quote_number);

  CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY,
    owner_uid TEXT NOT NULL,
    invoice_number TEXT NOT NULL DEFAULT '',
    document_kind TEXT NOT NULL DEFAULT 'invoice' CHECK(document_kind IN ('invoice', 'credit_note')),
    sequence_no INTEGER CHECK(sequence_no IS NULL OR sequence_no BETWEEN 1 AND 9007199254740991),
    issued_at TEXT,
    source_invoice_id TEXT,
    adjustment_kind TEXT CHECK(adjustment_kind IS NULL OR adjustment_kind IN ('cancellation', 'refund')),
    adjustment_scope TEXT CHECK(adjustment_scope IS NULL OR adjustment_scope IN ('full', 'partial')),
    adjustment_reason TEXT,
    idempotency_key TEXT CHECK(idempotency_key IS NULL OR TRIM(idempotency_key) <> ''),
    quote_id TEXT,
    customer_id TEXT,
    customer_name TEXT NOT NULL DEFAULT '',
    customer_phone TEXT DEFAULT '',
    customer_city TEXT DEFAULT '',
    customer_vat TEXT DEFAULT '',
    title TEXT DEFAULT '',
    status TEXT DEFAULT 'issued',
    issue_date TEXT DEFAULT (date('now')),
    due_date TEXT,
    paid_at TEXT,
    payment_method TEXT DEFAULT '',
    subtotal NUMERIC DEFAULT 0,
    discount NUMERIC DEFAULT 0,
    discount_mode TEXT DEFAULT 'fixed',
    discount_value NUMERIC DEFAULT 0,
    vat NUMERIC DEFAULT 0,
    vat_percent NUMERIC DEFAULT 15,
    vat_amount NUMERIC DEFAULT 0,
    additional_fee NUMERIC DEFAULT 0,
    total_without_vat NUMERIC DEFAULT 0,
    total_with_vat NUMERIC DEFAULT 0,
    currency TEXT DEFAULT 'SAR',
    items TEXT DEFAULT '[]',
    notes TEXT DEFAULT '',
    terms TEXT DEFAULT '',
    seller_name TEXT DEFAULT '',
    seller_vat TEXT DEFAULT '',
    seller_vat_number TEXT DEFAULT '',
    seller_address TEXT DEFAULT '',
    invoice_type TEXT DEFAULT '',
    qr_code TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_invoices_owner ON invoices(owner_uid, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(owner_uid, status, created_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_owner_number ON invoices(owner_uid, invoice_number);

  CREATE TABLE IF NOT EXISTS invoice_sequences (
    owner_uid TEXT NOT NULL,
    series TEXT NOT NULL,
    last_value INTEGER NOT NULL CHECK(last_value BETWEEN 0 AND 9007199254740991),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(owner_uid, series)
  );

  CREATE TABLE IF NOT EXISTS crm_deals (
    id TEXT PRIMARY KEY,
    owner_uid TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    customer_id TEXT,
    customer_name TEXT DEFAULT '',
    customer_phone TEXT DEFAULT '',
    stage TEXT DEFAULT 'lead',
    amount NUMERIC DEFAULT 0,
    currency TEXT DEFAULT 'SAR',
    probability INTEGER DEFAULT 10,
    expected_close TEXT,
    assigned_to TEXT,
    source TEXT DEFAULT 'manual',
    quote_id TEXT,
    invoice_id TEXT,
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_crm_deals_owner_stage ON crm_deals(owner_uid, stage, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_crm_deals_customer ON crm_deals(owner_uid, customer_id);

  CREATE TABLE IF NOT EXISTS crm_tasks (
    id TEXT PRIMARY KEY,
    owner_uid TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    status TEXT DEFAULT 'open',
    priority TEXT DEFAULT 'normal',
    due_date TEXT,
    assigned_to TEXT,
    related_type TEXT,
    related_id TEXT,
    customer_id TEXT,
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_crm_tasks_owner_status ON crm_tasks(owner_uid, status, due_date);
  CREATE INDEX IF NOT EXISTS idx_crm_tasks_customer ON crm_tasks(owner_uid, customer_id);

  CREATE TABLE IF NOT EXISTS crm_notes (
    id TEXT PRIMARY KEY,
    owner_uid TEXT NOT NULL,
    customer_id TEXT,
    body TEXT NOT NULL DEFAULT '',
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_crm_notes_customer ON crm_notes(owner_uid, customer_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    owner_uid TEXT NOT NULL,
    actor_uid TEXT,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    summary TEXT DEFAULT '',
    before_data TEXT,
    after_data TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_audit_logs_owner ON audit_logs(owner_uid, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(owner_uid, entity_type, entity_id, created_at DESC);

  -- ===========================================================================
  -- Telephony / IVR call-routing (Unifonic). A published "main number" plays an
  -- IVR menu; the caller's DTMF digit selects a department; the call is forwarded
  -- to that department's agent. On no-answer the missed-call flow fires WhatsApp
  -- to both the customer and the agent. See server/ivrEngine.ts.
  -- ===========================================================================

  -- Per-owner telephony settings (the advertised number, greeting, ring timeout).
  CREATE TABLE IF NOT EXISTS telephony_config (
    owner_uid TEXT PRIMARY KEY,
    provider TEXT DEFAULT 'unifonic',
    main_number TEXT DEFAULT '',
    greeting TEXT DEFAULT '',
    menu_prompt TEXT DEFAULT '',
    ring_timeout_sec INTEGER DEFAULT 20,
    enabled INTEGER DEFAULT 1,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- IVR menu departments: one row per DTMF digit (e.g. 1 = المبيعات).
  CREATE TABLE IF NOT EXISTS ivr_departments (
    id TEXT PRIMARY KEY,
    owner_uid TEXT NOT NULL,
    digit TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    ring_timeout_sec INTEGER DEFAULT 20,
    active INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_ivr_dept_owner_digit ON ivr_departments(owner_uid, digit);
  CREATE INDEX IF NOT EXISTS idx_ivr_dept_owner ON ivr_departments(owner_uid, sort_order);

  -- Agents (employees) reachable for a department. Multiple agents per department
  -- are tried in sort_order — the first active agent receives the forward today;
  -- the ordering is also the basis for sequential/round-robin routing later.
  CREATE TABLE IF NOT EXISTS ivr_department_agents (
    id TEXT PRIMARY KEY,
    department_id TEXT NOT NULL,
    owner_uid TEXT NOT NULL,
    user_id TEXT,
    name TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ivr_agents_dept ON ivr_department_agents(department_id, sort_order);
  CREATE INDEX IF NOT EXISTS idx_ivr_agents_owner ON ivr_department_agents(owner_uid);

  -- One row per inbound call. Tracks the IVR selection, the forward target, the
  -- final status, and whether the missed-call WhatsApp messages were sent.
  CREATE TABLE IF NOT EXISTS call_logs (
    id TEXT PRIMARY KEY,
    owner_uid TEXT NOT NULL,
    provider TEXT DEFAULT 'unifonic',
    call_sid TEXT,
    from_phone TEXT,
    to_phone TEXT,
    department_id TEXT,
    department_name TEXT,
    selected_digit TEXT,
    agent_user_id TEXT,
    agent_phone TEXT,
    agent_name TEXT,
    status TEXT DEFAULT 'ringing',
    missed INTEGER DEFAULT 0,
    wa_customer_notified INTEGER DEFAULT 0,
    wa_agent_notified INTEGER DEFAULT 0,
    forwarded_at TEXT,
    ended_at TEXT,
    duration_sec INTEGER DEFAULT 0,
    metadata TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_call_logs_owner ON call_logs(owner_uid, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_call_logs_sid ON call_logs(call_sid);
  CREATE INDEX IF NOT EXISTS idx_call_logs_missed ON call_logs(owner_uid, missed, created_at DESC);

  -- Self-hosted phone gateway outbox. When a reply must go out as SMS (because
  -- WhatsApp isn't connected), it is queued here; the user's Android automation
  -- app (MacroDroid/Tasker) polls GET /api/gateway/outbox, sends each SMS from
  -- the company SIM, then acks them. No external provider involved.
  CREATE TABLE IF NOT EXISTS gateway_outbox (
    id TEXT PRIMARY KEY,
    owner_uid TEXT NOT NULL,
    to_phone TEXT NOT NULL,
    body TEXT NOT NULL,
    role TEXT DEFAULT 'customer',
    channel TEXT DEFAULT 'sms',
    status TEXT DEFAULT 'pending',
    call_id TEXT,
    error TEXT,
    attempts INTEGER DEFAULT 0,
    lease_until TEXT,
    device_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    sent_at TEXT,
    updated_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_gateway_outbox_pending ON gateway_outbox(owner_uid, status, created_at);

  -- Contacts discovered by the phone/telephony gateway are kept in CRM and
  -- synchronised back to the paired Android phone. A durable outbox prevents
  -- contacts from being lost while the phone is offline.
  CREATE TABLE IF NOT EXISTS gateway_contact_outbox (
    id TEXT PRIMARY KEY,
    owner_uid TEXT NOT NULL,
    customer_id TEXT NOT NULL,
    phone TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    saved_at TEXT,
    UNIQUE(owner_uid, customer_id)
  );
  CREATE INDEX IF NOT EXISTS idx_gateway_contact_pending
    ON gateway_contact_outbox(owner_uid, status, created_at);

  -- Durable inbound event ledger. Provider retries are accepted once and every
  -- downstream side effect uses the same idempotency key.
  CREATE TABLE IF NOT EXISTS communication_events (
    id TEXT PRIMARY KEY,
    owner_uid TEXT NOT NULL,
    provider TEXT NOT NULL,
    event_id TEXT NOT NULL,
    event_type TEXT DEFAULT '',
    payload_hash TEXT DEFAULT '',
    processed_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(owner_uid, provider, event_id)
  );
  CREATE INDEX IF NOT EXISTS idx_communication_events_owner_created
    ON communication_events(owner_uid, created_at DESC);

  -- Durable outbound queue. Workers claim jobs with a lease, retry transient
  -- failures and stop at max_attempts instead of losing webhook-triggered sends.
  CREATE TABLE IF NOT EXISTS communication_jobs (
    id TEXT PRIMARY KEY,
    owner_uid TEXT NOT NULL,
    event_key TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'whatsapp_template',
    channel TEXT NOT NULL DEFAULT 'whatsapp',
    recipient_phone TEXT NOT NULL,
    template_name TEXT,
    payload TEXT NOT NULL DEFAULT '{}',
    role TEXT DEFAULT 'customer',
    call_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    available_at TEXT NOT NULL DEFAULT (datetime('now')),
    lease_until TEXT,
    last_error TEXT,
    provider_message_id TEXT,
    expires_at TEXT,
    sent_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(owner_uid, event_key)
  );
  CREATE INDEX IF NOT EXISTS idx_communication_jobs_ready
    ON communication_jobs(status, available_at, lease_until, created_at);
  CREATE INDEX IF NOT EXISTS idx_communication_jobs_owner
    ON communication_jobs(owner_uid, created_at DESC);

  -- Explicit marketing consent. Absence of a granted row means the recipient
  -- is not eligible for campaign messages (fail closed).
  CREATE TABLE IF NOT EXISTS communication_preferences (
    owner_uid TEXT NOT NULL,
    phone TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'whatsapp',
    purpose TEXT NOT NULL DEFAULT 'marketing',
    status TEXT NOT NULL DEFAULT 'unknown',
    source TEXT NOT NULL DEFAULT 'manual',
    evidence TEXT NOT NULL DEFAULT '',
    captured_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY(owner_uid, phone, channel, purpose)
  );
  CREATE INDEX IF NOT EXISTS idx_communication_preferences_status
    ON communication_preferences(owner_uid, channel, purpose, status, updated_at DESC);

  -- Suppression is independent of consent: once an opt-out is active it wins
  -- over every audience rule and is rechecked immediately before send.
  CREATE TABLE IF NOT EXISTS communication_suppressions (
    id TEXT PRIMARY KEY,
    owner_uid TEXT NOT NULL,
    phone TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'whatsapp',
    reason TEXT NOT NULL DEFAULT 'opt_out',
    source TEXT NOT NULL DEFAULT 'inbound',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    lifted_at TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_communication_suppressions_active
    ON communication_suppressions(owner_uid, phone, channel) WHERE active = 1;

  CREATE TABLE IF NOT EXISTS communication_campaigns (
    id TEXT PRIMARY KEY,
    owner_uid TEXT NOT NULL,
    name TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'whatsapp',
    template_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    audience_filter TEXT NOT NULL DEFAULT '{}',
    template_vars TEXT NOT NULL DEFAULT '{}',
    scheduled_at TEXT,
    rate_limit_per_minute INTEGER NOT NULL DEFAULT 30,
    frequency_cap_days INTEGER NOT NULL DEFAULT 7,
    created_by TEXT,
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_communication_campaigns_owner
    ON communication_campaigns(owner_uid, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_communication_campaigns_due
    ON communication_campaigns(status, scheduled_at);

  CREATE TABLE IF NOT EXISTS communication_campaign_recipients (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL,
    owner_uid TEXT NOT NULL,
    customer_id TEXT,
    phone TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'eligible',
    skip_reason TEXT,
    job_id TEXT,
    provider_message_id TEXT,
    sent_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(campaign_id, phone)
  );
  CREATE INDEX IF NOT EXISTS idx_campaign_recipients_campaign
    ON communication_campaign_recipients(campaign_id, status, created_at);
  CREATE INDEX IF NOT EXISTS idx_campaign_recipients_owner_phone
    ON communication_campaign_recipients(owner_uid, phone, sent_at DESC);

  -- Short-lived, one-time codes used to pair an Android phone without copying
  -- the server-wide legacy token into the app.
  CREATE TABLE IF NOT EXISTS gateway_pairing_codes (
    id TEXT PRIMARY KEY,
    owner_uid TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_gateway_pairing_active
    ON gateway_pairing_codes(code_hash, used_at, expires_at);
  CREATE INDEX IF NOT EXISTS idx_gateway_pairing_owner
    ON gateway_pairing_codes(owner_uid, created_at DESC);

  -- Each paired phone has an independently revocable credential. Only the
  -- HMAC fingerprint is persisted; the clear token is returned once at pairing.
  CREATE TABLE IF NOT EXISTS gateway_devices (
    id TEXT PRIMARY KEY,
    owner_uid TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    company_number TEXT NOT NULL DEFAULT '',
    token_hash TEXT NOT NULL,
    pairing_code_id TEXT,
    pairing_nonce_hash TEXT,
    last_seen_at TEXT,
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    revoked_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_gateway_devices_owner
    ON gateway_devices(owner_uid, revoked_at, created_at DESC);

  -- Tap payment gateway (online card/Apple Pay/STC Pay payments on invoices).
  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    owner_uid TEXT NOT NULL,
    invoice_id TEXT,
    idempotency_key TEXT,
    lease_token TEXT,
    reservation_expires_at TEXT,
    tap_charge_id TEXT,
    amount NUMERIC NOT NULL,
    currency TEXT DEFAULT 'SAR',
    status TEXT DEFAULT 'pending',
    redirect_url TEXT,
    tap_response TEXT,
    webhook_data TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);
  CREATE INDEX IF NOT EXISTS idx_payments_charge ON payments(tap_charge_id);
`);

for (const col of [
  ["idempotency_key", "TEXT"],
  ["lease_token", "TEXT"],
  ["reservation_expires_at", "TEXT"],
] as const) {
  if (!hasColumn("payments", col[0])) {
    db.exec(`ALTER TABLE payments ADD COLUMN ${col[0]} ${col[1]}`);
  }
}
// Preserve the newest legacy in-flight row if an older release allowed more
// than one pending payment for the same invoice, then enforce one reservation.
for (const [column, definition] of [
  ["pairing_code_id", "TEXT"],
  ["pairing_nonce_hash", "TEXT"],
] as const) {
  if (!hasColumn("gateway_devices", column)) {
    db.exec(`ALTER TABLE gateway_devices ADD COLUMN ${column} ${definition}`);
  }
}
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_gateway_device_pair_nonce
    ON gateway_devices(pairing_code_id, pairing_nonce_hash)
    WHERE pairing_code_id IS NOT NULL AND pairing_nonce_hash IS NOT NULL
`);
db.exec(`
  UPDATE payments
  SET status = 'failed', updated_at = datetime('now')
  WHERE status IN ('creating', 'pending')
    AND rowid NOT IN (
      SELECT MAX(rowid)
      FROM payments
      WHERE status IN ('creating', 'pending')
      GROUP BY owner_uid, invoice_id
    );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_owner_idempotency
    ON payments(owner_uid, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_one_inflight_per_invoice
    ON payments(owner_uid, invoice_id)
    WHERE status IN ('creating', 'pending');
`);

// Public landing-page enquiries are deliberately isolated from authenticated
// CRM customers. This additive CREATE TABLE is safe for existing databases and
// runs before the public route can accept traffic.
db.exec(PUBLIC_LEAD_SCHEMA_SQL);

// Post-schema column migrations. These run AFTER the main schema block above,
// so every referenced table is guaranteed to exist (fixes "no such table" on a
// fresh database).
// The store webhook moved from the original minimal event ledger to a richer
// Firestore-shaped record. Keep SQLite additive so both fresh and existing QA
// databases can persist the exact fields processStoreWebhook writes.
for (const col of [
  ["provider", "TEXT"],
  ["order_id", "TEXT"],
  ["order_number", "TEXT"],
  ["status", "TEXT DEFAULT 'processing'"],
  ["auth_mode", "TEXT"],
  ["received_at", "TEXT"],
  ["raw_payload", "TEXT"],
  ["processed_at", "TEXT"],
  ["imported", "TEXT"],
] as const) {
  if (!hasColumn("store_webhook_events", col[0])) {
    db.exec(`ALTER TABLE store_webhook_events ADD COLUMN ${col[0]} ${col[1]}`);
  }
}
db.exec("CREATE INDEX IF NOT EXISTS idx_store_webhook_events_owner_received ON store_webhook_events(owner_uid, received_at DESC)");

for (const col of [
  ["completed_at", "TEXT"],
  ["store_order_id", "TEXT"],
  ["store_order_number", "TEXT"],
  ["confirmed_by_technician", "INTEGER DEFAULT 0"],
  ["technician_confirmed_at", "TEXT"],
  ["technician_reminded_at", "TEXT"],
] as const) {
  if (!hasColumn("bookings", col[0])) {
    db.exec(`ALTER TABLE bookings ADD COLUMN ${col[0]} ${col[1]}`);
  }
}

// Reminder delivery records are written through the Firestore-shaped adapter.
// Keep these columns additive because production databases created before
// 1.3.6 have the original, smaller reminders table.
for (const col of [
  ["product_id", "TEXT"],
  ["trigger", "TEXT"],
  ["error", "TEXT"],
  ["whatsapp_jid", "TEXT"],
  ["whatsapp_message_id", "TEXT"],
] as const) {
  if (!hasColumn("reminders", col[0])) {
    db.exec(`ALTER TABLE reminders ADD COLUMN ${col[0]} ${col[1]}`);
  }
}

for (const col of [
  ["campaign_id", "TEXT"],
  ["campaign_recipient_id", "TEXT"],
] as const) {
  if (!hasColumn("communication_jobs", col[0])) {
    db.exec(`ALTER TABLE communication_jobs ADD COLUMN ${col[0]} ${col[1]}`);
  }
}
db.exec("CREATE INDEX IF NOT EXISTS idx_communication_jobs_campaign ON communication_jobs(campaign_id, status, created_at)");

for (const col of [
  ["owner_uid", "TEXT"],
  ["technician_name", "TEXT"],
  ["customer_id", "TEXT"],
  ["customer_name", "TEXT"],
  ["customer_phone", "TEXT"],
  ["product_id", "TEXT"],
  ["product_name", "TEXT"],
  ["message", "TEXT"],
  ["trigger", "TEXT"],
  ["whatsapp_jid", "TEXT"],
  ["whatsapp_message_id", "TEXT"],
  ["whatsapp_provider", "TEXT"],
] as const) {
  if (!hasColumn("technician_notifications", col[0])) {
    db.exec(`ALTER TABLE technician_notifications ADD COLUMN ${col[0]} ${col[1]}`);
  }
}

for (const col of [
  ["store_provider", "TEXT"],
  ["store_product_id", "TEXT"],
  ["price", "NUMERIC"],
  ["sale_price", "NUMERIC"],
  ["currency", "TEXT DEFAULT 'SAR'"],
  ["image_url", "TEXT"],
  ["image_urls", "TEXT DEFAULT '[]'"],
  ["stock_quantity", "NUMERIC"],
  ["store_status", "TEXT"],
  ["description", "TEXT DEFAULT ''"],
  ["store_url", "TEXT"],
  ["store_admin_url", "TEXT"],
  ["store_product_type", "TEXT"],
  ["categories", "TEXT DEFAULT '[]'"],
  ["variants", "TEXT DEFAULT '[]'"],
  ["catalog_visible", "INTEGER DEFAULT 1"],
  ["is_available", "INTEGER DEFAULT 1"],
  ["merged_into", "TEXT"],
  ["merged_at", "TEXT"],
  ["unlimited_quantity", "INTEGER DEFAULT 0"],
  ["last_synced_at", "TEXT"],
] as const) {
  if (!hasColumn("products", col[0])) {
    db.exec(`ALTER TABLE products ADD COLUMN ${col[0]} ${col[1]}`);
  }
}
db.exec("CREATE INDEX IF NOT EXISTS idx_products_store_product ON products(owner_uid, store_provider, store_product_id)");

// Round-robin pointer for distributing calls across a department's agents.
if (!hasColumn("ivr_departments", "rr_counter")) {
  db.exec("ALTER TABLE ivr_departments ADD COLUMN rr_counter INTEGER DEFAULT 0");
}

// Call lifecycle: recognized customer + agent acknowledgement / handled state.
for (const col of [
  ["customer_id", "TEXT"],
  ["customer_name", "TEXT"],
  ["handled", "INTEGER DEFAULT 0"],
  ["handled_at", "TEXT"],
  ["handled_by", "TEXT"],
  ["correlation_key", "TEXT"],
  ["wa_customer_job_id", "TEXT"],
  ["wa_agent_job_id", "TEXT"],
  ["wa_customer_status", "TEXT"],
  ["wa_agent_status", "TEXT"],
] as const) {
  if (!hasColumn("call_logs", col[0])) {
    db.exec(`ALTER TABLE call_logs ADD COLUMN ${col[0]} ${col[1]}`);
  }
}
db.exec("CREATE INDEX IF NOT EXISTS idx_call_logs_handled ON call_logs(owner_uid, handled, created_at DESC)");
db.exec("CREATE INDEX IF NOT EXISTS idx_call_logs_correlation ON call_logs(owner_uid, correlation_key, created_at DESC)");

for (const col of [
  ["attempts", "INTEGER DEFAULT 0"],
  ["lease_until", "TEXT"],
  ["device_id", "TEXT"],
  ["updated_at", "TEXT"],
] as const) {
  if (!hasColumn("gateway_outbox", col[0])) {
    db.exec(`ALTER TABLE gateway_outbox ADD COLUMN ${col[0]} ${col[1]}`);
  }
}

// Backfill contacts created from phone calls before Android contact sync was
// introduced. INSERT OR IGNORE makes every application startup idempotent.
db.exec(`
  INSERT OR IGNORE INTO gateway_contact_outbox
    (id, owner_uid, customer_id, phone, name, status, created_at)
  SELECT 'gct_' || lower(hex(randomblob(10))), owner_uid, id, phone, name, 'pending', created_at
  FROM customers
  WHERE source = 'phone_call' AND TRIM(phone) <> ''
`);

for (const col of [
  ["customer_vat", "TEXT DEFAULT ''"],
  ["discount_mode", "TEXT DEFAULT 'fixed'"],
  ["discount_value", "NUMERIC DEFAULT 0"],
  ["vat_percent", "NUMERIC DEFAULT 15"],
  ["vat_amount", "NUMERIC DEFAULT 0"],
  ["total_without_vat", "NUMERIC DEFAULT 0"],
  ["payment_method", "TEXT DEFAULT 'تحويل بنكي'"],
  ["payment_down_percent", "NUMERIC DEFAULT 70"],
  ["payment_final_percent", "NUMERIC DEFAULT 30"],
  ["payment_down_text", "TEXT DEFAULT ''"],
  ["payment_final_text", "TEXT DEFAULT ''"],
  ["payment_bank", "TEXT DEFAULT ''"],
  ["payment_account", "TEXT DEFAULT ''"],
  ["payment_iban", "TEXT DEFAULT ''"],
  ["payment_note", "TEXT DEFAULT ''"],
  ["installments", "TEXT DEFAULT '[]'"],
] as const) {
  if (!hasColumn("quotes", col[0])) {
    db.exec(`ALTER TABLE quotes ADD COLUMN ${col[0]} ${col[1]}`);
  }
}

for (const col of [
  ["invoice_number", "TEXT NOT NULL DEFAULT ''"],
  ["document_kind", "TEXT NOT NULL DEFAULT 'invoice' CHECK(document_kind IN ('invoice', 'credit_note'))"],
  ["sequence_no", "INTEGER CHECK(sequence_no IS NULL OR sequence_no BETWEEN 1 AND 9007199254740991)"],
  ["issued_at", "TEXT"],
  ["source_invoice_id", "TEXT"],
  ["adjustment_kind", "TEXT CHECK(adjustment_kind IS NULL OR adjustment_kind IN ('cancellation', 'refund'))"],
  ["adjustment_scope", "TEXT CHECK(adjustment_scope IS NULL OR adjustment_scope IN ('full', 'partial'))"],
  ["adjustment_reason", "TEXT"],
  ["idempotency_key", "TEXT CHECK(idempotency_key IS NULL OR TRIM(idempotency_key) <> '')"],
  ["quote_id", "TEXT"],
  ["customer_id", "TEXT"],
  ["customer_name", "TEXT NOT NULL DEFAULT ''"],
  ["customer_phone", "TEXT DEFAULT ''"],
  ["customer_city", "TEXT DEFAULT ''"],
  ["customer_vat", "TEXT DEFAULT ''"],
  ["title", "TEXT DEFAULT ''"],
  ["status", "TEXT DEFAULT 'issued'"],
  ["issue_date", "TEXT DEFAULT (date('now'))"],
  ["due_date", "TEXT"],
  ["paid_at", "TEXT"],
  ["payment_method", "TEXT DEFAULT ''"],
  ["subtotal", "NUMERIC DEFAULT 0"],
  ["discount", "NUMERIC DEFAULT 0"],
  ["discount_mode", "TEXT DEFAULT 'fixed'"],
  ["discount_value", "NUMERIC DEFAULT 0"],
  ["vat", "NUMERIC DEFAULT 0"],
  ["vat_percent", "NUMERIC DEFAULT 15"],
  ["vat_amount", "NUMERIC DEFAULT 0"],
  ["additional_fee", "NUMERIC DEFAULT 0"],
  ["total_without_vat", "NUMERIC DEFAULT 0"],
  ["total_with_vat", "NUMERIC DEFAULT 0"],
  ["currency", "TEXT DEFAULT 'SAR'"],
  ["items", "TEXT DEFAULT '[]'"],
  ["notes", "TEXT DEFAULT ''"],
  ["terms", "TEXT DEFAULT ''"],
  ["seller_name", "TEXT DEFAULT ''"],
  ["seller_vat", "TEXT DEFAULT ''"],
  ["seller_vat_number", "TEXT DEFAULT ''"],
  ["seller_address", "TEXT DEFAULT ''"],
  ["invoice_type", "TEXT DEFAULT ''"],
  ["qr_code", "TEXT DEFAULT ''"],
  ["created_at", "TEXT DEFAULT (datetime('now'))"],
  ["updated_at", "TEXT DEFAULT (datetime('now'))"],
] as const) {
  if (!hasColumn("invoices", col[0])) {
    db.exec(`ALTER TABLE invoices ADD COLUMN ${col[0]} ${col[1]}`);
  }
}

// A previous startup may already have installed the ledger triggers. Remove
// them during the synchronous migration window so idempotent backfills can run,
// then recreate them after reconciliation below.
db.exec(`
  DROP TRIGGER IF EXISTS invoices_prevent_issued_financial_update;
  DROP TRIGGER IF EXISTS invoices_prevent_issued_delete;
  DROP TRIGGER IF EXISTS invoices_validate_credit_note_insert;
  DROP TRIGGER IF EXISTS invoices_prevent_status_after_credit;
  DROP TRIGGER IF EXISTS invoices_prevent_credit_during_payment;
  DROP TRIGGER IF EXISTS invoices_prevent_paid_during_payment;
  DROP INDEX IF EXISTS idx_invoices_owner_sequence;
`);

function sequenceFromHistoricalInvoiceNumber(value: unknown): number | null {
  const match = String(value ?? "").trim().match(/^(?:INV|CN)-.+-(\d+)$/i);
  if (!match) return null;
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : null;
}

const assignHistoricalInvoiceSequence = db.prepare(
  "UPDATE invoices SET sequence_no = ? WHERE id = ?",
);
db.exec(`
  UPDATE invoices
  SET invoice_number = 'DRAFT-' || UPPER(SUBSTR(REPLACE(id, '-', ''), 1, 20)),
      sequence_no = NULL
  WHERE status = 'draft'
    AND issued_at IS NULL
    AND invoice_number NOT LIKE 'DRAFT-%';
`);
const backfillHistoricalInvoiceSequences = db.transaction(() => {
  const rows = db.prepare(
    `SELECT id, owner_uid, invoice_number, sequence_no
       FROM invoices
      WHERE status <> 'draft'
        AND TRIM(COALESCE(invoice_number, '')) <> ''
      ORDER BY owner_uid,
               COALESCE(NULLIF(issued_at, ''), NULLIF(created_at, ''), NULLIF(issue_date, ''), ''),
               invoice_number,
               id`,
  ).all() as Array<{
    id: string;
    owner_uid: string;
    invoice_number: unknown;
    sequence_no: unknown;
  }>;

  const byOwner = new Map<string, typeof rows>();
  for (const row of rows) {
    const ownerRows = byOwner.get(row.owner_uid) ?? [];
    ownerRows.push(row);
    byOwner.set(row.owner_uid, ownerRows);
  }

  for (const ownerRows of byOwner.values()) {
    const groups = new Map<number, typeof ownerRows>();
    for (const row of ownerRows) {
      const stored = Number(row.sequence_no);
      const sequence = Number.isSafeInteger(stored) && stored > 0
        ? stored
        : sequenceFromHistoricalInvoiceNumber(row.invoice_number);
      if (sequence === null) continue;
      const matches = groups.get(sequence) ?? [];
      matches.push(row);
      groups.set(sequence, matches);
    }

    // Keep the earliest historical document on its original numeric suffix.
    // Date-based legacy numbers restarted at 001, so later collisions receive
    // an internal sequence above every historical suffix. The visible invoice
    // numbers, dates, and financial values remain untouched.
    let nextSequence = Math.max(0, ...groups.keys()) + 1;
    for (const [sequence, matches] of groups) {
      assignHistoricalInvoiceSequence.run(sequence, matches[0].id);
      for (const collision of matches.slice(1)) {
        assignHistoricalInvoiceSequence.run(nextSequence, collision.id);
        nextSequence += 1;
      }
    }
  }
});
backfillHistoricalInvoiceSequences.immediate();

db.exec(`
  UPDATE invoices
  SET issued_at = COALESCE(NULLIF(created_at, ''), NULLIF(issue_date, ''))
  WHERE issued_at IS NULL
    AND status <> 'draft'
    AND TRIM(COALESCE(invoice_number, '')) <> '';
`);

const duplicateInvoiceSequence = db.prepare(`
  SELECT 1
  FROM invoices
  WHERE sequence_no IS NOT NULL
  GROUP BY owner_uid, sequence_no
  HAVING COUNT(*) > 1
  LIMIT 1
`).get();
if (duplicateInvoiceSequence) {
  throw new Error("Invoice sequence migration aborted: duplicate owner sequence values require manual repair.");
}

db.exec("CREATE INDEX IF NOT EXISTS idx_invoices_owner ON invoices(owner_uid, created_at DESC)");
db.exec("CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(owner_uid, status, created_at DESC)");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_owner_number ON invoices(owner_uid, invoice_number)");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_owner_sequence ON invoices(owner_uid, sequence_no) WHERE sequence_no IS NOT NULL");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_owner_idempotency ON invoices(owner_uid, idempotency_key) WHERE idempotency_key IS NOT NULL");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_one_full_credit_per_source ON invoices(owner_uid, source_invoice_id) WHERE document_kind = 'credit_note' AND adjustment_scope = 'full'");
db.exec("CREATE INDEX IF NOT EXISTS idx_invoices_owner_source ON invoices(owner_uid, source_invoice_id)");
db.exec(`
  INSERT INTO invoice_sequences (owner_uid, series, last_value, updated_at)
  SELECT owner_uid, 'tax_documents', MAX(sequence_no), datetime('now')
  FROM invoices
  WHERE sequence_no IS NOT NULL
  GROUP BY owner_uid
  ON CONFLICT(owner_uid, series) DO UPDATE SET
    last_value = MAX(invoice_sequences.last_value, excluded.last_value),
    updated_at = excluded.updated_at;
`);

type StoredInvoiceFinancialRow = {
  id: string;
  items: unknown;
  subtotal: unknown;
  discount: unknown;
  discount_mode: unknown;
  discount_value: unknown;
  vat: unknown;
  vat_percent: unknown;
  vat_amount: unknown;
  additional_fee: unknown;
  total_without_vat: unknown;
  total_with_vat: unknown;
};

function invoiceItemsForFinancialBackfill(value: unknown) {
  return verifiableInvoiceItems(value) ?? [];
}

function storedInvoiceDiscountValue(row: StoredInvoiceFinancialRow) {
  const explicit = Number(row.discount_value);
  const historicalAmount = Number(row.discount);
  if (row.discount_mode === "percent") {
    return Number.isFinite(explicit) ? explicit : 0;
  }
  if (Number.isFinite(explicit) && (explicit > 0 || !Number.isFinite(historicalAmount) || historicalAmount <= 0)) {
    return explicit;
  }
  return Number.isFinite(historicalAmount) ? historicalAmount : 0;
}

// Existing SQLite invoices may contain independently-written header totals.
// Reconcile every verifiable legacy row from its line items. The operation is
// idempotent, preserves issue/creation/update dates, and the production backup
// above is created before this release migration is applied.
const reconcileStoredInvoiceFinancials = db.transaction(() => {
  const rows = db.prepare(`
    SELECT id, items, subtotal, discount, discount_mode, discount_value, vat,
           vat_percent, vat_amount, additional_fee, total_without_vat, total_with_vat
      FROM invoices
  `).all() as StoredInvoiceFinancialRow[];
  const update = db.prepare(`
    UPDATE invoices
       SET subtotal = @subtotal,
           discount = @discount,
           discount_mode = @discount_mode,
           discount_value = @discount_value,
           vat = @vat,
           vat_percent = @vat_percent,
           vat_amount = @vat_amount,
           additional_fee = @additional_fee,
           total_without_vat = @total_without_vat,
           total_with_vat = @total_with_vat
     WHERE id = @id
  `);
  const numericFields = [
    "subtotal",
    "discount",
    "discount_value",
    "vat",
    "vat_percent",
    "vat_amount",
    "additional_fee",
    "total_without_vat",
    "total_with_vat",
  ] as const;

  for (const row of rows) {
    const items = invoiceItemsForFinancialBackfill(row.items);
    if (!items.length) continue;
    const discountMode: DiscountMode = row.discount_mode === "percent" ? "percent" : "fixed";
    const totals = calculateDocumentTotals({
      lines: items,
      discountValue: storedInvoiceDiscountValue(row),
      discountMode,
      vatPercent: normalizeVatPercent(row.vat_percent),
      additionalTax: Number(row.additional_fee),
    });
    const canonical = {
      id: row.id,
      subtotal: totals.subtotal,
      discount: totals.discountAmount,
      discount_mode: totals.discountMode,
      discount_value: totals.discountValue,
      vat: totals.vatAmount,
      vat_percent: totals.vatPercent,
      vat_amount: totals.vatAmount,
      additional_fee: totals.additionalTax,
      total_without_vat: totals.totalWithoutVat,
      total_with_vat: totals.total,
    };
    const differs = String(row.discount_mode || "fixed") !== canonical.discount_mode
      || numericFields.some((field) => {
        const stored = Number(row[field]);
        return !Number.isFinite(stored) || Math.abs(stored - canonical[field]) > 0.000_001;
      });
    if (differs) update.run(canonical);
  }
});
if (schemaVersionBeforeMigration < TARGET_SCHEMA_VERSION) {
  reconcileStoredInvoiceFinancials();
}

// Defense in depth: the HTTP layer already restricts financial edits and
// deletes to drafts. These triggers close check/write races and protect the
// ledger from any other SQLite caller. Operational status, paid_at and
// updated_at remain mutable; every fiscal field is frozen after issuance.
db.exec(`
  DROP TRIGGER IF EXISTS invoices_prevent_issued_financial_update;
  CREATE TRIGGER invoices_prevent_issued_financial_update
  BEFORE UPDATE ON invoices
  WHEN (OLD.issued_at IS NOT NULL OR OLD.document_kind = 'credit_note' OR OLD.status <> 'draft') AND (
    NEW.owner_uid IS NOT OLD.owner_uid OR
    NEW.invoice_number IS NOT OLD.invoice_number OR
    NEW.document_kind IS NOT OLD.document_kind OR
    NEW.sequence_no IS NOT OLD.sequence_no OR
    NEW.issued_at IS NOT OLD.issued_at OR
    NEW.source_invoice_id IS NOT OLD.source_invoice_id OR
    NEW.adjustment_kind IS NOT OLD.adjustment_kind OR
    NEW.adjustment_scope IS NOT OLD.adjustment_scope OR
    NEW.adjustment_reason IS NOT OLD.adjustment_reason OR
    NEW.idempotency_key IS NOT OLD.idempotency_key OR
    NEW.quote_id IS NOT OLD.quote_id OR
    NEW.customer_id IS NOT OLD.customer_id OR
    NEW.customer_name IS NOT OLD.customer_name OR
    NEW.customer_phone IS NOT OLD.customer_phone OR
    NEW.customer_city IS NOT OLD.customer_city OR
    NEW.customer_vat IS NOT OLD.customer_vat OR
    NEW.title IS NOT OLD.title OR
    NEW.issue_date IS NOT OLD.issue_date OR
    NEW.due_date IS NOT OLD.due_date OR
    NEW.payment_method IS NOT OLD.payment_method OR
    NEW.subtotal IS NOT OLD.subtotal OR
    NEW.discount IS NOT OLD.discount OR
    NEW.discount_mode IS NOT OLD.discount_mode OR
    NEW.discount_value IS NOT OLD.discount_value OR
    NEW.vat IS NOT OLD.vat OR
    NEW.vat_percent IS NOT OLD.vat_percent OR
    NEW.vat_amount IS NOT OLD.vat_amount OR
    NEW.additional_fee IS NOT OLD.additional_fee OR
    NEW.total_without_vat IS NOT OLD.total_without_vat OR
    NEW.total_with_vat IS NOT OLD.total_with_vat OR
    NEW.currency IS NOT OLD.currency OR
    NEW.items IS NOT OLD.items OR
    NEW.notes IS NOT OLD.notes OR
    NEW.terms IS NOT OLD.terms OR
    NEW.seller_name IS NOT OLD.seller_name OR
    NEW.seller_vat IS NOT OLD.seller_vat OR
    NEW.seller_vat_number IS NOT OLD.seller_vat_number OR
    NEW.seller_address IS NOT OLD.seller_address OR
    NEW.invoice_type IS NOT OLD.invoice_type OR
    NEW.qr_code IS NOT OLD.qr_code OR
    NEW.created_at IS NOT OLD.created_at
  )
  BEGIN
    SELECT RAISE(ABORT, 'ISSUED_INVOICE_IMMUTABLE');
  END;

  DROP TRIGGER IF EXISTS invoices_prevent_issued_delete;
  CREATE TRIGGER invoices_prevent_issued_delete
  BEFORE DELETE ON invoices
  WHEN OLD.issued_at IS NOT NULL OR OLD.document_kind = 'credit_note' OR OLD.status <> 'draft'
  BEGIN
    SELECT RAISE(ABORT, 'ISSUED_INVOICE_DELETE_FORBIDDEN');
  END;

  DROP TRIGGER IF EXISTS invoices_validate_credit_note_insert;
  CREATE TRIGGER invoices_validate_credit_note_insert
  BEFORE INSERT ON invoices
  WHEN NEW.document_kind = 'credit_note' AND NOT EXISTS (
    SELECT 1
    FROM invoices source
    WHERE source.id = NEW.source_invoice_id
      AND source.owner_uid = NEW.owner_uid
      AND source.document_kind = 'invoice'
      AND (
        (NEW.adjustment_kind = 'cancellation' AND source.status IN ('issued', 'sent')) OR
        (NEW.adjustment_kind = 'refund' AND source.status = 'paid')
      )
  )
  BEGIN
    SELECT RAISE(ABORT, 'CREDIT_NOTE_SOURCE_STATE_CONFLICT');
  END;

  DROP TRIGGER IF EXISTS invoices_prevent_status_after_credit;
  CREATE TRIGGER invoices_prevent_status_after_credit
  BEFORE UPDATE OF status ON invoices
  WHEN NEW.document_kind = 'invoice'
    AND NEW.status IN ('sent', 'paid')
    AND EXISTS (
      SELECT 1
      FROM invoices credit
      WHERE credit.owner_uid = OLD.owner_uid
        AND credit.source_invoice_id = OLD.id
        AND credit.document_kind = 'credit_note'
        AND credit.adjustment_scope = 'full'
    )
  BEGIN
    SELECT RAISE(ABORT, 'INVOICE_ALREADY_CREDITED');
  END;

  DROP TRIGGER IF EXISTS invoices_prevent_credit_during_payment;
  CREATE TRIGGER invoices_prevent_credit_during_payment
  BEFORE INSERT ON invoices
  WHEN NEW.document_kind = 'credit_note' AND EXISTS (
    SELECT 1
    FROM payments payment
    WHERE payment.owner_uid = NEW.owner_uid
      AND payment.invoice_id = NEW.source_invoice_id
      AND payment.status IN ('creating', 'pending', 'completed')
  )
  BEGIN
    SELECT RAISE(ABORT, 'INVOICE_PAYMENT_REQUIRES_PROVIDER_RESOLUTION');
  END;

  DROP TRIGGER IF EXISTS invoices_prevent_paid_during_payment;
  CREATE TRIGGER invoices_prevent_paid_during_payment
  BEFORE UPDATE OF status ON invoices
  WHEN NEW.document_kind = 'invoice'
    AND NEW.status = 'paid'
    AND OLD.status <> 'paid'
    AND EXISTS (
      SELECT 1
      FROM payments payment
      WHERE payment.owner_uid = OLD.owner_uid
        AND payment.invoice_id = OLD.id
        AND payment.status IN ('creating', 'pending')
    )
  BEGIN
    SELECT RAISE(ABORT, 'INVOICE_PAYMENT_IN_PROGRESS');
  END;
`);

for (const col of [
  ["store_provider", "TEXT"],
  ["store_customer_id", "TEXT"],
  ["email", "TEXT"],
  ["country", "TEXT"],
  ["gender", "TEXT"],
  ["location", "TEXT"],
  ["customer_groups", "TEXT DEFAULT '[]'"],
  ["is_blocked", "INTEGER"],
  ["block_reason", "TEXT"],
  ["remote_created_at", "TEXT"],
  ["remote_updated_at", "TEXT"],
  ["remote_timezone", "TEXT"],
] as const) {
  if (!hasColumn("customers", col[0])) {
    db.exec(`ALTER TABLE customers ADD COLUMN ${col[0]} ${col[1]}`);
  }
}
db.exec("CREATE INDEX IF NOT EXISTS idx_customers_owner_source_created ON customers(owner_uid, store_provider, created_at DESC)");
db.exec("CREATE INDEX IF NOT EXISTS idx_customers_owner_city_name ON customers(owner_uid, city, name)");

// Seller identity is saved per-owner via PUT /api/settings (defaultSettings
// always includes these), but the settings table never declared the columns —
// so on a fresh DB the seller name / VAT number / address never persisted.
for (const col of [
  ["seller_name", "TEXT DEFAULT ''"],
  ["seller_vat", "TEXT DEFAULT ''"],
  ["seller_vat_number", "TEXT DEFAULT ''"],
  ["seller_address", "TEXT DEFAULT ''"],
] as const) {
  if (!hasColumn("settings", col[0])) {
    db.exec(`ALTER TABLE settings ADD COLUMN ${col[0]} ${col[1]}`);
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    release TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT OR IGNORE INTO schema_migrations (version, release) VALUES (10004, '1.0.4');
  UPDATE users SET email = NULL
    WHERE provider = 'local-dev' AND LOWER(IFNULL(email, '')) = 'local@golden-pro-crm.dev';
  INSERT OR IGNORE INTO schema_migrations (version, release) VALUES (10007, '1.0.7');
  INSERT OR IGNORE INTO schema_migrations (version, release) VALUES (10100, '1.1.0');
  INSERT OR IGNORE INTO schema_migrations (version, release) VALUES (10200, '1.2.0');
  INSERT OR IGNORE INTO schema_migrations (version, release) VALUES (10300, '1.3.0');
  INSERT OR IGNORE INTO schema_migrations (version, release) VALUES (10303, '1.3.3');
  INSERT OR IGNORE INTO schema_migrations (version, release) VALUES (10304, '1.3.4');
  INSERT OR IGNORE INTO schema_migrations (version, release) VALUES (10305, '1.3.5');
  INSERT OR IGNORE INTO schema_migrations (version, release) VALUES (10306, '1.3.6');
  INSERT OR IGNORE INTO schema_migrations (version, release) VALUES (10307, '1.3.7');
  INSERT OR IGNORE INTO schema_migrations (version, release) VALUES (10308, '1.3.7-ledger-hardening');
  INSERT OR IGNORE INTO schema_migrations (version, release) VALUES (10309, '1.3.8-android-gateway');
`);
db.pragma(`user_version = ${TARGET_SCHEMA_VERSION}`);

export default db;
