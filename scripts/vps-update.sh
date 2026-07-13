#!/usr/bin/env bash
# CI/manual VPS entrypoint. CI uploads a clean archive and this wrapper delegates
# every server mutation to the same locked transaction used by deploy-vps.ps1.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/golden-pro-crm}"
APPROVED_APP_BASE="${DEPLOY_APPROVED_APP_BASE:-}"
DEPLOY_ARCHIVE="${DEPLOY_ARCHIVE:-}"
EXPECTED_VERSION="${EXPECTED_VERSION:-}"
EXPECTED_BUILD="${EXPECTED_BUILD:-}"
CRM_DOMAIN="${CRM_DOMAIN:-crm.breexe-pro.com}"
TRANSACTION_SCRIPT="${DEPLOY_TRANSACTION_SCRIPT:-$(cd "$(dirname "$0")" && pwd)/vps-deploy-transaction.sh}"
BACKUP_HELPER="${DEPLOY_BACKUP_HELPER:-}"
PRESERVE_HELPER="${DEPLOY_PRESERVE_HELPER:-}"
ROLLBACK_HELPER="${DEPLOY_ROLLBACK_HELPER:-}"

fail() { echo "VPS update failed: $*" >&2; exit 1; }
case "$APP_DIR" in /*) ;; *) fail "APP_DIR must be absolute" ;; esac
[ -s "$DEPLOY_ARCHIVE" ] || fail "DEPLOY_ARCHIVE must point to the uploaded clean release archive"
[ -s "$TRANSACTION_SCRIPT" ] || fail "the deployment transaction helper is missing"
[[ "$EXPECTED_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "EXPECTED_VERSION is invalid"
case "$EXPECTED_BUILD" in ''|unknown|*[!A-Za-z0-9._-]*) fail "EXPECTED_BUILD is invalid" ;; esac

exec env \
  APP_DIR="$APP_DIR" \
  DEPLOY_APPROVED_APP_BASE="$APPROVED_APP_BASE" \
  CRM_DOMAIN="$CRM_DOMAIN" \
  DEPLOY_ARCHIVE="$DEPLOY_ARCHIVE" \
  DEPLOY_BACKUP_HELPER="$BACKUP_HELPER" \
  DEPLOY_PRESERVE_HELPER="$PRESERVE_HELPER" \
  DEPLOY_ROLLBACK_HELPER="$ROLLBACK_HELPER" \
  USE_EXISTING_ENV=true \
  ALLOW_FIRST_DEPLOY=false \
  EXPECTED_VERSION="$EXPECTED_VERSION" \
  EXPECTED_BUILD="$EXPECTED_BUILD" \
  bash "$TRANSACTION_SCRIPT"
