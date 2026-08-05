#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/golden-pro-crm}"
CADDYFILE="${CADDYFILE:-$APP_DIR/deploy/Caddyfile}"
COMPOSE_FILE="${COMPOSE_FILE:-$APP_DIR/deploy/docker-compose.yml}"
DEPLOY_LOCK_FILE="${DEPLOY_LOCK_FILE:-/run/golden-pro-crm/deploy.lock}"
BACKUP_DIR="${STAGE_GUARD_BACKUP_DIR:-/var/backups/breexe-stage-caddy-guard}"
STAGE_DOMAIN="${ODOO_STAGE_DOMAIN:-stage-erp.breexe-pro.com}"
STAGE_UPSTREAM="${ODOO_STAGE_UPSTREAM:-host.docker.internal:18070}"
CRM_DOMAIN="${CRM_DOMAIN:-crm.breexe-pro.com}"
FIELDTECH_DOMAIN="${FIELDTECH_DOMAIN:-fieldtech.breexe-pro.com}"
ERP_DOMAIN="${ERP_DOMAIN:-erp.breexe-pro.com}"

log() {
  printf '[breexe-stage-caddy-guard] %s\n' "$*"
  command -v logger >/dev/null 2>&1 && logger -t breexe-stage-caddy-guard -- "$*" || true
}

fail() {
  log "ERROR: $*"
  exit 1
}

validate_domain() {
  case "$1" in
    ''|*[!A-Za-z0-9.-]*) return 1 ;;
  esac
}

stage_contract_matches() {
  local file="$1" https_block
  [ -f "$file" ] || return 1
  [ "$(grep -Fxc -- "http://$STAGE_DOMAIN {" "$file" || true)" = 1 ] || return 1
  [ "$(grep -Fxc -- "https://$STAGE_DOMAIN {" "$file" || true)" = 1 ] || return 1
  grep -Fq -- "/$STAGE_DOMAIN/$STAGE_DOMAIN.crt" "$file" || return 1
  grep -Fq -- "/$STAGE_DOMAIN/$STAGE_DOMAIN.key" "$file" || return 1
  https_block="$(awk -v start="https://$STAGE_DOMAIN {" '
    $0 == start { inside=1 }
    inside { print }
    inside && /^[[:space:]]*}[[:space:]]*$/ { exit }
  ' "$file")"
  [ -n "$https_block" ] || return 1
  printf '%s\n' "$https_block" | grep -Fq -- "reverse_proxy $STAGE_UPSTREAM" || return 1
  if printf '%s\n' "$https_block" | grep -Fq -- 'host.docker.internal:8069'; then return 1; fi
}

render_candidate() {
  local source="$1" output="$2"
  awk -v http_start="http://$STAGE_DOMAIN {" -v https_start="https://$STAGE_DOMAIN {" \
    -v guard_start="# BEGIN BREEXE ODOO STAGE ROUTE" -v guard_end="# END BREEXE ODOO STAGE ROUTE" '
    $0 == guard_start { guarded=1; next }
    guarded && $0 == guard_end { guarded=0; next }
    guarded { next }
    $0 == http_start || $0 == https_start { skipping=1; next }
    skipping && /^[[:space:]]*}[[:space:]]*$/ { skipping=0; next }
    !skipping { output[++line_count]=$0 }
    END {
      while (line_count > 0 && output[line_count] ~ /^[[:space:]]*$/) line_count--
      for (line_number=1; line_number<=line_count; line_number++) print output[line_number]
    }
  ' "$source" >"$output"
  cat >>"$output" <<EOF

# BEGIN BREEXE ODOO STAGE ROUTE
# Odoo Stage is owned by the host-level BreeXe route guard. The guard restores
# this isolated block after any release swap and rejects the Live upstream.
http://$STAGE_DOMAIN {
	redir https://{host}{uri} permanent
}

https://$STAGE_DOMAIN {
	tls /data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/$STAGE_DOMAIN/$STAGE_DOMAIN.crt /data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/$STAGE_DOMAIN/$STAGE_DOMAIN.key
	reverse_proxy $STAGE_UPSTREAM
}
# END BREEXE ODOO STAGE ROUTE
EOF
}

find_caddy_container() {
  docker ps --filter label=com.docker.compose.service=caddy --format '{{.Names}}' | head -n 1
}

container_contract_matches() {
  local container="$1" copy
  copy="$(mktemp)"
  if docker cp "$container:/etc/caddy/Caddyfile" "$copy" >/dev/null 2>&1 \
    && stage_contract_matches "$copy"; then
    rm -f -- "$copy"
    return 0
  fi
  rm -f -- "$copy"
  return 1
}

validate_candidate() {
  local candidate="$1" container="$2" data_volume config_volume
  data_volume="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$container")"
  config_volume="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/config"}}{{.Name}}{{end}}{{end}}' "$container")"
  [ -n "$data_volume" ] || fail "the running Caddy data volume was not found"
  [ -n "$config_volume" ] || fail "the running Caddy config volume was not found"
  docker run --rm \
    -e "CRM_DOMAIN=$CRM_DOMAIN" \
    -e "FIELDTECH_DOMAIN=$FIELDTECH_DOMAIN" \
    -e "ERP_DOMAIN=$ERP_DOMAIN" \
    -v "$candidate:/etc/caddy/Caddyfile:ro" \
    -v "$data_volume:/data" \
    -v "$config_volume:/config" \
    caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
}

stage_https_is_healthy() {
  curl --fail --silent --show-error --output /dev/null --max-time 10 \
    --resolve "$STAGE_DOMAIN:443:127.0.0.1" "https://$STAGE_DOMAIN/odoo"
}

repair_runtime() {
  local lock_dir candidate container changed=false attempt
  lock_dir="$(dirname "$DEPLOY_LOCK_FILE")"
  install -d -m 0700 -- "$lock_dir"
  [ ! -L "$lock_dir" ] || fail "deployment lock directory cannot be a symlink"
  exec 9>>"$DEPLOY_LOCK_FILE"
  chmod 600 "$DEPLOY_LOCK_FILE"
  flock -w 300 9 || fail "timed out waiting for the deployment transaction"

  [ -f "$CADDYFILE" ] && [ ! -L "$CADDYFILE" ] || fail "release Caddyfile is missing or unsafe"
  [ -f "$COMPOSE_FILE" ] && [ ! -L "$COMPOSE_FILE" ] || fail "release Compose file is missing or unsafe"
  container="$(find_caddy_container)"
  [ -n "$container" ] || fail "the running Caddy container was not found"

  if ! stage_contract_matches "$CADDYFILE"; then
    candidate="$(mktemp)"
    trap 'rm -f -- "${candidate:-}"' EXIT
    render_candidate "$CADDYFILE" "$candidate"
    stage_contract_matches "$candidate" || fail "rendered Stage route does not satisfy the isolation contract"
    validate_candidate "$candidate" "$container"
    install -d -m 0700 -- "$BACKUP_DIR"
    cp -a -- "$CADDYFILE" "$BACKUP_DIR/Caddyfile.$(date -u +%Y%m%dT%H%M%SZ)"
    install -m 0644 -- "$candidate" "$CADDYFILE"
    changed=true
    log "restored the isolated Stage route in the release Caddyfile"
  fi

  if [ "$changed" = true ] || ! container_contract_matches "$container" || ! stage_https_is_healthy; then
    (
      cd "$APP_DIR"
      docker compose -f "$COMPOSE_FILE" up -d --no-deps --force-recreate caddy
    )
    for attempt in $(seq 1 20); do
      if stage_https_is_healthy; then break; fi
      sleep 1
    done
  fi

  stage_contract_matches "$CADDYFILE" || fail "release Caddyfile lost the Stage contract after repair"
  container="$(find_caddy_container)"
  [ -n "$container" ] && container_contract_matches "$container" \
    || fail "running Caddy configuration does not contain the isolated Stage route"
  stage_https_is_healthy || fail "Stage HTTPS did not recover"
  log "Stage HTTPS is healthy and isolated on $STAGE_UPSTREAM"
}

for domain in "$STAGE_DOMAIN" "$CRM_DOMAIN" "$FIELDTECH_DOMAIN" "$ERP_DOMAIN"; do
  validate_domain "$domain" || fail "invalid domain: $domain"
done
case "$STAGE_UPSTREAM" in
  host.docker.internal:18070) ;;
  *) fail "Stage upstream must remain host.docker.internal:18070" ;;
esac

case "${1:---repair}" in
  --render)
    [ "$#" = 3 ] || fail "usage: $0 --render INPUT OUTPUT"
    render_candidate "$2" "$3"
    stage_contract_matches "$3" || fail "rendered file failed the Stage contract"
    ;;
  --check-file)
    [ "$#" = 2 ] || fail "usage: $0 --check-file FILE"
    stage_contract_matches "$2" || fail "file failed the Stage contract"
    ;;
  --check)
    stage_contract_matches "$CADDYFILE" || fail "release Caddyfile failed the Stage contract"
    caddy_container="$(find_caddy_container)"
    [ -n "$caddy_container" ] && container_contract_matches "$caddy_container" \
      || fail "running Caddy configuration failed the Stage contract"
    stage_https_is_healthy || fail "Stage HTTPS is unhealthy"
    log "Stage route check passed"
    ;;
  --repair)
    repair_runtime
    ;;
  *)
    fail "unsupported mode: $1"
    ;;
esac
