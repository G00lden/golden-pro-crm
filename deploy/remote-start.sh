#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/golden-pro-crm}"
CRM_DOMAIN="${CRM_DOMAIN:-crm.breexe-pro.com}"
HEALTH_RETRIES="${HEALTH_RETRIES:-30}"
HEALTH_SLEEP="${HEALTH_SLEEP:-4}"
EXPECTED_VERSION="${EXPECTED_VERSION:-}"
EXPECTED_BUILD="${EXPECTED_BUILD:-${BUILD_COMMIT:-}}"
ROLLBACK_DIR="${DEPLOY_ROLLBACK_DIR:-$APP_DIR/.deploy-rollback}"
ROLLBACK_IMAGE="golden-pro-crm:rollback"

fail() {
  echo "Deployment failed: $*" >&2
  exit 1
}

case "$APP_DIR" in
  /*) ;;
  *) fail "APP_DIR must be absolute" ;;
esac
[ "$APP_DIR" != "/" ] || fail "APP_DIR cannot be /"
case "$CRM_DOMAIN" in
  *[!A-Za-z0-9.-]*|'') fail "CRM_DOMAIN is invalid" ;;
esac
case "$HEALTH_RETRIES:$HEALTH_SLEEP" in
  *[!0-9:]*) fail "health retry settings must be integers" ;;
esac
[ "$HEALTH_RETRIES" -gt 0 ] && [ "$HEALTH_SLEEP" -gt 0 ] \
  || fail "health retry settings must be positive"

cd "$APP_DIR"
[ -s ".env.production" ] || fail ".env.production is missing or empty in $APP_DIR"
[ -s "deploy/docker-compose.yml" ] || fail "deploy/docker-compose.yml is missing"
[ -s "deploy/Caddyfile" ] || fail "deploy/Caddyfile is missing"
[ -s "deploy/remote-rollback.sh" ] || fail "deploy/remote-rollback.sh is missing"
for command_name in docker curl sha256sum; do
  command -v "$command_name" >/dev/null 2>&1 || fail "$command_name is required"
done

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

[ "$(env_value TRUST_PROXY_HEADERS)" = "true" ] \
  || fail "TRUST_PROXY_HEADERS must be true for the bundled trusted Caddy proxy"
PUBLIC_CONTACT_PHONE="$(env_value VITE_PUBLIC_CONTACT_PHONE)"
[[ "$PUBLIC_CONTACT_PHONE" =~ ^\+[1-9][0-9]{7,14}$ ]] \
  || fail "VITE_PUBLIC_CONTACT_PHONE must be a valid E.164 number"

PROJECT_NAME=""
if [ -d "$ROLLBACK_DIR" ]; then
  [ -s "$ROLLBACK_DIR/project-name" ] || fail "the preserved Compose project name is missing"
  (
    cd "$ROLLBACK_DIR"
    sha256sum --check --strict --status manifest.sha256
  ) || fail "the preserved rollback state failed its checksum"
  PROJECT_NAME="$(sed -n '1p' "$ROLLBACK_DIR/project-name")"
  case "$PROJECT_NAME" in
    ''|*[!A-Za-z0-9_-]*) fail "the preserved Compose project name is invalid" ;;
  esac
fi
COMPOSE=(docker compose)
if [ -n "$PROJECT_NAME" ]; then
  COMPOSE+=(--project-name "$PROJECT_NAME")
fi
COMPOSE+=(--env-file "$APP_DIR/.env.production" -f "$APP_DIR/deploy/docker-compose.yml")

if [ -z "$EXPECTED_VERSION" ]; then
  EXPECTED_VERSION="$(
    sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' release.json \
      | head -n 1
  )"
fi
[[ "$EXPECTED_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || fail "the expected release version is invalid"
case "$EXPECTED_BUILD" in
  ''|unknown|*[!A-Za-z0-9._-]*) fail "an exact EXPECTED_BUILD is required" ;;
esac

export BUILD_COMMIT="$EXPECTED_BUILD"
export CRM_DOMAIN

OLD_CID="$("${COMPOSE[@]}" ps -q crm 2>/dev/null || true)"
HAD_PREVIOUS=false
if [ -n "$OLD_CID" ]; then
  HAD_PREVIOUS=true
  [ "$(docker inspect --format '{{.State.Running}}' "$OLD_CID" 2>/dev/null || true)" = "true" ] \
    || fail "the existing CRM container is not running"
  [ -d "$ROLLBACK_DIR" ] || fail "rollback state was not preserved before source replacement"
  docker image inspect "$ROLLBACK_IMAGE" >/dev/null 2>&1 \
    || fail "the previous CRM image was not preserved"
fi

rollback_and_fail() {
  local reason="$1"
  echo "$reason" >&2
  if [ "$HAD_PREVIOUS" = true ]; then
    if APP_DIR="$APP_DIR" CRM_DOMAIN="$CRM_DOMAIN" HEALTH_RETRIES="$HEALTH_RETRIES" \
      HEALTH_SLEEP="$HEALTH_SLEEP" bash "$APP_DIR/deploy/remote-rollback.sh"; then
      echo "The previous deployment was restored after the failed release." >&2
      exit 1
    fi
    echo "Automatic rollback failed; manual recovery is required." >&2
    exit 2
  fi
  echo "No previous deployment exists to restore." >&2
  exit 1
}

echo "Validating the new Caddy configuration before replacement..."
if ! docker run --rm --network none \
  -e CRM_DOMAIN="$CRM_DOMAIN" \
  -v "$APP_DIR/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" \
  caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null; then
  rollback_and_fail "The new Caddy configuration is invalid."
fi

internal_release_matches() {
  local cid
  cid="$("${COMPOSE[@]}" ps -q crm 2>/dev/null || true)"
  [ -n "$cid" ] || return 1
  [ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid")" = "healthy" ] \
    || return 1
  docker exec \
    -e EXPECTED_VERSION="$EXPECTED_VERSION" \
    -e EXPECTED_BUILD="$EXPECTED_BUILD" \
    "$cid" node -e '
      fetch("http://127.0.0.1:8080/api/health")
        .then(async (response) => ({ response, payload: await response.json() }))
        .then(({ response, payload }) => {
          const release = payload && payload.release || {};
          if (!response.ok || payload.status !== "ok" ||
              release.version !== process.env.EXPECTED_VERSION ||
              payload.commit !== process.env.EXPECTED_BUILD) process.exit(1);
        })
        .catch(() => process.exit(1));
    ' >/dev/null 2>&1
}

caddy_release_matches() {
  local cid payload
  cid="$("${COMPOSE[@]}" ps -q crm 2>/dev/null || true)"
  [ -n "$cid" ] || return 1
  payload="$(
    curl --fail --silent --show-error --connect-timeout 5 --max-time 15 \
      --resolve "$CRM_DOMAIN:443:127.0.0.1" "https://$CRM_DOMAIN/api/health" 2>/dev/null
  )" || return 1
  printf '%s' "$payload" | docker exec -i \
    -e EXPECTED_VERSION="$EXPECTED_VERSION" \
    -e EXPECTED_BUILD="$EXPECTED_BUILD" \
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

wait_for_release() {
  local attempt
  for attempt in $(seq 1 "$HEALTH_RETRIES"); do
    if internal_release_matches && caddy_release_matches; then
      return 0
    fi
    sleep "$HEALTH_SLEEP"
  done
  return 1
}

echo "Building release $EXPECTED_VERSION ($EXPECTED_BUILD) before replacing the running stack..."
if ! "${COMPOSE[@]}" build crm; then
  rollback_and_fail "The new CRM image failed to build."
fi

echo "Recreating CRM and Caddy so both use the new image and configuration..."
if ! "${COMPOSE[@]}" up -d --no-build --force-recreate crm caddy; then
  rollback_and_fail "Compose could not start the new release."
fi

if ! wait_for_release; then
  rollback_and_fail "The new release failed the exact internal/Caddy health contract."
fi

"${COMPOSE[@]}" ps
echo "Golden Pro CRM $EXPECTED_VERSION is healthy internally and through Caddy at build $EXPECTED_BUILD."
