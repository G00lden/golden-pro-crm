import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const STAGE_DOMAIN = "stage-erp.breexe-pro.com";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

function siteBlock(caddyfile, scheme, domain) {
  const escaped = domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = caddyfile.match(new RegExp(`${scheme}://${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`));
  assert.ok(match, `${scheme}://${domain} site block is required`);
  return match[1];
}

test("release Caddyfile keeps Odoo Stage isolated from Live", async () => {
  const caddyfile = await source("deploy/Caddyfile");
  const httpBlock = siteBlock(caddyfile, "http", STAGE_DOMAIN);
  const httpsBlock = siteBlock(caddyfile, "https", STAGE_DOMAIN);

  assert.match(httpBlock, /redir https:\/\/\{host\}\{uri\} permanent/);
  assert.match(httpsBlock, /stage-erp\.breexe-pro\.com\.crt/);
  assert.match(httpsBlock, /stage-erp\.breexe-pro\.com\.key/);
  assert.match(httpsBlock, /reverse_proxy host\.docker\.internal:18070/);
  assert.doesNotMatch(httpsBlock, /host\.docker\.internal:8069/);
});

test("deployment fails closed when the Stage route is removed or misrouted", async () => {
  const transaction = await source("scripts/vps-deploy-transaction.sh");
  const remoteStart = await source("deploy/remote-start.sh");

  for (const marker of [
    "http://stage-erp.breexe-pro.com",
    "https://stage-erp.breexe-pro.com",
    "reverse_proxy host.docker.internal:18070",
    "host.docker.internal:8069",
  ]) {
    assert.ok(transaction.includes(marker), `deployment contract must check ${marker}`);
  }
  assert.match(transaction, /stage_block=.*awk/s);
  assert.match(transaction, /if printf .*stage_block.*host\.docker\.internal:8069/s);
  assert.match(remoteStart, /ODOO_STAGE_DOMAIN=.*stage-erp\.breexe-pro\.com/);
  assert.match(remoteStart, /erp_login_matches "\$ODOO_STAGE_DOMAIN"/);
});

test("host-level guard survives complete release directory replacement", async () => {
  const guard = await source("scripts/breexe-stage-caddy-guard.sh");
  const pathUnit = await source("deploy/systemd/breexe-stage-caddy-guard.path");
  const timerUnit = await source("deploy/systemd/breexe-stage-caddy-guard.timer");

  assert.match(guard, /flock -w 300/);
  assert.match(guard, /host\.docker\.internal:18070/);
  assert.match(guard, /host\.docker\.internal:8069/);
  assert.match(guard, /docker compose .*force-recreate caddy/);
  assert.match(guard, /stage_https_is_healthy/);
  assert.match(pathUnit, /PathChanged=\/opt\/golden-pro-crm\/deploy\/Caddyfile/);
  assert.match(timerUnit, /OnUnitInactiveSec=30s/);
});
