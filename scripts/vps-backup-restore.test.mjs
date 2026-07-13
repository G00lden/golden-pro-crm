import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const backup = readFileSync(new URL("./vps-backup.sh", import.meta.url), "utf8");
const restore = readFileSync(new URL("./vps-restore.sh", import.meta.url), "utf8");
const deployVps = readFileSync(new URL("./deploy-vps.ps1", import.meta.url), "utf8");
const preserveDeployState = readFileSync(new URL("./vps-preserve-deploy-state.sh", import.meta.url), "utf8");
const vpsUpdate = readFileSync(new URL("./vps-update.sh", import.meta.url), "utf8");
const deployTransactionUrl = new URL("./vps-deploy-transaction.sh", import.meta.url);
const deployTransaction = readFileSync(deployTransactionUrl, "utf8");
const deployWorkflow = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");
const ciWorkflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const deploymentDoc = readFileSync(new URL("../docs/deployment.md", import.meta.url), "utf8");
const vpsDeploymentDoc = readFileSync(new URL("../docs/vps-deployment-ar.md", import.meta.url), "utf8");
const vpsCicdDoc = readFileSync(new URL("../docs/vps-cicd-backups-ar.md", import.meta.url), "utf8");
const remoteStart = readFileSync(new URL("../deploy/remote-start.sh", import.meta.url), "utf8");
const remoteRollback = readFileSync(new URL("../deploy/remote-rollback.sh", import.meta.url), "utf8");
const remoteRollbackUrl = new URL("../deploy/remote-rollback.sh", import.meta.url);
const caddyConfig = readFileSync(new URL("../deploy/Caddyfile", import.meta.url), "utf8");
const composeConfig = readFileSync(new URL("../deploy/docker-compose.yml", import.meta.url), "utf8");

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

function embeddedShellScript(source, anchor, endMarker) {
  const anchorIndex = source.indexOf(anchor);
  assert.notEqual(anchorIndex, -1, `missing embedded-shell anchor: ${anchor}`);
  const prefix = "crm sh -eu -c '\n";
  const start = source.indexOf(prefix, anchorIndex);
  assert.notEqual(start, -1, `missing embedded shell command after: ${anchor}`);
  const bodyStart = start + prefix.length;
  const end = source.indexOf(endMarker, bodyStart);
  assert.notEqual(end, -1, `missing embedded-shell terminator after: ${anchor}`);
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

function makeExecutable(filePath) {
  const result = spawnSync("bash", ["-c", 'chmod +x "$1"', "chmod-test", toBashPath(filePath)], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function writeExecutable(filePath, source) {
  writeFileSync(filePath, source, "utf8");
  makeExecutable(filePath);
}

function writeSha256Manifest(directory, files) {
  const entries = files.map((file) => {
    const payload = readFileSync(path.join(directory, file));
    const hash = crypto.createHash("sha256").update(payload).digest("hex");
    return `${hash}  ${file}`;
  });
  writeFileSync(path.join(directory, "manifest.sha256"), `${entries.join("\n")}\n`, "utf8");
}

function createDeployArchive(directory, remoteStartSource, overrides = {}) {
  const payload = path.join(directory, "payload");
  const deploy = path.join(payload, "deploy");
  mkdirSync(path.join(payload, "scripts"), { recursive: true });
  mkdirSync(deploy, { recursive: true });
  writeFileSync(path.join(payload, "new-only.txt"), "new source", "utf8");
  writeFileSync(path.join(payload, "release.json"), '{"version":"1.2.3"}\n', "utf8");
  writeFileSync(path.join(deploy, "docker-compose.yml"), overrides.compose ?? composeConfig, "utf8");
  writeFileSync(path.join(deploy, "Caddyfile"), overrides.caddy ?? caddyConfig, "utf8");
  writeExecutable(path.join(deploy, "remote-start.sh"), remoteStartSource);
  writeExecutable(path.join(deploy, "remote-rollback.sh"), "#!/bin/sh\nexit 99\n");
  const archive = path.join(directory, "release.tar.gz");
  const packed = spawnSync(
    "bash",
    ["-c", 'tar -czf "$1" -C "$2" .', "pack-test", toBashPath(archive), toBashPath(payload)],
    { encoding: "utf8" },
  );
  assert.equal(packed.status, 0, packed.stderr);
  return archive;
}

test("VPS backup uses external storage, one lock, unique snapshots, and guarded pruning", () => {
  assert.match(backup, /DEFAULT_BACKUP_DIR="\/var\/backups\/golden-pro-crm"/);
  assert.match(backup, /DEFAULT_LOCK_FILE="\/run\/golden-pro-crm\/backup-restore\.lock"/);
  assert.match(backup, /custom BACKUP_DIR requires BACKUP_APPROVED_BASE/);
  assert.match(backup, /BACKUP_DIR is outside BACKUP_APPROVED_BASE/);
  assert.match(backup, /BACKUP_KEEP_DAYS must be an integer from 1 through 3650/);
  assert.match(backup, /flock -n 9/);
  assert.match(backup, /CRM_BACKUP_LOCK_FD/);
  assert.match(backup, /COMPOSE_PROJECT=.*project-name/);
  assert.match(backup, /COMPOSE\+=\(--project-name "\$COMPOSE_PROJECT"\)/);
  assert.match(backup, /Inherited backup lock descriptor does not reference the shared lock file/);
  assert.match(backup, /RUN_ID="\$\{STAMP\}-\$\$-\$\{RANDOM\}"/);
  assert.match(backup, /_backup-\$\{RUN_ID\}\.db/);
  assert.match(backup, /_salla-integrations-\$\{RUN_ID\}\.json/);
  assert.match(backup, /const source = "\/app\/\.runtime\/salla-integrations\.json"/);
  assert.match(backup, /chmod 600 "\$DEST\/salla-integrations\.json"/);
  assert.match(backup, /docker cp "\$CID:\/app\/\.wa-session\/\." "\$DEST\/wa-session"[^\n]*\n\s*\|\| fail/);
  assert.match(backup, /WhatsApp session volume is missing/);
  assert.match(backup, /manifest_files\+=\("wa-session\.tar\.gz"\)/);
  assert.match(backup, /sha256sum --check --strict --status manifest\.sha256/);
  assert.match(backup, /DB_PATH does not match the backup\/restore database contract/);
  assert.match(backup, /if \[ "\$PRUNE_ENABLED" = "true" \]/);
  assert.ok(backup.includes('[[ "$candidate_name" =~ ^[0-9]{8}-[0-9]{6}-[0-9]+-[0-9]+$ ]]'));
  assert.match(backup, /\[ -f "\$candidate\/manifest\.sha256" \]/);
  assert.match(backup, /backup pruning disabled for this operation/);
});

test("VPS backup rejects root, outside-base, and unsafe lock destinations before mutation", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "crm-backup-path-policy-"));
  const approved = path.join(directory, "approved");
  mkdirSync(approved, { mode: 0o700 });
  const script = toBashPath(fileURLToPath(new URL("./vps-backup.sh", import.meta.url)));
  const common = {
    ...process.env,
    APP_DIR: toBashPath(directory),
    BACKUP_APPROVED_BASE: toBashPath(approved),
    BACKUP_APPROVED_LOCK_BASE: toBashPath(approved),
  };
  try {
    const rootResult = spawnSync("bash", [script], {
      encoding: "utf8",
      env: { ...common, BACKUP_DIR: "/" },
    });
    assert.notEqual(rootResult.status, 0);
    assert.match(rootResult.stderr, /BACKUP_DIR is unsafe/);

    const outsideBackup = toBashPath(path.join(directory, "outside-backups"));
    const outsideResult = spawnSync("bash", [script], {
      encoding: "utf8",
      env: { ...common, BACKUP_DIR: outsideBackup },
    });
    assert.notEqual(outsideResult.status, 0);
    assert.match(outsideResult.stderr, /outside BACKUP_APPROVED_BASE/);
    assert.equal(statSync(directory).isDirectory(), true);

    const safeBackup = toBashPath(path.join(approved, "backups"));
    const unsafeLock = toBashPath(path.join(directory, "outside.lock"));
    const lockResult = spawnSync("bash", [script], {
      encoding: "utf8",
      env: { ...common, BACKUP_DIR: safeBackup, BACKUP_LOCK_FILE: unsafeLock },
    });
    assert.notEqual(lockResult.status, 0);
    assert.match(lockResult.stderr, /outside BACKUP_APPROVED_LOCK_BASE/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("VPS restore enforces manifest whitelist, disables safety pruning, and checks SQLite before overwrite", () => {
  assert.match(restore, /DEFAULT_BACKUP_DIR="\/var\/backups\/golden-pro-crm"/);
  assert.match(restore, /BACKUP_DIR="\$\{BACKUP_DIR:-\$DEFAULT_BACKUP_DIR\}"/);
  assert.match(restore, /DEFAULT_LOCK_FILE="\/run\/golden-pro-crm\/backup-restore\.lock"/);
  assert.match(restore, /flock -n 9/);
  assert.match(restore, /COMPOSE_PROJECT=.*project-name/);
  assert.match(restore, /COMPOSE\+=\(--project-name "\$COMPOSE_PROJECT"\)/);
  assert.match(restore, /backup manifest must include golden-crm\.db\.gz/);
  assert.match(restore, /local -a allowed=/);
  for (const payload of ["golden-crm.db.gz", "salla-integrations.json", "wa-session.tar.gz", "env.production"]) {
    assert.ok(restore.includes(`"${payload}"`), `manifest whitelist is missing ${payload}`);
  }
  assert.match(restore, /BACKUP_PRUNE_ENABLED=false/);
  assert.match(restore, /CRM_BACKUP_LOCK_FD=9/);
  assert.match(restore, /pragma\("integrity_check"\)/);
  assert.match(restore, /docker cp "\$SALLA_SRC" "\$CID:\/app\/\.runtime\/salla-integrations\.json"/);
  assert.match(restore, /validate_wa_archive "\$SRC\/wa-session\.tar\.gz"/);
  assert.match(restore, /find "\$target" -mindepth 1 -maxdepth 1 ! -name/);
  assert.match(restore, /chown -R node:node "\$stage"/);
  assert.doesNotMatch(restore, /wa-session[\s\S]{0,220}?docker cp[\s\S]{0,80}?\|\| true/);
  assert.match(restore, /Restored CRM did not become healthy/);
  assert.match(restore, /Restore source is outside BACKUP_DIR or is not a direct backup directory/);
  assert.match(restore, /validate_trusted_regular_file "\$entry" "Backup source payload"/);
  assert.match(restore, /cannot be group\/world writable/);
  assert.match(restore, /cp --no-dereference --reflink=never/);
  assert.match(restore, /Backup payload changed while it was being staged/);
  assert.match(restore, /validate_manifest "\$STAGED_SRC"/);
  before(
    restore,
    "flock -n 9",
    'STAGING_ROOT="$BACKUP_DIR/.restore-staging"',
    "the restore lock must be held before a private source snapshot is staged",
  );
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

test("VPS restore rejects destructive or raced lock paths before opening them", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "crm-restore-lock-policy-"));
  const approved = path.join(directory, "approved");
  const backupDirectory = path.join(approved, "backups");
  const target = path.join(approved, "target.lock");
  const link = path.join(approved, "link.lock");
  mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(target, "unchanged", "utf8");
  let linkCreated = false;
  try {
    symlinkSync(target, link);
    linkCreated = true;
  } catch (error) {
    if (process.platform !== "win32" || error?.code !== "EPERM") throw error;
  }
  const script = toBashPath(fileURLToPath(new URL("./vps-restore.sh", import.meta.url)));
  const source = toBashPath(directory);
  const common = {
    ...process.env,
    APP_DIR: toBashPath(directory),
    BACKUP_DIR: toBashPath(backupDirectory),
    BACKUP_APPROVED_BASE: toBashPath(approved),
    BACKUP_APPROVED_LOCK_BASE: toBashPath(approved),
  };
  try {
    const invalidLocks = [
      ["/", /BACKUP_LOCK_FILE is unsafe/],
      ["/etc/passwd", /requires a safe BACKUP_APPROVED_LOCK_BASE|outside BACKUP_APPROVED_LOCK_BASE/],
      [toBashPath(path.join(directory, "outside.lock")), /outside BACKUP_APPROVED_LOCK_BASE/],
    ];
    if (linkCreated) invalidLocks.push([toBashPath(link), /cannot be a symlink/]);
    for (const [lockPath, message] of invalidLocks) {
      const result = spawnSync("bash", [script, source], {
        encoding: "utf8",
        env: { ...common, BACKUP_LOCK_FILE: lockPath },
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, message);
    }
    assert.equal(readFileSync(target, "utf8"), "unchanged");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("VPS restore confines trusted sources and rejects writable or swapped payloads", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "crm-restore-source-policy-"));
  const approved = path.join(directory, "approved");
  const backupDirectory = path.join(approved, "backups");
  const app = path.join(directory, "app");
  const outside = path.join(directory, "outside-backup");
  const writableSource = path.join(backupDirectory, "writable-source");
  const writablePayload = path.join(backupDirectory, "writable-payload");
  const racedSource = path.join(backupDirectory, "raced-source");
  const bin = path.join(directory, "bin");
  mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(app, { mode: 0o700 });
  mkdirSync(bin, { mode: 0o700 });

  const setMode = (mode, target) => {
    const result = spawnSync(
      "bash",
      ["-c", 'chmod "$1" "$2"', "restore-source-chmod", mode, toBashPath(target)],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
  };
  const createSource = (target) => {
    mkdirSync(target, { mode: 0o700 });
    const payload = Buffer.from("original-payload");
    const hash = crypto.createHash("sha256").update(payload).digest("hex");
    writeFileSync(path.join(target, "golden-crm.db.gz"), payload, { mode: 0o600 });
    writeFileSync(path.join(target, "manifest.sha256"), `${hash}  golden-crm.db.gz\n`, { mode: 0o600 });
    setMode("700", target);
    setMode("600", path.join(target, "golden-crm.db.gz"));
    setMode("600", path.join(target, "manifest.sha256"));
  };
  for (const target of [approved, backupDirectory, app, bin]) setMode("700", target);
  writeExecutable(path.join(bin, "flock"), "#!/bin/sh\nexit 0\n");
  writeExecutable(path.join(bin, "find"), [
    "#!/bin/sh",
    "permission_check=false",
    'for argument in "$@"; do [ "$argument" != "/022" ] || permission_check=true; done',
    'if [ "$permission_check" = true ] && [ -n "${STUB_WRITABLE_PATH:-}" ] && [ "${1:-}" = "$STUB_WRITABLE_PATH" ]; then',
    '  printf "%s\\n" "$1"',
    "  exit 0",
    "fi",
    'exec /usr/bin/find "$@"',
    "",
  ].join("\n"));
  const script = toBashPath(fileURLToPath(new URL("./vps-restore.sh", import.meta.url)));
  const common = {
    ...process.env,
    PATH: `${toBashPath(bin)}:${process.env.PATH}`,
    APP_DIR: toBashPath(app),
    BACKUP_DIR: toBashPath(backupDirectory),
    BACKUP_APPROVED_BASE: toBashPath(approved),
    BACKUP_LOCK_FILE: toBashPath(path.join(approved, "restore.lock")),
    BACKUP_APPROVED_LOCK_BASE: toBashPath(approved),
  };
  const runRestore = (source, env = common) => spawnSync(
    "bash",
    [script, toBashPath(source)],
    { encoding: "utf8", env },
  );

  try {
    for (const target of [outside, writableSource, writablePayload, racedSource]) createSource(target);

    const outsideResult = runRestore(outside);
    assert.equal(outsideResult.status, 2, outsideResult.stderr);
    assert.match(outsideResult.stderr, /outside BACKUP_DIR|direct backup directory/i);

    setMode("770", writableSource);
    const writableDirectoryResult = runRestore(writableSource, {
      ...common,
      STUB_WRITABLE_PATH: toBashPath(writableSource),
    });
    assert.equal(writableDirectoryResult.status, 2, writableDirectoryResult.stderr);
    assert.match(writableDirectoryResult.stderr, /source directory cannot be group\/world writable/i);

    setMode("660", path.join(writablePayload, "golden-crm.db.gz"));
    const writablePayloadResult = runRestore(writablePayload, {
      ...common,
      STUB_WRITABLE_PATH: toBashPath(path.join(writablePayload, "golden-crm.db.gz")),
    });
    assert.equal(writablePayloadResult.status, 2, writablePayloadResult.stderr);
    assert.match(writablePayloadResult.stderr, /source payload cannot be group\/world writable/i);

    writeExecutable(path.join(bin, "cp"), [
      "#!/usr/bin/env bash",
      'source="${@: -2:1}"',
      '/usr/bin/cp "$@"',
      'if [[ "$source" == */golden-crm.db.gz ]]; then',
      '  replacement="${source}.replacement"',
      '  printf %s "raced-payload" > "$replacement"',
      '  chmod 600 "$replacement"',
      '  mv -f -- "$replacement" "$source"',
      "fi",
      "",
    ].join("\n"));
    const raced = runRestore(racedSource);
    assert.equal(raced.status, 2, raced.stderr);
    assert.match(raced.stderr, /payload changed while it was being staged/i);
    assert.doesNotMatch(raced.stderr, /original-payload|raced-payload/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("manual VPS deployment uploads immutable inputs then delegates one locked transaction", () => {
  assert.match(deployVps, /npm run test:unit\s+Assert-NativeSuccess "Unit test suite"/);
  assert.match(deployVps, /AllowFirstDeployWithoutBackup/);
  assert.match(deployVps, /TRUST_PROXY_HEADERS.*-cne "true"/);
  assert.match(deployVps, /VITE_PUBLIC_CONTACT_PHONE/);
  assert.match(deployVps, /\^\\\+\[1-9\]\[0-9\]\{7,14\}\$/);
  assert.match(deployVps, /scripts\/vps-deploy-transaction\.sh/);
  assert.match(deployVps, /scripts\/vps-backup\.sh/);
  assert.match(deployVps, /scripts\/vps-preserve-deploy-state\.sh/);
  assert.match(deployVps, /deploy\/remote-rollback\.sh/);
  assert.match(deployVps, /DEPLOY_BACKUP_HELPER='\$remoteBackup'/);
  assert.match(deployVps, /DEPLOY_PRESERVE_HELPER='\$remotePreserve'/);
  assert.match(deployVps, /DEPLOY_ROLLBACK_HELPER='\$remoteRollback'/);
  assert.match(deployVps, /EXPECTED_VERSION='\$releaseVersion'/);
  assert.match(deployVps, /EXPECTED_BUILD='\$buildCommit'/);
  assert.match(deployVps, /ERP_DOMAIN='\$ErpDomain'/);
  assert.match(deployVps, /FIRST_DEPLOY_CADDY_DATA_VOLUME='\$CaddyDataVolume'/);
  assert.match(deployVps, /FIRST_DEPLOY_CADDY_CONFIG_VOLUME='\$CaddyConfigVolume'/);
  for (const status of [1, 2, 75]) assert.match(deployVps, new RegExp(`transactionExit -eq ${status}`));
  assert.match(deployVps, /remoteBundleCreated.*transactionStarted.*transactionResolved/);
  assert.match(deployVps, /mktemp -d \/tmp\/golden-pro-crm-deploy\.XXXXXXXXXX/);
  assert.match(deployVps, /DB_PATH must resolve to \/app\/\.runtime\/golden-crm\.db/);
  assert.match(deployVps, /DEPLOY_APPROVED_APP_BASE='\$ApprovedAppBase'/);
  assert.doesNotMatch(deployVps, /tar -xzf .* -C '\$AppDir'/);
});

test("deployment transaction owns both locks and restores source as a clean rename swap", () => {
  assert.match(deployTransaction, /LOCK_FILE="\/run\/golden-pro-crm\/deploy\.lock"/);
  assert.match(deployTransaction, /BACKUP_LOCK_FILE="\/run\/golden-pro-crm\/backup-restore\.lock"/);
  assert.match(deployTransaction, /LEGACY_BACKUP_LOCK_FILE="\/var\/lock\/golden-pro-crm-backup-restore\.lock"/);
  assert.match(deployTransaction, /flock -n 8/);
  assert.match(deployTransaction, /flock -n 7/);
  assert.match(deployTransaction, /flock -n 9/);
  assert.match(deployTransaction, /stat -Lc '%d:%i'/);
  assert.match(deployTransaction, /export CRM_BACKUP_LOCK_FD=9/);
  assert.match(deployTransaction, /DEPLOY_BACKUP_HELPER/);
  assert.match(deployTransaction, /DB_PATH_VALUE=[\s\S]*tail -n 1/);
  assert.match(deployTransaction, /DB_PATH must resolve to \/app\/\.runtime\/golden-crm\.db before deployment/);
  assert.match(deployTransaction, /DEPLOY_PRESERVE_HELPER/);
  assert.match(deployTransaction, /DEPLOY_ROLLBACK_HELPER/);
  assert.match(deployTransaction, /APP_DIR's parent must be deploy-user owned and not group\/world writable/);
  assert.match(deployTransaction, /active Compose path must be deploy-user owned and not group\/world writable/);
  before(deployTransaction, 'flock -n 8', 'bash "$TRUSTED_BACKUP"', "the deploy lock must precede backup");
  before(deployTransaction, 'flock -n 9', 'bash "$TRUSTED_BACKUP"', "the backup/restore lock must precede backup");
  before(deployTransaction, 'bash "$TRUSTED_BACKUP"', 'mv -- "$APP_DIR" "$PREVIOUS_SOURCE"', "backup must precede source swap");
  assert.match(deployTransaction, /mv -- "\$APP_DIR" "\$FAILED_SOURCE"/);
  assert.match(deployTransaction, /mv -- "\$previous_candidate" "\$APP_DIR"/);
  assert.match(deployTransaction, /mv -- "\$PREVIOUS_SOURCE" "\$RETAINED_SOURCE"/);
  assert.match(deployTransaction, /source retention must share APP_DIR's filesystem/);
  assert.doesNotMatch(deployTransaction, /cp -a -- "\$APP_DIR\/\.git"/);
  const ownershipSafeExtraction = 'tar --extract --gzip --no-same-owner --file "$DEPLOY_ARCHIVE" --directory "$STAGED_SOURCE"';
  assert.ok(deployTransaction.includes(ownershipSafeExtraction), "release extraction must discard archive-supplied numeric owners");
  assert.doesNotMatch(deployTransaction, /chown[^\n]*\$STAGED_SOURCE/);
  before(
    deployTransaction,
    ownershipSafeExtraction,
    'mv -- "$APP_DIR" "$PREVIOUS_SOURCE"',
    "ownership-safe extraction must complete before the source swap",
  );
  assert.match(deployTransaction, /https:\/\/\$CRM_DOMAIN\/api\/health/);
  assert.match(deployTransaction, /https:\/\/\$CRM_DOMAIN\/api\/version/);
  assert.match(deployTransaction, /staged_proxy_contract_matches/);
  assert.match(deployTransaction, /host\.docker\.internal:host-gateway/);
  assert.match(deployTransaction, /First deployment requires existing named Caddy data\/config volumes/);
  assert.match(deployTransaction, /--cap-drop ALL --cap-add NET_BIND_SERVICE/);
  before(
    deployTransaction,
    "staged_proxy_contract_matches",
    'mv -- "$APP_DIR" "$PREVIOUS_SOURCE"',
    "the CRM/ERP proxy contract must be checked before the source swap",
  );
  before(
    deployTransaction,
    "verifying first-deploy Caddy volumes",
    'mv -- "$APP_DIR" "$PREVIOUS_SOURCE"',
    "first-deploy Caddy prerequisites must be checked before the source swap",
  );
});

test("deployment-state preservation captures the actual running files and rollback image atomically", () => {
  assert.match(preserveDeployState, /com\.docker\.compose\.project\.config_files/);
  assert.match(preserveDeployState, /docker cp "\$CADDY_CID:\/etc\/caddy\/Caddyfile"/);
  assert.match(preserveDeployState, /capture_caddy_volume "\/data"/);
  assert.match(preserveDeployState, /capture_caddy_volume "\/config"/);
  assert.match(preserveDeployState, /\.Type \.Name/);
  assert.match(preserveDeployState, /caddy-data-volume caddy-config-volume/);
  assert.match(preserveDeployState, /capture_previous_proxy_contract/);
  assert.match(preserveDeployState, /previous-crm-domain previous-erp-domain/);
  assert.match(preserveDeployState, /previous-require-crm-origin previous-require-erp-endpoint/);
  assert.match(preserveDeployState, /ACTIVE_ROOT=.*dirname "\$COMPOSE_LABEL"/);
  assert.match(preserveDeployState, /cp -- "\$ACTIVE_ENV" "\$TMP_DIR\/env\.production"/);
  assert.match(preserveDeployState, /CRM_ACTIVE_ENV_FILE/);
  assert.match(preserveDeployState, /docker image tag "\$OLD_IMAGE_ID" "\$ROLLBACK_IMAGE"/);
  assert.match(preserveDeployState, /sha256sum Caddyfile docker-compose\.yml env\.production/);
  const installIndex = preserveDeployState.indexOf('mv -- "$TMP_DIR" "$ROLLBACK_DIR"');
  const finalCleanupIndex = preserveDeployState.lastIndexOf('rm -rf -- "$PREVIOUS_DIR"');
  assert.notEqual(installIndex, -1, "the temporary state must be installed atomically");
  assert.ok(finalCleanupIndex > installIndex, "the previous snapshot must be cleaned only after replacement");
});

test("preservation derives the current VPS CRM env domain and the later hard-coded ERP block", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "crm-preserved-proxy-contract-test-"));
  const app = path.join(directory, "app");
  const deploy = path.join(app, "deploy");
  const bin = path.join(directory, "bin");
  const composePath = path.join(deploy, "docker-compose.yml");
  const envPath = path.join(app, ".env.production");
  const runningCaddyfile = path.join(directory, "running-Caddyfile");
  mkdirSync(deploy, { recursive: true });
  mkdirSync(bin);
  writeFileSync(composePath, "services:\n  crm: {}\n  caddy: {}\n", "utf8");
  writeFileSync(envPath, "TRUST_PROXY_HEADERS=true\n", "utf8");
  writeFileSync(runningCaddyfile, [
    "{ auto_https off }",
    "http://{$CRM_DOMAIN} {",
    "  reverse_proxy crm:8080",
    "}",
    "https://status.example.com {",
    "  reverse_proxy status:9000",
    "}",
    "http://erp.breexe-pro.com { redir https://{host}{uri} permanent }",
    "https://erp.breexe-pro.com {",
    "  tls /data/caddy/certificates/erp.crt /data/caddy/certificates/erp.key",
    "  reverse_proxy host.docker.internal:8069",
    "}",
    "",
  ].join("\n"), "utf8");

  writeExecutable(path.join(bin, "docker"), [
    "#!/usr/bin/env bash",
    "set -eu",
    'case "${1:-}" in',
    "  ps) printf '%s\\n' caddy-cid ;;",
    "  inspect)",
    '    args=" $* "',
    '    case "$args" in',
    '      *".State.Running"*) printf "%s\\n" true ;;',
    '      *"project.config_files"*) printf "%s\\n" "$ACTIVE_COMPOSE" ;;',
    '      *"com.docker.compose.project"*) printf "%s\\n" deploy ;;',
    '      *"eq .Destination \\\"/data\\\""*) printf "%s\\n" "volume|deploy_caddy_data" ;;',
    '      *"eq .Destination \\\"/config\\\""*) printf "%s\\n" "volume|deploy_caddy_config" ;;',
    '      *".Config.Env"*)',
    '        if [ "${*: -1}" = caddy-cid ]; then printf "%s\\n" "CRM_DOMAIN=crm.breexe-pro.com"; else printf "%s\\n" "BUILD_COMMIT=oldbuild123"; fi',
    '        ;;',
    '      *"{{.Image}}"*) printf "%s\\n" sha256:old-image ;;',
    "    esac",
    "    ;;",
    "  volume) exit 0 ;;",
    "  cp) /usr/bin/cp \"$RUNNING_CADDYFILE\" \"${3:?}\" ;;",
    "  image) exit 0 ;;",
    "  exec) printf '%s' 1.3.6 ;;",
    "  *) exit 0 ;;",
    "esac",
    "",
  ].join("\n"));

  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH || ""}`,
    APP_DIR: toBashPath(app),
    CRM_CID: "crm-cid",
    CRM_ACTIVE_ENV_FILE: toBashPath(envPath),
    ACTIVE_COMPOSE: toBashPath(composePath),
    RUNNING_CADDYFILE: toBashPath(runningCaddyfile),
  };

  try {
    const result = spawnSync(
      "bash",
      [toBashPath(fileURLToPath(new URL("./vps-preserve-deploy-state.sh", import.meta.url)))],
      { encoding: "utf8", env },
    );
    assert.equal(result.status, 0, result.stderr);
    const rollback = path.join(app, ".deploy-rollback");
    assert.equal(readFileSync(path.join(rollback, "previous-crm-domain"), "utf8"), "crm.breexe-pro.com\n");
    assert.equal(readFileSync(path.join(rollback, "previous-erp-domain"), "utf8"), "erp.breexe-pro.com\n");
    assert.equal(readFileSync(path.join(rollback, "previous-require-crm-origin"), "utf8"), "true\n");
    assert.equal(readFileSync(path.join(rollback, "previous-require-erp-endpoint"), "utf8"), "true\n");
    assert.equal(readFileSync(path.join(rollback, "previous-crm-origin-scheme"), "utf8"), "http\n");
    const checksum = spawnSync("bash", ["-c", 'cd "$1" && sha256sum --check --strict --status manifest.sha256', "checksum", toBashPath(rollback)], { encoding: "utf8" });
    assert.equal(checksum.status, 0, checksum.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("remote start validates Caddy, builds first, recreates both services, and checks the exact release", () => {
  assert.match(remoteStart, /ROLLBACK_IMAGE="golden-pro-crm:rollback"/);
  assert.match(remoteStart, /TRUST_PROXY_HEADERS.*must be true/);
  assert.match(remoteStart, /VITE_PUBLIC_CONTACT_PHONE.*valid E\.164/);
  assert.match(remoteStart, /--project-name "\$PROJECT_NAME"/);
  assert.match(remoteStart, /docker volume inspect "\$value"/);
  assert.match(remoteStart, /type=volume,src=\$CADDY_DATA_VOLUME,dst=\/data,readonly/);
  assert.match(remoteStart, /type=volume,src=\$CADDY_CONFIG_VOLUME,dst=\/config,readonly/);
  assert.match(remoteStart, /--network none --cap-drop ALL --cap-add NET_BIND_SERVICE/);
  assert.match(remoteStart, /-e ERP_DOMAIN="\$ERP_DOMAIN"/);
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
  assert.match(remoteStart, /--header "Host: \$CRM_DOMAIN" "http:\/\/127\.0\.0\.1\/api\/health"/);
  assert.match(remoteStart, /--resolve "\$domain:443:127\.0\.0\.1"/);
  assert.match(remoteStart, /"https:\/\/\$domain\/web\/login"/);
  assert.ok(remoteStart.includes("grep -Eiq '<title[[:space:]]*>[[:space:]]*odoo([[:space:]<]|$)'"));
  assert.doesNotMatch(remoteStart, /--resolve "\$CRM_DOMAIN:443:127\.0\.0\.1"/);
  assert.match(remoteStart, /if ! wait_for_release/);
  assert.match(remoteStart, /bash "\$APP_DIR\/deploy\/remote-rollback\.sh"/);
});

test("remote rollback restores image, env, Compose, and Caddy then verifies both paths", () => {
  assert.match(remoteRollback, /sha256sum --check --strict --status manifest\.sha256/);
  assert.match(remoteRollback, /docker volume inspect "\$value"/);
  assert.match(remoteRollback, /type=volume,src=\$CADDY_DATA_VOLUME,dst=\/data,readonly/);
  assert.match(remoteRollback, /type=volume,src=\$CADDY_CONFIG_VOLUME,dst=\/config,readonly/);
  assert.match(remoteRollback, /--network none --cap-drop ALL --cap-add NET_BIND_SERVICE/);
  assert.match(remoteRollback, /PREVIOUS_CRM_DOMAIN/);
  assert.match(remoteRollback, /PREVIOUS_ERP_DOMAIN/);
  assert.match(remoteRollback, /mv -f "\$APP_DIR\/\.env\.production\.rollback-next" "\$APP_DIR\/\.env\.production"/);
  assert.match(remoteRollback, /docker-compose\.yml\.rollback-next/);
  assert.match(remoteRollback, /Caddyfile\.rollback-next/);
  assert.match(remoteRollback, /docker image tag "\$ROLLBACK_IMAGE" "\$RUNTIME_IMAGE"/);
  assert.match(remoteRollback, /docker image tag "\$ROLLBACK_IMAGE" "deploy-crm:latest"/);
  assert.match(remoteRollback, /up -d --no-build --force-recreate crm caddy/);
  assert.match(remoteRollback, /--header "Host: \$PREVIOUS_CRM_DOMAIN" "http:\/\/127\.0\.0\.1\/api\/health"/);
  assert.match(remoteRollback, /erp_login_matches "\$PREVIOUS_ERP_DOMAIN"/);
  assert.match(remoteRollback, /--resolve "\$domain:443:127\.0\.0\.1"/);
  assert.match(remoteRollback, /"https:\/\/\$domain\/web\/login"/);
  assert.ok(remoteRollback.includes("grep -Eiq '<title[[:space:]]*>[[:space:]]*odoo([[:space:]<]|$)'"));
  assert.doesNotMatch(remoteRollback, /--resolve "\$CRM_DOMAIN:443:127\.0\.0\.1"/);
});

test("ERP login probes accept an Odoo page and reject unrelated successful HTML without a pipeline", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "crm-erp-login-probe-test-"));
  const bin = path.join(directory, "bin");
  const curlLog = path.join(directory, "curl.log");
  mkdirSync(bin);
  writeExecutable(path.join(bin, "curl"), [
    "#!/usr/bin/env bash",
    "set -eu",
    'printf "%s\\n" "$*" >> "$ERP_TEST_CURL_LOG"',
    'output=""',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    --output) output="$2"; shift 2 ;;',
    '    *) shift ;;',
    '  esac',
    'done',
    '[ -n "$output" ] || exit 91',
    'printf "%s" "${ERP_TEST_BODY:-}" > "$output"',
    'exit "${ERP_TEST_CURL_STATUS:-0}"',
    "",
  ].join("\n"));

  const probes = [
    ["remote start", shellFunction(remoteStart, "erp_login_matches", "wait_for_release")],
    ["remote rollback", shellFunction(remoteRollback, "erp_login_matches", "contract_matches")],
  ];
  const common = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH || ""}`,
    ERP_TEST_CURL_LOG: toBashPath(curlLog),
  };

  try {
    for (const [label, probe] of probes) {
      assert.match(probe, /--output "\$response_file"/);
      assert.doesNotMatch(probe, /\|\s*grep/);
      writeFileSync(curlLog, "", "utf8");
      const command = `${probe}\nerp_login_matches "$1"`;
      const accepted = spawnSync(
        "bash",
        ["-c", command, label, "erp.breexe-pro.com"],
        { encoding: "utf8", env: { ...common, ERP_TEST_BODY: "<html><TITLE >   oDoO</TITLE></html>" } },
      );
      assert.equal(accepted.status, 0, `${label}: ${accepted.stderr}`);
      const request = readFileSync(curlLog, "utf8");
      assert.match(request, /--resolve erp\.breexe-pro\.com:443:127\.0\.0\.1/);
      assert.match(request, /https:\/\/erp\.breexe-pro\.com\/web\/login/);

      const unrelated = spawnSync(
        "bash",
        ["-c", command, label, "erp.breexe-pro.com"],
        { encoding: "utf8", env: { ...common, ERP_TEST_BODY: "<html><title>Customer portal</title></html>" } },
      );
      assert.equal(unrelated.status, 1, `${label} accepted a non-Odoo HTTP 200 page`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("bundled Caddy and Compose retain the VPS CRM/ERP host contract", () => {
  assert.match(caddyConfig, /auto_https off/);
  assert.match(caddyConfig, /http:\/\/\{\$CRM_DOMAIN\}/);
  assert.match(caddyConfig, /https:\/\/\{\$ERP_DOMAIN\}/);
  assert.match(caddyConfig, /\{\$ERP_DOMAIN\}\.crt[\s\S]*\{\$ERP_DOMAIN\}\.key/);
  assert.match(caddyConfig, /reverse_proxy host\.docker\.internal:8069/);
  assert.match(composeConfig, /extra_hosts:[\s\S]*host\.docker\.internal:host-gateway/);
  assert.match(composeConfig, /ERP_DOMAIN: \$\{ERP_DOMAIN:-erp\.breexe-pro\.com\}/);
  assert.match(composeConfig, /caddy_data:\/data/);
  assert.match(composeConfig, /caddy_config:\/config/);
  assert.match(composeConfig, /name: \$\{CADDY_DATA_VOLUME:-deploy_caddy_data\}/);
  assert.match(composeConfig, /name: \$\{CADDY_CONFIG_VOLUME:-deploy_caddy_config\}/);
});

test("deployment rejects a release that drops the ERP host-gateway contract before swapping AppDir", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "crm-proxy-contract-test-"));
  const app = path.join(directory, "app");
  const bin = path.join(directory, "bin");
  const helper = path.join(directory, "helper.sh");
  mkdirSync(app);
  mkdirSync(bin);
  writeFileSync(path.join(app, "old-only.txt"), "old source", "utf8");
  const brokenCompose = composeConfig.replace(/    extra_hosts:\r?\n      - "host\.docker\.internal:host-gateway"\r?\n/, "");
  assert.notEqual(brokenCompose, composeConfig, "the fixture must remove host-gateway");
  createDeployArchive(directory, "#!/bin/sh\ntouch \"$APP_DIR/remote-start-ran\"\n", { compose: brokenCompose });
  writeExecutable(path.join(bin, "docker"), "#!/bin/sh\nexit 0\n");
  writeExecutable(path.join(bin, "flock"), "#!/bin/sh\nexit 0\n");
  writeExecutable(helper, "#!/bin/sh\nexit 99\n");
  writeFileSync(path.join(directory, "env.production"), "TRUST_PROXY_HEADERS=true\nDB_PATH=.runtime/golden-crm.db\n", "utf8");
  const command = [
    'PATH="$1:$PATH"',
    'DEPLOY_TRANSACTION_TESTING=true DEPLOY_TEST_LOCK_FILE="$2/deploy.lock" DEPLOY_TEST_BACKUP_LOCK_FILE="$2/backup.lock"',
    'DEPLOY_TEST_SOURCE_RETENTION_ROOT="$2/source-trees" DEPLOY_APPROVED_APP_BASE="$2"',
    'APP_DIR="$2/app" CRM_DOMAIN=crm.breexe-pro.com ERP_DOMAIN=erp.breexe-pro.com',
    'DEPLOY_ARCHIVE="$2/release.tar.gz" DEPLOY_ENV_FILE="$2/env.production"',
    'DEPLOY_BACKUP_HELPER="$2/helper.sh" DEPLOY_PRESERVE_HELPER="$2/helper.sh" DEPLOY_ROLLBACK_HELPER="$2/helper.sh"',
    'USE_EXISTING_ENV=false ALLOW_FIRST_DEPLOY=true EXPECTED_VERSION=1.2.3 EXPECTED_BUILD=abcdef123456',
    'HEALTH_RETRIES=1 HEALTH_SLEEP=1 bash "$3"',
  ].join(" ");

  try {
    const result = spawnSync(
      "bash",
      ["-c", command, "proxy-contract-test", toBashPath(bin), toBashPath(directory), toBashPath(fileURLToPath(deployTransactionUrl))],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /would drop the required CRM\/ERP proxy or Caddy volume contract/i);
    assert.equal(readFileSync(path.join(app, "old-only.txt"), "utf8"), "old source");
    assert.throws(() => readFileSync(path.join(app, "new-only.txt"), "utf8"));
    assert.throws(() => readFileSync(path.join(app, "remote-start-ran"), "utf8"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("first deployment rejects missing volumes or ERP certificates before source replacement", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "crm-first-deploy-caddy-test-"));
  const app = path.join(directory, "app");
  const bin = path.join(directory, "bin");
  const helper = path.join(directory, "helper.sh");
  const dockerLog = path.join(directory, "docker.log");
  mkdirSync(app);
  mkdirSync(bin);
  writeFileSync(path.join(app, "old-only.txt"), "old source", "utf8");
  createDeployArchive(directory, "#!/bin/sh\ntouch \"$APP_DIR/remote-start-ran\"\n");
  writeExecutable(path.join(bin, "docker"), [
    "#!/usr/bin/env bash",
    'printf "%s\\n" "$*" >> "$DOCKER_LOG"',
    'if [ "${1:-}:${2:-}" = "volume:inspect" ]; then [ "${FIRST_DEPLOY_TEST_MODE:-}" = missing ] && exit 41; exit 0; fi',
    'if [ "${1:-}" = run ]; then',
    '  case " $* " in *" --cap-drop ALL --cap-add NET_BIND_SERVICE "*) ;; *) exit 42 ;; esac',
    '  [ "${FIRST_DEPLOY_TEST_MODE:-}" = bad-cert ] && exit 43',
    "fi",
    "exit 0",
    "",
  ].join("\n"));
  writeExecutable(path.join(bin, "flock"), "#!/bin/sh\nexit 0\n");
  writeExecutable(helper, "#!/bin/sh\nexit 99\n");
  writeFileSync(path.join(directory, "env.production"), "TRUST_PROXY_HEADERS=true\nDB_PATH=.runtime/golden-crm.db\n", "utf8");
  const command = [
    'PATH="$1:$PATH" DOCKER_LOG="$2/docker.log" FIRST_DEPLOY_TEST_MODE="$4"',
    'DEPLOY_TRANSACTION_TESTING=true DEPLOY_TEST_LOCK_FILE="$2/deploy.lock" DEPLOY_TEST_BACKUP_LOCK_FILE="$2/backup.lock"',
    'DEPLOY_TEST_SOURCE_RETENTION_ROOT="$2/source-trees" DEPLOY_APPROVED_APP_BASE="$2"',
    'APP_DIR="$2/app" CRM_DOMAIN=crm.breexe-pro.com ERP_DOMAIN=erp.breexe-pro.com',
    'DEPLOY_ARCHIVE="$2/release.tar.gz" DEPLOY_ENV_FILE="$2/env.production"',
    'DEPLOY_BACKUP_HELPER="$2/helper.sh" DEPLOY_PRESERVE_HELPER="$2/helper.sh" DEPLOY_ROLLBACK_HELPER="$2/helper.sh"',
    'USE_EXISTING_ENV=false ALLOW_FIRST_DEPLOY=true EXPECTED_VERSION=1.2.3 EXPECTED_BUILD=abcdef123456',
    'HEALTH_RETRIES=1 HEALTH_SLEEP=1 bash "$3"',
  ].join(" ");

  try {
    for (const [mode, errorPattern] of [
      ["missing", /requires existing named Caddy data\/config volumes/i],
      ["bad-cert", /requires a valid ERP certificate\/key/i],
    ]) {
      writeFileSync(dockerLog, "", "utf8");
      const result = spawnSync(
        "bash",
        ["-c", command, "first-deploy-caddy-test", toBashPath(bin), toBashPath(directory), toBashPath(fileURLToPath(deployTransactionUrl)), mode],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, errorPattern);
      assert.equal(readFileSync(path.join(app, "old-only.txt"), "utf8"), "old source");
      assert.throws(() => readFileSync(path.join(app, "new-only.txt"), "utf8"));
      assert.throws(() => readFileSync(path.join(app, "remote-start-ran"), "utf8"));
    }
    const log = readFileSync(dockerLog, "utf8");
    assert.match(log, /volume inspect deploy_caddy_data deploy_caddy_config/);
    assert.match(log, /--network none --cap-drop ALL --cap-add NET_BIND_SERVICE/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rollback validates manual TLS with the preserved Caddy volumes and fails closed when one is unavailable", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "crm-caddy-rollback-test-"));
  const app = path.join(directory, "app");
  const rollback = path.join(app, ".deploy-rollback");
  const deploy = path.join(app, "deploy");
  const bin = path.join(directory, "bin");
  const dockerLog = path.join(directory, "docker.log");
  mkdirSync(rollback, { recursive: true });
  mkdirSync(deploy, { recursive: true });
  mkdirSync(bin);

  const files = {
    Caddyfile: [
      "{ auto_https off }",
      "http://{$CRM_DOMAIN} { reverse_proxy crm:8080 }",
      "https://erp.breexe-pro.com {",
      "  tls /data/caddy/certificates/erp.crt /data/caddy/certificates/erp.key",
      "  reverse_proxy host.docker.internal:8069",
      "}",
      "",
    ].join("\n"),
    "docker-compose.yml": "services:\n  crm: {}\n  caddy: {}\n",
    "env.production": "TRUST_PROXY_HEADERS=true\n",
    "previous-build": "oldbuild123\n",
    "previous-version": "1.3.6\n",
    "project-name": "deploy\n",
    "caddy-data-volume": "deploy_caddy_data\n",
    "caddy-config-volume": "deploy_caddy_config\n",
    "previous-crm-domain": "crm.breexe-pro.com\n",
    "previous-erp-domain": "erp.breexe-pro.com\n",
    "previous-require-crm-origin": "true\n",
    "previous-require-erp-endpoint": "true\n",
    "previous-crm-origin-scheme": "http\n",
  };
  for (const [name, payload] of Object.entries(files)) {
    writeFileSync(path.join(rollback, name), payload, "utf8");
  }
  writeSha256Manifest(rollback, Object.keys(files));

  writeExecutable(path.join(bin, "docker"), [
    "#!/usr/bin/env bash",
    "set -eu",
    'printf "%s\\n" "$*" >> "$DOCKER_LOG"',
    'case "${1:-}:${2:-}" in',
    "  image:inspect|image:tag) exit 0 ;;",
    "  volume:inspect)",
    '    case "${3:-}" in deploy_caddy_data|deploy_caddy_config) exit 0 ;; *) exit 41 ;; esac',
    "    ;;",
    "  run:*)",
    '    args=" $* "',
    '    case "$args" in *" --network none "*) ;; *) exit 42 ;; esac',
    '    case "$args" in *" --cap-drop ALL --cap-add NET_BIND_SERVICE "*) ;; *) exit 43 ;; esac',
    '    case "$args" in *" --mount type=volume,src=deploy_caddy_data,dst=/data,readonly "*) ;; *) exit 44 ;; esac',
    '    case "$args" in *" --mount type=volume,src=deploy_caddy_config,dst=/config,readonly "*) ;; *) exit 45 ;; esac',
    '    case "$args" in *",dst=/etc/caddy/Caddyfile,readonly "*) ;; *) exit 46 ;; esac',
    "    exit 0 ;;",
    "  compose:*)",
    '    case " $* " in *" ps -q crm "*) printf "%s\\n" crm-cid ;; esac',
    "    exit 0 ;;",
    "  inspect:--format) printf '%s\\n' healthy; exit 0 ;;",
    "  exec:*) cat >/dev/null || true; exit 0 ;;",
    "  *) exit 0 ;;",
    "esac",
    "",
  ].join("\n"));
  writeExecutable(path.join(bin, "curl"), [
    "#!/usr/bin/env bash",
    'printf "curl %s\\n" "$*" >> "$DOCKER_LOG"',
    'if [[ " $* " == *"/web/login"* ]]; then',
    '  output=""',
    '  while [ "$#" -gt 0 ]; do',
    '    case "$1" in --output) output="$2"; shift 2 ;; *) shift ;; esac',
    '  done',
    '  [ -n "$output" ] || exit 81',
    '  [ "${ERP_TEST_FORCE_FAILURE:-false}" != true ] || exit 82',
    '  body="${ERP_TEST_BODY:-}"',
    '  [ -n "$body" ] || body="<html><title>Odoo</title></html>"',
    '  printf "%s" "$body" > "$output"',
    '  exit 0',
    'fi',
    "printf '%s\\n' '{\"status\":\"ok\",\"release\":{\"version\":\"1.3.6\"},\"commit\":\"oldbuild123\"}'",
    "",
  ].join("\n"));

  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH || ""}`,
    APP_DIR: toBashPath(app),
    CRM_DOMAIN: "new-crm.invalid.example",
    ERP_DOMAIN: "new-erp.invalid.example",
    HEALTH_RETRIES: "1",
    HEALTH_SLEEP: "1",
    DOCKER_LOG: toBashPath(dockerLog),
  };

  try {
    const restored = spawnSync("bash", [toBashPath(fileURLToPath(remoteRollbackUrl))], { encoding: "utf8", env });
    assert.equal(restored.status, 0, restored.stderr);
    const successfulLog = readFileSync(dockerLog, "utf8");
    assert.match(successfulLog, /--network none --cap-drop ALL --cap-add NET_BIND_SERVICE/);
    assert.match(successfulLog, /-e CRM_DOMAIN=crm\.breexe-pro\.com -e ERP_DOMAIN=erp\.breexe-pro\.com/);
    assert.doesNotMatch(successfulLog, /new-(?:crm|erp)\.invalid\.example/);
    assert.match(successfulLog, /type=volume,src=deploy_caddy_data,dst=\/data,readonly/);
    assert.match(successfulLog, /type=volume,src=deploy_caddy_config,dst=\/config,readonly/);
    assert.match(successfulLog, /--header Host: crm\.breexe-pro\.com http:\/\/127\.0\.0\.1\/api\/health/);
    assert.match(successfulLog, /--resolve erp\.breexe-pro\.com:443:127\.0\.0\.1 https:\/\/erp\.breexe-pro\.com\/web\/login/);

    writeFileSync(dockerLog, "", "utf8");
    const unrelatedErpPage = spawnSync(
      "bash",
      [toBashPath(fileURLToPath(remoteRollbackUrl))],
      { encoding: "utf8", env: { ...env, ERP_TEST_BODY: "<html><title>Customer portal</title></html>" } },
    );
    assert.equal(unrelatedErpPage.status, 2, unrelatedErpPage.stderr);
    assert.match(unrelatedErpPage.stderr, /did not recover its CRM and Odoo ERP login health contract/i);
    assert.match(readFileSync(dockerLog, "utf8"), /https:\/\/erp\.breexe-pro\.com\/web\/login/);

    writeFileSync(path.join(rollback, "Caddyfile"), [
      "{ auto_https off }",
      "http://{$CRM_DOMAIN} { reverse_proxy crm:8080 }",
      "",
    ].join("\n"), "utf8");
    writeFileSync(path.join(rollback, "previous-crm-domain"), "legacy-crm.example.com\n", "utf8");
    writeFileSync(path.join(rollback, "previous-erp-domain"), "none\n", "utf8");
    writeFileSync(path.join(rollback, "previous-require-crm-origin"), "true\n", "utf8");
    writeFileSync(path.join(rollback, "previous-require-erp-endpoint"), "false\n", "utf8");
    writeFileSync(path.join(rollback, "previous-crm-origin-scheme"), "http\n", "utf8");
    writeSha256Manifest(rollback, Object.keys(files));
    writeFileSync(dockerLog, "", "utf8");
    const legacyWithoutErp = spawnSync(
      "bash",
      [toBashPath(fileURLToPath(remoteRollbackUrl))],
      { encoding: "utf8", env: { ...env, ERP_TEST_FORCE_FAILURE: "true" } },
    );
    assert.equal(legacyWithoutErp.status, 0, legacyWithoutErp.stderr);
    const legacyLog = readFileSync(dockerLog, "utf8");
    assert.match(legacyLog, /-e CRM_DOMAIN=legacy-crm\.example\.com/);
    assert.doesNotMatch(legacyLog, /ERP_DOMAIN=|--resolve .*erp|\/web\/login|new-erp\.invalid/);
    assert.match(legacyLog, /--header Host: legacy-crm\.example\.com http:\/\/127\.0\.0\.1\/api\/health/);

    writeFileSync(path.join(rollback, "caddy-data-volume"), "missing_caddy_data\n", "utf8");
    writeSha256Manifest(rollback, Object.keys(files));
    writeFileSync(dockerLog, "", "utf8");
    const rejected = spawnSync("bash", [toBashPath(fileURLToPath(remoteRollbackUrl))], { encoding: "utf8", env });
    assert.equal(rejected.status, 2, rejected.stderr);
    assert.match(rejected.stderr, /preserved Caddy data volume is unavailable/i);
    const rejectedLog = readFileSync(dockerLog, "utf8");
    assert.doesNotMatch(rejectedLog, /image tag|compose .* up /);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("GitHub Actions packages a clean archive and uses the same transaction entrypoint", () => {
  assert.match(vpsUpdate, /DEPLOY_ARCHIVE/);
  assert.match(vpsUpdate, /USE_EXISTING_ENV=true/);
  assert.match(vpsUpdate, /bash "\$TRANSACTION_SCRIPT"/);
  assert.doesNotMatch(vpsUpdate, /git reset --hard/);
  assert.match(deployWorkflow, /actions\/checkout@v4/);
  assert.match(deployWorkflow, /workflow_run:/);
  assert.match(deployWorkflow, /workflow_run\.conclusion == 'success'/);
  assert.match(deployWorkflow, /workflow_run\.event == 'push'/);
  assert.match(deployWorkflow, /ref:.*workflow_run\.head_sha/);
  assert.match(ciWorkflow, /npm run test:unit/);
  assert.doesNotMatch(deployWorkflow, /workflow_dispatch:/);
  assert.doesNotMatch(deployWorkflow, /ssh-keyscan/);
  assert.match(deployWorkflow, /VPS_KNOWN_HOSTS/);
  assert.match(deployWorkflow, /mktemp -d \/tmp\/golden-pro-crm-ci\.XXXXXXXXXX/);
  assert.match(deployWorkflow, /--exclude=\.git/);
  assert.match(deployWorkflow, /vps-deploy-transaction\.sh/);
  assert.match(deployWorkflow, /vps-backup\.sh/);
  assert.match(deployWorkflow, /vps-preserve-deploy-state\.sh/);
  assert.match(deployWorkflow, /remote-rollback\.sh/);
  assert.match(deployWorkflow, /DEPLOY_TRANSACTION_SCRIPT=/);
  assert.match(deployWorkflow, /EXPECTED_BUILD='\$BUILD_COMMIT'/);
  assert.match(deployWorkflow, /0\|1\|2\|75\)/);
  assert.match(deployWorkflow, /outcome \$transaction_status is ambiguous/);
  assert.match(deployWorkflow, /VPS deployment secrets are incomplete/);
  assert.doesNotMatch(deployWorkflow, /secrets not configured[^\n]*skipping deploy/i);
});

test("deployment docs route every mutation through the transaction entrypoints", () => {
  assert.doesNotMatch(deploymentDoc, /^\s*docker compose .*\b(up|restart)\b/m);
  assert.doesNotMatch(deploymentDoc, /NODE_ENV=production[^\n]*npm start/);
  assert.doesNotMatch(vpsDeploymentDoc, /^\s*docker compose .*\b(up|restart)\b/m);
  assert.doesNotMatch(vpsCicdDoc, /^\s*(?:cd .*&&\s*)?bash scripts\/vps-update\.sh\s*$/m);
  assert.doesNotMatch(readme, /^\s*npm start\s*$/m);
  assert.doesNotMatch(readme, /^\s*docker compose .*\b(up|restart)\b/m);
  assert.match(deploymentDoc, /deploy-vps\.ps1/);
  assert.match(deploymentDoc, /Caddy المضمّن/);
  assert.match(readme, /deploy:vps/);
  assert.match(vpsDeploymentDoc, /AllowFirstDeployWithoutBackup/);
  assert.match(vpsCicdDoc, /AllowFirstDeployWithoutBackup/);
  assert.match(vpsCicdDoc, /\.golden-pro-crm-source-trees/);
});

test("deployment transaction fails with exit 75 when the shared deploy lock is contended", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "crm-deploy-lock-test-"));
  const bin = path.join(directory, "bin");
  mkdirSync(bin);
  const flock = path.join(bin, "flock");
  const app = path.join(directory, "app");
  const input = path.join(directory, "input");
  mkdirSync(app);
  writeFileSync(path.join(app, "ownership-marker"), "unchanged", "utf8");
  const appModeBefore = statSync(app).mode & 0o777;
  writeFileSync(input, "present", "utf8");
  writeExecutable(flock, '#!/bin/sh\n[ "${STUB_FLOCK_CONTENDED:-false}" != true ]\n');

  const command = [
    'PATH="$1:$PATH"',
    'STUB_FLOCK_CONTENDED=true',
    'DEPLOY_TRANSACTION_TESTING=true',
    'DEPLOY_TEST_LOCK_FILE="$2/deploy.lock"',
    'DEPLOY_TEST_BACKUP_LOCK_FILE="$2/backup.lock"',
    'DEPLOY_TEST_SOURCE_RETENTION_ROOT="$2/source-trees" DEPLOY_APPROVED_APP_BASE="$2"',
    'APP_DIR="$2/app"',
    'DEPLOY_ARCHIVE="$2/input"',
    'DEPLOY_ENV_FILE="$2/input"',
    'DEPLOY_BACKUP_HELPER="$2/input"',
    'DEPLOY_PRESERVE_HELPER="$2/input"',
    'DEPLOY_ROLLBACK_HELPER="$2/input"',
    'EXPECTED_VERSION=1.2.3 EXPECTED_BUILD=abcdef123456',
    'bash "$3"',
  ].join(" ");

  try {
    const result = spawnSync(
      "bash",
      ["-c", command, "deploy-lock-test", toBashPath(bin), toBashPath(directory), toBashPath(fileURLToPath(deployTransactionUrl))],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 75, result.stderr);
    assert.match(result.stderr, /Another CRM deployment transaction is already running/);
    assert.equal(readFileSync(path.join(app, "ownership-marker"), "utf8"), "unchanged");
    assert.equal(statSync(app).mode & 0o777, appModeBefore);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("deployment transaction holds the backup/restore lock before any backup can start", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "crm-restore-lock-test-"));
  const bin = path.join(directory, "bin");
  mkdirSync(bin);
  const input = path.join(directory, "input");
  writeFileSync(input, "present", "utf8");
  writeExecutable(path.join(bin, "flock"), '#!/bin/sh\n[ "${2:-}" != 9 ]\n');

  const command = [
    'PATH="$1:$PATH" DEPLOY_TRANSACTION_TESTING=true',
    'DEPLOY_TEST_LOCK_FILE="$2/deploy.lock" DEPLOY_TEST_BACKUP_LOCK_FILE="$2/backup.lock"',
    'DEPLOY_TEST_SOURCE_RETENTION_ROOT="$2/source-trees" DEPLOY_APPROVED_APP_BASE="$2"',
    'APP_DIR="$2/app" DEPLOY_ARCHIVE="$2/input" DEPLOY_ENV_FILE="$2/input"',
    'DEPLOY_BACKUP_HELPER="$2/input" DEPLOY_PRESERVE_HELPER="$2/input" DEPLOY_ROLLBACK_HELPER="$2/input"',
    'EXPECTED_VERSION=1.2.3 EXPECTED_BUILD=abcdef123456 bash "$3"',
  ].join(" ");

  try {
    const result = spawnSync(
      "bash",
      ["-c", command, "restore-lock-test", toBashPath(bin), toBashPath(directory), toBashPath(fileURLToPath(deployTransactionUrl))],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 75, result.stderr);
    assert.match(result.stderr, /backup or restore operation is already running/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("deployment transaction ignores a running CRM container outside the approved release roots", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "crm-unrelated-container-test-"));
  const app = path.join(directory, "app");
  const unrelatedCompose = path.join(directory, "other-app", "deploy", "docker-compose.yml");
  const bin = path.join(directory, "bin");
  const input = path.join(directory, "input");
  const helperLog = path.join(directory, "helper.log");
  mkdirSync(app);
  mkdirSync(path.dirname(unrelatedCompose), { recursive: true });
  mkdirSync(bin);
  writeFileSync(unrelatedCompose, "services: {}\n", "utf8");
  writeFileSync(input, "present", "utf8");
  writeExecutable(path.join(bin, "flock"), "#!/bin/sh\nexit 0\n");
  writeExecutable(path.join(bin, "docker"), `#!/bin/sh
if [ "\${1:-}" = ps ]; then echo unrelated123; exit 0; fi
if [ "\${1:-}" = inspect ]; then echo "$UNRELATED_COMPOSE"; exit 0; fi
exit 0
`);
  const helper = path.join(directory, "helper.sh");
  writeExecutable(helper, '#!/bin/sh\necho called >> "$HELPER_LOG"\n');
  const command = [
    'PATH="$1:$PATH" UNRELATED_COMPOSE="$2/other-app/deploy/docker-compose.yml" HELPER_LOG="$2/helper.log"',
    'DEPLOY_TRANSACTION_TESTING=true DEPLOY_TEST_LOCK_FILE="$2/deploy.lock" DEPLOY_TEST_BACKUP_LOCK_FILE="$2/backup.lock"',
    'DEPLOY_TEST_SOURCE_RETENTION_ROOT="$2/source-trees" DEPLOY_APPROVED_APP_BASE="$2" APP_DIR="$2/app"',
    'DEPLOY_ARCHIVE="$2/input" DEPLOY_ENV_FILE="$2/input" DEPLOY_BACKUP_HELPER="$2/helper.sh"',
    'DEPLOY_PRESERVE_HELPER="$2/helper.sh" DEPLOY_ROLLBACK_HELPER="$2/helper.sh"',
    'EXPECTED_VERSION=1.2.3 EXPECTED_BUILD=abcdef123456 bash "$3"',
  ].join(" ");

  try {
    const result = spawnSync(
      "bash",
      ["-c", command, "unrelated-container-test", toBashPath(bin), toBashPath(directory), toBashPath(fileURLToPath(deployTransactionUrl))],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /No running CRM deployment was found/);
    assert.throws(() => readFileSync(helperLog, "utf8"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("failed staged release restores the exact old AppDir without stale archive overlay", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "crm-source-restore-test-"));
  const app = path.join(directory, "app");
  const payload = path.join(directory, "payload");
  const payloadDeploy = path.join(payload, "deploy");
  const payloadScripts = path.join(payload, "scripts");
  const bin = path.join(directory, "bin");
  const archive = path.join(directory, "release.tar.gz");
  const envFile = path.join(directory, "env.production");
  const helper = path.join(directory, "trusted-helper.sh");
  mkdirSync(app);
  mkdirSync(payloadDeploy, { recursive: true });
  mkdirSync(payloadScripts, { recursive: true });
  mkdirSync(bin);
  writeFileSync(path.join(app, "old-only.txt"), "old source", "utf8");
  writeFileSync(path.join(app, "removed-in-new.txt"), "must return", "utf8");
  writeFileSync(path.join(payload, "new-only.txt"), "new source", "utf8");
  writeFileSync(path.join(payload, "release.json"), '{"version":"1.2.3"}\n', "utf8");
  writeFileSync(path.join(payloadDeploy, "docker-compose.yml"), "services: {}\n", "utf8");
  writeFileSync(path.join(payloadDeploy, "Caddyfile"), "example.test\n", "utf8");
  writeExecutable(path.join(payloadDeploy, "remote-start.sh"), '#!/bin/sh\n[ -f "$APP_DIR/new-only.txt" ] || exit 90\nexit 42\n');
  writeExecutable(path.join(payloadDeploy, "remote-rollback.sh"), "#!/bin/sh\nexit 99\n");
  writeExecutable(path.join(bin, "docker"), '#!/bin/sh\n[ "${1:-}" != ps ] || exit 0\nexit 0\n');
  writeExecutable(path.join(bin, "flock"), "#!/bin/sh\nexit 0\n");
  writeExecutable(helper, "#!/bin/sh\nexit 99\n");
  writeFileSync(envFile, "TRUST_PROXY_HEADERS=true\nDB_PATH=.runtime/golden-crm.db\n", "utf8");
  const packed = spawnSync(
    "bash",
    ["-c", 'tar -czf "$1" -C "$2" .', "pack-test", toBashPath(archive), toBashPath(payload)],
    { encoding: "utf8" },
  );
  assert.equal(packed.status, 0, packed.stderr);

  const command = [
    'PATH="$1:$PATH"',
    'DEPLOY_TRANSACTION_TESTING=true',
    'DEPLOY_TEST_LOCK_FILE="$2/deploy.lock"',
    'DEPLOY_TEST_BACKUP_LOCK_FILE="$2/backup.lock"',
    'DEPLOY_TEST_SOURCE_RETENTION_ROOT="$2/source-trees" DEPLOY_APPROVED_APP_BASE="$2"',
    'APP_DIR="$2/app" CRM_DOMAIN=example.test',
    'DEPLOY_ARCHIVE="$2/release.tar.gz" DEPLOY_ENV_FILE="$2/env.production"',
    'DEPLOY_BACKUP_HELPER="$2/trusted-helper.sh"',
    'DEPLOY_PRESERVE_HELPER="$2/trusted-helper.sh"',
    'DEPLOY_ROLLBACK_HELPER="$2/trusted-helper.sh"',
    'USE_EXISTING_ENV=false ALLOW_FIRST_DEPLOY=true',
    'EXPECTED_VERSION=1.2.3 EXPECTED_BUILD=abcdef123456 HEALTH_RETRIES=1 HEALTH_SLEEP=1',
    'bash "$3"',
  ].join(" ");

  try {
    const result = spawnSync(
      "bash",
      ["-c", command, "source-restore-test", toBashPath(bin), toBashPath(directory), toBashPath(fileURLToPath(deployTransactionUrl))],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /previous source and running deployment were restored/i);
    assert.equal(readFileSync(path.join(app, "old-only.txt"), "utf8"), "old source");
    assert.equal(readFileSync(path.join(app, "removed-in-new.txt"), "utf8"), "must return");
    assert.throws(() => readFileSync(path.join(app, "new-only.txt"), "utf8"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("first upgrade uses uploaded trusted helpers when old AppDir lacks preserve and rollback", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "crm-trusted-helper-test-"));
  const app = path.join(directory, "app");
  const scripts = path.join(app, "scripts");
  const bin = path.join(directory, "bin");
  const activeCompose = path.join(directory, "app-releases", "legacy123", "deploy", "docker-compose.yml");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(bin);
  mkdirSync(path.dirname(activeCompose), { recursive: true });
  const activeEnv = path.join(path.dirname(path.dirname(activeCompose)), ".env.production");
  writeFileSync(path.join(app, ".env.production"), "EXISTING=stale\nDB_PATH=.runtime/golden-crm.db\n", "utf8");
  writeFileSync(activeEnv, "EXISTING=active\nDB_PATH=.runtime/golden-crm.db\n", "utf8");
  writeFileSync(activeCompose, "services: {}\n", "utf8");
  writeExecutable(path.join(scripts, "vps-backup.sh"), '#!/bin/sh\necho old-helper >> "$HELPER_LOG"\nexit 88\n');
  writeExecutable(path.join(bin, "docker"), `#!/bin/sh
if [ "\${1:-}" = ps ]; then echo crm123; exit 0; fi
case "$*" in
  *project.config_files*) echo "$ACTIVE_COMPOSE" ;;
  *com.docker.compose.project*) echo deploy ;;
esac
exit 0
`);
  writeExecutable(path.join(bin, "flock"), "#!/bin/sh\nexit 0\n");
  const backupHelper = path.join(directory, "bundle-backup.sh");
  const preserveHelper = path.join(directory, "bundle-preserve.sh");
  const rollbackHelper = path.join(directory, "bundle-rollback.sh");
  writeExecutable(backupHelper, '#!/bin/sh\necho "trusted-backup-fd-${CRM_BACKUP_LOCK_FD:-missing}" >> "$HELPER_LOG"\nprintf "backup-env:" >> "$HELPER_LOG"\nsed -n "1p" "$CRM_ENV_FILE" >> "$HELPER_LOG"\n');
  writeExecutable(preserveHelper, '#!/bin/sh\necho trusted-preserve >> "$HELPER_LOG"\nprintf "preserve-env:" >> "$HELPER_LOG"\nsed -n "1p" "$CRM_ACTIVE_ENV_FILE" >> "$HELPER_LOG"\nmkdir -p "$APP_DIR/.deploy-rollback"\n');
  writeExecutable(rollbackHelper, '#!/bin/sh\necho unexpected-rollback >> "$HELPER_LOG"\n');
  writeFileSync(path.join(directory, "invalid.tar.gz"), "not an archive", "utf8");

  const command = [
    'PATH="$1:$PATH" HELPER_LOG="$2/helpers.log" ACTIVE_COMPOSE="$2/app-releases/legacy123/deploy/docker-compose.yml"',
    'DEPLOY_TRANSACTION_TESTING=true DEPLOY_TEST_LOCK_FILE="$2/deploy.lock" DEPLOY_TEST_BACKUP_LOCK_FILE="$2/backup.lock"',
    'DEPLOY_TEST_SOURCE_RETENTION_ROOT="$2/source-trees" DEPLOY_APPROVED_APP_BASE="$2"',
    'APP_DIR="$2/app" CRM_DOMAIN=example.test DEPLOY_ARCHIVE="$2/invalid.tar.gz" USE_EXISTING_ENV=true',
    'DEPLOY_BACKUP_HELPER="$2/bundle-backup.sh" DEPLOY_PRESERVE_HELPER="$2/bundle-preserve.sh" DEPLOY_ROLLBACK_HELPER="$2/bundle-rollback.sh"',
    'EXPECTED_VERSION=1.2.3 EXPECTED_BUILD=abcdef123456 HEALTH_RETRIES=1 HEALTH_SLEEP=1',
    'bash "$3"',
  ].join(" ");

  try {
    const result = spawnSync(
      "bash",
      ["-c", command, "trusted-helper-test", toBashPath(bin), toBashPath(directory), toBashPath(fileURLToPath(deployTransactionUrl))],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1, result.stderr);
    const helperLog = readFileSync(path.join(directory, "helpers.log"), "utf8");
    assert.match(helperLog, /trusted-backup-fd-9/);
    assert.match(helperLog, /trusted-preserve/);
    assert.match(helperLog, /backup-env:EXISTING=active/);
    assert.match(helperLog, /preserve-env:EXISTING=active/);
    assert.doesNotMatch(helperLog, /EXISTING=stale/);
    assert.doesNotMatch(helperLog, /old-helper|unexpected-rollback/);
    assert.equal(readFileSync(path.join(app, ".env.production"), "utf8"), "EXISTING=stale\nDB_PATH=.runtime/golden-crm.db\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("successful clean swap retains the complete previous AppDir outside transaction cleanup", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "crm-source-retention-test-"));
  const app = path.join(directory, "app");
  const bin = path.join(directory, "bin");
  const marker = path.join(directory, "running.marker");
  const helper = path.join(directory, "helper.sh");
  mkdirSync(path.join(app, "backups", "historical"), { recursive: true });
  mkdirSync(bin);
  writeFileSync(path.join(app, "old-only.txt"), "old source", "utf8");
  writeFileSync(path.join(app, "backups", "historical", "customer.db"), "legacy data", "utf8");
  createDeployArchive(directory, '#!/bin/sh\ntouch "$RUNNING_MARKER"\nexit 0\n');
  writeExecutable(path.join(bin, "flock"), "#!/bin/sh\nexit 0\n");
  writeExecutable(path.join(bin, "curl"), '#!/bin/sh\nprintf %s \'{"status":"ok"}\'\n');
  writeExecutable(path.join(bin, "docker"), `#!/bin/sh
if [ "\${1:-}" = ps ]; then [ -f "$RUNNING_MARKER" ] && echo crm123; exit 0; fi
if [ "\${1:-}" = inspect ]; then
  case "$*" in *project.config_files*) echo "$APP_DIR/deploy/docker-compose.yml" ;; esac
  exit 0
fi
if [ "\${1:-}" = exec ]; then cat >/dev/null; exit 0; fi
exit 0
`);
  writeExecutable(helper, "#!/bin/sh\nexit 99\n");
  writeFileSync(path.join(directory, "env.production"), "TRUST_PROXY_HEADERS=true\nDB_PATH=.runtime/golden-crm.db\n", "utf8");

  const command = [
    'PATH="$1:$PATH" RUNNING_MARKER="$2/running.marker"',
    'DEPLOY_TRANSACTION_TESTING=true DEPLOY_TEST_LOCK_FILE="$2/deploy.lock" DEPLOY_TEST_BACKUP_LOCK_FILE="$2/backup.lock"',
    'DEPLOY_TEST_SOURCE_RETENTION_ROOT="$2/source-trees" DEPLOY_APPROVED_APP_BASE="$2"',
    'APP_DIR="$2/app" CRM_DOMAIN=example.test DEPLOY_ARCHIVE="$2/release.tar.gz" DEPLOY_ENV_FILE="$2/env.production"',
    'DEPLOY_BACKUP_HELPER="$2/helper.sh" DEPLOY_PRESERVE_HELPER="$2/helper.sh" DEPLOY_ROLLBACK_HELPER="$2/helper.sh"',
    'USE_EXISTING_ENV=false ALLOW_FIRST_DEPLOY=true EXPECTED_VERSION=1.2.3 EXPECTED_BUILD=abcdef123456',
    'HEALTH_RETRIES=1 HEALTH_SLEEP=1 bash "$3"',
  ].join(" ");

  try {
    const result = spawnSync(
      "bash",
      ["-c", command, "source-retention-test", toBashPath(bin), toBashPath(directory), toBashPath(fileURLToPath(deployTransactionUrl))],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(path.join(app, "new-only.txt"), "utf8"), "new source");
    assert.throws(() => readFileSync(path.join(app, "old-only.txt"), "utf8"));
    assert.throws(() => readFileSync(path.join(app, "backups", "historical", "customer.db"), "utf8"));
    const retainedEntries = readdirSync(path.join(directory, "source-trees"));
    assert.equal(retainedEntries.length, 1);
    const retained = path.join(directory, "source-trees", retainedEntries[0]);
    assert.equal(readFileSync(path.join(retained, "old-only.txt"), "utf8"), "old source");
    assert.equal(readFileSync(path.join(retained, "backups", "historical", "customer.db"), "utf8"), "legacy data");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("TERM in the old-source rename window restores AppDir exactly", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "crm-source-signal-test-"));
  const app = path.join(directory, "app");
  const bin = path.join(directory, "bin");
  const helper = path.join(directory, "helper.sh");
  mkdirSync(app);
  mkdirSync(bin);
  writeFileSync(path.join(app, "old-only.txt"), "old source", "utf8");
  createDeployArchive(directory, "#!/bin/sh\nexit 90\n");
  writeExecutable(path.join(bin, "flock"), "#!/bin/sh\nexit 0\n");
  writeExecutable(path.join(bin, "docker"), '#!/bin/sh\n[ "${1:-}" = ps ] && exit 0\nexit 0\n');
  writeExecutable(path.join(bin, "mv"), `#!/bin/sh
/usr/bin/mv "$@" || exit $?
if [ "\${2:-}" = "$SIGNAL_SOURCE" ] && [ ! -e "$SIGNAL_MARKER" ]; then
  : > "$SIGNAL_MARKER"
  kill -TERM "$PPID"
  sleep 1
fi
`);
  writeExecutable(helper, "#!/bin/sh\nexit 99\n");
  writeFileSync(path.join(directory, "env.production"), "TRUST_PROXY_HEADERS=true\nDB_PATH=.runtime/golden-crm.db\n", "utf8");
  const command = [
    'PATH="$1:$PATH" SIGNAL_SOURCE="$2/app" SIGNAL_MARKER="$2/signal.marker"',
    'DEPLOY_TRANSACTION_TESTING=true DEPLOY_TEST_LOCK_FILE="$2/deploy.lock" DEPLOY_TEST_BACKUP_LOCK_FILE="$2/backup.lock"',
    'DEPLOY_TEST_SOURCE_RETENTION_ROOT="$2/source-trees" DEPLOY_APPROVED_APP_BASE="$2"',
    'APP_DIR="$2/app" CRM_DOMAIN=example.test DEPLOY_ARCHIVE="$2/release.tar.gz" DEPLOY_ENV_FILE="$2/env.production"',
    'DEPLOY_BACKUP_HELPER="$2/helper.sh" DEPLOY_PRESERVE_HELPER="$2/helper.sh" DEPLOY_ROLLBACK_HELPER="$2/helper.sh"',
    'USE_EXISTING_ENV=false ALLOW_FIRST_DEPLOY=true EXPECTED_VERSION=1.2.3 EXPECTED_BUILD=abcdef123456',
    'HEALTH_RETRIES=1 HEALTH_SLEEP=1 bash "$3"',
  ].join(" ");

  try {
    const result = spawnSync(
      "bash",
      ["-c", command, "source-signal-test", toBashPath(bin), toBashPath(directory), toBashPath(fileURLToPath(deployTransactionUrl))],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /transaction was interrupted/i);
    assert.equal(readFileSync(path.join(app, "old-only.txt"), "utf8"), "old source");
    assert.throws(() => readFileSync(path.join(app, "new-only.txt"), "utf8"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("transaction rejects traversal, quoting, outside-base, and symlink AppDir values before locking", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "crm-app-path-test-"));
  const approved = path.join(directory, "approved");
  const realApp = path.join(approved, "real-app");
  const linkedApp = path.join(approved, "linked-app");
  mkdirSync(realApp, { recursive: true });
  symlinkSync(realApp, linkedApp, process.platform === "win32" ? "junction" : "dir");
  const input = path.join(directory, "input");
  writeFileSync(input, "present", "utf8");

  const directoryBash = toBashPath(directory);
  const approvedBash = toBashPath(approved);
  const runInvalidPath = (appDir, approvedBase = approvedBash) => {
    return spawnSync(
      "bash",
      [toBashPath(fileURLToPath(deployTransactionUrl))],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          DEPLOY_TRANSACTION_TESTING: "true",
          DEPLOY_TEST_LOCK_FILE: `${directoryBash}/deploy.lock`,
          DEPLOY_TEST_BACKUP_LOCK_FILE: `${directoryBash}/backup.lock`,
          DEPLOY_TEST_SOURCE_RETENTION_ROOT: `${directoryBash}/source-trees`,
          APP_DIR: appDir,
          DEPLOY_APPROVED_APP_BASE: approvedBase,
          DEPLOY_ARCHIVE: `${directoryBash}/input`,
          DEPLOY_ENV_FILE: `${directoryBash}/input`,
          DEPLOY_BACKUP_HELPER: `${directoryBash}/input`,
          DEPLOY_PRESERVE_HELPER: `${directoryBash}/input`,
          DEPLOY_ROLLBACK_HELPER: `${directoryBash}/input`,
          EXPECTED_VERSION: "1.2.3",
          EXPECTED_BUILD: "abcdef123456",
        },
      },
    );
  };

  try {
    for (const invalid of [
      `${approvedBash}/app/../escape`,
      `${approvedBash}/app'quoted`,
      `${directoryBash}/outside/app`,
      toBashPath(linkedApp),
    ]) {
      const result = runInvalidPath(invalid);
      assert.equal(result.status, 1, `path should fail: ${invalid}\n${result.stderr}`);
      assert.match(result.stderr, /unsafe|canonical|outside|symlink/i);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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

test("WhatsApp archive validator rejects traversal before extraction", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "crm-wa-archive-test-"));
  const root = path.join(directory, "root");
  const session = path.join(root, "wa-session");
  const goodArchive = path.join(directory, "good.tar.gz");
  const traversalArchive = path.join(directory, "traversal.tar.gz");
  mkdirSync(session, { recursive: true });
  writeFileSync(path.join(session, "creds.json"), "{}", "utf8");
  const validator = shellFunction(restore, "validate_wa_archive", 'if [ -f "$SRC/wa-session.tar.gz" ]');
  const runValidator = (archivePath) => spawnSync(
    "bash",
    ["-c", `${validator}\nvalidate_wa_archive "$1"`, "wa-archive-test", toBashPath(archivePath)],
    { encoding: "utf8" },
  );

  try {
    const packed = spawnSync("bash", ["-c", 'tar -czf "$1" -C "$2" wa-session', "wa-pack", toBashPath(goodArchive), toBashPath(root)], { encoding: "utf8" });
    assert.equal(packed.status, 0, packed.stderr);
    assert.equal(runValidator(goodArchive).status, 0);

    const traversal = spawnSync(
      "bash",
      ["-c", 'tar -czf "$1" -C "$2" --transform="s|^wa-session/creds.json$|../escape.json|" wa-session/creds.json', "wa-traversal", toBashPath(traversalArchive), toBashPath(root)],
      { encoding: "utf8" },
    );
    assert.equal(traversal.status, 0, traversal.stderr);
    const rejected = runValidator(traversalArchive);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /unsafe path/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("WhatsApp restore removes stale entries only after a successful staged copy", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "crm-wa-replace-test-"));
  const sourceDir = path.join(directory, "source");
  const targetDir = path.join(directory, "target");
  const bin = path.join(directory, "bin");
  mkdirSync(sourceDir);
  mkdirSync(targetDir);
  mkdirSync(bin);
  writeFileSync(path.join(sourceDir, "fresh.json"), "fresh", "utf8");
  writeFileSync(path.join(targetDir, "stale.json"), "stale", "utf8");
  writeExecutable(path.join(bin, "chown"), "#!/bin/sh\nexit 0\n");
  writeExecutable(path.join(bin, "chmod"), "#!/bin/sh\nexit 0\n");
  const raw = embeddedShellScript(restore, "restoring WhatsApp session", "\n    '\n  rm -rf");
  const script = raw
    .replaceAll("/app/.wa-session", toBashPath(targetDir))
    .replaceAll("/tmp/wa-session-restore", toBashPath(sourceDir))
    .replace('mkdir -m 700 -- "$stage"', 'mkdir -- "$stage"');
  const run = () => spawnSync("bash", ["-eu", "-c", script], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${toBashPath(bin)}:${process.env.PATH}`, RESTORE_RUN_ID: "unit" },
  });

  try {
    const success = run();
    assert.equal(success.status, 0, success.stderr);
    assert.equal(readFileSync(path.join(targetDir, "fresh.json"), "utf8"), "fresh");
    assert.throws(() => readFileSync(path.join(targetDir, "stale.json"), "utf8"));

    writeFileSync(path.join(targetDir, "must-survive.json"), "old-live", "utf8");
    writeExecutable(path.join(bin, "cp"), "#!/bin/sh\nexit 73\n");
    const failed = run();
    assert.equal(failed.status, 73, failed.stderr);
    assert.equal(readFileSync(path.join(targetDir, "must-survive.json"), "utf8"), "old-live");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("restore health gate times out instead of announcing completion", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "crm-restore-health-test-"));
  const bin = path.join(directory, "bin");
  const sleepLog = path.join(directory, "sleep.log");
  mkdirSync(bin);
  writeExecutable(path.join(bin, "docker"), `#!/bin/sh
if [ "\${1:-}" = compose ]; then echo crm123; exit 0; fi
if [ "\${1:-}" = inspect ]; then echo "\${STUB_HEALTH:-starting}"; exit 0; fi
exit 0
`);
  writeExecutable(path.join(bin, "sleep"), '#!/bin/sh\necho sleep >> "$SLEEP_LOG"\n');
  const waitFunction = shellFunction(restore, "wait_for_restored_health", 'log "starting app"');
  const command = `${waitFunction}\nCOMPOSE=(docker compose); HEALTH_RETRIES=2; HEALTH_SLEEP=1; wait_for_restored_health`;
  const common = {
    ...process.env,
    PATH: `${toBashPath(bin)}:${process.env.PATH}`,
    SLEEP_LOG: toBashPath(sleepLog),
  };

  try {
    const timedOut = spawnSync("bash", ["-c", command], { encoding: "utf8", env: common });
    assert.equal(timedOut.status, 1, timedOut.stderr);
    assert.equal(readFileSync(sleepLog, "utf8").trim().split(/\r?\n/).length, 2);
    const healthy = spawnSync("bash", ["-c", command], { encoding: "utf8", env: { ...common, STUB_HEALTH: "healthy" } });
    assert.equal(healthy.status, 0, healthy.stderr);
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
