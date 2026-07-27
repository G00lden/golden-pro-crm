import assert from "node:assert/strict";
import test from "node:test";
import { WhatsAppService } from "./whatsapp";
import { CAMPAIGN_OFFER_BUTTONS } from "./whatsappCampaignOffer";

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
  process.env.WHATSAPP_CLOUD_WABA_ID = "67890";
  process.env.WHATSAPP_CLOUD_TEMPLATE_CAMPAIGN_OFFER_IMAGE = "campaign_offer_image_ar";
  process.env.WHATSAPP_CAMPAIGN_ORDER_URL_PREFIX = "https://goldenksa.store/";
  process.env.OUTBOUND_MODE = "allowlist";
  process.env.OUTBOUND_TEST_PHONE_ALLOWLIST = phone;
  let payload: Record<string, any> | null = null;
  let approvalChecks = 0;
  globalThis.fetch = (async (input, init) => {
    if (String(input).includes("/message_templates?")) {
      approvalChecks += 1;
      return new Response(JSON.stringify({
        data: [{
          name: "campaign_offer_image_ar",
          status: "APPROVED",
          language: "ar",
          components: [
            { type: "HEADER", format: "IMAGE" },
            { type: "BODY", text: "مرحبًا {{1}}\n{{2}}" },
            {
              type: "BUTTONS",
              buttons: [
                {
                  type: "URL",
                  text: CAMPAIGN_OFFER_BUTTONS[0].title,
                  url: "https://goldenksa.store/{{1}}",
                },
                { type: "QUICK_REPLY", text: CAMPAIGN_OFFER_BUTTONS[1].title },
                { type: "QUICK_REPLY", text: CAMPAIGN_OFFER_BUTTONS[2].title },
              ],
            },
          ],
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
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
  assert.equal(approvalChecks, 1);
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

test("a non-approved Meta campaign template blocks the send before the message POST", async (t) => {
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
  process.env.WHATSAPP_CLOUD_WABA_ID = "67890";
  process.env.WHATSAPP_CLOUD_TEMPLATE_CAMPAIGN_OFFER_IMAGE = "campaign_offer_image_ar";
  process.env.WHATSAPP_CAMPAIGN_ORDER_URL_PREFIX = "https://goldenksa.store/";
  process.env.OUTBOUND_MODE = "allowlist";
  process.env.OUTBOUND_TEST_PHONE_ALLOWLIST = phone;
  let postCount = 0;
  globalThis.fetch = (async (_input, init) => {
    if (init?.method === "POST") postCount += 1;
    return new Response(JSON.stringify({
      data: [{
        name: "campaign_offer_image_ar",
        status: "PENDING",
        language: "ar",
        components: [],
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  await assert.rejects(
    new WhatsAppService(".wa-test-session").sendTemplate(
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
    ),
    /not APPROVED/,
  );
  assert.equal(postCount, 0);
});

test("an ambiguous Cloud API network outcome is marked non-retryable", async (t) => {
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
  process.env.OUTBOUND_MODE = "allowlist";
  process.env.OUTBOUND_TEST_PHONE_ALLOWLIST = phone;
  globalThis.fetch = (async () => {
    throw new TypeError("simulated connection reset");
  }) as typeof fetch;

  await assert.rejects(
    new WhatsAppService(".wa-test-session").sendText(phone, "test"),
    (error: unknown) => {
      assert.equal((error as Error).name, "AmbiguousWhatsAppSendError");
      assert.match((error as Error).message, /automatic retry is blocked/);
      return true;
    },
  );
});
