#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GUARD="$ROOT/scripts/breexe-stage-caddy-guard.sh"
WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT

cat >"$WORK/base" <<'EOF'
http://crm.example.test {
	reverse_proxy crm:8080
}

https://erp.example.test {
	reverse_proxy host.docker.internal:8069
}
EOF

bash "$GUARD" --render "$WORK/base" "$WORK/first"
bash "$GUARD" --check-file "$WORK/first"
[ "$(grep -Fxc 'http://stage-erp.breexe-pro.com {' "$WORK/first")" = 1 ]
[ "$(grep -Fxc 'https://stage-erp.breexe-pro.com {' "$WORK/first")" = 1 ]

cp "$WORK/first" "$WORK/wrong"
sed -i 's/host\.docker\.internal:18070/host.docker.internal:8069/' "$WORK/wrong"
if bash "$GUARD" --check-file "$WORK/wrong" >/dev/null 2>&1; then
  echo "wrong Stage upstream was accepted" >&2
  exit 1
fi
bash "$GUARD" --render "$WORK/wrong" "$WORK/repaired"
bash "$GUARD" --check-file "$WORK/repaired"
! awk '
  /^https:\/\/stage-erp\.breexe-pro\.com[[:space:]]*\{/ { inside=1 }
  inside && /host\.docker\.internal:8069/ { found=1 }
  inside && /^[[:space:]]*}[[:space:]]*$/ { exit }
  END { exit found ? 0 : 1 }
' "$WORK/repaired"

bash "$GUARD" --render "$WORK/repaired" "$WORK/second"
cmp "$WORK/repaired" "$WORK/second"
echo "Stage Caddy guard fixture tests passed"
