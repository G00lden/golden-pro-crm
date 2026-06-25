import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "golden-crm.db");

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent performance
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

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
] as const) {
  if (!hasStoreOrderColumn(col[0])) {
    db.exec(`ALTER TABLE store_orders ADD COLUMN ${col[0]} ${col[1]}`);
  }
}
db.exec("CREATE INDEX IF NOT EXISTS idx_store_orders_imported ON store_orders(imported_at)");

// bookings + technician_notifications were created with a minimal column set.
// bookingLifecycle / bookingNotifications write to richer columns; add the
// missing ones so completing or notifying a booking does not throw SQLITE_ERROR.
function hasColumn(table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

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
    stock_quantity NUMERIC,
    store_status TEXT,
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
    product_name TEXT,
    remind_type TEXT,
    status TEXT DEFAULT 'pending',
    sent_at TEXT DEFAULT (datetime('now')),
    message TEXT DEFAULT '',
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
    title TEXT DEFAULT '',
    status TEXT DEFAULT 'issued',
    issue_date TEXT DEFAULT (date('now')),
    valid_until TEXT,
    follow_up_date TEXT,
    subtotal NUMERIC DEFAULT 0,
    discount NUMERIC DEFAULT 0,
    tax NUMERIC DEFAULT 0,
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
    vat NUMERIC DEFAULT 0,
    vat_percent NUMERIC DEFAULT 15,
    vat_amount NUMERIC DEFAULT 0,
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
    qr_code TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_invoices_owner ON invoices(owner_uid, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(owner_uid, status, created_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_owner_number ON invoices(owner_uid, invoice_number);

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
`);

for (const col of [
  ["store_provider", "TEXT"],
  ["store_product_id", "TEXT"],
  ["price", "NUMERIC"],
  ["sale_price", "NUMERIC"],
  ["currency", "TEXT DEFAULT 'SAR'"],
  ["image_url", "TEXT"],
  ["stock_quantity", "NUMERIC"],
  ["store_status", "TEXT"],
  ["last_synced_at", "TEXT"],
] as const) {
  if (!hasColumn("products", col[0])) {
    db.exec(`ALTER TABLE products ADD COLUMN ${col[0]} ${col[1]}`);
  }
}
db.exec("CREATE INDEX IF NOT EXISTS idx_products_store_product ON products(owner_uid, store_provider, store_product_id)");

for (const col of [
  ["payment_method", "TEXT DEFAULT 'تحويل بنكي'"],
  ["payment_down_percent", "NUMERIC DEFAULT 70"],
  ["payment_final_percent", "NUMERIC DEFAULT 30"],
  ["payment_down_text", "TEXT DEFAULT ''"],
  ["payment_final_text", "TEXT DEFAULT ''"],
  ["payment_bank", "TEXT DEFAULT ''"],
  ["payment_account", "TEXT DEFAULT ''"],
  ["payment_iban", "TEXT DEFAULT ''"],
  ["payment_note", "TEXT DEFAULT ''"],
] as const) {
  if (!hasColumn("quotes", col[0])) {
    db.exec(`ALTER TABLE quotes ADD COLUMN ${col[0]} ${col[1]}`);
  }
}

for (const col of [
  ["invoice_number", "TEXT NOT NULL DEFAULT ''"],
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
  ["vat", "NUMERIC DEFAULT 0"],
  ["vat_percent", "NUMERIC DEFAULT 15"],
  ["vat_amount", "NUMERIC DEFAULT 0"],
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
  ["qr_code", "TEXT DEFAULT ''"],
  ["created_at", "TEXT DEFAULT (datetime('now'))"],
  ["updated_at", "TEXT DEFAULT (datetime('now'))"],
] as const) {
  if (!hasColumn("invoices", col[0])) {
    db.exec(`ALTER TABLE invoices ADD COLUMN ${col[0]} ${col[1]}`);
  }
}
db.exec("CREATE INDEX IF NOT EXISTS idx_invoices_owner ON invoices(owner_uid, created_at DESC)");
db.exec("CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(owner_uid, status, created_at DESC)");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_owner_number ON invoices(owner_uid, invoice_number)");

for (const col of [
  ["store_provider", "TEXT"],
  ["store_customer_id", "TEXT"],
] as const) {
  if (!hasColumn("customers", col[0])) {
    db.exec(`ALTER TABLE customers ADD COLUMN ${col[0]} ${col[1]}`);
  }
}

export default db;
