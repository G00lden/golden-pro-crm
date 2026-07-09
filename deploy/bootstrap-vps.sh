#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/golden-pro-crm}"
APP_USER="${APP_USER:-goldencrm}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this script as root on Ubuntu 24.04." >&2
  exit 1
fi

apt-get update
apt-get install -y ca-certificates curl gnupg ufw tar git

install -m 0755 -d /etc/apt/keyrings
if [ ! -f /etc/apt/keyrings/docker.gpg ]; then
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
fi

. /etc/os-release
cat >/etc/apt/sources.list.d/docker.list <<EOF
deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable
EOF

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --create-home --shell /bin/bash "$APP_USER"
fi

mkdir -p "$APP_DIR" "$APP_DIR/.runtime" "$APP_DIR/.wa-session"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

systemctl enable docker
systemctl restart docker

echo "VPS bootstrap completed."
echo "App directory: $APP_DIR"
echo "Next: upload the project and run docker compose."
