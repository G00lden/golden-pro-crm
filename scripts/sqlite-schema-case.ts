import Database from "better-sqlite3";

const dbPath = process.env.DB_PATH;
if (!dbPath) throw new Error("DB_PATH is required.");
const scenario = process.argv[2] || "fresh";

if (scenario === "legacy") {
  const legacy = new Database(dbPath);
  legacy.exec(`
    PRAGMA user_version = 10003;
    CREATE TABLE users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
      email TEXT UNIQUE, password_hash TEXT NOT NULL, role TEXT DEFAULT 'admin',
      created_at TEXT, updated_at TEXT, uid TEXT, permissions TEXT DEFAULT '{}',
      active INTEGER DEFAULT 1, last_login_at TEXT, provider TEXT DEFAULT 'firebase'
    );
    INSERT INTO users (id, name, email, password_hash, role, uid, provider)
    VALUES ('legacy_local', 'Legacy local', 'local@golden-pro-crm.dev', '', 'admin', 'local-dev-owner', 'local-dev');
    CREATE TABLE quotes (
      id TEXT PRIMARY KEY, owner_uid TEXT NOT NULL, quote_number TEXT NOT NULL,
      customer_id TEXT, customer_name TEXT NOT NULL DEFAULT '', customer_phone TEXT DEFAULT '',
      customer_city TEXT DEFAULT '', title TEXT DEFAULT '', status TEXT DEFAULT 'issued',
      issue_date TEXT, valid_until TEXT, follow_up_date TEXT, subtotal NUMERIC DEFAULT 0,
      discount NUMERIC DEFAULT 0, tax NUMERIC DEFAULT 0, total NUMERIC DEFAULT 0,
      currency TEXT DEFAULT 'SAR', payment_method TEXT DEFAULT '', payment_down_percent NUMERIC DEFAULT 70,
      payment_final_percent NUMERIC DEFAULT 30, payment_down_text TEXT DEFAULT '', payment_final_text TEXT DEFAULT '',
      payment_bank TEXT DEFAULT '', payment_account TEXT DEFAULT '', payment_iban TEXT DEFAULT '',
      payment_note TEXT DEFAULT '', items TEXT DEFAULT '[]', notes TEXT DEFAULT '', terms TEXT DEFAULT '',
      confirmed_at TEXT, created_at TEXT, updated_at TEXT
    );
    INSERT INTO quotes (id, owner_uid, quote_number, customer_name, discount, total)
    VALUES ('legacy_quote', 'owner', 'QT-LEGACY', 'Legacy customer', 10, 90);
    CREATE TABLE store_orders (
      id TEXT PRIMARY KEY,
      owner_uid TEXT NOT NULL,
      order_id TEXT,
      status TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    INSERT INTO store_orders (id, owner_uid, order_id, status, created_at, updated_at)
    VALUES ('legacy_store_order', 'owner', 'SALLA-LEGACY', 'paid', '2026-01-01', '2026-01-01');
  `);
  legacy.close();
}

const { default: db } = await import("../server/db");

function columns(table: string) {
  return new Set(
    (db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as Array<{ name: string }>).map((row) => row.name),
  );
}

function indexes(table: string) {
  return new Map(
    (db.prepare("SELECT name, [unique] AS is_unique FROM pragma_index_list(?)").all(table) as Array<{
      name: string;
      is_unique: number;
    }>).map((row) => [row.name, Boolean(row.is_unique)]),
  );
}

const quoteColumns = columns("quotes");
for (const required of [
  "discount_mode",
  "discount_value",
  "vat_percent",
  "vat_amount",
  "total_without_vat",
  "installments",
]) {
  if (!quoteColumns.has(required)) throw new Error(`quotes.${required} is missing`);
}
for (const required of ["discount_mode", "discount_value", "vat_percent", "vat_amount", "additional_fee", "total_without_vat", "total_with_vat", "invoice_type"]) {
  if (!columns("invoices").has(required)) throw new Error(`invoices.${required} is missing`);
}
for (const required of ["seller_name", "seller_vat_number", "seller_address"]) {
  if (!columns("settings").has(required)) throw new Error(`settings.${required} is missing`);
}
for (const required of ["merged_into", "merged_at"]) {
  if (!columns("products").has(required)) throw new Error(`products.${required} is missing`);
}
for (const required of [
  "product_id",
  "remind_type",
  "trigger",
  "error",
  "whatsapp_jid",
  "whatsapp_message_id",
]) {
  if (!columns("reminders").has(required)) throw new Error(`reminders.${required} is missing`);
}

const userVersion = Number(db.pragma("user_version", { simple: true }));
if (userVersion !== 10307) throw new Error(`Expected schema 10307, got ${userVersion}`);

for (const required of [
  "remote_status_id",
  "remote_status_name",
  "remote_status_slug",
  "remote_updated_at",
  "remote_synced_at",
  "sync_origin",
  "remote_deleted_at",
  "order_created_at",
  "order_timezone",
  "payment_method",
  "shipping_company",
  "shipment_status",
  "country",
  "sales_channel",
  "assigned_employee",
  "pickup_branch",
  "order_tags",
  "is_read",
  "is_price_quote",
  "metadata_contract_version",
]) {
  if (!columns("store_orders").has(required)) throw new Error(`store_orders.${required} is missing`);
}

for (const required of [
  "email",
  "country",
  "gender",
  "location",
  "customer_groups",
  "is_blocked",
  "block_reason",
  "remote_created_at",
  "remote_updated_at",
  "remote_timezone",
]) {
  if (!columns("customers").has(required)) throw new Error(`customers.${required} is missing`);
}

for (const required of ["idx_store_orders_owner_created", "idx_store_orders_owner_status_created"]) {
  if (!indexes("store_orders").has(required)) throw new Error(`${required} is missing`);
}
for (const required of [
  "provider",
  "order_id",
  "order_number",
  "status",
  "auth_mode",
  "received_at",
  "raw_payload",
  "processed_at",
  "imported",
]) {
  if (!columns("store_webhook_events").has(required)) throw new Error(`store_webhook_events.${required} is missing`);
}
if (!indexes("store_webhook_events").has("idx_store_webhook_events_owner_received")) {
  throw new Error("idx_store_webhook_events_owner_received is missing");
}
for (const required of ["idx_customers_owner_source_created", "idx_customers_owner_city_name"]) {
  if (!indexes("customers").has(required)) throw new Error(`${required} is missing`);
}

const inboxColumns = columns("salla_order_inbox");
for (const required of [
  "id",
  "owner_uid",
  "merchant_id",
  "event_type",
  "remote_order_id",
  "payload_hash",
  "status",
  "attempts",
  "received_at",
  "processed_at",
  "next_attempt_at",
  "error_code",
  "error",
  "lease_token",
  "created_at",
  "updated_at",
]) {
  if (!inboxColumns.has(required)) throw new Error(`salla_order_inbox.${required} is missing`);
}

const commandColumns = columns("salla_order_commands");
for (const required of [
  "id",
  "owner_uid",
  "order_doc_id",
  "remote_order_id",
  "command_type",
  "desired_hash",
  "payload",
  "status",
  "attempt_count",
  "before_hash",
  "after_hash",
  "result_status",
  "last_error",
  "actor_uid",
  "lease_token",
  "created_at",
  "updated_at",
  "completed_at",
]) {
  if (!commandColumns.has(required)) throw new Error(`salla_order_commands.${required} is missing`);
}

for (const required of ["idx_salla_order_inbox_owner_status", "idx_salla_order_inbox_due"]) {
  if (!indexes("salla_order_inbox").has(required)) throw new Error(`${required} is missing`);
}
const commandIndexes = indexes("salla_order_commands");
for (const required of ["idx_salla_order_commands_owner_status", "idx_salla_order_commands_due"]) {
  if (!commandIndexes.has(required)) throw new Error(`${required} is missing`);
}
if (commandIndexes.get("uq_salla_order_commands_desired_hash") !== true) {
  throw new Error("The desired-command hash unique index is missing or not unique.");
}

for (const table of [
  "communication_events",
  "communication_jobs",
  "communication_preferences",
  "communication_suppressions",
  "communication_campaigns",
  "communication_campaign_recipients",
]) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!exists) throw new Error(`${table} is missing`);
}
for (const required of ["campaign_id", "campaign_recipient_id"]) {
  if (!columns("communication_jobs").has(required)) throw new Error(`communication_jobs.${required} is missing`);
}
for (const required of ["correlation_key", "wa_customer_job_id", "wa_agent_job_id", "wa_customer_status", "wa_agent_status"]) {
  if (!columns("call_logs").has(required)) throw new Error(`call_logs.${required} is missing`);
}

if (scenario === "legacy") {
  const legacy = db.prepare("SELECT discount, total FROM quotes WHERE id = 'legacy_quote'").get() as { discount: number; total: number };
  if (!legacy || Number(legacy.discount) !== 10 || Number(legacy.total) !== 90) {
    throw new Error("Legacy quote values changed during migration.");
  }
  const legacyLocal = db.prepare("SELECT email FROM users WHERE id = 'legacy_local'").get() as { email: string | null };
  if (legacyLocal.email !== null) throw new Error("Legacy local synthetic email was not cleared.");
  const legacyStoreOrder = db.prepare("SELECT order_id, status FROM store_orders WHERE id = 'legacy_store_order'").get() as {
    order_id: string;
    status: string;
  };
  if (legacyStoreOrder?.order_id !== "SALLA-LEGACY" || legacyStoreOrder.status !== "paid") {
    throw new Error("Legacy store-order values changed during migration.");
  }
}

db.prepare(`
  INSERT INTO quotes (
    id, owner_uid, quote_number, customer_name, discount, discount_mode,
    discount_value, vat_percent, vat_amount, total_without_vat, total, installments
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run("schema_probe", "owner", "QT-PROBE", "Probe", 20, "percent", 10, 15, 27, 180, 207, "[]");

const migration = db.prepare("SELECT release FROM schema_migrations WHERE version = 10004").get() as { release?: string };
if (migration?.release !== "1.0.4") throw new Error("Schema migration ledger was not updated.");
const identityMigration = db.prepare("SELECT release FROM schema_migrations WHERE version = 10007").get() as { release?: string };
if (identityMigration?.release !== "1.0.7") throw new Error("Identity migration ledger was not updated.");
const invoiceMigration = db.prepare("SELECT release FROM schema_migrations WHERE version = 10100").get() as { release?: string };
if (invoiceMigration?.release !== "1.1.0") throw new Error("Invoice migration ledger was not updated.");
const communicationMigration = db.prepare("SELECT release FROM schema_migrations WHERE version = 10200").get() as { release?: string };
if (communicationMigration?.release !== "1.2.0") throw new Error("Communication migration ledger was not updated.");
const campaignMigration = db.prepare("SELECT release FROM schema_migrations WHERE version = 10300").get() as { release?: string };
if (campaignMigration?.release !== "1.3.0") throw new Error("Campaign migration ledger was not updated.");
const orderSyncMigration = db.prepare("SELECT release FROM schema_migrations WHERE version = 10303").get() as { release?: string };
if (orderSyncMigration?.release !== "1.3.3") throw new Error("Salla order-sync migration ledger was not updated.");
const filterMetadataMigration = db.prepare("SELECT release FROM schema_migrations WHERE version = 10304").get() as { release?: string };
if (filterMetadataMigration?.release !== "1.3.4") throw new Error("Salla filter-metadata migration ledger was not updated.");
const qaWebhookMigration = db.prepare("SELECT release FROM schema_migrations WHERE version = 10305").get() as { release?: string };
if (qaWebhookMigration?.release !== "1.3.5") throw new Error("Store webhook event migration ledger was not updated.");
const invoiceFeeMigration = db.prepare("SELECT release FROM schema_migrations WHERE version = 10306").get() as { release?: string };
if (invoiceFeeMigration?.release !== "1.3.6") throw new Error("Invoice additional-fee migration ledger was not updated.");
const integrationSafetyMigration = db.prepare("SELECT release FROM schema_migrations WHERE version = 10307").get() as { release?: string };
if (integrationSafetyMigration?.release !== "1.3.7") throw new Error("Integration safety migration ledger was not updated.");

const { createSqliteFirestoreAdapter } = await import("../server/sqliteFirestoreAdapter");
const adapter = createSqliteFirestoreAdapter();
const reminderRef = await adapter.collection("reminders").add({
  createdBy: "owner",
  installation_id: "installation-1",
  customer_id: "customer-1",
  customer_phone: "0500000000",
  product_id: "product-1",
  product_name: "Filter",
  reminder_type: "first",
  trigger: "schema-test",
  status: "dry_run",
  message: "simulation",
  error: "dry-run",
  whatsapp_jid: "966500000000@s.whatsapp.net",
  whatsapp_message_id: null,
});
const reminderData = (await reminderRef.get()).data() as Record<string, unknown>;
if (reminderData.reminder_type !== "first" || reminderData.product_id !== "product-1") {
  throw new Error("Reminder delivery fields did not round-trip through SQLite.");
}
const inboxRef = await adapter.collection("salla_order_inbox").add({
  createdBy: "owner",
  merchantId: "merchant-1",
  eventType: "order.updated",
  remoteOrderId: "SALLA-1",
  payloadHash: "event-hash-1",
});
if (!inboxRef.id.startsWith("soi_")) throw new Error("Salla inbox IDs do not use the expected prefix.");

const commandRef = await adapter.collection("salla_order_commands").add({
  createdBy: "owner",
  orderDocId: "store-order-1",
  remoteOrderId: "SALLA-1",
  commandType: "status.update",
  desiredHash: "desired-hash-1",
  payload: { status: "completed", metadata: { source: "schema-test" } },
  actorUid: "schema-test",
});
if (!commandRef.id.startsWith("soc_")) throw new Error("Salla command IDs do not use the expected prefix.");
const commandSnapshot = await commandRef.get();
const commandData = commandSnapshot.data() as Record<string, unknown>;
if (
  commandData.remote_order_id !== "SALLA-1" ||
  commandData.order_doc_id !== "store-order-1" ||
  commandData.remoteOrderId !== "SALLA-1" ||
  commandData.orderDocId !== "store-order-1"
) {
  throw new Error("Salla command camelCase fields were not mapped to SQLite columns.");
}
if ((commandData.payload as { metadata?: { source?: string } })?.metadata?.source !== "schema-test") {
  throw new Error("Salla command JSON payload did not round-trip through SQLite.");
}
let duplicateRejected = false;
try {
  await adapter.collection("salla_order_commands").add({
    createdBy: "owner",
    orderDocId: "store-order-1",
    commandType: "status.update",
    desiredHash: "desired-hash-1",
    payload: { status: "completed" },
  });
} catch (error) {
  duplicateRejected = String(error).includes("UNIQUE constraint failed");
}
if (!duplicateRejected) throw new Error("Duplicate desired Salla commands were not rejected.");

db.close();
console.log(JSON.stringify({ scenario, userVersion, quotes: [...quoteColumns].length }));
