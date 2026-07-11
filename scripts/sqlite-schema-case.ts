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
  `);
  legacy.close();
}

const { default: db } = await import("../server/db");

function columns(table: string) {
  return new Set(
    (db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as Array<{ name: string }>).map((row) => row.name),
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
for (const required of ["vat_percent", "vat_amount", "total_without_vat", "total_with_vat"]) {
  if (!columns("invoices").has(required)) throw new Error(`invoices.${required} is missing`);
}
for (const required of ["seller_name", "seller_vat_number", "seller_address"]) {
  if (!columns("settings").has(required)) throw new Error(`settings.${required} is missing`);
}

const userVersion = Number(db.pragma("user_version", { simple: true }));
if (userVersion !== 10007) throw new Error(`Expected schema 10007, got ${userVersion}`);

if (scenario === "legacy") {
  const legacy = db.prepare("SELECT discount, total FROM quotes WHERE id = 'legacy_quote'").get() as { discount: number; total: number };
  if (!legacy || Number(legacy.discount) !== 10 || Number(legacy.total) !== 90) {
    throw new Error("Legacy quote values changed during migration.");
  }
  const legacyLocal = db.prepare("SELECT email FROM users WHERE id = 'legacy_local'").get() as { email: string | null };
  if (legacyLocal.email !== null) throw new Error("Legacy local synthetic email was not cleared.");
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

db.close();
console.log(JSON.stringify({ scenario, userVersion, quotes: [...quoteColumns].length }));
