#!/usr/bin/env bash
# Restore the deployment captured by scripts/vps-preserve-deploy-state.sh.
set -euo pipefail
umask 077

APP_DIR="${APP_DIR:-/opt/golden-pro-crm}"
ROLLBACK_DIR="${DEPLOY_ROLLBACK_DIR:-$APP_DIR/.deploy-rollback}"
ROLLBACK_IMAGE="golden-pro-crm:rollback"
RUNTIME_IMAGE="golden-pro-crm:runtime"
HEALTH_RETRIES="${HEALTH_RETRIES:-30}"
HEALTH_SLEEP="${HEALTH_SLEEP:-4}"

fail() {
  echo "Rollback failed: $*" >&2
  exit 2
}

case "$APP_DIR" in
  /*) ;;
  *) fail "APP_DIR must be absolute" ;;
esac
[ "$APP_DIR" != "/" ] || fail "APP_DIR cannot be /"
[ "$ROLLBACK_DIR" = "$APP_DIR/.deploy-rollback" ] || fail "invalid rollback state path"
case "$HEALTH_RETRIES:$HEALTH_SLEEP" in
  *[!0-9:]*) fail "health retry settings must be integers" ;;
esac
[ "$HEALTH_RETRIES" -gt 0 ] && [ "$HEALTH_SLEEP" -gt 0 ] \
  || fail "health retry settings must be positive"

for command_name in docker curl grep mktemp rm sha256sum; do
  command -v "$command_name" >/dev/null 2>&1 || fail "$command_name is required"
done
[ -d "$ROLLBACK_DIR" ] || fail "preserved deployment state is missing"
(
  cd "$ROLLBACK_DIR"
  sha256sum --check --strict --status manifest.sha256
) || fail "preserved deployment state failed its checksum"
for required_file in Caddyfile docker-compose.yml env.production previous-build previous-version project-name \
  caddy-data-volume caddy-config-volume previous-crm-domain previous-erp-domain \
  previous-require-crm-origin previous-require-erp-endpoint previous-crm-origin-scheme; do
  [ -s "$ROLLBACK_DIR/$required_file" ] || fail "preserved $required_file is missing"
done
docker image inspect "$ROLLBACK_IMAGE" >/dev/null 2>&1 || fail "the preserved CRM image is missing"

preserved_volume_name() {
  local path="$1" label="$2" value
  value="$(<"$path")"
  case "$value" in
    ''|[!A-Za-z0-9]*|*[!A-Za-z0-9_.-]*) fail "the preserved Caddy $label volume name is invalid" ;;
  esac
  docker volume inspect "$value" >/dev/null 2>&1 \
    || fail "the preserved Caddy $label volume is unavailable"
  printf '%s' "$value"
}

safe_domain() {
  case "$1" in
    ''|none|.*|*.|*..*|*[!A-Za-z0-9.-]*) return 1 ;;
  esac
  case "$1" in *.*) return 0 ;; *) return 1 ;; esac
}

preserved_contract_value() {
  local file="$1" value
  value="$(<"$ROLLBACK_DIR/$file")"
  [ -n "$value" ] || fail "preserved $file is empty"
  printf '%s' "$value"
}

PREVIOUS_BUILD="$(sed -n '1p' "$ROLLBACK_DIR/previous-build")"
PREVIOUS_VERSION="$(sed -n '1p' "$ROLLBACK_DIR/previous-version")"
PROJECT_NAME="$(sed -n '1p' "$ROLLBACK_DIR/project-name")"
case "$PREVIOUS_BUILD" in
  ''|*[!A-Za-z0-9._-]*) PREVIOUS_BUILD="unknown" ;;
esac
[[ "$PREVIOUS_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || PREVIOUS_VERSION="unknown"
case "$PROJECT_NAME" in
  ''|*[!A-Za-z0-9_-]*) fail "the preserved Compose project name is invalid" ;;
esac
CADDY_DATA_VOLUME="$(preserved_volume_name "$ROLLBACK_DIR/caddy-data-volume" data)"
CADDY_CONFIG_VOLUME="$(preserved_volume_name "$ROLLBACK_DIR/caddy-config-volume" config)"
PREVIOUS_CRM_DOMAIN="$(preserved_contract_value previous-crm-domain)"
PREVIOUS_ERP_DOMAIN="$(preserved_contract_value previous-erp-domain)"
PREVIOUS_REQUIRE_CRM_ORIGIN="$(preserved_contract_value previous-require-crm-origin)"
PREVIOUS_REQUIRE_ERP_ENDPOINT="$(preserved_contract_value previous-require-erp-endpoint)"
PREVIOUS_CRM_ORIGIN_SCHEME="$(preserved_contract_value previous-crm-origin-scheme)"
case "$PREVIOUS_REQUIRE_CRM_ORIGIN:$PREVIOUS_REQUIRE_ERP_ENDPOINT" in
  true:true|true:false|false:true|false:false) ;;
  *) fail "the preserved proxy requirement flags are invalid" ;;
esac
if [ "$PREVIOUS_CRM_DOMAIN" != "none" ]; then
  safe_domain "$PREVIOUS_CRM_DOMAIN" || fail "the preserved CRM domain is invalid"
fi
if [ "$PREVIOUS_ERP_DOMAIN" != "none" ]; then
  safe_domain "$PREVIOUS_ERP_DOMAIN" || fail "the preserved ERP domain is invalid"
fi
if [ "$PREVIOUS_REQUIRE_CRM_ORIGIN" = true ]; then
  [ "$PREVIOUS_CRM_DOMAIN" != "none" ] || fail "the preserved CRM origin requires a domain"
  case "$PREVIOUS_CRM_ORIGIN_SCHEME" in http|https) ;; *) fail "the preserved CRM origin scheme is invalid" ;; esac
else
  [ "$PREVIOUS_CRM_ORIGIN_SCHEME" = "none" ] || fail "an unused preserved CRM origin must use scheme none"
fi
if [ "$PREVIOUS_REQUIRE_ERP_ENDPOINT" = true ]; then
  [ "$PREVIOUS_ERP_DOMAIN" != "none" ] || fail "the preserved ERP endpoint requires a domain"
fi
CADDY_ENV_ARGS=()
if [ "$PREVIOUS_CRM_DOMAIN" != "none" ]; then CADDY_ENV_ARGS+=(-e "CRM_DOMAIN=$PREVIOUS_CRM_DOMAIN"); fi
if [ "$PREVIOUS_ERP_DOMAIN" != "none" ]; then CADDY_ENV_ARGS+=(-e "ERP_DOMAIN=$PREVIOUS_ERP_DOMAIN"); fi

echo "Validating the preserved Caddy configuration..."
docker run --rm --network none --cap-drop ALL --cap-add NET_BIND_SERVICE \
  "${CADDY_ENV_ARGS[@]}" \
  --mount "type=volume,src=$CADDY_DATA_VOLUME,dst=/data,readonly" \
  --mount "type=volume,src=$CADDY_CONFIG_VOLUME,dst=/config,readonly" \
  --mount "type=bind,src=$ROLLBACK_DIR/Caddyfile,dst=/etc/caddy/Caddyfile,readonly" \
  caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null \
  || fail "the preserved Caddyfile is invalid"

mkdir -p "$APP_DIR/deploy"
install -m 600 "$ROLLBACK_DIR/env.production" "$APP_DIR/.env.production.rollback-next"
install -m 600 "$ROLLBACK_DIR/docker-compose.yml" "$APP_DIR/deploy/docker-compose.yml.rollback-next"
install -m 600 "$ROLLBACK_DIR/Caddyfile" "$APP_DIR/deploy/Caddyfile.rollback-next"
mv -f "$APP_DIR/.env.production.rollback-next" "$APP_DIR/.env.production"
mv -f "$APP_DIR/deploy/docker-compose.yml.rollback-next" "$APP_DIR/deploy/docker-compose.yml"
mv -f "$APP_DIR/deploy/Caddyfile.rollback-next" "$APP_DIR/deploy/Caddyfile"
chmod 600 "$APP_DIR/.env.production"

docker image tag "$ROLLBACK_IMAGE" "$RUNTIME_IMAGE"
docker image tag "$ROLLBACK_IMAGE" "deploy-crm:latest"
docker image tag "$ROLLBACK_IMAGE" "${PROJECT_NAME}-crm:latest"
export BUILD_COMMIT="$PREVIOUS_BUILD"
unset CRM_DOMAIN ERP_DOMAIN
if [ "$PREVIOUS_CRM_DOMAIN" != "none" ]; then export CRM_DOMAIN="$PREVIOUS_CRM_DOMAIN"; fi
if [ "$PREVIOUS_ERP_DOMAIN" != "none" ]; then export ERP_DOMAIN="$PREVIOUS_ERP_DOMAIN"; fi
export CADDY_DATA_VOLUME CADDY_CONFIG_VOLUME
COMPOSE=(
  docker compose --project-name "$PROJECT_NAME"
  --env-file "$APP_DIR/.env.production"
  -f "$APP_DIR/deploy/docker-compose.yml"
)

erp_login_matches() {
  local domain="$1" response_file status=1
  response_file="$(mktemp /tmp/golden-pro-crm-erp-health.XXXXXXXXXX)" || return 1
  if curl --fail --silent --show-error --connect-timeout 5 --max-time 15 \
    --output "$response_file" --resolve "$domain:443:127.0.0.1" \
    "https://$domain/web/login" 2>/dev/null \
    && grep -Eiq '<title[[:space:]]*>[[:space:]]*odoo([[:space:]<]|$)' "$response_file"; then
    status=0
  fi
  rm -f -- "$response_file"
  return "$status"
}

contract_matches() {
  local cid payload
  cid="$("${COMPOSE[@]}" ps -q crm 2>/dev/null || true)"
  [ -n "$cid" ] || return 1
  [ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid")" = "healthy" ] \
    || return 1

  if ! docker exec \
    -e EXPECTED_VERSION="$PREVIOUS_VERSION" \
    -e EXPECTED_BUILD="$PREVIOUS_BUILD" \
    "$cid" node -e '
      fetch("http://127.0.0.1:8080/api/health")
        .then(async (response) => ({ response, payload: await response.json() }))
        .then(({ response, payload }) => {
          const release = payload && payload.release || {};
          const version = String(process.env.EXPECTED_VERSION || "unknown");
          const build = String(process.env.EXPECTED_BUILD || "unknown");
          const versionMatches = version === "unknown" || release.version === version;
          const buildMatches = build === "unknown" || payload.commit === build;
          if (!response.ok || payload.status !== "ok" || !versionMatches || !buildMatches) process.exit(1);
        })
        .catch(() => process.exit(1));
    ' >/dev/null 2>&1; then
    return 1
  fi

  if [ "$PREVIOUS_REQUIRE_CRM_ORIGIN" = true ]; then
    if [ "$PREVIOUS_CRM_ORIGIN_SCHEME" = "http" ]; then
      payload="$(
        curl --fail --silent --show-error --connect-timeout 5 --max-time 15 \
          --header "Host: $PREVIOUS_CRM_DOMAIN" "http://127.0.0.1/api/health" 2>/dev/null
      )" || return 1
    else
      payload="$(
        curl --fail --silent --show-error --connect-timeout 5 --max-time 15 \
          --resolve "$PREVIOUS_CRM_DOMAIN:443:127.0.0.1" \
          "https://$PREVIOUS_CRM_DOMAIN/api/health" 2>/dev/null
      )" || return 1
    fi
    printf '%s' "$payload" | docker exec -i \
      -e EXPECTED_VERSION="$PREVIOUS_VERSION" \
      -e EXPECTED_BUILD="$PREVIOUS_BUILD" \
      "$cid" node -e '
        let raw = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => { raw += chunk; });
        process.stdin.on("end", () => {
          try {
            const payload = JSON.parse(raw);
            const release = payload && payload.release || {};
            const version = String(process.env.EXPECTED_VERSION || "unknown");
            const build = String(process.env.EXPECTED_BUILD || "unknown");
            if (payload.status !== "ok" || (version !== "unknown" && release.version !== version) ||
                (build !== "unknown" && payload.commit !== build)) process.exit(1);
          } catch { process.exit(1); }
        });
      ' >/dev/null 2>&1 || return 1
  fi
  if [ "$PREVIOUS_REQUIRE_ERP_ENDPOINT" = true ]; then
    erp_login_matches "$PREVIOUS_ERP_DOMAIN" || return 1
  fi
  return 0
}

echo "Restoring the preserved CRM image, Compose file, environment, and Caddyfile..."
"${COMPOSE[@]}" up -d --no-build --force-recreate crm caddy \
  || fail "Compose could not recreate the preserved stack"

for _ in $(seq 1 "$HEALTH_RETRIES"); do
  if contract_matches; then
    "${COMPOSE[@]}" ps
    echo "The preserved deployment recovered its checksummed CRM and Odoo ERP login health contract."
    exit 0
  fi
  sleep "$HEALTH_SLEEP"
done

fail "the preserved deployment did not recover its CRM and Odoo ERP login health contract"
