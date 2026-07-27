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

test("Cloud API media campaigns send the approved header and three template buttons", async (t) => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  t.after(() => {
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
  });

  const phone = "966501234567";
  process.env.WHATSAPP_PROVIDER = "cloud_api";
  process.env.WHATSAPP_CLOUD_API_TOKEN = "test-token";
  process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID = "12345";
  process.env.WHATSAPP_CLOUD_TEMPLATE_CAMPAIGN_OFFER_IMAGE = "campaign_offer_image_ar";
  process.env.OUTBOUND_MODE = "allowlist";
  process.env.OUTBOUND_TEST_PHONE_ALLOWLIST = phone;
  let payload: Record<string, any> | null = null;
  globalThis.fetch = (async (_input, init) => {
    payload = JSON.parse(String(init?.body || "{}"));
    return new Response(JSON.stringify({ messages: [{ id: "wamid.media-campaign" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const service = new WhatsAppService(".wa-test-session");
  const result = await service.sendTemplate(
    phone,
    "campaign_offer_image",
    { customer_name: "محمد", offer_text: "عرض خاص" },
    {
      templateOptions: {
        header: { type: "image", link: "https://cdn.example.test/offer.jpg" },
        buttons: [
          { type: "url", index: 0, text: "products/filter" },
          { type: "quick_reply", index: 1, payload: "campaign:change_filters:camp_1" },
          { type: "quick_reply", index: 2, payload: "campaign:book_appointment:camp_1" },
        ],
      },
    },
  );

  assert.equal(result.messageId, "wamid.media-campaign");
  assert.equal(payload?.template.name, "campaign_offer_image_ar");
  assert.deepEqual(payload?.template.components, [
    {
      type: "header",
      parameters: [{ type: "image", image: { link: "https://cdn.example.test/offer.jpg" } }],
    },
    {
      type: "body",
      parameters: [
        { type: "text", text: "محمد" },
        { type: "text", text: "عرض خاص" },
      ],
    },
    {
      type: "button",
      sub_type: "url",
      index: "0",
      parameters: [{ type: "text", text: "products/filter" }],
    },
    {
      type: "button",
      sub_type: "quick_reply",
      index: "1",
      parameters: [{ type: "payload", payload: "campaign:change_filters:camp_1" }],
    },
    {
      type: "button",
      sub_type: "quick_reply",
      index: "2",
      parameters: [{ type: "payload", payload: "campaign:book_appointment:camp_1" }],
    },
  ]);
});
