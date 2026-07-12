import assert from "node:assert/strict";
import test from "node:test";
import { WhatsAppService } from "./whatsapp";

test("Cloud API is not reported connected until Meta accepts a live probe", async (t) => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  t.after(() => {
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
  });

  process.env.WHATSAPP_PROVIDER = "cloud_api";
  process.env.WHATSAPP_CLOUD_API_TOKEN = "test-token";
  process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID = "12345";
  const service = new WhatsAppService(".wa-test-session");

  assert.equal(service.getStatus().status, "connecting");
  globalThis.fetch = async () => new Response(JSON.stringify({ id: "12345" }), { status: 200 });
  const ready = await service.verifyConnection(true);
  assert.equal(ready.status, "connected");
  assert.equal(ready.configured, true);
  assert.ok(ready.verifiedAt);
});

test("an expired Cloud API token produces an error instead of a false connected state", async (t) => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  t.after(() => {
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
  });

  process.env.WHATSAPP_PROVIDER = "cloud_api";
  process.env.WHATSAPP_CLOUD_API_TOKEN = "expired-token";
  process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID = "12345";
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: { message: "Invalid OAuth access token" } }),
    { status: 401 },
  );

  const status = await new WhatsAppService(".wa-test-session").verifyConnection(true);
  assert.equal(status.status, "error");
  assert.match(status.lastError || "", /Invalid OAuth access token/);
  assert.equal(status.connectedAt, undefined);
});
