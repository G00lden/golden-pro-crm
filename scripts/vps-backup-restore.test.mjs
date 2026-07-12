import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const backup = readFileSync(new URL("./vps-backup.sh", import.meta.url), "utf8");
const restore = readFileSync(new URL("./vps-restore.sh", import.meta.url), "utf8");

function before(source, first, second, message) {
  const firstIndex = source.indexOf(first);
  const secondIndex = source.indexOf(second);
  assert.notEqual(firstIndex, -1, `missing contract marker: ${first}`);
  assert.notEqual(secondIndex, -1, `missing contract marker: ${second}`);
  assert.ok(firstIndex < secondIndex, message);
}

function embeddedNodeScript(source, anchor, endMarker) {
  const anchorIndex = source.indexOf(anchor);
  assert.notEqual(anchorIndex, -1, `missing embedded-script anchor: ${anchor}`);
  const prefix = "node -e '";
  const start = source.indexOf(prefix, anchorIndex);
  assert.notEqual(start, -1, `missing embedded Node command after: ${anchor}`);
  const bodyStart = start + prefix.length;
  const end = source.indexOf(endMarker, bodyStart);
  assert.notEqual(end, -1, `missing embedded-script terminator after: ${anchor}`);
  return source.slice(bodyStart, end);
}

function shellFunction(source, name, nextMarker) {
  const start = source.indexOf(`${name}() {`);
  assert.notEqual(start, -1, `missing shell function: ${name}`);
  const end = source.indexOf(`\n}\n\n${nextMarker}`, start);
  assert.notEqual(end, -1, `missing end of shell function: ${name}`);
  return source.slice(start, end + 3);
}

function toBashPath(value) {
  if (process.platform !== "win32") return value;
  const converted = spawnSync("cygpath", ["-u", value], { encoding: "utf8" });
  assert.equal(converted.status, 0, converted.stderr);
  return converted.stdout.trim();
}

test("VPS backup uses external storage, one lock, unique snapshots, and guarded pruning", () => {
  assert.match(backup, /BACKUP_DIR="\$\{BACKUP_DIR:-\/var\/backups\/golden-pro-crm\}"/);
  assert.match(backup, /BACKUP_LOCK_FILE:-\/var\/lock\/golden-pro-crm-backup-restore\.lock/);
  assert.match(backup, /flock -n 9/);
  assert.match(backup, /CRM_BACKUP_LOCK_FD/);
  assert.match(backup, /Inherited backup lock descriptor does not reference the shared lock file/);
  assert.match(backup, /RUN_ID="\$\{STAMP\}-\$\$-\$\{RANDOM\}"/);
  assert.match(backup, /_backup-\$\{RUN_ID\}\.db/);
  assert.match(backup, /_salla-integrations-\$\{RUN_ID\}\.json/);
  assert.match(backup, /const source = "\/app\/\.runtime\/salla-integrations\.json"/);
  assert.match(backup, /chmod 600 "\$DEST\/salla-integrations\.json"/);
  assert.match(backup, /sha256sum --check --strict --status manifest\.sha256/);
  assert.match(backup, /if \[ "\$PRUNE_ENABLED" = "true" \]/);
  assert.match(backup, /backup pruning disabled for this operation/);
});

test("VPS restore enforces manifest whitelist, disables safety pruning, and checks SQLite before overwrite", () => {
  assert.match(restore, /BACKUP_DIR="\$\{BACKUP_DIR:-\/var\/backups\/golden-pro-crm\}"/);
  assert.match(restore, /BACKUP_LOCK_FILE:-\/var\/lock\/golden-pro-crm-backup-restore\.lock/);
  assert.match(restore, /flock -n 9/);
  assert.match(restore, /backup manifest must include golden-crm\.db\.gz/);
  assert.match(restore, /local -a allowed=/);
  for (const payload of ["golden-crm.db.gz", "salla-integrations.json", "wa-session.tar.gz", "env.production"]) {
    assert.ok(restore.includes(`"${payload}"`), `manifest whitelist is missing ${payload}`);
  }
  assert.match(restore, /BACKUP_PRUNE_ENABLED=false/);
  assert.match(restore, /CRM_BACKUP_LOCK_FD=9/);
  assert.match(restore, /pragma\("integrity_check"\)/);
  assert.match(restore, /docker cp "\$SALLA_SRC" "\$CID:\/app\/\.runtime\/salla-integrations\.json"/);
  before(
    restore,
    "checking SQLite integrity before overwrite",
    'docker cp "$TMP" "$CID:/app/.runtime/golden-crm.db"',
    "SQLite integrity_check must pass before the live database is overwritten",
  );
  before(
    restore,
    "safety snapshot of current state",
    "stopping app container",
    "the safety snapshot must finish before the CRM container is stopped",
  );
  before(
    restore,
    "validating restored runtime before CRM startup",
    "starting app",
    "runtime validation must finish before CRM startup",
  );
});

test("embedded backup validator rejects malformed JSON and snapshots a valid object", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "crm-salla-backup-test-"));
  const sourcePath = path.join(directory, "salla-integrations.json");
  const snapshotPath = path.join(directory, "snapshot.json");
  const rawScript = embeddedNodeScript(
    backup,
    "validating and snapshotting Salla integration state",
    "\n'; then",
  );
  const script = rawScript
    .replace('"/app/.runtime/salla-integrations.json"', JSON.stringify(sourcePath))
    .replace('"/app/.runtime/_salla-integrations-"', JSON.stringify(`${directory}${path.sep}`));
  const env = { ...process.env, BACKUP_SALLA_SNAPSHOT: snapshotPath };

  try {
    writeFileSync(sourcePath, "{broken", "utf8");
    const invalid = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", env });
    assert.equal(invalid.status, 4);

    writeFileSync(sourcePath, JSON.stringify({ owner: { status: "connected" } }), "utf8");
    const valid = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", env });
    assert.equal(valid.status, 0, valid.stderr);
    assert.deepEqual(JSON.parse(readFileSync(snapshotPath, "utf8")), { owner: { status: "connected" } });
    if (process.platform !== "win32") {
      assert.equal(statSync(snapshotPath).mode & 0o777, 0o600);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("manifest validator accepts only complete whitelisted payloads", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "crm-manifest-test-"));
  const dbPayload = Buffer.from("database-backup");
  const dbPath = path.join(directory, "golden-crm.db.gz");
  const manifestPath = path.join(directory, "manifest.sha256");
  const validator = shellFunction(restore, "validate_manifest", 'log "validating backup manifest');
  const bashDirectory = toBashPath(directory);
  const runValidator = () => spawnSync(
    "bash",
    ["-c", `${validator}\nvalidate_manifest "$1"`, "manifest-test", bashDirectory],
    { encoding: "utf8" },
  );

  try {
    writeFileSync(dbPath, dbPayload);
    const hash = crypto.createHash("sha256").update(dbPayload).digest("hex");
    writeFileSync(manifestPath, `${hash}  golden-crm.db.gz\n`, "utf8");
    assert.equal(runValidator().status, 0);

    writeFileSync(path.join(directory, "unexpected.txt"), "unexpected", "utf8");
    assert.equal(runValidator().status, 1);
    rmSync(path.join(directory, "unexpected.txt"));

    writeFileSync(path.join(directory, "salla-integrations.json"), "{}", "utf8");
    assert.equal(runValidator().status, 1, "every present payload must be listed in manifest");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("embedded SQLite validator rejects corruption before overwrite", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "crm-sqlite-integrity-test-"));
  const dbPath = path.join(directory, "candidate.db");
  const script = embeddedNodeScript(
    restore,
    "checking SQLite integrity before overwrite",
    "\n  '",
  );
  const env = { ...process.env, RESTORE_DB_PATH: dbPath };

  try {
    const db = new Database(dbPath);
    db.exec("CREATE TABLE healthcheck (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO healthcheck(value) VALUES ('ok');");
    db.close();
    const valid = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", env });
    assert.equal(valid.status, 0, valid.stderr);

    writeFileSync(dbPath, "not-a-sqlite-database", "utf8");
    const corrupt = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", env });
    assert.equal(corrupt.status, 6);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("embedded restore Salla validator accepts only a JSON object", () => {
  const script = embeddedNodeScript(
    restore,
    "validating Salla integration state from backup",
    "\n  ' < \"$SALLA_SRC\"",
  );

  const malformed = spawnSync(process.execPath, ["-e", script], { input: "{broken", encoding: "utf8" });
  assert.equal(malformed.status, 4);

  const array = spawnSync(process.execPath, ["-e", script], { input: "[]", encoding: "utf8" });
  assert.equal(array.status, 4);

  const object = spawnSync(process.execPath, ["-e", script], { input: '{"owner":{"status":"connected"}}', encoding: "utf8" });
  assert.equal(object.status, 0, object.stderr);
});
