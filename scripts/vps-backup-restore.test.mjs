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
const deployVps = readFileSync(new URL("./deploy-vps.ps1", import.meta.url), "utf8");
const preserveDeployState = readFileSync(new URL("./vps-preserve-deploy-state.sh", import.meta.url), "utf8");
const vpsUpdate = readFileSync(new URL("./vps-update.sh", import.meta.url), "utf8");
const remoteStart = readFileSync(new URL("../deploy/remote-start.sh", import.meta.url), "utf8");
const remoteRollback = readFileSync(new URL("../deploy/remote-rollback.sh", import.meta.url), "utf8");

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

test("VPS deployment validates proxy/contact inputs and preserves the live state before replacement", () => {
  assert.match(deployVps, /AllowFirstDeployWithoutBackup/);
  assert.match(deployVps, /TRUST_PROXY_HEADERS.*-cne "true"/);
  assert.match(deployVps, /VITE_PUBLIC_CONTACT_PHONE/);
  assert.match(deployVps, /\^\\\+\[1-9\]\[0-9\]\{7,14\}\$/);
  assert.match(deployVps, /Pre-deployment VPS backup/);
  before(
    deployVps,
    "bash scripts/vps-backup.sh",
    "Uploading project archive",
    "the live VPS backup must finish before any new project archive is uploaded",
  );
  before(
    deployVps,
    "bash scripts/vps-backup.sh",
    "bash /tmp/golden-preserve-deploy-state.sh",
    "the data backup must finish before deployment-state preservation",
  );
  before(
    deployVps,
    "bash /tmp/golden-preserve-deploy-state.sh",
    "Project archive upload",
    "the actual running state must be preserved before source upload/extraction",
  );
  assert.match(deployVps, /EXPECTED_VERSION='\$releaseVersion'/);
  assert.match(deployVps, /EXPECTED_BUILD='\$buildCommit'/);
  assert.match(deployVps, /https:\/\/\$Domain\/api\/health/);
  assert.match(deployVps, /https:\/\/\$Domain\/api\/version/);
  assert.match(deployVps, /health\.release\.version -ne \$releaseVersion/);
  assert.match(deployVps, /version\.commit -ne \$buildCommit/);
  assert.match(deployVps, /catch \{/);
  assert.match(deployVps, /bash \/tmp\/golden-remote-rollback\.sh/);
  assert.match(deployVps, /previous deployment was restored/);
});

test("deployment-state preservation captures the actual running files and rollback image atomically", () => {
  assert.match(preserveDeployState, /com\.docker\.compose\.project\.config_files/);
  assert.match(preserveDeployState, /docker cp "\$CADDY_CID:\/etc\/caddy\/Caddyfile"/);
  assert.match(preserveDeployState, /ACTIVE_ROOT=.*dirname "\$COMPOSE_LABEL"/);
  assert.match(preserveDeployState, /cp -- "\$ACTIVE_ENV" "\$TMP_DIR\/env\.production"/);
  assert.match(preserveDeployState, /docker image tag "\$OLD_IMAGE_ID" "\$ROLLBACK_IMAGE"/);
  assert.match(preserveDeployState, /sha256sum Caddyfile docker-compose\.yml env\.production/);
  const installIndex = preserveDeployState.indexOf('mv -- "$TMP_DIR" "$ROLLBACK_DIR"');
  const finalCleanupIndex = preserveDeployState.lastIndexOf('rm -rf -- "$PREVIOUS_DIR"');
  assert.notEqual(installIndex, -1, "the temporary state must be installed atomically");
  assert.ok(finalCleanupIndex > installIndex, "the previous snapshot must be cleaned only after replacement");
});

test("remote start validates Caddy, builds first, recreates both services, and checks the exact release", () => {
  assert.match(remoteStart, /ROLLBACK_IMAGE="golden-pro-crm:rollback"/);
  assert.match(remoteStart, /TRUST_PROXY_HEADERS.*must be true/);
  assert.match(remoteStart, /VITE_PUBLIC_CONTACT_PHONE.*valid E\.164/);
  assert.match(remoteStart, /--project-name "\$PROJECT_NAME"/);
  const caddyValidationIndex = remoteStart.indexOf("caddy validate");
  const buildIndex = remoteStart.indexOf('"${COMPOSE[@]}" build crm');
  const replacementIndex = remoteStart.indexOf('"${COMPOSE[@]}" up -d --no-build --force-recreate crm caddy', buildIndex + 1);
  assert.notEqual(caddyValidationIndex, -1, "remote start must validate Caddy");
  assert.notEqual(buildIndex, -1, "remote start is missing the isolated CRM build");
  assert.ok(caddyValidationIndex < buildIndex, "Caddy must validate before the image build");
  assert.ok(
    replacementIndex > buildIndex,
    "the new image must finish building before the running container is replaced",
  );
  assert.match(remoteStart, /release\.version !== process\.env\.EXPECTED_VERSION/);
  assert.match(remoteStart, /payload\.commit !== process\.env\.EXPECTED_BUILD/);
  assert.match(remoteStart, /--resolve "\$CRM_DOMAIN:443:127\.0\.0\.1"/);
  assert.match(remoteStart, /if ! wait_for_release/);
  assert.match(remoteStart, /bash "\$APP_DIR\/deploy\/remote-rollback\.sh"/);
});

test("remote rollback restores image, env, Compose, and Caddy then verifies both paths", () => {
  assert.match(remoteRollback, /sha256sum --check --strict --status manifest\.sha256/);
  assert.match(remoteRollback, /mv -f "\$APP_DIR\/\.env\.production\.rollback-next" "\$APP_DIR\/\.env\.production"/);
  assert.match(remoteRollback, /docker-compose\.yml\.rollback-next/);
  assert.match(remoteRollback, /Caddyfile\.rollback-next/);
  assert.match(remoteRollback, /docker image tag "\$ROLLBACK_IMAGE" "\$RUNTIME_IMAGE"/);
  assert.match(remoteRollback, /docker image tag "\$ROLLBACK_IMAGE" "deploy-crm:latest"/);
  assert.match(remoteRollback, /up -d --no-build --force-recreate crm caddy/);
  assert.match(remoteRollback, /--resolve "\$CRM_DOMAIN:443:127\.0\.0\.1"/);
});

test("GitHub Actions VPS update backs up and preserves before reset and delegates atomic deployment", () => {
  before(vpsUpdate, "bash scripts/vps-backup.sh", "bash scripts/vps-preserve-deploy-state.sh", "backup must precede preservation");
  before(vpsUpdate, "bash scripts/vps-preserve-deploy-state.sh", 'git reset --hard "origin/$BRANCH"', "preservation must precede source reset");
  before(vpsUpdate, 'cp deploy/remote-rollback.sh "$ROLLBACK_HELPER"', 'git reset --hard "origin/$BRANCH"', "a trusted rollback helper must exist outside the worktree before reset");
  assert.match(vpsUpdate, /trap unexpected_failure ERR/);
  assert.match(vpsUpdate, /POST_RESET=true[\s\S]*git reset --hard "origin\/\$BRANCH"/);
  assert.match(vpsUpdate, /bash deploy\/remote-start\.sh/);
  assert.match(vpsUpdate, /bash "\$ROLLBACK_HELPER"/);
  assert.match(vpsUpdate, /git reset --hard "\$PREV"/);
  assert.match(vpsUpdate, /https:\/\/\$CRM_DOMAIN\/api\/health/);
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
