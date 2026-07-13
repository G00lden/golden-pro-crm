import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import express from "express";

const tempDir = mkdtempSync(path.join(tmpdir(), "golden-crm-telephony-routes-"));
process.env.DB_PATH = path.join(tempDir, "telephony-routes-test.db");
process.env.DATA_PROVIDER = "sqlite";
process.env.NODE_ENV = "test";
process.env.PUBLIC_BASE_URL = "https://crm.example.com";
process.env.TELEPHONY_WEBHOOK_SECRET = "ivr-route-secret";
process.env.TELEPHONY_STATUS_WEBHOOK_USER = "unifonic-status";
process.env.TELEPHONY_STATUS_WEBHOOK_PASSWORD = "status-password";
process.env.OUTBOUND_MODE = "dry_run";

const { registerTelephonyWebhookRoutes } = await import("./routes-telephony");
const { createDepartment, upsertTelephonyConfig } = await import("./ivrEngine");
const { default: db } = await import("./db");

const ownerUid = "route-owner";
upsertTelephonyConfig(ownerUid, { enabled: true, main_number: "966533971168" });
createDepartment(ownerUid, {
  digit: "1",
  name: "المبيعات",
  agents: [{ name: "المختص", phone: "966500000041", active: true }],
});

const app = express();
app.use(express.json());
registerTelephonyWebhookRoutes(app, {
  webhookRateLimit: (_req, _res, next) => next(),
  telephonyOwnerUid: () => ownerUid,
});
app.use((error: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(error.status || 500).json({ error: error.message });
});
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Test server did not bind to a TCP port.");
const origin = `http://127.0.0.1:${address.port}`;

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

test("initial IVR requires Authorization while the session callback is protected by its token", async () => {
  const endpoint = `${origin}/webhooks/telephony/ivr?callerId=%2B966500000040&recipient=%2B966533971168&callSid=provider-route-call`;
  const rejected = await fetch(endpoint);
  assert.equal(rejected.status, 401);

  const accepted = await fetch(endpoint, { headers: { authorization: "ivr-route-secret" } });
  assert.equal(accepted.status, 200);
  const instructions = await accepted.json() as Array<{ responseUrl?: string }>;
  const responseUrl = instructions[0]?.responseUrl || "";
  assert.match(responseUrl, /\/webhooks\/telephony\/ivr\/session\//);
  const sessionPath = new URL(responseUrl).pathname;

  const selected = await fetch(`${origin}${sessionPath}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callerId: "+966500000040", recipient: "+966533971168", digits: "1" }),
  });
  assert.equal(selected.status, 200);
  const transfer = await selected.json() as Array<{ transfer?: string; recording?: boolean }>;
  assert.equal(transfer[0]?.transfer, "+966500000041");
  assert.equal(transfer[0]?.recording, false);
});

test("repeated initial hits from one caller still create separate call sessions", async () => {
  const endpoint = `${origin}/webhooks/telephony/ivr?callerId=%2B966500000042&recipient=%2B966533971168`;
  const [first, second] = await Promise.all([
    fetch(endpoint, { headers: { authorization: "Bearer ivr-route-secret" } }),
    fetch(endpoint, { headers: { authorization: "Bearer ivr-route-secret" } }),
  ]);
  const firstBody = await first.json() as Array<{ responseUrl?: string }>;
  const secondBody = await second.json() as Array<{ responseUrl?: string }>;
  assert.notEqual(firstBody[0]?.responseUrl, secondBody[0]?.responseUrl);
  const count = db.prepare("SELECT COUNT(*) AS c FROM call_logs WHERE owner_uid = ? AND from_phone_norm = ?")
    .get(ownerUid, "966500000042") as { c: number };
  assert.equal(Number(count.c), 2);
});

test("status webhook uses independent Basic Authentication and acknowledges duplicates", async () => {
  const body = JSON.stringify({ callSid: "provider-route-call", status: "completed", timestamp: "2026-07-13T15:00:00Z" });
  const unauthorized = await fetch(`${origin}/webhooks/telephony/status`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer ivr-route-secret" },
    body,
  });
  assert.equal(unauthorized.status, 401);

  const authorization = `Basic ${Buffer.from("unifonic-status:status-password").toString("base64")}`;
  const accepted = await fetch(`${origin}/webhooks/telephony/status`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization },
    body,
  });
  assert.equal(accepted.status, 200);
  const first = await accepted.json() as { received: boolean; duplicate: boolean };
  assert.equal(first.received, true);
  assert.equal(first.duplicate, false);

  const repeated = await fetch(`${origin}/webhooks/telephony/status`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization },
    body,
  });
  const duplicate = await repeated.json() as { received: boolean; duplicate: boolean };
  assert.equal(repeated.status, 200);
  assert.equal(duplicate.duplicate, true);
});
