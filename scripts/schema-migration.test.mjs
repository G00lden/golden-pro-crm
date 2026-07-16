import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const caseScript = path.join(root, "scripts", "sqlite-schema-case.ts");
const restartCaseScript = path.join(root, "scripts", "sqlite-invoice-restart-case.ts");

function runCase(scenario, production = false) {
  const directory = mkdtempSync(path.join(os.tmpdir(), `breexe-schema-${scenario}-`));
  const dbPath = path.join(directory, "crm.db");
  const result = spawnSync(process.execPath, ["--import", "tsx", caseScript, scenario], {
    cwd: root,
    env: {
      ...process.env,
      DB_PATH: dbPath,
      NODE_ENV: production ? "production" : "test",
      DB_MIGRATION_BACKUP_DIR: path.join(directory, "backups"),
    },
    encoding: "utf8",
  });
  return { directory, result };
}

test("a fresh database receives the complete current schema", () => {
  const { directory, result } = runCase("fresh");
  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /"userVersion":10500/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a legacy database preserves dates and identifiers while repairing invoice totals", () => {
  const { directory, result } = runCase("legacy");
  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /"scenario":"legacy"/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("production upgrade creates a pre-migration backup", () => {
  const { directory, result } = runCase("legacy", true);
  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const backups = readdirSync(path.join(directory, "backups"));
    assert.equal(backups.length, 1);
    assert.match(backups[0], /pre-schema-10500/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a previous 10307 deployment upgrades through a new backup and ledger marker", () => {
  const { directory, result } = runCase("previous-10307", true);
  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /"userVersion":10500/);
    const backups = readdirSync(path.join(directory, "backups"));
    assert.equal(backups.length, 1);
    assert.match(backups[0], /pre-schema-10500/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the Supabase migration mirrors the Salla filter metadata schema", () => {
  const migration = readFileSync(
    path.join(root, "supabase", "migrations", "20260713020000_salla_filter_metadata.sql"),
    "utf8",
  );
  for (const required of [
    "order_created_at",
    "order_timezone",
    "payment_method",
    "shipping_company",
    "shipment_status",
    "sales_channel",
    "assigned_employee",
    "pickup_branch",
    "order_tags jsonb",
    "is_read boolean",
    "metadata_contract_version",
    "customer_groups jsonb",
    "is_blocked boolean",
    "remote_created_at",
    "remote_updated_at",
    "store_orders_owner_created_idx",
    "customers_owner_source_created_idx",
  ]) {
    assert.match(migration, new RegExp(required));
  }
});

test("the Supabase migration mirrors the Salla order synchronization schema", () => {
  const migration = readFileSync(
    path.join(root, "supabase", "migrations", "20260713010000_salla_order_sync_foundation.sql"),
    "utf8",
  );
  for (const required of [
    "remote_status_id",
    "remote_status_name",
    "remote_status_slug",
    "remote_updated_at",
    "remote_synced_at",
    "sync_origin",
    "remote_deleted_at",
    "salla_order_inbox",
    "salla_order_commands",
    "payload jsonb",
    "lease_token",
    "salla_order_commands_desired_hash_uidx",
    "enable row level security",
  ]) {
    assert.match(migration, new RegExp(required));
  }
});

test("invoice financial backfill is gated off after the first schema startup", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "breexe-schema-restart-"));
  const dbPath = path.join(directory, "crm.db");
  const env = { ...process.env, DB_PATH: dbPath, NODE_ENV: "test" };
  try {
    const seed = spawnSync(process.execPath, ["--import", "tsx", restartCaseScript, "seed"], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    assert.equal(seed.status, 0, seed.stderr || seed.stdout);
    const verify = spawnSync(process.execPath, ["--import", "tsx", restartCaseScript, "verify"], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    assert.equal(verify.status, 0, verify.stderr || verify.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the Supabase migration preserves invoice additional fees", () => {
  const migration = readFileSync(
    path.join(root, "supabase", "migrations", "20260713030000_invoice_additional_fee.sql"),
    "utf8",
  );
  for (const required of [
    "alter table public.invoices",
    "additional_fee numeric",
    "additional_fee >= 0",
  ]) {
    assert.match(migration, new RegExp(required));
  }
});

test("the Supabase invoice migration declares conservative line guards and no timestamp assignments", () => {
  const migration = readFileSync(
    path.join(root, "supabase", "migrations", "20260713170000_invoice_financial_invariant.sql"),
    "utf8",
  );
  assert.match(migration, /and not exists\s*\(/i);
  assert.match(migration, /jsonb_typeof\(candidate\.value -> 'description'\) is distinct from 'string'/i);
  assert.match(migration, /nullif\(btrim\(candidate\.value ->> 'description'\), ''\) is null/i);
  assert.match(
    migration,
    /jsonb_typeof\(candidate\.value -> 'quantity'\) = 'number'[\s\S]*?candidate\.value ->> 'quantity'\)::numeric <= 0/i,
  );
  assert.match(
    migration,
    /candidate\.value -> 'unit_price'[\s\S]*?candidate\.value -> 'unitPrice'[\s\S]*?::numeric < 0/i,
  );
  assert.match(migration, /jsonb_array_length\(case[\s\S]*?else '\[\]'::jsonb[\s\S]*?end\) > 0/i);
  assert.match(migration, /drop trigger if exists invoices_touch_updated_at/i);
  assert.match(migration, /create trigger invoices_touch_updated_at/i);

  const update = migration.match(/update public\.invoices as invoice\s+set([\s\S]*?)\s+from canonical/i);
  assert.ok(update, "Supabase invoice update block is missing");
  assert.doesNotMatch(update[1], /\b(?:issue_date|created_at|updated_at)\s*=/i);
  for (const required of ["discount_value", "vat_excluded", "total_without_vat", "total_with_vat"]) {
    assert.match(migration, new RegExp(required));
  }
});
