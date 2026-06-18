import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const rootPath = fileURLToPath(root);
const baseUrl = process.env.APP_URL || "http://localhost:3000";
const results = [];
let spawnedServer;

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
  const timer = setTimeout(() => controller.abort(), 10000);
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

async function ensureServer() {
  if (await serverIsHealthy()) return;

  const command = process.platform === "win32" ? "cmd.exe" : "npm";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", "npm run dev"] : ["run", "dev"];
  spawnedServer = spawn(command, args, {
    cwd: rootPath,
    env: { ...process.env, PORT: new URL(baseUrl).port || "3000" },
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  });

  for (let attempt = 0; attempt < 30; attempt += 1) {
    await delay(1000);
    if (await serverIsHealthy()) return;
  }

  throw new Error(`Dev server did not become healthy at ${baseUrl}.`);
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
    assert.equal(body.timeZone, "Asia/Riyadh");
    assert.ok(body.reminders && typeof body.reminders.enabled === "boolean");
    assert.ok(body.reminders.schedule, "health response must expose reminder schedule");
    assert.ok(body.storeWebhook && body.storeWebhook.endpoint === "/api/store/webhook");
  });

  await check("protected API rejects anonymous requests", async () => {
    const whatsapp = await timedFetch("/api/whatsapp/status");
    const reminders = await timedFetch("/api/reminders/run-due", { method: "POST" });
    const storeDiagnostics = await timedFetch("/api/store/webhook/diagnostics");
    assert.equal(whatsapp.status, 401);
    assert.equal(reminders.status, 401);
    assert.equal(storeDiagnostics.status, 401);
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
      "/api/reminders/diagnostics",
      "/api/reminders/scheduler",
      "runDueReminders({ mode: \"scheduled\" })",
    ], "server reminder API");
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
    const app = await readText("src/App.tsx");
    assertIncludes(server, [
      "/api/bookings/:id/notify-technician",
      "notifyTechnicianForBooking",
    ], "server technician notification route");
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
      "shouldNotifyTechnician",
      "sendTechnicianNotice",
      "إرسال الموعد للفني",
    ], "technician notification UI");
  });

  await check("store webhook integration is secure and idempotent", async () => {
    const server = await readText("server.ts");
    const webhook = await readText("server/storeWebhook.ts");
    const app = await readText("src/App.tsx");
    const api = await readText("src/api.ts");
    const docs = await readText("docs/store-webhook-architecture.md");
    assertIncludes(server, [
      "/api/store/webhook",
      "processStoreWebhook",
      "getStoreWebhookDiagnostics",
      "storeWebhook: getStoreWebhookPublicState()",
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
    const app = await readText("src/App.tsx");
    const docs = await readText("docs/salla-api-integration.md");

    assertIncludes(server, [
      "/api/integrations/salla/status",
      "/api/integrations/salla/connect",
      "/api/integrations/salla/callback",
      "/api/integrations/salla/webhook",
      "/api/integrations/salla/sync",
      "syncAllLinkedSallaIntegrations",
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

    const headers = { Authorization: "Bearer local-dev:any" };
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
    const app = await readText("src/App.tsx");
    assertIncludes(app, [
      "function CustomersPage",
      "function ProductsPage",
      "function InstallationsPage",
      "function StoreOrdersPage",
      "function CustomerCarePage",
      "function TechniciansPage",
      "function BookingsPage",
      "function MessagesPage",
      "api.seedDemoData(10)",
      "api.runDueReminders({ automatic: true })",
      "api.completeInstallation",
      "api.completeBooking",
      "api.remindInstallation",
      "api.getReminderDiagnostics",
      "api.getCustomerCareQueue",
      "تشخيص التذكيرات",
      "selectableInstallations",
      "pending_external_service",
    ], "frontend workflows");
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
  if (spawnedServer) spawnedServer.kill();
}
