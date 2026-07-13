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
DEFAULT_BACKUP_DIR="/var/backups/golden-pro-crm"
BACKUP_DIR="${BACKUP_DIR:-$DEFAULT_BACKUP_DIR}"
APPROVED_BACKUP_BASE="${BACKUP_APPROVED_BASE:-}"
DEFAULT_LOCK_FILE="/run/golden-pro-crm/backup-restore.lock"
LOCK_FILE="${BACKUP_LOCK_FILE:-$DEFAULT_LOCK_FILE}"
APPROVED_LOCK_BASE="${BACKUP_APPROVED_LOCK_BASE:-}"
COMPOSE_PROJECT="${CRM_COMPOSE_PROJECT:-}"
ROLLBACK_DIR="$APP_DIR/.deploy-rollback"
HEALTH_RETRIES="${RESTORE_HEALTH_RETRIES:-30}"
HEALTH_SLEEP="${RESTORE_HEALTH_SLEEP:-4}"

log() { printf '\n\033[1;33m[restore]\033[0m %s\n' "$*"; }
fail() { echo "$*" >&2; exit 2; }
safe_absolute_path() {
  local value="$1"
  [[ "$value" =~ ^/[A-Za-z0-9._/-]+$ ]] \
    && [[ "$value" != "/" && "$value" != *//* && "$value" != */./* && "$value" != */../* && "$value" != */. && "$value" != */.. && "$value" != */ ]]
}
validate_trusted_directory() {
  local value="$1" label="$2"
  safe_absolute_path "$value" || fail "$label must be a safe absolute path."
  [ -d "$value" ] && [ ! -L "$value" ] || fail "$label must be an existing non-symlink directory."
  [ "$(readlink -m -- "$value")" = "$value" ] || fail "$label cannot traverse symlinks."
  [ "$(stat -c %u -- "$value")" = "$(id -u)" ] || fail "$label must be owned by the restore user."
  [ -z "$(find "$value" -maxdepth 0 -perm /022 -print -quit)" ] \
    || fail "$label cannot be group/world writable."
}
validate_trusted_subdirectory_chain() {
  local base="$1" target="$2" label="$3" remainder current part
  local -a path_parts=()
  case "$target" in "$base"/*) ;; *) fail "$label is outside its trusted base." ;; esac
  remainder="${target#"$base"/}"
  current="$base"
  IFS='/' read -r -a path_parts <<< "$remainder"
  for part in "${path_parts[@]}"; do
    [ -n "$part" ] || fail "$label contains an empty path component."
    current="$current/$part"
    validate_trusted_directory "$current" "$label path component"
  done
}
validate_trusted_regular_file() {
  local value="$1" label="$2"
  [ -f "$value" ] && [ ! -L "$value" ] || fail "$label must be a regular non-symlink file."
  [ "$(readlink -m -- "$value")" = "$value" ] || fail "$label cannot traverse symlinks."
  [ "$(stat -c %u -- "$value")" = "$(id -u)" ] || fail "$label must be owned by the restore user."
  [ -z "$(find "$value" -maxdepth 0 -perm /022 -print -quit)" ] \
    || fail "$label cannot be group/world writable."
}

safe_absolute_path "$BACKUP_DIR" || fail "BACKUP_DIR is unsafe."
[ ! -L "$BACKUP_DIR" ] || fail "BACKUP_DIR cannot be a symlink."
if [ "$BACKUP_DIR" != "$DEFAULT_BACKUP_DIR" ]; then
  [ -n "$APPROVED_BACKUP_BASE" ] || fail "A custom BACKUP_DIR requires BACKUP_APPROVED_BASE."
  validate_trusted_directory "$APPROVED_BACKUP_BASE" "BACKUP_APPROVED_BASE"
  case "$BACKUP_DIR" in "$APPROVED_BACKUP_BASE"/*) ;; *) fail "BACKUP_DIR is outside BACKUP_APPROVED_BASE." ;; esac
  validate_trusted_subdirectory_chain "$APPROVED_BACKUP_BASE" "$BACKUP_DIR" "BACKUP_DIR"
else
  validate_trusted_directory "$(dirname -- "$BACKUP_DIR")" "BACKUP_DIR parent"
fi
validate_trusted_directory "$BACKUP_DIR" "BACKUP_DIR"

safe_absolute_path "$LOCK_FILE" || fail "BACKUP_LOCK_FILE is unsafe."
[ ! -L "$LOCK_FILE" ] || fail "BACKUP_LOCK_FILE cannot be a symlink."
if [ "$LOCK_FILE" != "$DEFAULT_LOCK_FILE" ]; then
  safe_absolute_path "$APPROVED_LOCK_BASE" || fail "A custom BACKUP_LOCK_FILE requires a safe BACKUP_APPROVED_LOCK_BASE."
  [ -d "$APPROVED_LOCK_BASE" ] && [ ! -L "$APPROVED_LOCK_BASE" ] \
    || fail "BACKUP_APPROVED_LOCK_BASE must be an existing non-symlink directory."
  [ "$(readlink -m -- "$APPROVED_LOCK_BASE")" = "$APPROVED_LOCK_BASE" ] \
    || fail "BACKUP_APPROVED_LOCK_BASE cannot traverse symlinks."
  [ "$(stat -c %u -- "$APPROVED_LOCK_BASE")" = "$(id -u)" ] \
    || fail "BACKUP_APPROVED_LOCK_BASE must be owned by the restore user."
  [ -z "$(find "$APPROVED_LOCK_BASE" -maxdepth 0 -perm /022 -print -quit)" ] \
    || fail "BACKUP_APPROVED_LOCK_BASE cannot be group/world writable."
  case "$LOCK_FILE" in "$APPROVED_LOCK_BASE"/*) ;; *) fail "BACKUP_LOCK_FILE is outside BACKUP_APPROVED_LOCK_BASE." ;; esac
  [ "$(readlink -m -- "$LOCK_FILE")" = "$LOCK_FILE" ] || fail "BACKUP_LOCK_FILE cannot traverse symlinks."
fi

command -v flock >/dev/null 2>&1 || { echo "flock is required." >&2; exit 1; }
command -v sha256sum >/dev/null 2>&1 || { echo "sha256sum is required." >&2; exit 1; }
if [ -z "$COMPOSE_PROJECT" ] && [ -d "$ROLLBACK_DIR" ]; then
  [ -s "$ROLLBACK_DIR/manifest.sha256" ] && [ -s "$ROLLBACK_DIR/project-name" ] \
    || fail "The preserved Compose project contract is incomplete."
  (cd "$ROLLBACK_DIR" && sha256sum --check --strict --status manifest.sha256) \
    || fail "The preserved Compose project contract failed its checksum."
  COMPOSE_PROJECT="$(sed -n '1p' "$ROLLBACK_DIR/project-name")"
fi
case "$COMPOSE_PROJECT" in '' ) ;; *[!A-Za-z0-9_-]*) fail "Invalid CRM_COMPOSE_PROJECT." ;; esac
[[ "$HEALTH_RETRIES" =~ ^[1-9][0-9]*$ ]] && [ "$HEALTH_RETRIES" -le 300 ] \
  || fail "RESTORE_HEALTH_RETRIES must be an integer from 1 through 300."
[[ "$HEALTH_SLEEP" =~ ^[1-9][0-9]*$ ]] && [ "$HEALTH_SLEEP" -le 60 ] \
  || fail "RESTORE_HEALTH_SLEEP must be an integer from 1 through 60."
COMPOSE=(docker compose)
[ -n "$COMPOSE_PROJECT" ] && COMPOSE+=(--project-name "$COMPOSE_PROJECT")
COMPOSE+=(--env-file "$APP_DIR/.env.production" -f "$APP_DIR/deploy/docker-compose.yml")
LOCK_PARENT="$(dirname "$LOCK_FILE")"
mkdir -p "$LOCK_PARENT"
[ -d "$LOCK_PARENT" ] && [ ! -L "$LOCK_PARENT" ] || fail "The private lock directory cannot be a symlink."
[ "$(stat -c %u -- "$LOCK_PARENT")" = "$(id -u)" ] || fail "The private lock directory must be owned by the restore user."
chmod 700 "$LOCK_PARENT"
if [ -e "$LOCK_FILE" ]; then
  [ -f "$LOCK_FILE" ] && [ ! -L "$LOCK_FILE" ] || fail "BACKUP_LOCK_FILE must be a regular non-symlink file."
  [ "$(stat -c %u -- "$LOCK_FILE")" = "$(id -u)" ] || fail "BACKUP_LOCK_FILE must be owned by the restore user."
fi
exec 9>"$LOCK_FILE"
chmod 600 "$LOCK_FILE"
if ! flock -n 9; then
  echo "Another CRM backup or restore operation is already running." >&2
  exit 75
fi
export CRM_BACKUP_LOCK_FD=9

if [ -z "$SRC" ]; then
  echo "usage: bash scripts/vps-restore.sh <backup-dir>" >&2
  echo "available:" >&2
  ls -1 "$BACKUP_DIR" 2>/dev/null | sed 's/^/  /' >&2 || true
  exit 1
fi
safe_absolute_path "$SRC" || fail "Restore source path is unsafe."
[ "$(dirname -- "$SRC")" = "$BACKUP_DIR" ] || fail "Restore source is outside BACKUP_DIR or is not a direct backup directory."
validate_trusted_directory "$SRC" "Restore source directory"
ORIGINAL_SRC="$SRC"
cd "$APP_DIR"

RUN_ID="$(date +%Y%m%d-%H%M%S)-$$-${RANDOM}"
STAGING_ROOT="$BACKUP_DIR/.restore-staging"
[ ! -L "$STAGING_ROOT" ] || fail "Restore staging directory cannot be a symlink."
if [ ! -e "$STAGING_ROOT" ]; then
  mkdir -m 700 -- "$STAGING_ROOT"
else
  validate_trusted_directory "$STAGING_ROOT" "Restore staging directory"
fi
validate_trusted_directory "$STAGING_ROOT" "Restore staging directory"
STAGED_SRC="$(mktemp -d "$STAGING_ROOT/restore-${RUN_ID}.XXXXXXXXXX")"
chmod 700 -- "$STAGED_SRC"
TMP=""
WT=""
cleanup() {
  [ -z "$TMP" ] || rm -f -- "$TMP"
  [ -z "$WT" ] || rm -rf -- "$WT"
  [ -z "$STAGED_SRC" ] || { chmod -R u+rwX -- "$STAGED_SRC" 2>/dev/null || true; rm -rf -- "$STAGED_SRC"; }
}
trap cleanup EXIT

validate_backup_source_entries() {
  local root="$1" entry name
  local -a entries=()
  mapfile -d '' -t entries < <(find "$root" -mindepth 1 -maxdepth 1 -print0)
  for entry in "${entries[@]}"; do
    name="${entry##*/}"
    case "$name" in
      .incomplete) fail "Backup source is marked incomplete." ;;
      manifest.sha256|golden-crm.db.gz|salla-integrations.json|wa-session.tar.gz|env.production) ;;
      *) fail "Backup source contains a non-whitelisted entry." ;;
    esac
    validate_trusted_regular_file "$entry" "Backup source payload"
  done
}

source_fingerprint() {
  stat -Lc '%d:%i:%s:%y:%z:%u:%a' -- "$1"
}

copy_stable_payload() {
  local source="$1" destination="$2" before after
  validate_trusted_regular_file "$source" "Backup source payload"
  before="$(source_fingerprint "$source")"
  cp --no-dereference --reflink=never -- "$source" "$destination"
  validate_trusted_regular_file "$source" "Backup source payload"
  after="$(source_fingerprint "$source")"
  [ "$before" = "$after" ] || fail "Backup payload changed while it was being staged."
  validate_trusted_regular_file "$destination" "Staged backup payload"
  chmod 600 -- "$destination"
}

stage_backup_source() {
  local source="$1" destination="$2" name
  local -a allowed=(
    "manifest.sha256"
    "golden-crm.db.gz"
    "salla-integrations.json"
    "wa-session.tar.gz"
    "env.production"
  )

  validate_trusted_directory "$source" "Restore source directory"
  validate_backup_source_entries "$source"
  for name in "${allowed[@]}"; do
    if [ -e "$source/$name" ]; then
      copy_stable_payload "$source/$name" "$destination/$name"
    fi
  done
  validate_trusted_directory "$source" "Restore source directory"
  validate_backup_source_entries "$source"
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

  [ -f "$manifest" ] && [ ! -L "$manifest" ] || {
    echo "backup checksum manifest is required and must be a regular file." >&2
    return 1
  }

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
stage_backup_source "$SRC" "$STAGED_SRC"
validate_manifest "$STAGED_SRC"
find "$STAGED_SRC" -type f -exec chmod 400 {} +
chmod 500 -- "$STAGED_SRC"
SRC="$STAGED_SRC"
DB_GZ="$SRC/golden-crm.db.gz"
SALLA_SRC="$SRC/salla-integrations.json"
[ -f "$DB_GZ" ] || { echo "no golden-crm.db.gz in $SRC" >&2; exit 1; }

validate_wa_archive() {
  local archive="$1"
  local listing types
  listing="$(mktemp "${TMPDIR:-/tmp}/golden-crm-wa-list.XXXXXX")"
  types="$(mktemp "${TMPDIR:-/tmp}/golden-crm-wa-types.XXXXXX")"
  if ! tar -tzf "$archive" --quoting-style=escape > "$listing"; then
    rm -f -- "$listing" "$types"
    echo "WhatsApp session archive cannot be listed." >&2
    return 1
  fi
  if ! tar -tvzf "$archive" --quoting-style=escape > "$types"; then
    rm -f -- "$listing" "$types"
    echo "WhatsApp session archive types cannot be inspected." >&2
    return 1
  fi
  if ! awk '
    BEGIN { count=0 }
    $0 !~ /^wa-session\/?$/ && $0 !~ /^wa-session\/[A-Za-z0-9._\/@%+=:,-]+$/ { exit 1 }
    /(^|\/)\.\.?(\/|$)/ { exit 1 }
    { count++ }
    END { if (count == 0) exit 1 }
  ' "$listing"; then
    rm -f -- "$listing" "$types"
    echo "WhatsApp session archive contains an unsafe path." >&2
    return 1
  fi
  if ! awk 'substr($0, 1, 1) != "-" && substr($0, 1, 1) != "d" { exit 1 }' "$types"; then
    rm -f -- "$listing" "$types"
    echo "WhatsApp session archive contains a link or special file." >&2
    return 1
  fi
  rm -f -- "$listing" "$types"
}

if [ -f "$SRC/wa-session.tar.gz" ]; then
  log "validating WhatsApp session archive paths and file types"
  validate_wa_archive "$SRC/wa-session.tar.gz"
fi

CID="$("${COMPOSE[@]}" ps -q crm)"
[ -n "$CID" ] || { echo "CRM container is not running; cannot create a safety snapshot." >&2; exit 1; }

TMP="$(mktemp "${TMPDIR:-/tmp}/golden-crm-restore-${RUN_ID}.XXXXXX.db")"

log "decompressing database backup to a unique temporary file"
gunzip -c "$DB_GZ" > "$TMP"

# Validate the candidate database in a one-off container before the live volume
# is stopped or overwritten.
RESTORE_DB_CONTAINER_PATH="/tmp/golden-crm-restore-${RUN_ID}.db"
log "checking SQLite integrity before overwrite"
"${COMPOSE[@]}" run --rm --no-deps \
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
  "${COMPOSE[@]}" exec -T crm node -e '
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

read -r -p "This overwrites the live database with $ORIGINAL_SRC. Continue? [y/N] " ans
[ "$ans" = "y" ] || { echo "aborted"; exit 1; }

# Fail closed and keep the shared flock held. Pruning is disabled so the restore
# source cannot be deleted by the nested safety backup.
log "safety snapshot of current state"
BACKUP_DIR="$BACKUP_DIR" \
BACKUP_PRUNE_ENABLED=false \
CRM_BACKUP_LOCK_FD=9 \
bash scripts/vps-backup.sh

log "stopping app container"
"${COMPOSE[@]}" stop crm
CID="$("${COMPOSE[@]}" ps -aq crm)"
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
  tar -xzf "$SRC/wa-session.tar.gz" --no-same-owner --no-same-permissions -C "$WT"
  [ -d "$WT/wa-session" ] && [ ! -L "$WT/wa-session" ] \
    || { echo "WhatsApp session archive has no safe root directory." >&2; exit 1; }
  if find "$WT/wa-session" \( -type l -o \( ! -type f ! -type d \) \) -print -quit | grep -q .; then
    echo "WhatsApp session archive extracted an unsupported file type." >&2
    exit 1
  fi
  "${COMPOSE[@]}" run --rm --no-deps --user root \
    -e RESTORE_RUN_ID="$RUN_ID" \
    -v "$WT/wa-session:/tmp/wa-session-restore:ro" \
    crm sh -eu -c '
      target=/app/.wa-session
      stage="$target/.restore-$RESTORE_RUN_ID"
      [ -d "$target" ]
      rm -rf -- "$stage"
      mkdir -m 700 -- "$stage"
      cp -a /tmp/wa-session-restore/. "$stage/"
      find "$stage" -type d -exec chmod 700 {} +
      find "$stage" -type f -exec chmod 600 {} +
      chown -R node:node "$stage"
      find "$target" -mindepth 1 -maxdepth 1 ! -name ".restore-$RESTORE_RUN_ID" -exec rm -rf -- {} +
      find "$stage" -mindepth 1 -maxdepth 1 -exec mv -t "$target" -- {} +
      rmdir -- "$stage"
      chown node:node "$target"
      chmod 700 "$target"
    '
  rm -rf "$WT"
  WT=""
else
  log "backup has no WhatsApp session payload; preserving the current volume state"
fi

# A one-off container mounts the same named volumes without starting the CRM.
log "repairing runtime ownership and permissions"
"${COMPOSE[@]}" run --rm --no-deps --user root crm sh -c '
  chown node:node /app/.runtime/golden-crm.db
  chmod 600 /app/.runtime/golden-crm.db
  rm -f /app/.runtime/golden-crm.db-wal /app/.runtime/golden-crm.db-shm
  if [ -f /app/.runtime/salla-integrations.json ]; then
    chown node:node /app/.runtime/salla-integrations.json
    chmod 600 /app/.runtime/salla-integrations.json
  fi
  chown -R node:node /app/.wa-session
  find /app/.wa-session -type d -exec chmod 700 {} +
  find /app/.wa-session -type f -exec chmod 600 {} +
'

log "validating restored runtime before CRM startup"
"${COMPOSE[@]}" run --rm --no-deps crm node -e '
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

  const waRoot = "/app/.wa-session";
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : null;
  const pending = [waRoot];
  while (pending.length > 0) {
    const current = pending.pop();
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      console.error("Restored WhatsApp session contains an unsupported file type.");
      process.exitCode = 5;
      break;
    }
    if (expectedUid !== null && stat.uid !== expectedUid) {
      console.error("Restored WhatsApp session ownership is invalid.");
      process.exitCode = 5;
      break;
    }
    const mode = stat.mode & 0o777;
    if ((stat.isDirectory() && mode !== 0o700) || (stat.isFile() && mode !== 0o600)) {
      console.error("Restored WhatsApp session permissions are invalid.");
      process.exitCode = 5;
      break;
    }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(current)) pending.push(`${current}/${name}`);
    }
  }
'

wait_for_restored_health() {
  local cid health_status
  for _ in $(seq 1 "$HEALTH_RETRIES"); do
    cid="$("${COMPOSE[@]}" ps -q crm)"
    if [ -n "$cid" ]; then
      health_status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$cid" 2>/dev/null || true)"
      [ "$health_status" = "healthy" ] && return 0
    fi
    sleep "$HEALTH_SLEEP"
  done
  return 1
}

log "starting app"
"${COMPOSE[@]}" up -d
log "waiting for restored CRM health"
if ! wait_for_restored_health; then
  echo "Restored CRM did not become healthy; it remains unavailable for investigation." >&2
  exit 1
fi
log "restore complete and CRM health is verified"
