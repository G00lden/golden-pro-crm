#!/usr/bin/env bash
# Restore a Golden Pro CRM backup produced by scripts/vps-backup.sh.
#
#   bash scripts/vps-restore.sh /opt/golden-pro-crm/backups/20260707-031500
#
# Restores the SQLite database (and the WhatsApp session, if present) into the
# running stack's volumes, then restarts. The app is stopped during the copy so
# nothing writes to the DB mid-restore. Existing state is backed up first.
set -euo pipefail

SRC="${1:-}"
APP_DIR="${APP_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
COMPOSE="docker compose -f $APP_DIR/deploy/docker-compose.yml"

if [ -z "$SRC" ] || [ ! -d "$SRC" ]; then
  echo "usage: bash scripts/vps-restore.sh <backup-dir>" >&2
  echo "available:" >&2
  ls -1 "$APP_DIR/backups" 2>/dev/null | sed 's/^/  /' >&2 || true
  exit 1
fi

cd "$APP_DIR"
log() { printf '\n\033[1;33m[restore]\033[0m %s\n' "$*"; }

DB_GZ="$SRC/golden-crm.db.gz"
[ -f "$DB_GZ" ] || { echo "no golden-crm.db.gz in $SRC" >&2; exit 1; }

read -r -p "This overwrites the live database with $SRC. Continue? [y/N] " ans
[ "$ans" = "y" ] || { echo "aborted"; exit 1; }

log "safety snapshot of current state"
bash scripts/vps-backup.sh || log "pre-restore snapshot failed (continuing)"

log "stopping app container"
$COMPOSE stop crm
CID="$($COMPOSE ps -aq crm)"

log "restoring database"
TMP="$(mktemp)"; gunzip -c "$DB_GZ" > "$TMP"
docker cp "$TMP" "$CID:/app/.runtime/golden-crm.db"
# Drop stale WAL/SHM so the restored DB is authoritative.
$COMPOSE run --rm --no-deps crm sh -c 'rm -f /app/.runtime/golden-crm.db-wal /app/.runtime/golden-crm.db-shm' 2>/dev/null || true
rm -f "$TMP"

if [ -f "$SRC/wa-session.tar.gz" ]; then
  log "restoring WhatsApp session"
  WT="$(mktemp -d)"; tar -xzf "$SRC/wa-session.tar.gz" -C "$WT"
  docker cp "$WT/wa-session/." "$CID:/app/.wa-session/" 2>/dev/null || true
  rm -rf "$WT"
fi

log "starting app"
$COMPOSE up -d
log "restore complete — verify: docker compose -f deploy/docker-compose.yml logs -f crm"
