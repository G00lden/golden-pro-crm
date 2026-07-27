import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.DATA_PROVIDER = "sqlite";
process.env.DB_PROVIDER = "sqlite";
process.env.DB_PATH = ":memory:";
process.env.SALLA_CART_WHATSAPP_DELAY_MINUTES = "0";
process.env.OUTBOUND_MODE = "allowlist";
process.env.OUTBOUND_TEST_PHONE_ALLOWLIST = "";
process.env.WHATSAPP_PROVIDER = "cloud_api";
process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID = "phone-id-test";
process.env.WHATSAPP_CLOUD_API_TOKEN = "token-test";
process.env.WHATSAPP_CLOUD_TEMPLATE_ABANDONED_CART_SUPPORT = "cart_support_ar";
process.env.WHATSAPP_CLOUD_TEMPLATE_LANGUAGE = "ar";
delete process.env.OUTBOUND_CONFIRM_CODE;

const db = (await import("./db")).default;
const { ingestSallaCartEvent, sallaCartConciergeStore } = await import("./sallaCartConcierge");
const { processNextCommunicationJob } = await import("./communicationWorker");
const { communicationPreferenceStore } = await import("./communicationPreferences");
const { getWhatsAppCommerceSession } = await import("./whatsappCommerceStorage");
const originalFetch = globalThis.fetch;

function abandonedPayload(cartId: string, phone = "0501234567") {
  return {
    id: cartId,
    checkout_url: `https://store.example/checkout/${cartId}`,
    customer: { name: "عميل اختبار", mobile: phone },
    items: [{ id: `line-${cartId}`, product_id: `product-${cartId}`, quantity: 1, price: 100 }],
    total: { amount: 100, currency: "SAR" },
  };
}

test.beforeEach(() => {
  globalThis.fetch = originalFetch;
  process.env.OUTBOUND_TEST_PHONE_ALLOWLIST = "";
  process.env.SALLA_CART_WHATSAPP_DELAY_MINUTES = "0";
  for (const table of [
    "communication_jobs",
    "communication_preferences",
    "communication_suppressions",
    "salla_abandoned_carts",
  ]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
});

test("abandoned-cart outreach fails closed when explicit WhatsApp consent is missing", async () => {
  const ownerUid = "cart-consent-owner";
  const queued = ingestSallaCartEvent({
    ownerUid,
    merchantId: "merchant-1",
    event: "abandoned.cart",
    payload: abandonedPayload("cart-consent-1"),
    eventAt: new Date().toISOString(),
  });
  assert.equal(queued.queued, true);

  const processed = await processNextCommunicationJob();
  assert.equal(processed?.status, "blocked");
  assert.equal(processed?.last_error, "salla_cart_consent_missing");
  assert.equal(
    sallaCartConciergeStore.get(ownerUid, "cart-consent-1")?.outreach_status,
    "salla_cart_consent_missing",
  );
});

test("a purchase event blocks a delayed cart message before the worker can claim it", async () => {
  const ownerUid = "cart-purchased-owner";
  process.env.SALLA_CART_WHATSAPP_DELAY_MINUTES = "60";
  const queued = ingestSallaCartEvent({
    ownerUid,
    event: "abandoned.cart",
    payload: abandonedPayload("cart-purchased-1"),
  });
  assert.equal(queued.queued, true);

  ingestSallaCartEvent({
    ownerUid,
    event: "abandoned.cart.purchased",
    payload: { id: "cart-purchased-1", status: "purchased" },
  });
  assert.equal(await processNextCommunicationJob(), null);
  const job = db.prepare(
    "SELECT status, last_error FROM communication_jobs WHERE owner_uid = ?",
  ).get(ownerUid) as { status: string; last_error: string };
  assert.deepEqual(job, {
    status: "blocked",
    last_error: "salla_cart_purchased",
  });
  assert.equal(sallaCartConciergeStore.get(ownerUid, "cart-purchased-1")?.status, "purchased");
  process.env.SALLA_CART_WHATSAPP_DELAY_MINUTES = "0";
});

test("an out-of-order abandoned event cannot resurrect a cart whose purchase arrived first", () => {
  const ownerUid = "cart-out-of-order-owner";
  ingestSallaCartEvent({
    ownerUid,
    event: "abandoned.cart.purchased",
    payload: { id: "cart-out-of-order-1", status: "purchased" },
    eventAt: "2026-07-27T10:10:00.000Z",
  });
  const lateAbandoned = ingestSallaCartEvent({
    ownerUid,
    event: "abandoned.cart",
    payload: abandonedPayload("cart-out-of-order-1"),
    eventAt: "2026-07-27T10:00:00.000Z",
  });
  assert.equal(lateAbandoned.queued, false);
  assert.equal(lateAbandoned.reason, "cart_purchased");
  assert.equal(sallaCartConciergeStore.get(ownerUid, "cart-out-of-order-1")?.status, "purchased");
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM communication_jobs WHERE owner_uid = ?").get(ownerUid) as { count: number }).count,
    0,
  );
});

test("a consented allowlisted cart sends the approved template once and opens the product-question session", async () => {
  const ownerUid = "cart-sent-owner";
  const phone = "966501234567";
  process.env.OUTBOUND_TEST_PHONE_ALLOWLIST = phone;
  communicationPreferenceStore.setPreference({
    ownerUid,
    phone,
    channel: "whatsapp",
    status: "granted",
    source: "store_checkout",
    evidence: "explicit checkbox",
  });
  ingestSallaCartEvent({
    ownerUid,
    event: "abandoned.cart",
    payload: abandonedPayload("cart-sent-1", phone),
  });

  let sends = 0;
  globalThis.fetch = (async (_input, init) => {
    sends += 1;
    const payload = JSON.parse(String(init?.body || "{}")) as Record<string, any>;
    assert.equal(payload.type, "template");
    assert.equal(payload.template.name, "cart_support_ar");
    assert.equal(payload.template.components[0].parameters.length, 3);
    return new Response(JSON.stringify({ messages: [{ id: "wamid.cart-sent-1" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const processed = await processNextCommunicationJob();
  assert.equal(processed?.status, "sent");
  assert.equal(sends, 1);
  assert.equal(sallaCartConciergeStore.get(ownerUid, "cart-sent-1")?.outreach_status, "sent");
  const session = getWhatsAppCommerceSession(db, ownerUid, phone);
  assert.equal(session?.step, "awaiting_cart_question");
  assert.equal((session?.context.cart as { cartId?: string })?.cartId, "cart-sent-1");
});
