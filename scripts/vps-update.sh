#!/usr/bin/env bash
# Zero-touch update for the Golden Pro CRM VPS deployment.
#
#   1. Pulls the latest code for the deploy branch.
#   2. Rebuilds and restarts the Docker stack (crm + Caddy).
#   3. Waits for the container to report healthy.
#   4. If the build fails OR the health check never passes, rolls the code back
#      to the previous commit and rebuilds, so a bad push can't take the site down.
#
# Run manually:  cd /opt/golden-pro-crm && bash scripts/vps-update.sh
# Run from CI:   invoked over SSH by .github/workflows/deploy.yml
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
BRANCH="${DEPLOY_BRANCH:-main}"
COMPOSE="docker compose -f deploy/docker-compose.yml"
HEALTH_RETRIES="${HEALTH_RETRIES:-30}"
HEALTH_SLEEP="${HEALTH_SLEEP:-4}"

cd "$APP_DIR"

log() { printf '\n\033[1;34m[deploy]\033[0m %s\n' "$*"; }

health_ok() {
  # Exec the same health probe the container uses, over the internal port.
  $COMPOSE exec -T crm node -e \
    "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    >/dev/null 2>&1
}

rebuild() { $COMPOSE up -d --build; }

PREV="$(git rev-parse HEAD)"
log "current commit: $PREV"

log "fetching origin/$BRANCH"
git fetch --quiet origin "$BRANCH"
git reset --hard "origin/$BRANCH"
NEW="$(git rev-parse HEAD)"
log "deploying commit: $NEW"

rollback() {
  log "ROLLBACK → $PREV"
  git reset --hard "$PREV"
  rebuild || true
  exit 1
}

if [ "$NEW" = "$PREV" ]; then
  log "already up to date; rebuilding to apply any env/compose changes"
fi

log "building and restarting containers"
if ! rebuild; then
  log "build/up failed"
  rollback
fi

log "waiting for health (up to $((HEALTH_RETRIES * HEALTH_SLEEP))s)"
for _ in $(seq 1 "$HEALTH_RETRIES"); do
  if health_ok; then
    log "healthy ✔  deployed $NEW"
    exit 0
  fi
  sleep "$HEALTH_SLEEP"
done

log "health check never passed"
rollback
