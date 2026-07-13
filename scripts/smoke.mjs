import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { getLocalTestToken } from "./local-test-auth.mjs";

const root = new URL("../", import.meta.url);
const rootPath = fileURLToPath(root);
const suppliedBaseUrl = String(process.env.APP_URL || "").trim();
let baseUrl = suppliedBaseUrl;
const smokeUid = process.env.SMOKE_TEST_UID || "smoke-test-owner";
const results = [];
let spawnedServer;
let standaloneDirectory;
let serverOutput = "";
let localAuthHeaders = {};

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

function pathUrl(path) {
  return new URL(path, root);
}

async function readText(path) {
  return readFile(pathUrl(path), "utf8");
}

async function readJson(path) {
  return JSON.parse(await readText(path));
}

async function timedFetch(path, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    return await fetch(new URL(path, baseUrl), { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function serverIsHealthy() {
  try {
    const response = await timedFetch("/api/health");
    if (!response.ok) return false;
    const body = await response.json();
    return body.status === "ok";
  } catch {
    return false;
  }
}

async function reserveLoopbackPort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  if (!port) throw new Error("Could not reserve a loopback port for the isolated smoke server.");
  return port;
}

async function ensureServer() {
  if (suppliedBaseUrl) {
    if (await serverIsHealthy()) return;
    throw new Error(`The explicitly supplied smoke server is not healthy at ${suppliedBaseUrl}.`);
  }

  standaloneDirectory = mkdtempSync(path.join(os.tmpdir(), "breexe-smoke-"));
  const port = await reserveLoopbackPort();
  baseUrl = `http://127.0.0.1:${port}`;
  const isolatedEnv = { ...process.env };
  for (const key of sensitiveInheritedKeys) delete isolatedEnv[key];

  spawnedServer = spawn(process.execPath, ["--import=tsx", "server.ts"], {
    cwd: rootPath,
    env: {
      ...isolatedEnv,
      ENV_FILE: path.join(standaloneDirectory, "intentionally-missing.env"),
      HOST: "127.0.0.1",
      PORT: String(port),
      APP_URL: baseUrl,
      PUBLIC_APP_URL: baseUrl,
      PUBLIC_BASE_URL: baseUrl,
      APP_BASE_URL: baseUrl,
      NODE_ENV: "test",
      ENABLE_VITE_DEV_SERVER: "true",
      DATA_PROVIDER: "sqlite",
      DB_PROVIDER: "sqlite",
      DB_PATH: path.join(standaloneDirectory, "smoke.db"),
      SALLA_INTEGRATION_STORE_PATH: path.join(standaloneDirectory, "salla-integrations.json"),
      WA_SESSION_DIR: path.join(standaloneDirectory, "wa-session"),
      ALLOW_LOCAL_AUTH: "true",
      LOCAL_AUTH_TOKEN: "smoke-test-only-secret-with-at-least-32-characters",
      LOCAL_AUTH_SHARED_UID: smokeUid,
      PUBLIC_LEADS_OWNER_UID: smokeUid,
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
      SALLA_APP_OWNER_UID: smokeUid,
    },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  spawnedServer.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
  spawnedServer.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });

  for (let attempt = 0; attempt < 120; attempt += 1) {
    await delay(250);
    if (await serverIsHealthy()) return;
    if (spawnedServer.exitCode !== null) {
      throw new Error(`Isolated smoke server exited early.\n${serverOutput}`);
    }
  }

  throw new Error(`Isolated smoke server did not become healthy at ${baseUrl}.\n${serverOutput}`);
}

async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

function assertIncludes(text, needles, label) {
  for (const needle of needles) {
    assert.ok(text.includes(needle), `${label} is missing: ${needle}`);
  }
}

try {
  await ensureServer();
  localAuthHeaders = {
    Authorization: `Bearer ${await getLocalTestToken(baseUrl, smokeUid)}`,
  };

  await check("package scripts and dependencies", async () => {
    const pkg = await readJson("package.json");
    assert.equal(pkg.name, "golden-pro-crm");
    assertIncludes(JSON.stringify(pkg.scripts), ["dev", "build", "start", "lint", "test:smoke"], "package scripts");
    assertIncludes(JSON.stringify(pkg.dependencies), ["firebase-admin", "@whiskeysockets/baileys", "pino"], "dependencies");
  });

  await check("server health and reminder scheduler", async () => {
    const response = await timedFetch("/api/health");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "ok");
    assert.ok(body.release?.version, "public health must expose the release version");
    assert.equal(body.reminders, undefined, "public health must not expose scheduler diagnostics");

    const detailsResponse = await timedFetch("/api/health/details", { headers: localAuthHeaders });
    assert.equal(detailsResponse.status, 200);
    const details = await detailsResponse.json();
    assert.equal(details.timeZone, "Asia/Riyadh");
    assert.ok(details.reminders && typeof details.reminders.enabled === "boolean");
    assert.ok(details.reminders.schedule, "authenticated health details must expose reminder schedule");
    assert.ok(details.storeWebhook && details.storeWebhook.endpoint === "/api/store/webhook");
  });

  await check("protected API rejects anonymous requests", async () => {
    const whatsapp = await timedFetch("/api/whatsapp/status");
    const reminders = await timedFetch("/api/reminders/run-due", { method: "POST" });
    const storeDiagnostics = await timedFetch("/api/store/webhook/diagnostics");
    assert.equal(whatsapp.status, 401);
    assert.equal(reminders.status, 401);
    assert.equal(storeDiagnostics.status, 401);
  });

  await check("public lead intake remains outside auth with bot-safe handling", async () => {
    const invalid = await timedFetch("/api/leads/public", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", phone: "123" }),
    });
    assert.equal(invalid.status, 400, "public lead validation must run before the Firebase auth guard");

    const honeypot = await timedFetch("/api/leads/public", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "QA Lead",
        phone: "+966551234567",
        source: "landing",
        website: "https://bot.example",
      }),
    });
    assert.equal(honeypot.status, 202);
    assert.deepEqual(await honeypot.json(), { success: true });
  });

  await check("local demo data covers full workflow", async () => {
    const api = await readText("src/api.ts");
    assertIncludes(api, [
      "export const seedDemoData",
      "buildDemoDataSet",
      "const demoProducts",
      "const demoTechs",
      "const dueOffsets",
      "status === \"completed\"",
      "status === \"cancelled\"",
      "bookings.push(booking)",
      "localDb.bookings.push(...demo.bookings)",
      "writeBatch(db)",
      "withoutId(item)",
      "batch.set(doc(db, \"bookings\", item.id), withoutId(item))",
    ], "seed demo data");
    assert.ok(
      !/setDoc\(doc\(db,\s*"(customers|products|installations|technicians|bookings)",\s*item\.id\),\s*item\)/.test(api),
      "cloud demo seed must not write local id field into Firestore documents",
    );
  });

  await check("reminder logic records success and failure", async () => {
    const api = await readText("src/api.ts");
    const server = await readText("server.ts");
    const engine = await readText("server/reminderEngine.ts");
    assertIncludes(api, [
      "sendLocalReminderViaWhatsApp",
      "/api/whatsapp/send-test",
      "status: \"failed\"",
      "hasSuccessfulReminderToday",
      "hasRecentReminderAttempt",
      "localDayWindow",
      "getReminderDiagnostics",
    ], "local reminder logic");
    assert.ok(!api.includes("applyLocalReminder"), "fake local reminder path must not remain in api.ts");
    assert.ok(!api.includes("status: \"local\""), "reminders must not be marked sent without WhatsApp delivery");
    assertIncludes(engine, [
      "recordFailedReminderAttempt",
      "status: \"failed\"",
      "todayWindowInTimeZone",
      "last_remind_attempt_at",
      "retryCooldownMinutes",
      "hasGlobalBlocker",
      "getReminderDiagnostics",
      "ENABLE_DAILY_CRON",
      "REMINDER_CRON_SCHEDULE",
    ], "server reminder engine");
    assertIncludes(server, [
      "registerReminderRoutes",
      "runDueReminders({ mode: \"scheduled\" })",
    ], "server reminder import");
    const reminderRoutes = await readText("server/routes-reminders.ts");
    assertIncludes(reminderRoutes, [
      "/api/reminders/diagnostics",
      "/api/reminders/scheduler",
    ], "server reminder routes");
    assert.ok(!engine.includes("last_remind_at?.startsWith(today)"), "server must compare reminder timestamps using the configured timezone day window");
  });

  await check("whatsapp connection state is guarded", async () => {
    const whatsapp = await readText("server/whatsapp.ts");
    assertIncludes(whatsapp, [
      "this.status !== \"connecting\" || !this.sock",
      "this.status = \"error\"",
      "this.notifyWaiters()",
      "throw error",
      "WHATSAPP_PROVIDER",
      "WHATSAPP_CLOUD_API_TOKEN",
      "WHATSAPP_CLOUD_TEMPLATE_NAME",
      "type: \"template\"",
      "graph.facebook.com",
    ], "whatsapp connection guard");
  });

  await check("technician booking notifications are wired", async () => {
    const server = await readText("server.ts");
    const notifier = await readText("server/bookingNotifications.ts");
    const api = await readText("src/api.ts");
    const app = await readText("src/pages/Bookings.tsx");
    assertIncludes(server, [
      "registerMaintenanceRoutes",
      "sendTechnicianPreAlerts",
    ], "server technician notification import");
    const maintenanceRoutes = await readText("server/routes-maintenance.ts");
    assertIncludes(maintenanceRoutes, [
      "/api/bookings/:id/notify-technician",
      "notifyTechnicianForBooking",
    ], "maintenance routes technician notification");
    assertIncludes(notifier, [
      "buildTechnicianBookingMessage",
      "technician_notifications",
      "whatsappService.sendText",
      "إشعار الفني يرسل للحجوزات المؤكدة فقط",
    ], "technician notification engine");
    assertIncludes(api, [
      "notifyTechnicianBooking",
      "sendLocalTechnicianNotification",
      "buildTechnicianBookingMessage",
    ], "technician notification API");
    assertIncludes(app, [
      "createPerItemActionLock",
      "sendTechnicianNotice",
      "تم حفظ الحجز دون إرسال",
      "إرسال الموعد للفني",
    ], "technician notification UI");
  });

  await check("store webhook integration is secure and idempotent", async () => {
    const server = await readText("server.ts");
    const webhook = await readText("server/storeWebhook.ts");
    const app = await readText("src/pages/Settings.tsx");
    const api = await readText("src/api.ts");
    const docs = await readText("docs/store-webhook-architecture.md");
    const healthRoutes = await readText("server/routes-health.ts");
    assertIncludes(healthRoutes, [
      "storeWebhook: getStoreWebhookPublicState()",
    ], "server store webhook import");
    const storeRoutes = await readText("server/routes-store.ts");
    assertIncludes(storeRoutes, [
      "/api/store/webhook",
      "processStoreWebhook",
      "getStoreWebhookDiagnostics",
    ], "server store webhook routes");
    assertIncludes(webhook, [
      "STORE_WEBHOOK_SECRET",
      "STORE_WEBHOOK_OWNER_UID",
      "X-Golden-Signature",
      "x-salla-signature",
      "classifyStoreItem",
      "SALE-",
      "INSTALL-",
      "MAINT-",
      "EXT-",
      "skuMatchKey",
      "external_maintenance",
      "needs_review",
      "pending_external_service",
      "store_webhook_events",
      "store_orders",
      "duplicate: true",
      "upsertCustomer",
      "upsertProduct",
      "installations",
      "linkStoreOrderInstallation",
      "booking_id: bookingId",
    ], "store webhook engine");
    assertIncludes(api, ["StoreWebhookDiagnostics", "StoreOrder", "getStoreOrders", "linkStoreOrderInstallation"], "store webhook API");
    assertIncludes(app, ["ربط المتجر عبر Webhook", "آخر أحداث المتجر"], "store webhook UI");
    assertIncludes(docs, ["POST /api/store/webhook", "HMAC SHA-256", "store_webhook_events"], "store webhook docs");
  });

  await check("salla oauth and sync integration is wired", async () => {
    const server = await readText("server.ts");
    const salla = await readText("server/salla.ts");
    const api = await readText("src/api.ts");
    const app = await readText("src/pages/Settings.tsx");
    const docs = await readText("docs/salla-api-integration.md");

    assertIncludes(server, [
      "registerSallaRoutes",
      "syncAllLinkedSallaIntegrations",
      "/api/integrations/salla/callback",
      "/salla/webhook",
    ], "server salla import");
    const sallaRoutes = await readText("server/routes-salla.ts");
    assertIncludes(sallaRoutes, [
      "/api/integrations/salla/status",
      "/api/integrations/salla/connect",
      "/api/integrations/salla/sync",
    ], "server salla routes");
    assertIncludes(salla, [
      "SALLA_AUTHORIZE_URL",
      "SALLA_TOKEN_URL",
      "SALLA_USERINFO_URL",
      "SALLA_API_BASE",
      "signState",
      "verifyState",
      "toSettingsShape",
      "fromSettingsShape",
      "importStoreOrderForUser",
      "syncSallaOrdersForUser",
      "handleSallaAppWebhook",
      "app.store.authorize",
    ], "salla integration service");
    assertIncludes(api, [
      "export type SallaIntegrationStatus",
      "getSallaIntegrationStatus",
      "getSallaConnectUrl",
      "syncSallaOrders",
    ], "salla frontend api");
    assertIncludes(app, [
      "ربط سلة عبر API",
      "Webhook URL",
      "مزامنة الآن",
      "SALLA_CLIENT_ID",
      "SALLA_CLIENT_SECRET",
    ], "salla settings ui");
    assertIncludes(docs, [
      "GET /api/integrations/salla/status",
      "POST /api/integrations/salla/webhook",
      "POST /api/integrations/salla/sync",
      "StoreWebhookOrder",
    ], "salla docs");

    const headers = localAuthHeaders;
    const statusResponse = await timedFetch("/api/integrations/salla/status", { headers });
    assert.equal(statusResponse.status, 200);
    const statusBody = await statusResponse.json();
    assert.equal(statusBody.provider, "salla");
    assert.ok(typeof statusBody.configured === "boolean");
    assert.ok(typeof statusBody.linked === "boolean");
    assert.ok(["easy", "custom"].includes(statusBody.auth_mode), "salla status must expose auth_mode");

    const connectResponse = await timedFetch("/api/integrations/salla/connect", { headers });
    const connectText = await connectResponse.text();
    assert.ok([200, 409, 500].includes(connectResponse.status), `unexpected connect status ${connectResponse.status}`);
    if (connectResponse.status === 200) {
      assert.ok(connectText.includes("\"url\""), "connect response must include url when configured");
    } else if (connectResponse.status === 409) {
      assert.ok(connectText.includes("Easy Mode") || connectText.includes("callback"), "easy mode connect error must explain webhook-based flow");
    } else {
      assert.ok(connectText.includes("SALLA_CLIENT_ID") || connectText.includes("Salla"), "connect error must be user-safe");
    }

    const syncResponse = await timedFetch("/api/integrations/salla/sync", { method: "POST", headers });
    const syncText = await syncResponse.text();
    assert.ok([200, 400, 401, 409, 412, 424, 500, 503].includes(syncResponse.status), `unexpected sync status ${syncResponse.status}`);
    if (syncResponse.status === 200) {
      assert.ok(syncText.includes("\"success\""), "sync success response must include success field");
    } else {
      assert.ok(syncText.includes("Salla"), "sync error must mention Salla clearly");
    }

  });

  await check("frontend exposes core CRM workflows", async () => {
    const customersPage = await readText("src/pages/Customers.tsx");
    const productsPage = await readText("src/pages/Products.tsx");
    const installPage = await readText("src/pages/Installations.tsx");
    const storeOrdersPage = await readText("src/pages/StoreOrders.tsx");
    const carePage = await readText("src/pages/CustomerCare.tsx");
    const techsPage = await readText("src/pages/Technicians.tsx");
    const bookingsPage = await readText("src/pages/Bookings.tsx");
    const appSource = await readText("src/App.tsx");
    const waConsole = await readText("src/pages/WhatsAppConsole.tsx");
    const dashboardPage = await readText("src/pages/Dashboard.tsx");
    const settingsPage = await readText("src/pages/Settings.tsx");
    const allPages = customersPage + productsPage + installPage + storeOrdersPage + carePage + techsPage + bookingsPage + appSource + waConsole + dashboardPage + settingsPage;
    assertIncludes(allPages, [
      "export default function CustomersPage",
      "function ProductsPage",
      "function InstallationsPage",
      "function StoreOrdersPage",
      "function CustomerCarePage",
      "function TechniciansPage",
      "function BookingsPage",
      "export function WhatsAppConsole",
      "api.seedDemoData(10)",
      "api.runDueReminders({ automatic: true })",
      "api.completeInstallation",
      "api.remindInstallation",
      "api.getCustomerCareQueue",
      "راجع تشخيص واتساب",
      "selectableInstallations",
      "pending_external_service",
    ], "frontend workflows");
  });

  await check("odoo-style CRM workspace is wired", async () => {
    const server = await readText("server.ts");
    const routes = await readText("server/odooCrm.ts");
    const db = await readText("server/db.ts");
    const adapter = await readText("server/sqliteFirestoreAdapter.ts");
    const api = await readText("src/api.ts");
    const app = await readText("src/App.tsx");
    const page = await readText("src/pages/OdooCrm.tsx");
    const roles = await readText("shared/accessControl.ts");

    assertIncludes(server, ["registerOdooCrmRoutes"], "odoo route registration");
    assertIncludes(db, ["crm_deals", "crm_tasks", "crm_notes", "audit_logs"], "odoo sqlite schema");
    assertIncludes(adapter, ["crm_deals", "crm_tasks", "crm_notes", "audit_logs"], "odoo sqlite adapter");
    assertIncludes(roles, ["\"sales\"", "\"technician\""], "odoo roles");
    assertIncludes(routes, [
      "/api/odoo/dashboard",
      "/api/odoo/pipeline",
      "/api/odoo/tasks",
      "/api/odoo/customer-360/:id",
      "/api/odoo/search",
      "/api/odoo/audit",
      "quote_id",
      "invoice_id",
      "recordAudit",
    ], "odoo backend routes");
    assertIncludes(api, [
      "getOdooDashboard",
      "getOdooPipeline",
      "createOdooDeal",
      "updateOdooTask",
      "getCustomer360",
      "searchOdoo",
    ], "odoo frontend API");
    assertIncludes(app, ["odooCrm", "CRM Odoo", "OdooCrmPage"], "odoo nav");
    assertIncludes(page, [
      "CRM مثل Odoo",
      "Pipeline المبيعات",
      "المهام والمتابعات",
      "عميل 360",
      "سجل النشاط",
    ], "odoo page");

    const headers = localAuthHeaders;
    const dashboardResponse = await timedFetch("/api/odoo/dashboard", { headers });
    assert.equal(dashboardResponse.status, 200);
    const dashboard = await dashboardResponse.json();
    assert.ok(Array.isArray(dashboard.pipeline), "dashboard must expose pipeline");
    assert.ok(dashboard.financial && typeof dashboard.financial === "object", "dashboard must expose financial metrics");

    const pipelineResponse = await timedFetch("/api/odoo/pipeline", { headers });
    assert.equal(pipelineResponse.status, 200);
    const pipeline = await pipelineResponse.json();
    assert.ok(Array.isArray(pipeline.stages), "pipeline must expose stages");
  });

  await check("firestore rules and indexes cover CRM data", async () => {
    const rules = await readText("firestore.rules");
    const indexes = await readJson("firestore.indexes.json");
    assertIncludes(rules, [
      "match /customers/{id}",
      "match /products/{id}",
      "match /installations/{id}",
      "match /technicians/{id}",
      "match /bookings/{id}",
      "match /reminders/{id}",
      "match /technician_notifications/{id}",
      "match /settings/{userId}",
      "match /store_orders/{id}",
      "match /store_webhook_events/{id}",
      "pending_installation",
      "pending_external_service",
      "last_remind_attempt_at",
      "allow create, update, delete: if false;",
    ], "firestore rules");

    const indexSignatures = indexes.indexes.map((item) =>
      `${item.collectionGroup}:${item.fields.map((field) => `${field.fieldPath}:${field.order}`).join(",")}`,
    );
    assert.ok(
      indexSignatures.some((sig) => sig.includes("installations:createdBy:ASCENDING,status:ASCENDING,next_maintenance:ASCENDING")),
      "missing installations due-reminder index",
    );
    assert.ok(
      indexSignatures.some((sig) => sig.includes("reminders:createdBy:ASCENDING,status:ASCENDING,sent_at:ASCENDING")),
      "missing reminders sent-today index",
    );
    assert.ok(
      indexSignatures.some((sig) => sig.includes("store_webhook_events:createdBy:ASCENDING,received_at:DESCENDING")),
      "missing store webhook events index",
    );
    assert.ok(
      indexSignatures.some((sig) => sig.includes("store_orders:createdBy:ASCENDING,imported_at:DESCENDING")),
      "missing store orders index",
    );
  });

  await check("environment example has no service-account secret", async () => {
    const env = await readText(".env.example");
    assert.ok(!/BEGIN PRIVATE KEY|private_key|WHATSAPP_TOKEN|WA_TOKEN/i.test(env));
    assert.match(env, /FIREBASE_SERVICE_ACCOUNT_PATH=\s*$/m);
    assert.match(env, /FIREBASE_SERVICE_ACCOUNT_JSON=\s*$/m);
    assert.match(env, /WHATSAPP_PROVIDER=web/m);
    assert.match(env, /WHATSAPP_CLOUD_PHONE_NUMBER_ID=\s*$/m);
    assert.match(env, /WHATSAPP_CLOUD_API_TOKEN=\s*$/m);
    assert.match(env, /WHATSAPP_CLOUD_TEMPLATE_NAME=\s*$/m);
    assert.match(env, /STORE_WEBHOOK_SECRET=\s*$/m);
    assert.match(env, /STORE_WEBHOOK_OWNER_UID=\s*$/m);
  });

  await check("firestore errors are user-safe", async () => {
    const firebase = await readText("src/firebase.ts");
    assertIncludes(firebase, [
      "ليست لديك صلاحية تنفيذ هذه العملية",
      "يتطلب هذا الاستعلام فهرسا",
      "تعذر الاتصال بـ Firestore حاليا",
    ], "firestore error messages");
    assert.ok(!firebase.includes("throw new Error(JSON.stringify(errInfo))"), "Firestore errors must not expose diagnostic JSON to the UI");
  });

  await check("call routing + self-hosted gateway are wired", async () => {
    const server = await readText("server.ts");
    const gateway = await readText("server/gateway.ts");
    const ivr = await readText("server/ivrEngine.ts");
    const routesGw = await readText("server/routes-gateway.ts");
    const db = await readText("server/db.ts");
    const templates = await readText("server/whatsappTemplates.ts");

    assertIncludes(server, [
      "registerGatewayWebhookRoutes",
      "registerTelephonyWebhookRoutes",
      "initWhatsAppAutoReply",
    ], "server telephony/gateway wiring");
    assertIncludes(gateway, [
      "handleGatewayEvent",
      "dispatchMessage",
      "pickAgentRoundRobin",
      "recentlyNotifiedCustomer",
      "GATEWAY_REPLY_COOLDOWN_MIN",
      "getNextPendingSms",
    ], "gateway engine");
    assertIncludes(ivr, [
      "pickAgentRoundRobin",
      "rr_counter",
      "recentlyNotifiedCustomer",
      "runMissedCallFlow",
      "findCustomerByPhone",
      "isAgentAck",
      "markCallHandled",
    ], "ivr engine routing helpers");
    assertIncludes(routesGw, [
      "/api/gateway/event",
      "/api/gateway/next",
      "/api/gateway/outbox/ack",
      "requireGatewayToken",
    ], "gateway routes");
    assertIncludes(db, ["gateway_outbox", "ivr_departments", "call_logs"], "telephony tables");
    assertIncludes(templates, ["missed_call_customer", "missed_call_agent"], "missed-call templates");

    // Live: gateway endpoints must reject calls without the gateway token, and
    // the admin status endpoint must reject anonymous requests.
    const noToken = await timedFetch("/api/gateway/next");
    assert.ok([401, 503].includes(noToken.status), "gateway/next must require the gateway token");
    const adminStatus = await timedFetch("/api/gateway/status");
    assert.equal(adminStatus.status, 401, "gateway/status must require an authenticated admin");
  });

  for (const result of results) {
    if (result.ok) console.log(`PASS ${result.name}`);
    else console.error(`FAIL ${result.name}: ${result.error}`);
  }

  const failed = results.filter((result) => !result.ok);
  if (failed.length) {
    process.exitCode = 1;
  } else {
    console.log(`Smoke checks passed (${results.length}/${results.length}).`);
  }
} finally {
  if (spawnedServer) {
    if (process.platform === "win32" && spawnedServer.pid) {
      const result = spawnSync("taskkill.exe", ["/PID", String(spawnedServer.pid), "/T", "/F"], { stdio: "ignore" });
      if (result.status !== 0 && spawnedServer.exitCode === null) spawnedServer.kill();
    } else if (spawnedServer.exitCode === null) {
      spawnedServer.kill("SIGTERM");
    }
    if (spawnedServer.exitCode === null) {
      await Promise.race([new Promise((resolve) => spawnedServer.once("exit", resolve)), delay(3000)]);
    }
  }
  if (standaloneDirectory) rmSync(standaloneDirectory, { recursive: true, force: true });
}
