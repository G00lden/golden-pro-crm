import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertLoopbackBaseUrl } from "./qa-seed.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relativePath) => readFileSync(path.join(root, relativePath), "utf8");

test("QA seed accepts only plain HTTP loopback targets", () => {
  assert.equal(assertLoopbackBaseUrl("http://127.0.0.1:4173/path"), "http://127.0.0.1:4173");
  assert.equal(assertLoopbackBaseUrl("http://localhost:3000"), "http://localhost:3000");
  assert.equal(assertLoopbackBaseUrl("http://[::1]:8080"), "http://[::1]:8080");

  for (const unsafe of [
    "https://127.0.0.1:4173",
    "http://crm.breexe-pro.com",
    "https://crm.breexe-pro.com",
    "http://192.168.1.20:4173",
  ]) {
    assert.throws(() => assertLoopbackBaseUrl(unsafe), /refuses non-loopback target/);
  }
});

test("Vite HMR and Firebase probe honor isolated local QA mode", () => {
  const server = source("server.ts");
  const firebase = source("src/firebase.ts");
  const firebaseAdmin = source("server/firebaseAdmin.ts");

  assert.match(server, /createViteServer\(\{[\s\S]*?hmr:\s*process\.env\.DISABLE_HMR\s*!==\s*["']true["']/);
  assert.match(server, /process\.env\.DISABLE_HMR\s*===\s*["']true["'][\s\S]*?ws:\s*false/);
  assert.match(server, /process\.env\.DISABLE_VITE_ENV_FILES\s*===\s*["']true["'][\s\S]*?envFile:\s*false/);
  assert.match(firebase, /typeof window !== ['"]undefined['"]\s*&&\s*!localAuthEnabled/);
  assert.match(firebaseAdmin, /dotenv\.config\(\{\s*path:\s*process\.env\.ENV_FILE\s*\|\|\s*["']\.env["']/);
});

test("public lead ingestion stays outside the authenticated API boundary", () => {
  const server = source("server.ts");
  const routeRegistration = server.indexOf("registerPublicLeadRoutes(app");
  const firebaseGuard = server.indexOf('app.use("/api", apiRateLimit, requireFirebaseUser)');

  assert.ok(routeRegistration >= 0, "public lead route must be registered");
  assert.ok(firebaseGuard > routeRegistration, "POST /api/leads/public must be registered before the Firebase API guard");
  assert.ok(server.includes("createRateLimiter(publicLeadRateLimitOptions())"));
});

test("QA launcher uses an external temporary root and strips provider credentials", () => {
  const launcher = source("scripts/qa-start.ps1");

  for (const token of [
    "golden-pro-crm-qa-",
    "intentionally-missing.env",
    "DB_PATH = $dbPath",
    "SALLA_INTEGRATION_STORE_PATH = $sallaStorePath",
    "WA_SESSION_DIR = $waSessionPath",
    'OUTBOUND_MODE = "dry_run"',
    'OFFICIAL_LAUNCH_APPROVED = "false"',
    'ENABLE_DAILY_CRON = "false"',
    'SALLA_SYNC_CRON_ENABLED = "false"',
    'COMMUNICATION_WORKER_ENABLED = "false"',
    'DISABLE_VITE_ENV_FILES = "true"',
    'WHATSAPP_PROVIDER = "cloud_api"',
    '"SALLA_CLIENT_SECRET"',
    '"WHATSAPP_CLOUD_API_TOKEN"',
    '"SUPABASE_SERVICE_ROLE_KEY"',
    '"GOOGLE_APPLICATION_CREDENTIALS"',
    '"NODE_OPTIONS"',
    '"scripts/qa-seed.mjs"',
  ]) {
    assert.ok(launcher.includes(token), `qa-start.ps1 is missing ${token}`);
  }
  assert.ok(!launcher.includes("npm run dev"), "QA launcher must bypass npm wrappers and inherited dotenv startup");
  assert.ok(!launcher.includes(".env.production"), "QA launcher must never select production dotenv files");

  const manifestBlock = launcher.match(/\$manifest = \[ordered\]@\{([\s\S]*?)\n\s*\}/)?.[1] || "";
  assert.ok(manifestBlock.includes("dbPath = $dbPath"));
  assert.doesNotMatch(manifestBlock, /secret|token/i, "QA manifest must not persist generated credentials");
});

test("QA launcher has valid PowerShell syntax", { skip: process.platform !== "win32" }, () => {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[scriptblock]::Create([IO.File]::ReadAllText($env:QA_SCRIPT_TO_PARSE)) | Out-Null",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, QA_SCRIPT_TO_PARSE: path.join(root, "scripts", "qa-start.ps1") },
      windowsHide: true,
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("QA fixture seeding fails closed and uses stable idempotency keys", () => {
  const seed = source("scripts/qa-seed.mjs");

  for (const token of [
    'details?.outbound?.mode !== "dry_run"',
    "details?.reminders?.enabled !== false",
    'whatsapp?.provider !== "cloud_api"',
    "whatsapp?.configured !== false",
    "salla?.linked || salla?.configured",
    "qa-store-",
    "event-${orderId}",
    "QA-${item.code}-ISOLATED-V1",
    'source: "manual"',
  ]) {
    assert.ok(seed.includes(token), `qa-seed.mjs is missing ${token}`);
  }
  assert.equal((seed.match(/source: "manual"/g) || []).length, 4, "all validated CRM fixtures must use the supported manual source");
  assert.ok(!seed.includes('notes: SEED_KEY,\n        source: "manual"'), "booking must not rely on a stripped notes field");
});

test("smoke and integration harnesses isolate every persistent provider surface", () => {
  for (const relativePath of ["scripts/smoke.mjs", "scripts/ci-integration.mjs"]) {
    const harness = source(relativePath);
    for (const token of [
      "DB_PATH",
      "SALLA_INTEGRATION_STORE_PATH",
      "WA_SESSION_DIR",
      "OUTBOUND_MODE",
      "OFFICIAL_LAUNCH_APPROVED",
      "ENABLE_DAILY_CRON",
      "SALLA_SYNC_CRON_ENABLED",
      "COMMUNICATION_WORKER_ENABLED",
      "WHATSAPP_PROVIDER",
      "sensitiveInheritedKeys",
    ]) {
      assert.ok(harness.includes(token), `${relativePath} is missing ${token}`);
    }
  }

  const smoke = source("scripts/smoke.mjs");
  assert.ok(smoke.includes('["--import=tsx", "server.ts"]'));
  assert.ok(!smoke.includes("npm run dev"));

  const integration = source("scripts/ci-integration.mjs");
  assert.match(integration, /NODE_ENV:\s*["']test["']/);
});
