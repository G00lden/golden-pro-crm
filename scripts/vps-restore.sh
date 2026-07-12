#!/usr/bin/env bash
# Restore a Golden Pro CRM backup produced by scripts/vps-backup.sh.
#
#   bash scripts/vps-restore.sh /var/backups/golden-pro-crm/<backup-dir>
#
# Restores SQLite, Salla integration state, and the WhatsApp session. The CRM
# stays stopped if any integrity or ownership check fails.
set -euo pipefail
umask 077

SRC="${1:-}"
APP_DIR="${APP_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/golden-pro-crm}"
LOCK_FILE="${BACKUP_LOCK_FILE:-/var/lock/golden-pro-crm-backup-restore.lock}"
COMPOSE="docker compose -f $APP_DIR/deploy/docker-compose.yml"

log() { printf '\n\033[1;33m[restore]\033[0m %s\n' "$*"; }

command -v flock >/dev/null 2>&1 || { echo "flock is required." >&2; exit 1; }
command -v sha256sum >/dev/null 2>&1 || { echo "sha256sum is required." >&2; exit 1; }
mkdir -p "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
chmod 600 "$LOCK_FILE"
if ! flock -n 9; then
  echo "Another CRM backup or restore operation is already running." >&2
  exit 75
fi
export CRM_BACKUP_LOCK_FD=9

if [ -z "$SRC" ] || [ ! -d "$SRC" ]; then
  echo "usage: bash scripts/vps-restore.sh <backup-dir>" >&2
  echo "available:" >&2
  ls -1 "$BACKUP_DIR" 2>/dev/null | sed 's/^/  /' >&2 || true
  exit 1
fi

SRC="$(cd -P "$SRC" && pwd)"
cd "$APP_DIR"

DB_GZ="$SRC/golden-crm.db.gz"
SALLA_SRC="$SRC/salla-integrations.json"
MANIFEST="$SRC/manifest.sha256"
[ ! -e "$SRC/.incomplete" ] || { echo "backup is marked incomplete: $SRC" >&2; exit 1; }
[ -f "$MANIFEST" ] && [ ! -L "$MANIFEST" ] || {
  echo "backup checksum manifest is required and must be a regular file." >&2
  exit 1
}

validate_manifest() {
  local root="$1"
  local manifest="$root/manifest.sha256"
  local line name payload entry required
  local -a allowed=(
    "golden-crm.db.gz"
    "salla-integrations.json"
    "wa-session.tar.gz"
    "env.production"
  )
  local -A seen=()

  while IFS= read -r line || [ -n "$line" ]; do
    if [[ ! "$line" =~ ^([[:xdigit:]]{64})[[:space:]][[:space:]*](golden-crm\.db\.gz|salla-integrations\.json|wa-session\.tar\.gz|env\.production)$ ]]; then
      echo "backup manifest contains a malformed or non-whitelisted entry." >&2
      return 1
    fi
    name="${BASH_REMATCH[2]}"
    if [ -n "${seen[$name]:-}" ]; then
      echo "backup manifest contains a duplicate entry: $name" >&2
      return 1
    fi
    seen["$name"]=1
  done < "$manifest"

  required="golden-crm.db.gz"
  [ -n "${seen[$required]:-}" ] || {
    echo "backup manifest must include golden-crm.db.gz." >&2
    return 1
  }

  for payload in "${allowed[@]}"; do
    if [ -e "$root/$payload" ]; then
      [ -f "$root/$payload" ] && [ ! -L "$root/$payload" ] || {
        echo "backup payload must be a regular non-symlink file: $payload" >&2
        return 1
      }
      [ -n "${seen[$payload]:-}" ] || {
        echo "backup payload is missing from manifest: $payload" >&2
        return 1
      }
    elif [ -n "${seen[$payload]:-}" ]; then
      echo "manifest references a missing backup payload: $payload" >&2
      return 1
    fi
  done

  while IFS= read -r entry; do
    case "$entry" in
      manifest.sha256|golden-crm.db.gz|salla-integrations.json|wa-session.tar.gz|env.production) ;;
      *)
        echo "backup directory contains a non-whitelisted entry: $entry" >&2
        return 1
        ;;
    esac
  done < <(find "$root" -mindepth 1 -maxdepth 1 -printf '%f\n')

  (cd "$root" && sha256sum --check --strict --status manifest.sha256)
}

log "validating backup manifest and payload whitelist"
validate_manifest "$SRC"
[ -f "$DB_GZ" ] || { echo "no golden-crm.db.gz in $SRC" >&2; exit 1; }

CID="$($COMPOSE ps -q crm)"
[ -n "$CID" ] || { echo "CRM container is not running; cannot create a safety snapshot." >&2; exit 1; }

RUN_ID="$(date +%Y%m%d-%H%M%S)-$$-${RANDOM}"
TMP="$(mktemp "${TMPDIR:-/tmp}/golden-crm-restore-${RUN_ID}.XXXXXX.db")"
WT=""
cleanup() {
  rm -f "$TMP"
  if [ -n "$WT" ]; then rm -rf "$WT"; fi
}
trap cleanup EXIT

log "decompressing database backup to a unique temporary file"
gunzip -c "$DB_GZ" > "$TMP"

# Validate the candidate database in a one-off container before the live volume
# is stopped or overwritten.
RESTORE_DB_CONTAINER_PATH="/tmp/golden-crm-restore-${RUN_ID}.db"
log "checking SQLite integrity before overwrite"
$COMPOSE run --rm --no-deps \
  --user root \
  -e RESTORE_DB_PATH="$RESTORE_DB_CONTAINER_PATH" \
  -v "$TMP:$RESTORE_DB_CONTAINER_PATH:ro" \
  crm node -e '
    const Database = require("better-sqlite3");
    const path = process.env.RESTORE_DB_PATH || "";
    let db;
    try {
      db = new Database(path, { readonly: true, fileMustExist: true });
      const rows = db.pragma("integrity_check");
      const ok = rows.length === 1 && String(rows[0]?.integrity_check || "").toLowerCase() === "ok";
      if (!ok) {
        console.error("SQLite integrity_check failed for restore candidate.");
        process.exitCode = 6;
      }
    } catch {
      console.error("Restore candidate is not a valid readable SQLite database.");
      process.exitCode = 6;
    } finally {
      try { db?.close(); } catch {}
    }
  '

# Validate the fixed Salla state path from the backup. No token values are printed.
if [ -f "$SALLA_SRC" ]; then
  log "validating Salla integration state from backup"
  $COMPOSE exec -T crm node -e '
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => {
      let parsed;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { console.error("Backup Salla integration state is not valid JSON."); process.exit(4); }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        console.error("Backup Salla integration state must be a JSON object.");
        process.exit(4);
      }
    });
  ' < "$SALLA_SRC"
fi

read -r -p "This overwrites the live database with $SRC. Continue? [y/N] " ans
[ "$ans" = "y" ] || { echo "aborted"; exit 1; }

# Fail closed and keep the shared flock held. Pruning is disabled so the restore
# source cannot be deleted by the nested safety backup.
log "safety snapshot of current state"
BACKUP_DIR="$BACKUP_DIR" \
BACKUP_PRUNE_ENABLED=false \
CRM_BACKUP_LOCK_FD=9 \
bash scripts/vps-backup.sh

log "stopping app container"
$COMPOSE stop crm
CID="$($COMPOSE ps -aq crm)"
[ -n "$CID" ] || { echo "CRM container was not found after stop." >&2; exit 1; }

log "restoring database"
docker cp "$TMP" "$CID:/app/.runtime/golden-crm.db"

if [ -f "$SALLA_SRC" ]; then
  log "restoring Salla integration state into crm_runtime"
  docker cp "$SALLA_SRC" "$CID:/app/.runtime/salla-integrations.json"
else
  log "backup has no Salla state; preserving the current volume state"
fi

if [ -f "$SRC/wa-session.tar.gz" ]; then
  log "restoring WhatsApp session"
  WT="$(mktemp -d "${TMPDIR:-/tmp}/golden-crm-wa-restore-${RUN_ID}.XXXXXX")"
  tar -xzf "$SRC/wa-session.tar.gz" -C "$WT"
  docker cp "$WT/wa-session/." "$CID:/app/.wa-session/" 2>/dev/null || true
  rm -rf "$WT"
  WT=""
fi

# A one-off container mounts the same named volumes without starting the CRM.
log "repairing runtime ownership and permissions"
$COMPOSE run --rm --no-deps --user root crm sh -c '
  chown node:node /app/.runtime/golden-crm.db
  chmod 600 /app/.runtime/golden-crm.db
  rm -f /app/.runtime/golden-crm.db-wal /app/.runtime/golden-crm.db-shm
  if [ -f /app/.runtime/salla-integrations.json ]; then
    chown node:node /app/.runtime/salla-integrations.json
    chmod 600 /app/.runtime/salla-integrations.json
  fi
'

log "validating restored runtime before CRM startup"
$COMPOSE run --rm --no-deps crm node -e '
  const fs = require("fs");
  const Database = require("better-sqlite3");

  let db;
  try {
    db = new Database("/app/.runtime/golden-crm.db", { readonly: true, fileMustExist: true });
    const rows = db.pragma("integrity_check");
    if (!(rows.length === 1 && String(rows[0]?.integrity_check || "").toLowerCase() === "ok")) {
      console.error("Restored SQLite database failed integrity_check.");
      process.exitCode = 6;
    }
  } catch {
    console.error("Restored SQLite database is not readable.");
    process.exitCode = 6;
  } finally {
    try { db?.close(); } catch {}
  }

  const sallaPath = "/app/.runtime/salla-integrations.json";
  if (fs.existsSync(sallaPath)) {
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(sallaPath, "utf8")); }
    catch { console.error("Restored Salla integration state is not valid JSON."); process.exitCode = 4; }
    if (parsed && (typeof parsed !== "object" || Array.isArray(parsed))) {
      console.error("Restored Salla integration state must be a JSON object.");
      process.exitCode = 4;
    }
    const mode = fs.statSync(sallaPath).mode & 0o777;
    if (mode !== 0o600) {
      console.error("Restored Salla integration state must have mode 0600.");
      process.exitCode = 5;
    }
  }
'

log "starting app"
$COMPOSE up -d
log "restore complete - verify: docker compose -f deploy/docker-compose.yml logs -f crm"
