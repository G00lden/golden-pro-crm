#!/usr/bin/env bash
# Consistent backup of the Golden Pro CRM state on the VPS.
#
# Captures, into $BACKUP_DIR/<timestamp>/:
#   * golden-crm.db.gz   — a CONSISTENT SQLite snapshot (VACUUM INTO, safe while
#                          the app is running), gzipped.
#   * wa-session.tar.gz  — the WhatsApp linked-device session (restore without
#                          re-scanning the QR).
#   * env.production     — the .env.production (secrets) — kept 0600.
# Then prunes backups older than $BACKUP_KEEP_DAYS.
#
# Schedule it daily via the systemd timer in deploy/ (or cron). Run manually:
#   cd /opt/golden-pro-crm && bash scripts/vps-backup.sh
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
COMPOSE="docker compose -f $APP_DIR/deploy/docker-compose.yml"

cd "$APP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$BACKUP_DIR/$STAMP"
mkdir -p "$DEST"
chmod 700 "$BACKUP_DIR" "$DEST"

log() { printf '\n\033[1;32m[backup]\033[0m %s\n' "$*"; }

# 1) Consistent SQLite snapshot via VACUUM INTO inside the container, then copy out.
log "snapshotting SQLite database"
$COMPOSE exec -T crm node -e '
  const path = "/app/.runtime/_backup.db";
  const fs = require("fs");
  try { fs.unlinkSync(path); } catch {}
  const db = require("better-sqlite3")(process.env.DB_PATH || "/app/.runtime/golden-crm.db", { readonly: true });
  db.exec("VACUUM INTO \x27" + path + "\x27");
  db.close();
'
CID="$($COMPOSE ps -q crm)"
docker cp "$CID:/app/.runtime/_backup.db" "$DEST/golden-crm.db"
$COMPOSE exec -T crm sh -c 'rm -f /app/.runtime/_backup.db' || true
gzip -f "$DEST/golden-crm.db"

# 2) WhatsApp session (from the named volume, via the container).
log "archiving WhatsApp session"
if docker cp "$CID:/app/.wa-session/." "$DEST/wa-session" >/dev/null 2>&1; then
  tar -czf "$DEST/wa-session.tar.gz" -C "$DEST" wa-session && rm -rf "$DEST/wa-session"
fi

# 3) Secrets file (kept private).
if [ -f "$APP_DIR/.env.production" ]; then
  cp "$APP_DIR/.env.production" "$DEST/env.production"
  chmod 600 "$DEST/env.production"
fi

# 4) Rotate: drop backups older than KEEP_DAYS.
log "pruning backups older than ${KEEP_DAYS}d"
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -mtime "+${KEEP_DAYS}" -exec rm -rf {} + 2>/dev/null || true

log "done → $DEST"
du -sh "$DEST" 2>/dev/null || true

# Optional off-site copy: if OFFSITE_RCLONE_REMOTE is set (e.g. "r2:crm-backups"),
# sync the backup root there with rclone (install & configure rclone separately).
if [ -n "${OFFSITE_RCLONE_REMOTE:-}" ] && command -v rclone >/dev/null 2>&1; then
  log "off-site sync → $OFFSITE_RCLONE_REMOTE"
  rclone copy "$DEST" "$OFFSITE_RCLONE_REMOTE/$STAMP" --transfers 4 || log "off-site sync failed (non-fatal)"
fi
