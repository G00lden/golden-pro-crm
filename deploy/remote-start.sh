#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/golden-pro-crm}"
cd "$APP_DIR"

if [ ! -f ".env.production" ]; then
  echo ".env.production is missing in $APP_DIR" >&2
  exit 1
fi

export BUILD_COMMIT="${BUILD_COMMIT:-$(git rev-parse --short HEAD 2>/dev/null || echo unknown)}"

docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml ps

echo "Golden Pro CRM containers are running."
echo "Health check: curl -fsS http://127.0.0.1/api/health"
