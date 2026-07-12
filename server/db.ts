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
    created_at TEXT DEFAULT (datetime('now')),
    sent_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_gateway_outbox_pending ON gateway_outbox(owner_uid, status, created_at);

  -- Tap payment gateway (online card/Apple Pay/STC Pay payments on invoices).
  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    owner_uid TEXT NOT NULL,
    invoice_id TEXT,
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

// Post-schema column migrations. These run AFTER the main schema block above,
// so every referenced table is guaranteed to exist (fixes "no such table" on a
// fresh database).
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
  ["stock_quantity", "NUMERIC"],
  ["store_status", "TEXT"],
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
] as const) {
  if (!hasColumn("call_logs", col[0])) {
    db.exec(`ALTER TABLE call_logs ADD COLUMN ${col[0]} ${col[1]}`);
  }
}
db.exec("CREATE INDEX IF NOT EXISTS idx_call_logs_handled ON call_logs(owner_uid, handled, created_at DESC)");

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
  ["customer_type", "TEXT DEFAULT 'unknown'"],
  ["odoo_id", "TEXT"],
] as const) {
  if (!hasColumn("customers", col[0])) {
    db.exec(`ALTER TABLE customers ADD COLUMN ${col[0]} ${col[1]}`);
  }
}

// Product-level service policy. `service_tasks` is a JSON array so one device
// can carry independent schedules (for example pre-filters every 3 months and
// a membrane every 24 months) without creating duplicate product records.
for (const col of [
  ["service_mode", "TEXT DEFAULT 'none'"],
  ["policy_active", "INTEGER DEFAULT 0"],
  ["service_tasks", "TEXT DEFAULT '[]'"],
  ["compatibility_group", "TEXT DEFAULT ''"],
  ["warranty_months", "INTEGER DEFAULT 0"],
  ["warranty_enabled", "INTEGER DEFAULT 0"],
  ["reminder_media_type", "TEXT DEFAULT 'none'"],
  ["reminder_media_url", "TEXT DEFAULT ''"],
  ["reminder_cta", "TEXT DEFAULT 'auto'"],
] as const) {
  if (!hasColumn("products", col[0])) {
    db.exec(`ALTER TABLE products ADD COLUMN ${col[0]} ${col[1]}`);
  }
}

// Align the legacy SQLite reminder table with the Firestore/Supabase shape.
// Keeping `remind_type` preserves old rows while new code writes
// `reminder_type`; readers accept either.
for (const col of [
  ["product_id", "TEXT"],
  ["reminder_type", "TEXT"],
  ["trigger", "TEXT"],
  ["error", "TEXT"],
  ["whatsapp_jid", "TEXT"],
  ["whatsapp_message_id", "TEXT"],
  ["asset_id", "TEXT"],
  ["service_cycle_id", "TEXT"],
] as const) {
  if (!hasColumn("reminders", col[0])) {
    db.exec(`ALTER TABLE reminders ADD COLUMN ${col[0]} ${col[1]}`);
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS customer_assets (
    id TEXT PRIMARY KEY,
    owner_uid TEXT NOT NULL,
    asset_code TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'unassigned',
    origin TEXT NOT NULL DEFAULT 'sold',
    customer_id TEXT,
    customer_name TEXT DEFAULT '',
    customer_phone TEXT DEFAULT '',
    product_id TEXT,
    product_name TEXT DEFAULT '',
    product_sku TEXT DEFAULT '',
    manufacturer_serial TEXT DEFAULT '',
    location_label TEXT DEFAULT '',
    purchase_date TEXT,
    installation_date TEXT,
    warranty_months INTEGER DEFAULT 0,
    warranty_start TEXT,
    warranty_end TEXT,
    store_provider TEXT,
    store_order_id TEXT,
    store_order_number TEXT,
    store_item_index INTEGER,
    store_order_item_key TEXT,
    source TEXT DEFAULT 'manual',
    notes TEXT DEFAULT '',
    activated_at TEXT,
    activated_by TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(owner_uid, asset_code)
  );
  CREATE INDEX IF NOT EXISTS idx_customer_assets_owner_status ON customer_assets(owner_uid, status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_customer_assets_customer ON customer_assets(owner_uid, customer_id, status);
  CREATE INDEX IF NOT EXISTS idx_customer_assets_product ON customer_assets(owner_uid, product_id, status);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_assets_serial ON customer_assets(owner_uid, manufacturer_serial)
    WHERE manufacturer_serial IS NOT NULL AND manufacturer_serial <> '';

  CREATE TABLE IF NOT EXISTS service_cycles (
    id TEXT PRIMARY KEY,
    owner_uid TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    customer_id TEXT,
    customer_name TEXT DEFAULT '',
    customer_phone TEXT DEFAULT '',
    product_id TEXT,
    product_name TEXT DEFAULT '',
    task_key TEXT NOT NULL,
    task_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    start_date TEXT NOT NULL,
    due_date TEXT NOT NULL,
    interval_value INTEGER NOT NULL DEFAULT 1,
    interval_unit TEXT NOT NULL DEFAULT 'months',
    lead_days INTEGER NOT NULL DEFAULT 14,
    reminder_template TEXT DEFAULT '',
    reminder_media_type TEXT DEFAULT 'none',
    reminder_media_url TEXT DEFAULT '',
    reminder_cta TEXT DEFAULT 'auto',
    reminder_count INTEGER DEFAULT 0,
    intensive_count INTEGER DEFAULT 0,
    last_reminder_at TEXT,
    next_reminder_at TEXT,
    completed_at TEXT,
    completed_by TEXT,
    completion_notes TEXT DEFAULT '',
    source_cycle_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_service_cycles_owner_due ON service_cycles(owner_uid, status, due_date);
  CREATE INDEX IF NOT EXISTS idx_service_cycles_next_reminder ON service_cycles(status, next_reminder_at);
  CREATE INDEX IF NOT EXISTS idx_service_cycles_asset ON service_cycles(owner_uid, asset_id, status);

  CREATE TABLE IF NOT EXISTS asset_events (
    id TEXT PRIMARY KEY,
    owner_uid TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    service_cycle_id TEXT,
    event_type TEXT NOT NULL,
    summary TEXT DEFAULT '',
    metadata TEXT DEFAULT '{}',
    performed_by TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_asset_events_asset ON asset_events(owner_uid, asset_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS marketing_campaigns (
    id TEXT PRIMARY KEY,
    owner_uid TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    message TEXT NOT NULL DEFAULT '',
    media_type TEXT DEFAULT 'none',
    media_url TEXT DEFAULT '',
    selected_customer_ids TEXT DEFAULT '[]',
    selected_product_ids TEXT DEFAULT '[]',
    sent_count INTEGER DEFAULT 0,
    failed_count INTEGER DEFAULT 0,
    sent_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_marketing_campaigns_owner ON marketing_campaigns(owner_uid, created_at DESC);

  CREATE TABLE IF NOT EXISTS odoo_import_runs (
    id TEXT PRIMARY KEY,
    owner_uid TEXT NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'preview',
    imported INTEGER DEFAULT 0,
    updated INTEGER DEFAULT 0,
    failed INTEGER DEFAULT 0,
    summary TEXT DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_odoo_import_runs_owner ON odoo_import_runs(owner_uid, created_at DESC);

  CREATE TABLE IF NOT EXISTS replacement_links (
    id TEXT PRIMARY KEY,
    owner_uid TEXT NOT NULL,
    customer_id TEXT,
    customer_name TEXT DEFAULT '',
    customer_phone TEXT DEFAULT '',
    product_id TEXT NOT NULL,
    product_name TEXT DEFAULT '',
    compatibility_group TEXT DEFAULT '',
    candidate_asset_ids TEXT DEFAULT '[]',
    selected_asset_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    purchase_date TEXT,
    store_order_id TEXT,
    store_order_number TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_replacement_links_owner_status ON replacement_links(owner_uid, status, created_at DESC);
`);

for (const col of [
  ["store_provider", "TEXT"],
  ["store_order_number", "TEXT"],
  ["store_item_index", "INTEGER"],
] as const) {
  if (!hasColumn("customer_assets", col[0])) db.exec(`ALTER TABLE customer_assets ADD COLUMN ${col[0]} ${col[1]}`);
}

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

export default db;
