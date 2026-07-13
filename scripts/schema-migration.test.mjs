import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const caseScript = path.join(root, "scripts", "sqlite-schema-case.ts");

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
    assert.match(result.stdout, /"userVersion":10304/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a legacy database is upgraded without changing historical values", () => {
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
    assert.match(backups[0], /pre-schema-10304/);
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
