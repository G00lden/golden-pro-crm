import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
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

test("a fresh database receives the complete 1.0.4 schema", () => {
  const { directory, result } = runCase("fresh");
  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /"userVersion":10004/);
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
    assert.match(backups[0], /pre-schema-10004/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
