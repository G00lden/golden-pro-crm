#!/usr/bin/env bash
# One fail-closed deployment transaction for both manual and CI archive deploys.
# Uploads may happen before this script starts; every mutation of APP_DIR and
# the running Compose project happens while the shared deployment lock is held.
set -euo pipefail
umask 077

APP_DIR="${APP_DIR:-/opt/golden-pro-crm}"
DEPLOY_APPROVED_APP_BASE="${DEPLOY_APPROVED_APP_BASE:-}"
CRM_DOMAIN="${CRM_DOMAIN:-crm.breexe-pro.com}"
ERP_DOMAIN="${ERP_DOMAIN:-erp.breexe-pro.com}"
DEPLOY_ARCHIVE="${DEPLOY_ARCHIVE:-}"
DEPLOY_ENV_FILE="${DEPLOY_ENV_FILE:-}"
DEPLOY_BACKUP_HELPER="${DEPLOY_BACKUP_HELPER:-}"
DEPLOY_PRESERVE_HELPER="${DEPLOY_PRESERVE_HELPER:-}"
DEPLOY_ROLLBACK_HELPER="${DEPLOY_ROLLBACK_HELPER:-}"
USE_EXISTING_ENV="${USE_EXISTING_ENV:-false}"
ALLOW_FIRST_DEPLOY="${ALLOW_FIRST_DEPLOY:-false}"
DEPLOY_BOOTSTRAP="${DEPLOY_BOOTSTRAP:-}"
EXPECTED_VERSION="${EXPECTED_VERSION:-}"
EXPECTED_BUILD="${EXPECTED_BUILD:-}"
HEALTH_RETRIES="${HEALTH_RETRIES:-30}"
HEALTH_SLEEP="${HEALTH_SLEEP:-4}"
FIRST_DEPLOY_CADDY_DATA_VOLUME="${FIRST_DEPLOY_CADDY_DATA_VOLUME:-deploy_caddy_data}"
FIRST_DEPLOY_CADDY_CONFIG_VOLUME="${FIRST_DEPLOY_CADDY_CONFIG_VOLUME:-deploy_caddy_config}"
LOCK_FILE="/run/golden-pro-crm/deploy.lock"
BACKUP_LOCK_FILE="/run/golden-pro-crm/backup-restore.lock"
LEGACY_BACKUP_LOCK_FILE="/var/lock/golden-pro-crm-backup-restore.lock"
SOURCE_RETENTION_ROOT=""
if [ "${DEPLOY_TRANSACTION_TESTING:-false}" = "true" ]; then
  LOCK_FILE="${DEPLOY_TEST_LOCK_FILE:?DEPLOY_TEST_LOCK_FILE is required in transaction test mode}"
  BACKUP_LOCK_FILE="${DEPLOY_TEST_BACKUP_LOCK_FILE:?DEPLOY_TEST_BACKUP_LOCK_FILE is required in transaction test mode}"
  LEGACY_BACKUP_LOCK_FILE="${BACKUP_LOCK_FILE}.legacy"
  SOURCE_RETENTION_ROOT="${DEPLOY_TEST_SOURCE_RETENTION_ROOT:?DEPLOY_TEST_SOURCE_RETENTION_ROOT is required in transaction test mode}"
fi

fail() { echo "Deployment transaction failed: $*" >&2; exit 1; }
log() { printf '\n[deploy-transaction] %s\n' "$*"; }

safe_absolute_path() {
  case "$1" in
    /*) ;;
    *) return 1 ;;
  esac
  case "$1" in
    *[!A-Za-z0-9._/-]*|*//*|*/./*|*/../*|*/.|*/..|*/) return 1 ;;
  esac
  return 0
}

owned_and_not_writable() {
  local path="$1"
  [ -e "$path" ] && [ ! -L "$path" ] \
    && [ "$(stat -c %u -- "$path")" = "$(id -u)" ] \
    && [ -z "$(find "$path" -maxdepth 0 -perm /022 -print -quit)" ]
}

harden_owned_path() {
  local path="$1" label="$2"
  [ -e "$path" ] && [ ! -L "$path" ] || return 1
  [ "$(stat -c %u -- "$path")" = "$(id -u)" ] || return 1
  chmod go-w -- "$path" || return 1
  owned_and_not_writable "$path" || return 1
}

safe_absolute_path "$APP_DIR" || fail "APP_DIR contains an unsafe or non-canonical path"
[ "$APP_DIR" != "/" ] || fail "APP_DIR cannot be /"
command -v readlink >/dev/null 2>&1 || fail "readlink is required"
CANONICAL_APP_DIR="$(readlink -m -- "$APP_DIR")"
[ "$CANONICAL_APP_DIR" = "$APP_DIR" ] || fail "APP_DIR must be canonical and must not traverse symlinks"
[ ! -L "$APP_DIR" ] || fail "APP_DIR cannot be a symlink"
if [ -z "$DEPLOY_APPROVED_APP_BASE" ]; then
  [ "$APP_DIR" = "/opt/golden-pro-crm" ] \
    || fail "a non-default APP_DIR requires DEPLOY_APPROVED_APP_BASE"
else
  safe_absolute_path "$DEPLOY_APPROVED_APP_BASE" || fail "DEPLOY_APPROVED_APP_BASE is unsafe"
  CANONICAL_APPROVED_BASE="$(readlink -m -- "$DEPLOY_APPROVED_APP_BASE")"
  [ "$CANONICAL_APPROVED_BASE" = "$DEPLOY_APPROVED_APP_BASE" ] \
    || fail "DEPLOY_APPROVED_APP_BASE must be canonical and must not traverse symlinks"
  [ -d "$DEPLOY_APPROVED_APP_BASE" ] && [ ! -L "$DEPLOY_APPROVED_APP_BASE" ] \
    || fail "DEPLOY_APPROVED_APP_BASE must be a real directory"
  owned_and_not_writable "$DEPLOY_APPROVED_APP_BASE" \
    || fail "DEPLOY_APPROVED_APP_BASE must be deploy-user owned and not group/world writable"
  case "$APP_DIR" in
    "$DEPLOY_APPROVED_APP_BASE"/*) ;;
    *) fail "APP_DIR is outside DEPLOY_APPROVED_APP_BASE" ;;
  esac
fi
APP_PARENT="${APP_DIR%/*}"
[ -n "$APP_PARENT" ] || APP_PARENT="/"
APP_BASE="${APP_DIR##*/}"
[ -d "$APP_PARENT" ] && [ ! -L "$APP_PARENT" ] \
  || fail "APP_DIR's parent must already be a real directory"
[ "$(readlink -m -- "$APP_PARENT")" = "$APP_PARENT" ] \
  || fail "APP_DIR's parent cannot traverse symlinks"
owned_and_not_writable "$APP_PARENT" \
  || fail "APP_DIR's parent must be deploy-user owned and not group/world writable"
if [ -e "$APP_DIR" ]; then
  [ -d "$APP_DIR" ] && [ ! -L "$APP_DIR" ] \
    || fail "an existing APP_DIR must be a real directory"
fi
LEGACY_RELEASE_ROOT="${APP_DIR}-releases"
safe_absolute_path "$LEGACY_RELEASE_ROOT" || fail "the legacy release root is unsafe"
[ "$(readlink -m -- "$LEGACY_RELEASE_ROOT")" = "$LEGACY_RELEASE_ROOT" ] \
  || fail "the legacy release root cannot traverse symlinks"
[ ! -L "$LEGACY_RELEASE_ROOT" ] || fail "the legacy release root cannot be a symlink"
if [ -e "$LEGACY_RELEASE_ROOT" ]; then
  [ -d "$LEGACY_RELEASE_ROOT" ] \
    || fail "the legacy release root must be a directory"
fi
if [ -z "$SOURCE_RETENTION_ROOT" ]; then
  SOURCE_RETENTION_ROOT="$APP_PARENT/.${APP_BASE}-source-trees"
fi
safe_absolute_path "$SOURCE_RETENTION_ROOT" || fail "the source-retention root is unsafe"
CANONICAL_RETENTION_ROOT="$(readlink -m -- "$SOURCE_RETENTION_ROOT")"
[ "$CANONICAL_RETENTION_ROOT" = "$SOURCE_RETENTION_ROOT" ] \
  || fail "the source-retention root must be canonical and must not traverse symlinks"
[ ! -L "$SOURCE_RETENTION_ROOT" ] || fail "the source-retention root cannot be a symlink"
case "$SOURCE_RETENTION_ROOT" in "$APP_DIR"|"$APP_DIR"/*) fail "source retention cannot be inside APP_DIR" ;; esac
case "$CRM_DOMAIN" in ''|*[!A-Za-z0-9.-]*) fail "CRM_DOMAIN is invalid" ;; esac
case "$ERP_DOMAIN" in ''|*[!A-Za-z0-9.-]*) fail "ERP_DOMAIN is invalid" ;; esac
for volume_name in "$FIRST_DEPLOY_CADDY_DATA_VOLUME" "$FIRST_DEPLOY_CADDY_CONFIG_VOLUME"; do
  case "$volume_name" in
    ''|[!A-Za-z0-9]*|*[!A-Za-z0-9_.-]*) fail "first-deploy Caddy volume names are invalid" ;;
  esac
done
case "$HEALTH_RETRIES:$HEALTH_SLEEP" in *[!0-9:]*) fail "health retry settings must be integers" ;; esac
[ "$HEALTH_RETRIES" -gt 0 ] && [ "$HEALTH_SLEEP" -gt 0 ] || fail "health retry settings must be positive"
[[ "$EXPECTED_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "EXPECTED_VERSION is invalid"
case "$EXPECTED_BUILD" in ''|unknown|*[!A-Za-z0-9._-]*) fail "EXPECTED_BUILD is invalid" ;; esac
[ "$USE_EXISTING_ENV" = "true" ] || [ "$USE_EXISTING_ENV" = "false" ] || fail "USE_EXISTING_ENV must be true or false"
[ "$ALLOW_FIRST_DEPLOY" = "true" ] || [ "$ALLOW_FIRST_DEPLOY" = "false" ] || fail "ALLOW_FIRST_DEPLOY must be true or false"
[ -s "$DEPLOY_ARCHIVE" ] || fail "DEPLOY_ARCHIVE is missing or empty"
[ -s "$DEPLOY_BACKUP_HELPER" ] || fail "DEPLOY_BACKUP_HELPER is missing or empty"
[ -s "$DEPLOY_PRESERVE_HELPER" ] || fail "DEPLOY_PRESERVE_HELPER is missing or empty"
[ -s "$DEPLOY_ROLLBACK_HELPER" ] || fail "DEPLOY_ROLLBACK_HELPER is missing or empty"
if [ "$USE_EXISTING_ENV" = "false" ]; then
  [ -s "$DEPLOY_ENV_FILE" ] || fail "DEPLOY_ENV_FILE is required when USE_EXISTING_ENV=false"
fi

for command_name in flock tar mktemp sha256sum awk sed cp mv seq sleep wc tr find grep rm mkdir chmod chown date stat id; do
  command -v "$command_name" >/dev/null 2>&1 || fail "$command_name is required"
done
LOCK_ROOT="$(dirname "$LOCK_FILE")"
[ "$LOCK_ROOT" = "$(dirname "$BACKUP_LOCK_FILE")" ] || fail "deployment and backup locks must share one private lock directory"
mkdir -p "$LOCK_ROOT"
[ -d "$LOCK_ROOT" ] && [ ! -L "$LOCK_ROOT" ] || fail "the private lock directory cannot be a symlink"
[ "$(readlink -m -- "$LOCK_ROOT")" = "$LOCK_ROOT" ] || fail "the private lock directory cannot traverse symlinks"
[ "$(stat -c %u -- "$LOCK_ROOT")" = "$(id -u)" ] || fail "the private lock directory must be owned by the deploy user"
chmod 700 "$LOCK_ROOT"
for lock_path in "$LOCK_FILE" "$BACKUP_LOCK_FILE"; do
  if [ -e "$lock_path" ]; then
    [ -f "$lock_path" ] && [ ! -L "$lock_path" ] || fail "lock files must be regular non-symlink files"
    [ "$(stat -c %u -- "$lock_path")" = "$(id -u)" ] || fail "lock files must be owned by the deploy user"
  fi
done
exec 8>"$LOCK_FILE"
chmod 600 "$LOCK_FILE"
if ! flock -n 8; then
  echo "Another CRM deployment transaction is already running." >&2
  exit 75
fi

# The currently deployed pre-1.3.7 backup/restore helpers use this legacy lock.
# Open append-only (never truncate), then prove the pathname still identifies
# the same root-owned regular inode as the already-open descriptor. Holding it
# through the first source swap prevents an old timer from racing the new lock.
exec 7>>"$LEGACY_BACKUP_LOCK_FILE"
LEGACY_LOCK_FD_PATH="/proc/$$/fd/7"
[ ! -L "$LEGACY_BACKUP_LOCK_FILE" ] && [ -f "$LEGACY_LOCK_FD_PATH" ] \
  || fail "the legacy backup lock is not a regular non-symlink file"
[ "$(stat -Lc %u -- "$LEGACY_LOCK_FD_PATH")" = "$(id -u)" ] \
  || fail "the legacy backup lock must be owned by the deploy user"
[ "$(stat -Lc '%d:%i' -- "$LEGACY_LOCK_FD_PATH")" = "$(stat -Lc '%d:%i' -- "$LEGACY_BACKUP_LOCK_FILE")" ] \
  || fail "the legacy backup lock pathname changed while opening it"
chmod 600 "$LEGACY_LOCK_FD_PATH"
if ! flock -n 7; then
  echo "A legacy CRM backup or restore operation is already running." >&2
  exit 75
fi

exec 9>"$BACKUP_LOCK_FILE"
chmod 600 "$BACKUP_LOCK_FILE"
if ! flock -n 9; then
  echo "A CRM backup or restore operation is already running." >&2
  exit 75
fi
export CRM_BACKUP_LOCK_FD=9

# Only after all three locks are held may the transaction adopt or normalize
# deployment paths. APP_PARENT was already proven trusted and non-writable, so
# this top-directory ownership transition cannot be swapped by another user.
if [ -e "$APP_DIR" ]; then
  if [ "$(stat -c %u -- "$APP_DIR")" != "$(id -u)" ]; then
    chown "$(id -u):$(id -g)" -- "$APP_DIR" \
      || fail "the existing APP_DIR could not be adopted by the deploy user"
  fi
  harden_owned_path "$APP_DIR" "APP_DIR" \
    || fail "APP_DIR must be deploy-user owned and not group/world writable"
fi
if [ -e "$LEGACY_RELEASE_ROOT" ]; then
  harden_owned_path "$LEGACY_RELEASE_ROOT" "legacy release root" \
    || fail "the legacy release root must be deploy-user owned and not group/world writable"
fi
mkdir -p "$APP_PARENT"
mkdir -p "$SOURCE_RETENTION_ROOT"
harden_owned_path "$SOURCE_RETENTION_ROOT" "source-retention root" \
  || fail "source retention must be deploy-user owned and not group/world writable"
chmod 700 "$SOURCE_RETENTION_ROOT"
[ "$(stat -c %d -- "$APP_PARENT")" = "$(stat -c %d -- "$SOURCE_RETENTION_ROOT")" ] \
  || fail "source retention must share APP_DIR's filesystem for atomic rename"

# Paths are siblings of APP_DIR, so both renames remain on one filesystem.
WORK_ROOT="$(mktemp -d "$APP_PARENT/.${APP_BASE}.deploy-txn.XXXXXX")"
STAGED_SOURCE="$WORK_ROOT/staged-source"
PREVIOUS_SOURCE="$WORK_ROOT/previous-source"
FAILED_SOURCE="$WORK_ROOT/failed-source"
RETENTION_ID="$(date -u +%Y%m%dT%H%M%SZ)-${EXPECTED_BUILD}-$$"
RETAINED_SOURCE="$SOURCE_RETENTION_ROOT/$RETENTION_ID"
TRUSTED_ROLLBACK="$WORK_ROOT/remote-rollback.sh"
TRUSTED_BACKUP="$WORK_ROOT/vps-backup.sh"
TRUSTED_PRESERVE="$WORK_ROOT/vps-preserve-deploy-state.sh"
SOURCE_SWAP_STARTED=false
HAD_SOURCE=false
HAD_RUNNING=false
PRESERVED=false
RUNTIME_MUTATED=false
FINISHED=false

cp -- "$DEPLOY_BACKUP_HELPER" "$TRUSTED_BACKUP"
cp -- "$DEPLOY_PRESERVE_HELPER" "$TRUSTED_PRESERVE"
cp -- "$DEPLOY_ROLLBACK_HELPER" "$TRUSTED_ROLLBACK"
chmod 700 "$TRUSTED_BACKUP" "$TRUSTED_PRESERVE" "$TRUSTED_ROLLBACK"

cleanup() {
  if [ "$FINISHED" = true ] && [ -d "$WORK_ROOT" ]; then
    rm -rf -- "$WORK_ROOT" || true
  fi
}
trap cleanup EXIT

owned_compose_path() {
  local compose_path="$1" canonical suffix release_id release_dir deploy_dir
  safe_absolute_path "$compose_path" || return 1
  [ ! -L "$compose_path" ] || return 1
  canonical="$(readlink -m -- "$compose_path")"
  [ "$canonical" = "$compose_path" ] || return 1
  if [ "$compose_path" = "$APP_DIR/deploy/docker-compose.yml" ]; then
    deploy_dir="$APP_DIR/deploy"
    [ -d "$deploy_dir" ] && [ -s "$compose_path" ] \
      && [ "$(stat -c %u -- "$deploy_dir")" = "$(id -u)" ] \
      && [ "$(stat -c %u -- "$compose_path")" = "$(id -u)" ]
    return
  fi
  case "$compose_path" in "$LEGACY_RELEASE_ROOT"/*) ;; *) return 1 ;; esac
  suffix="${compose_path#"$LEGACY_RELEASE_ROOT"/}"
  release_id="${suffix%%/*}"
  case "$release_id" in ''|*[!A-Za-z0-9._-]*) return 1 ;; esac
  [ "$suffix" = "$release_id/deploy/docker-compose.yml" ] || return 1
  release_dir="$LEGACY_RELEASE_ROOT/$release_id"
  deploy_dir="$release_dir/deploy"
  [ -d "$release_dir" ] && [ ! -L "$release_dir" ] || return 1
  [ "$(readlink -m -- "$release_dir")" = "$release_dir" ] || return 1
  [ -d "$deploy_dir" ] && [ ! -L "$deploy_dir" ] && [ -s "$compose_path" ] \
    && [ "$(stat -c %u -- "$release_dir")" = "$(id -u)" ] \
    && [ "$(stat -c %u -- "$deploy_dir")" = "$(id -u)" ] \
    && [ "$(stat -c %u -- "$compose_path")" = "$(id -u)" ]
}

harden_compose_path() {
  local compose_path="$1" root deploy_dir
  deploy_dir="${compose_path%/docker-compose.yml}"
  root="${compose_path%/deploy/docker-compose.yml}"
  if [ "$compose_path" = "$APP_DIR/deploy/docker-compose.yml" ]; then
    harden_owned_path "$APP_DIR" "active APP_DIR" \
      && harden_owned_path "$deploy_dir" "active deploy directory" \
      && harden_owned_path "$compose_path" "active Compose file"
    return
  fi
  harden_owned_path "$LEGACY_RELEASE_ROOT" "legacy release root" \
    && harden_owned_path "$root" "active legacy release" \
    && harden_owned_path "$deploy_dir" "active legacy deploy directory" \
    && harden_owned_path "$compose_path" "active legacy Compose file"
}

running_crm_id() {
  local candidates candidate compose_path selected="" count=0
  command -v docker >/dev/null 2>&1 || return 0
  candidates="$(docker ps --filter status=running --filter label=com.docker.compose.service=crm \
    --format '{{.ID}}' 2>/dev/null)" || return 1
  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    compose_path="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$candidate" 2>/dev/null || true)"
    owned_compose_path "$compose_path" || continue
    selected="$candidate"
    count=$((count + 1))
  done <<< "$candidates"
  [ "$count" -le 1 ] || fail "more than one running CRM deployment belongs to APP_DIR"
  printf '%s\n' "$selected"
}

restore_previous() {
  local reason="$1" source_status=0 runtime_status=0
  trap - ERR HUP INT TERM
  set +e
  echo "$reason" >&2

  if [ "$SOURCE_SWAP_STARTED" = true ]; then
    log "restoring the exact previous source tree"
    previous_candidate=""
    if [ -e "$PREVIOUS_SOURCE" ]; then
      previous_candidate="$PREVIOUS_SOURCE"
    elif [ -e "$RETAINED_SOURCE" ]; then
      previous_candidate="$RETAINED_SOURCE"
    fi
    if [ -n "$previous_candidate" ]; then
      if [ -e "$APP_DIR" ]; then
        mv -- "$APP_DIR" "$FAILED_SOURCE" || source_status=$?
      fi
      if [ "$source_status" -eq 0 ]; then
        mv -- "$previous_candidate" "$APP_DIR" || source_status=$?
      fi
    elif [ "$HAD_SOURCE" = true ]; then
      [ -e "$APP_DIR" ] || source_status=1
    elif [ -e "$APP_DIR" ]; then
      mv -- "$APP_DIR" "$FAILED_SOURCE" || source_status=$?
    fi
  fi

  if [ "$PRESERVED" = true ] && [ "$RUNTIME_MUTATED" = true ] && [ -s "$TRUSTED_ROLLBACK" ]; then
    log "restoring the preserved image, volumes binding, environment, Compose, and Caddy state"
    APP_DIR="$APP_DIR" HEALTH_RETRIES="$HEALTH_RETRIES" HEALTH_SLEEP="$HEALTH_SLEEP" \
      bash "$TRUSTED_ROLLBACK" || runtime_status=$?
  fi

  if [ "$source_status" -ne 0 ] || [ "$runtime_status" -ne 0 ]; then
    echo "Source restore status: $source_status; runtime restore status: $runtime_status" >&2
    echo "Recovery artifacts were retained at $WORK_ROOT" >&2
    exit 2
  fi
  if [ -d "$FAILED_SOURCE" ]; then rm -rf -- "$FAILED_SOURCE"; fi
  FINISHED=true
  echo "The previous source and running deployment were restored." >&2
  exit 1
}

unexpected_failure() {
  local status="$?"
  restore_previous "An unexpected deployment error occurred (exit $status)."
}
trap unexpected_failure ERR
trap 'restore_previous "The deployment transaction was interrupted."' HUP INT TERM

require_runtime_commands() {
  local command_name
  for command_name in docker curl; do
    command -v "$command_name" >/dev/null 2>&1 \
      || restore_previous "$command_name is required for the deployment runtime."
  done
}

if command -v docker >/dev/null 2>&1; then
  require_runtime_commands
elif [ -z "$DEPLOY_BOOTSTRAP" ]; then
  restore_previous "docker is missing and no bootstrap helper was requested."
fi

CRM_CID="$(running_crm_id)"
if [ -n "$CRM_CID" ]; then
  HAD_RUNNING=true
  [ -d "$APP_DIR" ] || restore_previous "A CRM container is running but APP_DIR is missing."
  ACTIVE_COMPOSE="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$CRM_CID" 2>/dev/null || true)"
  ACTIVE_PROJECT="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$CRM_CID" 2>/dev/null || true)"
  case "$ACTIVE_COMPOSE" in /*) ;; *) restore_previous "The running CRM has no safe absolute Compose-file label." ;; esac
  case "$ACTIVE_COMPOSE" in *,*) restore_previous "Multiple active Compose files are not supported." ;; esac
  owned_compose_path "$ACTIVE_COMPOSE" || restore_previous "The active Compose file is outside the approved APP_DIR release roots."
  harden_compose_path "$ACTIVE_COMPOSE" \
    || restore_previous "The active Compose path must be deploy-user owned and not group/world writable."
  case "$ACTIVE_PROJECT" in ''|*[!A-Za-z0-9_-]*) restore_previous "The active Compose project label is invalid." ;; esac
  ACTIVE_ROOT="${ACTIVE_COMPOSE%/deploy/docker-compose.yml}"
  if [ -s "$ACTIVE_ROOT/.env.production" ] && [ ! -L "$ACTIVE_ROOT/.env.production" ]; then
    ACTIVE_ENV="$ACTIVE_ROOT/.env.production"
  elif [ -s "$APP_DIR/.env.production" ] && [ ! -L "$APP_DIR/.env.production" ]; then
    ACTIVE_ENV="$APP_DIR/.env.production"
  else
    restore_previous "The active CRM production environment file is missing."
  fi
  [ "$(readlink -m -- "$ACTIVE_ENV")" = "$ACTIVE_ENV" ] \
    || restore_previous "The active CRM production environment cannot traverse symlinks."
  harden_owned_path "$ACTIVE_ENV" "active production environment" \
    || restore_previous "The active CRM production environment must be deploy-user owned and not group/world writable."

  log "creating the fail-closed data backup while holding the deployment lock"
  APP_DIR="$APP_DIR" CRM_COMPOSE_FILE="$ACTIVE_COMPOSE" CRM_COMPOSE_PROJECT="$ACTIVE_PROJECT" CRM_ENV_FILE="$ACTIVE_ENV" \
    BACKUP_LOCK_FILE="$BACKUP_LOCK_FILE" CRM_BACKUP_LOCK_FD=9 bash "$TRUSTED_BACKUP"
  log "preserving the exact running state from Compose container labels"
  APP_DIR="$APP_DIR" CRM_CID="$CRM_CID" CRM_ACTIVE_ENV_FILE="$ACTIVE_ENV" bash "$TRUSTED_PRESERVE"
  for required_file in caddy-data-volume caddy-config-volume previous-crm-domain previous-erp-domain \
    previous-require-crm-origin previous-require-erp-endpoint previous-crm-origin-scheme; do
    [ -s "$APP_DIR/.deploy-rollback/$required_file" ] \
      || restore_previous "The preserved Caddy volume binding is incomplete."
  done
  (cd "$APP_DIR/.deploy-rollback" && sha256sum --check --strict --status manifest.sha256) \
    || restore_previous "The preserved deployment state failed its checksum."
  PRESERVED=true
elif [ "$ALLOW_FIRST_DEPLOY" != "true" ]; then
  restore_previous "No running CRM deployment was found; explicit first-deploy acknowledgement is required."
fi

if [ -n "$DEPLOY_BOOTSTRAP" ]; then
  [ -s "$DEPLOY_BOOTSTRAP" ] || restore_previous "The requested bootstrap helper is missing."
  if [ "$HAD_RUNNING" = true ]; then
    log "a running deployment exists; skipping the first-install bootstrap"
  else
    log "running the VPS bootstrap under the deployment lock"
    RUNTIME_MUTATED=true
    APP_DIR="$APP_DIR" bash "$DEPLOY_BOOTSTRAP" || restore_previous "VPS bootstrap failed."
  fi
fi
require_runtime_commands

mkdir -p "$STAGED_SOURCE"
log "validating and extracting the release into a clean sibling staging tree"
if ! tar -tzf "$DEPLOY_ARCHIVE" | awk '
  /^\// { exit 1 }
  { n=split($0, p, "/"); for (i=1; i<=n; i++) if (p[i] == "..") exit 1 }
  END { if (NR == 0) exit 1 }
'; then
  restore_previous "The deployment archive contains an unsafe or empty path list."
fi
# Security: archive member owners come from an untrusted build host (including
# Windows/CI numeric UIDs), so GNU tar must map files to the trusted transaction user.
tar --extract --gzip --no-same-owner --file "$DEPLOY_ARCHIVE" --directory "$STAGED_SOURCE" \
  || restore_previous "The deployment archive could not be extracted."
rm -rf -- "$STAGED_SOURCE/.git" "$STAGED_SOURCE/.deploy-rollback" \
  "$STAGED_SOURCE/backups" "$STAGED_SOURCE/data" "$STAGED_SOURCE/.runtime" "$STAGED_SOURCE/.wa-session"
rm -f -- "$STAGED_SOURCE/.env.production"

for required_file in release.json deploy/docker-compose.yml deploy/Caddyfile deploy/remote-start.sh deploy/remote-rollback.sh; do
  [ -s "$STAGED_SOURCE/$required_file" ] || restore_previous "The staged release is missing $required_file."
done

staged_proxy_contract_matches() {
  local caddy="$STAGED_SOURCE/deploy/Caddyfile" compose="$STAGED_SOURCE/deploy/docker-compose.yml" marker
  for marker in \
    'auto_https off' \
    'http://{$CRM_DOMAIN}' \
    'header_up X-Breexe-Client-IP {client_ip}' \
    'reverse_proxy crm:8080' \
    'http://{$ERP_DOMAIN}' \
    'https://{$ERP_DOMAIN}' \
    '/{$ERP_DOMAIN}/{$ERP_DOMAIN}.crt' \
    '/{$ERP_DOMAIN}/{$ERP_DOMAIN}.key' \
    'reverse_proxy host.docker.internal:8069'; do
    grep -Fq -- "$marker" "$caddy" || return 1
  done
  for marker in \
    'host.docker.internal:host-gateway' \
    'ERP_DOMAIN: ${ERP_DOMAIN:-erp.breexe-pro.com}' \
    'caddy_data:/data' \
    'caddy_config:/config'; do
    grep -Fq -- "$marker" "$compose" || return 1
  done
}
staged_proxy_contract_matches \
  || restore_previous "The staged release would drop the required CRM/ERP proxy or Caddy volume contract."

START_CADDY_DATA_VOLUME=""
START_CADDY_CONFIG_VOLUME=""
if [ "$HAD_RUNNING" = false ]; then
  log "verifying first-deploy Caddy volumes and the ERP certificate before source replacement"
  docker volume inspect "$FIRST_DEPLOY_CADDY_DATA_VOLUME" "$FIRST_DEPLOY_CADDY_CONFIG_VOLUME" >/dev/null 2>&1 \
    || restore_previous "First deployment requires existing named Caddy data/config volumes."
  if ! docker run --rm --network none --cap-drop ALL --cap-add NET_BIND_SERVICE \
    -e CRM_DOMAIN="$CRM_DOMAIN" -e ERP_DOMAIN="$ERP_DOMAIN" \
    --mount "type=volume,src=$FIRST_DEPLOY_CADDY_DATA_VOLUME,dst=/data,readonly" \
    --mount "type=volume,src=$FIRST_DEPLOY_CADDY_CONFIG_VOLUME,dst=/config,readonly" \
    --mount "type=bind,src=$STAGED_SOURCE/deploy/Caddyfile,dst=/etc/caddy/Caddyfile,readonly" \
    caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null; then
    restore_previous "First deployment requires a valid ERP certificate/key in the preserved Caddy data volume."
  fi
  START_CADDY_DATA_VOLUME="$FIRST_DEPLOY_CADDY_DATA_VOLUME"
  START_CADDY_CONFIG_VOLUME="$FIRST_DEPLOY_CADDY_CONFIG_VOLUME"
fi
STAGED_VERSION="$(sed -n 's/^.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$STAGED_SOURCE/release.json" | head -n 1)"
[ "$STAGED_VERSION" = "$EXPECTED_VERSION" ] \
  || restore_previous "The staged release version '$STAGED_VERSION' does not match EXPECTED_VERSION '$EXPECTED_VERSION'."

if [ "$USE_EXISTING_ENV" = "true" ]; then
  if [ "$PRESERVED" = true ]; then
    [ -s "$APP_DIR/.deploy-rollback/env.production" ] \
      || restore_previous "The preserved active production environment is missing."
    (cd "$APP_DIR/.deploy-rollback" && sha256sum --check --strict --status manifest.sha256) \
      || restore_previous "The preserved active production environment failed its checksum."
    cp -- "$APP_DIR/.deploy-rollback/env.production" "$STAGED_SOURCE/.env.production"
  else
    [ -s "$APP_DIR/.env.production" ] || restore_previous "The existing production environment is missing."
    cp -- "$APP_DIR/.env.production" "$STAGED_SOURCE/.env.production"
  fi
else
  cp -- "$DEPLOY_ENV_FILE" "$STAGED_SOURCE/.env.production"
fi
chmod 600 "$STAGED_SOURCE/.env.production"

DB_PATH_VALUE="$(sed -n 's/^[[:space:]]*\(export[[:space:]][[:space:]]*\)\?DB_PATH[[:space:]]*=[[:space:]]*//p' "$STAGED_SOURCE/.env.production" | tail -n 1 | sed 's/[[:space:]]*$//' | tr -d '\r')"
case "$DB_PATH_VALUE" in
  .runtime/golden-crm.db|/app/.runtime/golden-crm.db|\".runtime/golden-crm.db\"|\"/app/.runtime/golden-crm.db\"|\'.runtime/golden-crm.db\'|\'/app/.runtime/golden-crm.db\') ;;
  *) restore_previous "DB_PATH must resolve to /app/.runtime/golden-crm.db before deployment." ;;
esac

# Retain only the atomic rollback snapshot. Application files always come from
# the fresh archive, so removed files cannot survive as a stale overlay.
if [ "$PRESERVED" = true ]; then cp -a -- "$APP_DIR/.deploy-rollback" "$STAGED_SOURCE/.deploy-rollback"; fi
find "$STAGED_SOURCE/deploy" "$STAGED_SOURCE/scripts" -type f -name '*.sh' -exec sed -i 's/\r$//' {} +

if [ -e "$APP_DIR" ]; then HAD_SOURCE=true; fi
SOURCE_SWAP_STARTED=true
if [ "$HAD_SOURCE" = true ]; then
  mv -- "$APP_DIR" "$PREVIOUS_SOURCE"
fi
if ! mv -- "$STAGED_SOURCE" "$APP_DIR"; then
  restore_previous "The staged source could not be installed atomically."
fi

log "building, recreating, and checking the exact release through local Caddy"
RUNTIME_MUTATED=true
if ! APP_DIR="$APP_DIR" CRM_DOMAIN="$CRM_DOMAIN" EXPECTED_VERSION="$EXPECTED_VERSION" \
  EXPECTED_BUILD="$EXPECTED_BUILD" BUILD_COMMIT="$EXPECTED_BUILD" \
  HEALTH_RETRIES="$HEALTH_RETRIES" HEALTH_SLEEP="$HEALTH_SLEEP" ERP_DOMAIN="$ERP_DOMAIN" \
  CADDY_VALIDATION_DATA_VOLUME="$START_CADDY_DATA_VOLUME" \
  CADDY_VALIDATION_CONFIG_VOLUME="$START_CADDY_CONFIG_VOLUME" \
  bash "$APP_DIR/deploy/remote-start.sh"; then
  restore_previous "The staged release failed its build or local health contract."
fi

public_contract_matches() {
  local cid health version
  cid="$(running_crm_id)"
  [ -n "$cid" ] || return 1
  health="$(curl --fail --silent --show-error --connect-timeout 5 --max-time 30 "https://$CRM_DOMAIN/api/health" 2>/dev/null)" || return 1
  version="$(curl --fail --silent --show-error --connect-timeout 5 --max-time 30 "https://$CRM_DOMAIN/api/version" 2>/dev/null)" || return 1
  printf '%s\n%s' "$health" "$version" | docker exec -i \
    -e EXPECTED_VERSION="$EXPECTED_VERSION" -e EXPECTED_BUILD="$EXPECTED_BUILD" "$cid" node -e '
      let raw = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { raw += chunk; });
      process.stdin.on("end", () => {
        try {
          const split = raw.indexOf("\n");
          const health = JSON.parse(raw.slice(0, split));
          const version = JSON.parse(raw.slice(split + 1));
          const release = health && health.release || {};
          if (health.status !== "ok" || release.version !== process.env.EXPECTED_VERSION ||
              health.commit !== process.env.EXPECTED_BUILD ||
              version.version !== process.env.EXPECTED_VERSION ||
              version.commit !== process.env.EXPECTED_BUILD || version.runtime !== "production") process.exit(1);
        } catch { process.exit(1); }
      });
    ' >/dev/null 2>&1
}

log "verifying the exact release through public HTTPS before releasing the lock"
PUBLIC_HEALTHY=false
for _ in $(seq 1 "$HEALTH_RETRIES"); do
  if public_contract_matches; then PUBLIC_HEALTHY=true; break; fi
  sleep "$HEALTH_SLEEP"
done
[ "$PUBLIC_HEALTHY" = true ] || restore_previous "Public HTTPS did not expose the exact staged release."

if [ "$HAD_SOURCE" = true ]; then
  mv -- "$PREVIOUS_SOURCE" "$RETAINED_SOURCE"
  chmod 700 "$RETAINED_SOURCE"
  log "retained the complete previous AppDir at $RETAINED_SOURCE"
fi
trap '' HUP INT TERM
SOURCE_SWAP_STARTED=false
FINISHED=true
trap - ERR HUP INT TERM
log "release $EXPECTED_VERSION ($EXPECTED_BUILD) completed atomically"
