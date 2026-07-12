#!/usr/bin/env bash
# Consistent backup of the Golden Pro CRM state on the VPS.
#
# Captures, into $BACKUP_DIR/<timestamp>-<pid>-<random>/:
#   * golden-crm.db.gz         - consistent SQLite snapshot, gzipped.
#   * salla-integrations.json  - validated Salla connection state, mode 0600.
#   * wa-session.tar.gz        - WhatsApp linked-device session, when present.
#   * env.production           - production secrets, mode 0600, when present.
#   * manifest.sha256          - checksums for every captured payload.
#
# Schedule it daily via the systemd timer in deploy/ (or cron). Run manually:
#   cd /opt/golden-pro-crm && bash scripts/vps-backup.sh
set -euo pipefail
umask 077

APP_DIR="${APP_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/golden-pro-crm}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
PRUNE_ENABLED="${BACKUP_PRUNE_ENABLED:-true}"
LOCK_FILE="${BACKUP_LOCK_FILE:-/var/lock/golden-pro-crm-backup-restore.lock}"
COMPOSE="docker compose -f $APP_DIR/deploy/docker-compose.yml"

log() { printf '\n\033[1;32m[backup]\033[0m %s\n' "$*"; }

command -v flock >/dev/null 2>&1 || { echo "flock is required." >&2; exit 1; }
command -v sha256sum >/dev/null 2>&1 || { echo "sha256sum is required." >&2; exit 1; }
mkdir -p "$(dirname "$LOCK_FILE")" "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# Restore holds this same lock for its entire operation and passes the inherited
# descriptor to its nested safety backup. Direct backup runs acquire it here.
if [ -n "${CRM_BACKUP_LOCK_FD:-}" ]; then
  [[ "$CRM_BACKUP_LOCK_FD" =~ ^[0-9]+$ ]] || { echo "Invalid inherited backup lock descriptor." >&2; exit 75; }
  inherited_lock="$(readlink -f "/proc/$$/fd/$CRM_BACKUP_LOCK_FD" 2>/dev/null || true)"
  expected_lock="$(readlink -f "$LOCK_FILE" 2>/dev/null || true)"
  [ -n "$inherited_lock" ] && [ "$inherited_lock" = "$expected_lock" ] || {
    echo "Inherited backup lock descriptor does not reference the shared lock file." >&2
    exit 75
  }
  flock -n "$CRM_BACKUP_LOCK_FD" || { echo "Inherited CRM backup/restore lock is not held." >&2; exit 75; }
else
  exec 9>"$LOCK_FILE"
  chmod 600 "$LOCK_FILE"
  if ! flock -n 9; then
    echo "Another CRM backup or restore operation is already running." >&2
    exit 75
  fi
  export CRM_BACKUP_LOCK_FD=9
fi

cd "$APP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
RUN_ID="${STAMP}-$$-${RANDOM}"
DEST="$BACKUP_DIR/$RUN_ID"
RUNTIME_DB_SNAPSHOT="/app/.runtime/_backup-${RUN_ID}.db"
RUNTIME_SALLA_SNAPSHOT="/app/.runtime/_salla-integrations-${RUN_ID}.json"
mkdir "$DEST"
chmod 700 "$DEST"
: > "$DEST/.incomplete"
chmod 600 "$DEST/.incomplete"

CID=""
cleanup() {
  if [ -n "$CID" ]; then
    $COMPOSE exec -T crm sh -c 'rm -f -- "$1" "$2"' sh \
      "$RUNTIME_DB_SNAPSHOT" "$RUNTIME_SALLA_SNAPSHOT" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# 1) Consistent SQLite snapshot via VACUUM INTO inside the container, then copy out.
log "snapshotting SQLite database"
$COMPOSE exec -T -e BACKUP_DB_PATH="$RUNTIME_DB_SNAPSHOT" crm node -e '
  const fs = require("fs");
  const snapshot = process.env.BACKUP_DB_PATH || "";
  if (!snapshot.startsWith("/app/.runtime/_backup-") || !snapshot.endsWith(".db")) {
    console.error("Invalid SQLite backup snapshot path.");
    process.exit(2);
  }
  try { fs.unlinkSync(snapshot); } catch {}
  const db = require("better-sqlite3")(process.env.DB_PATH || "/app/.runtime/golden-crm.db", { readonly: true });
  db.exec("VACUUM INTO \x27" + snapshot.replaceAll("\x27", "\x27\x27") + "\x27");
  db.close();
'
CID="$($COMPOSE ps -q crm)"
[ -n "$CID" ] || { echo "CRM container is not running." >&2; exit 1; }
docker cp "$CID:$RUNTIME_DB_SNAPSHOT" "$DEST/golden-crm.db"
gzip -f "$DEST/golden-crm.db"

# 2) Parse the fixed production Salla path before copying it. If the file exists
# but is truncated or malformed, the whole backup fails closed.
log "validating and snapshotting Salla integration state"
SALLA_PRESENT=false
if $COMPOSE exec -T -e BACKUP_SALLA_SNAPSHOT="$RUNTIME_SALLA_SNAPSHOT" crm node -e '
  const fs = require("fs");
  const source = "/app/.runtime/salla-integrations.json";
  const snapshot = process.env.BACKUP_SALLA_SNAPSHOT || "";
  if (!snapshot.startsWith("/app/.runtime/_salla-integrations-") || !snapshot.endsWith(".json")) {
    console.error("Invalid Salla backup snapshot path.");
    process.exit(2);
  }
  if (!fs.existsSync(source)) process.exit(3);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(source, "utf8"));
  } catch {
    console.error("Salla integration state exists but is not valid JSON.");
    process.exit(4);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error("Salla integration state must be a JSON object.");
    process.exit(4);
  }
  try { fs.unlinkSync(snapshot); } catch {}
  fs.writeFileSync(snapshot, JSON.stringify(parsed, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(snapshot, 0o600);
'; then
  docker cp "$CID:$RUNTIME_SALLA_SNAPSHOT" "$DEST/salla-integrations.json"
  chmod 600 "$DEST/salla-integrations.json"
  SALLA_PRESENT=true
else
  salla_status=$?
  if [ "$salla_status" -ne 3 ]; then
    echo "Salla integration backup aborted because the live state is invalid." >&2
    exit "$salla_status"
  fi
  log "Salla integration state is absent; continuing without it"
fi

# 3) WhatsApp session (from the named volume, via the container).
log "archiving WhatsApp session"
if docker cp "$CID:/app/.wa-session/." "$DEST/wa-session" >/dev/null 2>&1; then
  tar -czf "$DEST/wa-session.tar.gz" -C "$DEST" wa-session && rm -rf "$DEST/wa-session"
fi

# 4) Secrets file (kept private).
if [ -f "$APP_DIR/.env.production" ]; then
  cp "$APP_DIR/.env.production" "$DEST/env.production"
  chmod 600 "$DEST/env.production"
fi

# 5) Integrity manifest. This is the complete payload whitelist.
log "writing checksum manifest"
manifest_files=("golden-crm.db.gz")
[ "$SALLA_PRESENT" = true ] && manifest_files+=("salla-integrations.json")
[ -f "$DEST/wa-session.tar.gz" ] && manifest_files+=("wa-session.tar.gz")
[ -f "$DEST/env.production" ] && manifest_files+=("env.production")
(
  cd "$DEST"
  sha256sum "${manifest_files[@]}" > manifest.sha256
)
chmod 600 "$DEST/manifest.sha256"
(cd "$DEST" && sha256sum --check --strict --status manifest.sha256)
rm -f "$DEST/.incomplete"

# 6) Rotate only when explicitly enabled. Restore disables this for its nested
# safety snapshot so an old source backup cannot be pruned mid-operation.
if [ "$PRUNE_ENABLED" = "true" ]; then
  log "pruning backups older than ${KEEP_DAYS}d"
  find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -mtime "+${KEEP_DAYS}" -exec rm -rf {} + 2>/dev/null || true
else
  log "backup pruning disabled for this operation"
fi

log "done -> $DEST"
du -sh "$DEST" 2>/dev/null || true

# Optional off-site copy.
if [ -n "${OFFSITE_RCLONE_REMOTE:-}" ] && command -v rclone >/dev/null 2>&1; then
  log "off-site sync -> $OFFSITE_RCLONE_REMOTE"
  rclone copy "$DEST" "$OFFSITE_RCLONE_REMOTE/$RUN_ID" --transfers 4 || log "off-site sync failed (non-fatal)"
fi
