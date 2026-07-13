#!/usr/bin/env bash
# Capture the exact running deployment before source files are replaced.
# The snapshot is consumed by deploy/remote-rollback.sh.
set -euo pipefail
umask 077

APP_DIR="${APP_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
ROLLBACK_DIR="${DEPLOY_ROLLBACK_DIR:-$APP_DIR/.deploy-rollback}"
ROLLBACK_IMAGE="golden-pro-crm:rollback"

fail() {
  echo "Unable to preserve the running deployment: $*" >&2
  exit 1
}

case "$APP_DIR" in
  /*) ;;
  *) fail "APP_DIR must be an absolute path" ;;
esac
[ "$APP_DIR" != "/" ] || fail "APP_DIR cannot be /"
[ "$ROLLBACK_DIR" = "$APP_DIR/.deploy-rollback" ] || fail "rollback state must stay inside APP_DIR"

for command_name in docker sha256sum mktemp; do
  command -v "$command_name" >/dev/null 2>&1 || fail "$command_name is required"
done

CRM_CID="${CRM_CID:-}"
if [ -z "$CRM_CID" ] && [ -f "$APP_DIR/deploy/docker-compose.yml" ]; then
  CRM_CID="$(
    docker compose --env-file "$APP_DIR/.env.production" \
      -f "$APP_DIR/deploy/docker-compose.yml" ps -q crm 2>/dev/null \
      | head -n 1 || true
  )"
fi
if [ -z "$CRM_CID" ]; then
  CRM_CANDIDATES="$(
    docker ps --filter status=running --filter label=com.docker.compose.service=crm \
      --format '{{.ID}}'
  )"
  [ "$(printf '%s\n' "$CRM_CANDIDATES" | sed '/^$/d' | wc -l | tr -d ' ')" = "1" ] \
    || fail "exactly one running CRM container is required"
  CRM_CID="$(printf '%s\n' "$CRM_CANDIDATES" | sed -n '1p')"
fi
[ -n "$CRM_CID" ] || fail "a running CRM container was not found"
[ "$(docker inspect --format '{{.State.Running}}' "$CRM_CID" 2>/dev/null || true)" = "true" ] \
  || fail "the selected CRM container is not running"

PROJECT_NAME="$(
  docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$CRM_CID" 2>/dev/null || true
)"
[ -n "$PROJECT_NAME" ] && [ "$PROJECT_NAME" != "<no value>" ] \
  || fail "the CRM container has no Compose project label"

COMPOSE_LABEL="$(
  docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$CRM_CID" 2>/dev/null || true
)"
[ -n "$COMPOSE_LABEL" ] && [ "$COMPOSE_LABEL" != "<no value>" ] \
  || fail "the CRM container has no Compose config-files label"
case "$COMPOSE_LABEL" in
  *,*) fail "multiple Compose files are not supported by the rollback contract" ;;
esac
case "$COMPOSE_LABEL" in
  /*) ;;
  *) fail "the active Compose file path is not absolute" ;;
esac
[ -f "$COMPOSE_LABEL" ] || fail "the active Compose file no longer exists: $COMPOSE_LABEL"

CADDY_CANDIDATES="$(
  docker ps --filter status=running \
    --filter "label=com.docker.compose.project=$PROJECT_NAME" \
    --filter label=com.docker.compose.service=caddy \
    --format '{{.ID}}'
)"
[ "$(printf '%s\n' "$CADDY_CANDIDATES" | sed '/^$/d' | wc -l | tr -d ' ')" = "1" ] \
  || fail "exactly one running Caddy container is required"
CADDY_CID="$(printf '%s\n' "$CADDY_CANDIDATES" | sed -n '1p')"

ACTIVE_ROOT="$(cd "$(dirname "$COMPOSE_LABEL")/.." && pwd)"
if [ -f "$ACTIVE_ROOT/.env.production" ]; then
  ACTIVE_ENV="$ACTIVE_ROOT/.env.production"
elif [ -f "$APP_DIR/.env.production" ]; then
  ACTIVE_ENV="$APP_DIR/.env.production"
else
  fail "the active production environment file was not found"
fi

PARENT_DIR="$(dirname "$ROLLBACK_DIR")"
mkdir -p "$PARENT_DIR"
TMP_DIR="$(mktemp -d "$PARENT_DIR/.deploy-rollback.tmp.XXXXXX")"
cleanup() {
  if [ -n "${TMP_DIR:-}" ] && [ -d "$TMP_DIR" ]; then
    rm -rf -- "$TMP_DIR"
  fi
}
trap cleanup EXIT

cp -- "$ACTIVE_ENV" "$TMP_DIR/env.production"
cp -- "$COMPOSE_LABEL" "$TMP_DIR/docker-compose.yml"
docker cp "$CADDY_CID:/etc/caddy/Caddyfile" "$TMP_DIR/Caddyfile" >/dev/null
[ -s "$TMP_DIR/env.production" ] || fail "the active environment file is empty"
[ -s "$TMP_DIR/docker-compose.yml" ] || fail "the active Compose file is empty"
[ -s "$TMP_DIR/Caddyfile" ] || fail "the running Caddyfile is empty"
chmod 600 "$TMP_DIR/env.production"
chmod 600 "$TMP_DIR/docker-compose.yml" "$TMP_DIR/Caddyfile"

OLD_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$CRM_CID")"
[ -n "$OLD_IMAGE_ID" ] || fail "the running CRM image could not be identified"
docker image inspect "$OLD_IMAGE_ID" >/dev/null 2>&1 || fail "the running CRM image is unavailable"
docker image tag "$OLD_IMAGE_ID" "$ROLLBACK_IMAGE"

OLD_BUILD="$(
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$CRM_CID" \
    | sed -n 's/^BUILD_COMMIT=//p' | head -n 1
)"
case "$OLD_BUILD" in
  ''|*[!A-Za-z0-9._-]*) OLD_BUILD="unknown" ;;
esac

OLD_VERSION="$(
  docker exec "$CRM_CID" node -e '
    fetch("http://127.0.0.1:8080/api/health")
      .then(async (response) => {
        const payload = await response.json();
        const version = String(payload && payload.release && payload.release.version || "");
        if (!response.ok || !/^\d+\.\d+\.\d+$/.test(version)) process.exit(2);
        process.stdout.write(version);
      })
      .catch(() => process.exit(2));
  ' 2>/dev/null || true
)"
[[ "$OLD_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || OLD_VERSION="unknown"

printf '%s\n' "$OLD_IMAGE_ID" > "$TMP_DIR/previous-image-id"
printf '%s\n' "$OLD_BUILD" > "$TMP_DIR/previous-build"
printf '%s\n' "$OLD_VERSION" > "$TMP_DIR/previous-version"
printf '%s\n' "$PROJECT_NAME" > "$TMP_DIR/project-name"
printf '%s\n' "$COMPOSE_LABEL" > "$TMP_DIR/source-compose-path"
printf '%s\n' "$ACTIVE_ENV" > "$TMP_DIR/source-env-path"
(
  cd "$TMP_DIR"
  sha256sum Caddyfile docker-compose.yml env.production previous-image-id previous-build previous-version \
    project-name source-compose-path source-env-path > manifest.sha256
)
chmod 600 "$TMP_DIR"/*

PREVIOUS_DIR="$APP_DIR/.deploy-rollback.previous"
if [ -e "$PREVIOUS_DIR" ]; then
  rm -rf -- "$PREVIOUS_DIR"
fi
if [ -e "$ROLLBACK_DIR" ]; then
  mv -- "$ROLLBACK_DIR" "$PREVIOUS_DIR"
fi
mv -- "$TMP_DIR" "$ROLLBACK_DIR"
TMP_DIR=""
rm -rf -- "$PREVIOUS_DIR"
chmod 700 "$ROLLBACK_DIR"
trap - EXIT

echo "Preserved the active CRM image, environment, Compose file, and running Caddyfile."
