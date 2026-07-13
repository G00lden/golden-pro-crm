#!/usr/bin/env bash
# Fail-closed VPS update path used by GitHub Actions and manual deployments.
set -euo pipefail
umask 077

APP_DIR="${APP_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
BRANCH="${DEPLOY_BRANCH:-main}"
HEALTH_RETRIES="${HEALTH_RETRIES:-30}"
HEALTH_SLEEP="${HEALTH_SLEEP:-4}"
ROLLBACK_HELPER="/tmp/golden-pro-crm-remote-rollback.sh"

log() { printf '\n[deploy] %s\n' "$*"; }
fail() { echo "VPS update failed: $*" >&2; exit 1; }

case "$APP_DIR" in
  /*) ;;
  *) fail "APP_DIR must be absolute" ;;
esac
[ "$APP_DIR" != "/" ] || fail "APP_DIR cannot be /"
case "$BRANCH" in
  ''|*[!A-Za-z0-9._/-]*|*..*) fail "DEPLOY_BRANCH is invalid" ;;
esac
case "$HEALTH_RETRIES:$HEALTH_SLEEP" in
  *[!0-9:]*) fail "health retry settings must be integers" ;;
esac
[ "$HEALTH_RETRIES" -gt 0 ] && [ "$HEALTH_SLEEP" -gt 0 ] \
  || fail "health retry settings must be positive"

cd "$APP_DIR"
for command_name in docker git curl; do
  command -v "$command_name" >/dev/null 2>&1 || fail "$command_name is required"
done
[ -s .env.production ] || fail ".env.production is missing"
[ -s scripts/vps-backup.sh ] || fail "the current backup script is missing"
[ -s scripts/vps-preserve-deploy-state.sh ] || fail "the current state-preservation script is missing"
[ -s deploy/remote-rollback.sh ] || fail "the current trusted rollback script is missing"

env_value() {
  local key="$1" value
  value="$(
    sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*//p" .env.production \
      | tail -n 1 | tr -d '\r'
  )"
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  printf '%s' "$value"
}

CRM_DOMAIN="$(env_value CRM_DOMAIN)"
CRM_DOMAIN="${CRM_DOMAIN:-crm.breexe-pro.com}"
case "$CRM_DOMAIN" in
  *[!A-Za-z0-9.-]*|'') fail "CRM_DOMAIN is invalid" ;;
esac

COMPOSE=(docker compose --env-file "$APP_DIR/.env.production" -f "$APP_DIR/deploy/docker-compose.yml")
RUNNING_CID="$("${COMPOSE[@]}" ps -q crm 2>/dev/null || true)"
[ -n "$RUNNING_CID" ] || fail "a running CRM deployment is required for zero-touch update"

PREV="$(git rev-parse HEAD)"
case "$PREV" in
  *[!0-9a-f]*) fail "the current Git commit is invalid" ;;
esac
log "current commit: $PREV"

# Both operations intentionally precede fetch/reset. Backup protects data;
# preserve protects the exact image, env, Compose file, and running Caddyfile.
log "creating a fail-closed data backup"
APP_DIR="$APP_DIR" bash scripts/vps-backup.sh
log "preserving the exact running deployment"
APP_DIR="$APP_DIR" bash scripts/vps-preserve-deploy-state.sh

PROJECT_NAME="$(sed -n '1p' "$APP_DIR/.deploy-rollback/project-name")"
case "$PROJECT_NAME" in
  ''|*[!A-Za-z0-9_-]*) fail "the preserved Compose project name is invalid" ;;
esac
COMPOSE=(
  docker compose --project-name "$PROJECT_NAME"
  --env-file "$APP_DIR/.env.production"
  -f "$APP_DIR/deploy/docker-compose.yml"
)

# Keep a trusted rollback helper outside the Git worktree. Every error after
# source reset is routed through this helper and restores both source/runtime.
cp deploy/remote-rollback.sh "$ROLLBACK_HELPER"
chmod 700 "$ROLLBACK_HELPER"
POST_RESET=false
RESTORING=false
cleanup_helper() { rm -f -- "$ROLLBACK_HELPER"; }
trap cleanup_helper EXIT

restore_source_and_runtime() {
  local reason="$1" reset_status=0 rollback_status=0
  RESTORING=true
  trap - ERR
  set +e
  echo "$reason" >&2
  log "restoring source commit $PREV"
  git reset --hard "$PREV"
  reset_status=$?
  log "restoring the preserved runtime and proxy state"
  APP_DIR="$APP_DIR" CRM_DOMAIN="$CRM_DOMAIN" HEALTH_RETRIES="$HEALTH_RETRIES" \
    HEALTH_SLEEP="$HEALTH_SLEEP" bash "$ROLLBACK_HELPER"
  rollback_status=$?
  if [ "$reset_status" -ne 0 ] || [ "$rollback_status" -ne 0 ]; then
    echo "Source reset status: $reset_status; runtime rollback status: $rollback_status" >&2
    exit 2
  fi
  echo "The previous source and deployment were restored." >&2
  exit 1
}

unexpected_failure() {
  local status="$?"
  if [ "$POST_RESET" = true ] && [ "$RESTORING" = false ]; then
    restore_source_and_runtime "An unexpected error occurred after source replacement."
  fi
  exit "$status"
}
trap unexpected_failure ERR

log "fetching origin/$BRANCH"
git fetch --quiet origin "$BRANCH"
POST_RESET=true
git reset --hard "origin/$BRANCH"
NEW="$(git rev-parse HEAD)"
BUILD_COMMIT="$(git rev-parse --short=12 HEAD)"
case "$NEW:$BUILD_COMMIT" in
  *[!0-9a-f:]*) restore_source_and_runtime "The fetched Git commit is invalid." ;;
esac
EXPECTED_VERSION="$(
  sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' release.json \
    | head -n 1
)"
[[ "$EXPECTED_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || restore_source_and_runtime "The fetched release version is invalid."
[ -s deploy/remote-start.sh ] \
  || restore_source_and_runtime "The fetched remote-start script is missing."
[ -s deploy/remote-rollback.sh ] \
  || restore_source_and_runtime "The fetched rollback script is missing."
log "deploying commit: $NEW as release $EXPECTED_VERSION"

if ! APP_DIR="$APP_DIR" CRM_DOMAIN="$CRM_DOMAIN" \
  EXPECTED_VERSION="$EXPECTED_VERSION" EXPECTED_BUILD="$BUILD_COMMIT" BUILD_COMMIT="$BUILD_COMMIT" \
  HEALTH_RETRIES="$HEALTH_RETRIES" HEALTH_SLEEP="$HEALTH_SLEEP" bash deploy/remote-start.sh; then
  restore_source_and_runtime "The fetched release failed its atomic deployment contract."
fi

public_release_matches() {
  local cid payload
  cid="$("${COMPOSE[@]}" ps -q crm 2>/dev/null || true)"
  [ -n "$cid" ] || return 1
  payload="$(
    curl --fail --silent --show-error --connect-timeout 5 --max-time 30 \
      "https://$CRM_DOMAIN/api/health" 2>/dev/null
  )" || return 1
  printf '%s' "$payload" | docker exec -i \
    -e EXPECTED_VERSION="$EXPECTED_VERSION" -e EXPECTED_BUILD="$BUILD_COMMIT" \
    "$cid" node -e '
      let raw = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { raw += chunk; });
      process.stdin.on("end", () => {
        try {
          const payload = JSON.parse(raw);
          const release = payload && payload.release || {};
          if (payload.status !== "ok" || release.version !== process.env.EXPECTED_VERSION ||
              payload.commit !== process.env.EXPECTED_BUILD) process.exit(1);
        } catch { process.exit(1); }
      });
    ' >/dev/null 2>&1
}

log "verifying the exact release through public HTTPS"
PUBLIC_HEALTHY=false
for _ in $(seq 1 "$HEALTH_RETRIES"); do
  if public_release_matches; then
    PUBLIC_HEALTHY=true
    break
  fi
  sleep "$HEALTH_SLEEP"
done
[ "$PUBLIC_HEALTHY" = true ] \
  || restore_source_and_runtime "Public HTTPS did not expose the exact new release."

POST_RESET=false
log "healthy: release $EXPECTED_VERSION at build $BUILD_COMMIT"
