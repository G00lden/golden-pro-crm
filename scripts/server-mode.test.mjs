import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolveServerMode, serverEnvironment } from "./lib/server-mode.mjs";

test("start defaults to production", () => {
  assert.equal(resolveServerMode([]), "production");
  const env = serverEnvironment("production", {});
  assert.equal(env.NODE_ENV, "production");
  assert.equal(env.ENABLE_VITE_DEV_SERVER, "false");
  assert.equal(env.ENV_FILE, ".env.production");
});

test("development requires the explicit --dev flag", () => {
  assert.equal(resolveServerMode(["--dev"]), "development");
  const env = serverEnvironment("development", {});
  assert.equal(env.NODE_ENV, "development");
  assert.equal(env.ENABLE_VITE_DEV_SERVER, "true");
  assert.equal(env.ENV_FILE, ".env");
});

test("an explicit environment file is preserved", () => {
  assert.equal(serverEnvironment("production", { ENV_FILE: "custom.env" }).ENV_FILE, "custom.env");
});

test("Docker runtime commit overrides stale env-file metadata", () => {
  const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
  const rootCompose = readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8");
  const compose = readFileSync(new URL("../deploy/docker-compose.yml", import.meta.url), "utf8");
  assert.match(compose, /image:\s*golden-pro-crm:runtime/);
  assert.match(compose, /environment:\s*[\s\S]*?BUILD_COMMIT:\s*\$\{BUILD_COMMIT:-unknown\}/);
  assert.match(dockerfile, /ARG VITE_PUBLIC_CONTACT_PHONE=/);
  assert.match(dockerfile, /ENV VITE_PUBLIC_CONTACT_PHONE=\$VITE_PUBLIC_CONTACT_PHONE/);
  assert.match(compose, /VITE_PUBLIC_CONTACT_PHONE:\s*\$\{VITE_PUBLIC_CONTACT_PHONE:-\}/);
  assert.match(rootCompose, /VITE_PUBLIC_CONTACT_PHONE:\s*\$\{VITE_PUBLIC_CONTACT_PHONE:\?[^}]+\}/);
  assert.match(rootCompose, /docker compose --env-file \.env\.production up -d --build/);
});

test("unsupported Cloud Run deployment fails closed instead of building an incomplete image", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.scripts["deploy:cloudrun"], "node scripts/cloudrun-unsupported.mjs");
  const result = spawnSync(process.execPath, ["scripts/cloudrun-unsupported.mjs"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cloud Run deployment is disabled/);
  assert.match(result.stderr, /VPS/);
});

test("the bundled VPS example explicitly enables the private trusted-proxy contract", () => {
  const productionExample = readFileSync(new URL("../.env.production.example", import.meta.url), "utf8");
  assert.match(productionExample, /^TRUST_PROXY_HEADERS=true$/m);
  assert.match(productionExample, /^VITE_PUBLIC_CONTACT_PHONE=$/m);
});

test("bundled Caddy derives a private client-IP header from trusted Cloudflare peers", () => {
  const caddy = readFileSync(new URL("../deploy/Caddyfile", import.meta.url), "utf8");
  assert.match(caddy, /trusted_proxies static[\s\S]*173\.245\.48\.0\/20[\s\S]*2606:4700::\/32/);
  assert.match(caddy, /trusted_proxies_strict/);
  assert.match(caddy, /client_ip_headers Cf-Connecting-Ip X-Forwarded-For/);
  assert.match(caddy, /header_up X-Breexe-Client-IP \{client_ip\}/);
});
