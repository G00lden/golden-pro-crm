import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const release = JSON.parse(readFileSync(path.join(root, "release.json"), "utf8"));
const directory = mkdtempSync(path.join(os.tmpdir(), "breexe-ci-"));
const port = 3400 + (process.pid % 500);
const appUrl = `http://127.0.0.1:${port}`;
const serverConfig = {
  PORT: String(port),
  HOST: "127.0.0.1",
  APP_URL: appUrl,
  PUBLIC_APP_URL: appUrl,
  PUBLIC_BASE_URL: appUrl,
  APP_BASE_URL: appUrl,
  DB_PATH: path.join(directory, "ci.db"),
  SALLA_INTEGRATION_STORE_PATH: path.join(directory, "salla-integrations.json"),
  WA_SESSION_DIR: path.join(directory, "wa-session"),
  DATA_PROVIDER: "sqlite",
  DB_PROVIDER: "sqlite",
  ALLOW_LOCAL_AUTH: "true",
  LOCAL_AUTH_SHARED_UID: "ci-owner",
  PUBLIC_LEADS_OWNER_UID: "ci-owner",
  LOCAL_AUTH_TOKEN: "ci-integration-secret-with-at-least-32-characters",
  GOLDEN_PATH_UID: "ci-owner",
  SMOKE_TEST_UID: "ci-owner",
  OUTBOUND_MODE: "dry_run",
  OFFICIAL_LAUNCH_APPROVED: "false",
  DISABLE_OUTBOUND: "true",
  DISABLE_HMR: "true",
  DISABLE_VITE_ENV_FILES: "true",
  ENABLE_DAILY_CRON: "false",
  SALLA_SYNC_CRON_ENABLED: "false",
  COMMUNICATION_WORKER_ENABLED: "false",
  WHATSAPP_PROVIDER: "cloud_api",
  SALLA_AUTH_MODE: "easy",
  SALLA_APP_OWNER_UID: "ci-owner",
  NODE_ENV: "test",
  ENABLE_VITE_DEV_SERVER: "false",
};
const envFile = path.join(directory, ".env.integration");
writeFileSync(
  envFile,
  `${Object.entries(serverConfig).map(([key, value]) => `${key}=${value}`).join("\n")}\n`,
  "utf8",
);

// CI must not inherit a developer's production providers. In particular,
// dotenv does not overwrite already-defined process variables, so setting a
// safe ENV_FILE alone would still leave real Salla/WhatsApp credentials live.
const sensitiveInheritedKeys = [
  "ENV_FILE",
  "NODE_OPTIONS",
  "DOTENV_CONFIG_PATH",
  "DOTENV_CONFIG_OVERRIDE",
  "DOTENV_CONFIG_DOTENV_KEY",
  "DOTENV_KEY",
  "CRM_BEARER_TOKEN",
  "SALLA_CLIENT_ID",
  "SALLA_CLIENT_SECRET",
  "SALLA_STATE_SECRET",
  "SALLA_ACCESS_TOKEN",
  "SALLA_REFRESH_TOKEN",
  "SALLA_APP_WEBHOOK_SECRET",
  "SALLA_REDIRECT_URI",
  "STORE_WEBHOOK_SECRET",
  "STORE_WEBHOOK_OWNER_UID",
  "WHATSAPP_CLOUD_API_TOKEN",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_CLOUD_PHONE_NUMBER_ID",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_WEBHOOK_VERIFY_TOKEN",
  "WHATSAPP_WEBHOOK_SECRET",
  "WHATSAPP_CLOUD_TEMPLATE_NAME",
  "WHATSAPP_TEMPLATE_NAME",
  "TAP_SECRET_KEY",
  "TAP_WEBHOOK_SECRET",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_ANON_KEY",
  "FIREBASE_SERVICE_ACCOUNT_JSON",
  "FIREBASE_SERVICE_ACCOUNT_PATH",
  "FIREBASE_PROJECT_ID",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "VITE_FIREBASE_API_KEY",
  "VITE_FIREBASE_AUTH_DOMAIN",
  "VITE_FIREBASE_PROJECT_ID",
  "VITE_FIREBASE_STORAGE_BUCKET",
  "VITE_FIREBASE_MESSAGING_SENDER_ID",
  "VITE_FIREBASE_APP_ID",
  "INVOICE_SHARE_SECRET",
  "JWT_SECRET",
  "SESSION_SECRET",
  "TELEPHONY_WEBHOOK_SECRET",
  "UNIFONIC_APP_SID",
  "UNIFONIC_API_KEY",
  "GATEWAY_TOKEN",
  "OUTBOUND_CONFIRM_CODE",
  "OUTBOUND_TEST_PHONE_ALLOWLIST",
];
const isolatedInheritedEnv = { ...process.env };
for (const key of sensitiveInheritedKeys) delete isolatedInheritedEnv[key];

const sharedEnv = { ...isolatedInheritedEnv, ...serverConfig, APP_URL: appUrl };
const serverEnv = { ...isolatedInheritedEnv, ENV_FILE: envFile };
for (const key of Object.keys(serverConfig)) delete serverEnv[key];

// Exercise the deployable bundle and ENV_FILE bootstrap, not a development
// proxy. This also avoids an npm/tsx wrapper that could be orphaned on Windows.
const server = spawn(process.execPath, ["dist-server/server.mjs"], {
  cwd: root,
  env: serverEnv,
  stdio: ["ignore", "pipe", "pipe"],
  shell: false,
  windowsHide: true,
});

let serverOutput = "";
server.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
server.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${appUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // retry while the process initializes
    }
    if (server.exitCode !== null) throw new Error(`Test server exited early.\n${serverOutput}`);
    await delay(250);
  }
  throw new Error(`Test server did not become healthy.\n${serverOutput}`);
}

async function verifyProductionSurface() {
  for (const pathname of ["/@vite/client", "/src/main.tsx", "/package.json", "/server.ts"]) {
    const response = await fetch(`${appUrl}${pathname}`);
    if (response.status !== 404) {
      throw new Error(`Production source path ${pathname} returned ${response.status}, expected 404.`);
    }
  }
  const versionResponse = await fetch(`${appUrl}/api/version`);
  const version = await versionResponse.json();
  if (!versionResponse.ok || version.version !== release.version) {
    throw new Error(`Production version endpoint is invalid: ${JSON.stringify(version)}`);
  }
}

async function run(script) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: root,
      env: sharedEnv,
      stdio: "inherit",
      shell: false,
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${script} failed with exit code ${code}`)));
  });
}

try {
  await waitForServer();
  await verifyProductionSurface();
  await run("scripts/smoke.mjs");
  await run("scripts/golden-path.mjs");
  console.log(`CI integration passed against ${appUrl}`);
} finally {
  if (process.platform === "win32" && server.pid) {
    const result = spawnSync("taskkill.exe", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" });
    if (result.status !== 0 && server.exitCode === null) server.kill();
  } else {
    server.kill("SIGTERM");
  }
  if (server.exitCode === null) {
    await Promise.race([new Promise((resolve) => server.once("exit", resolve)), delay(3000)]);
  }
  rmSync(directory, { recursive: true, force: true });
  if (server.exitCode === null) {
    throw new Error(`CI test server ${server.pid} did not stop cleanly.`);
  }
}
