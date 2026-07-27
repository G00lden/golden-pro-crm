import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.DATA_PROVIDER = "sqlite";
process.env.DB_PROVIDER = "sqlite";
process.env.DB_PATH = ":memory:";
process.env.SALLA_DELIVERY_REVIEW_ENABLED = "true";
process.env.SALLA_DELIVERY_REVIEW_DELAY_MINUTES = "0";
process.env.OUTBOUND_MODE = "allowlist";
process.env.OUTBOUND_TEST_PHONE_ALLOWLIST = "";
process.env.WHATSAPP_PROVIDER = "cloud_api";
process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID = "phone-id-test";
process.env.WHATSAPP_CLOUD_API_TOKEN = "token-test";
process.env.WHATSAPP_CLOUD_TEMPLATE_DELIVERY_REVIEW_REQUEST = "delivery_review_ar";
process.env.WHATSAPP_CLOUD_TEMPLATE_LANGUAGE = "ar";
delete process.env.OUTBOUND_CONFIRM_CODE;

const db = (await import("./db")).default;
const {
  deliveryReviewStore,
  isDeliveredSallaStatus,
  queueDeliveryReview,
} = await import("./deliveryReview");
const { processNextCommunicationJob } = await import("./communicationWorker");
const { communicationPreferenceStore } = await import("./communicationPreferences");
const { getWhatsAppCommerceSession } = await import("./whatsappCommerceStorage");
const { handleWhatsAppCommerceConversation } = await import("./whatsappCommerce");
const originalFetch = globalThis.fetch;

function queue(ownerUid: string, orderId: string, phone = "966501234567") {
  return queueDeliveryReview({
    ownerUid,
    orderId,
    orderNumber: `REF-${orderId}`,
    customerName: "عميل اختبار",
    customerPhone: phone,
    deliveredAt: new Date().toISOString(),
  });
}

function consent(ownerUid: string, phone: string) {
  communicationPreferenceStore.setPreference({
    ownerUid,
    phone,
    channel: "whatsapp",
    status: "granted",
    source: "store_checkout",
    evidence: "explicit checkbox",
  });
}

test.beforeEach(() => {
  globalThis.fetch = originalFetch;
  process.env.OUTBOUND_TEST_PHONE_ALLOWLIST = "";
  process.env.SALLA_DELIVERY_REVIEW_ENABLED = "true";
  for (const table of [
    "whatsapp_commerce_sessions",
    "crm_tasks",
    "delivery_review_requests",
    "communication_jobs",
    "communication_preferences",
    "communication_suppressions",
  ]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
});

test("only Salla's exact delivered slug is a delivery trigger", () => {
  assert.equal(isDeliveredSallaStatus("delivered"), true);
  assert.equal(isDeliveredSallaStatus("completed"), false);
  assert.equal(isDeliveredSallaStatus("in_progress"), false);
});

test("delivery review is queued once per order and fails closed without WhatsApp consent", async () => {
  const ownerUid = "delivery-consent-owner";
  assert.equal(queue(ownerUid, "1001").queued, true);
  queue(ownerUid, "1001");
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM communication_jobs WHERE owner_uid = ?")
      .get(ownerUid) as { count: number }).count,
    1,
  );

  const processed = await processNextCommunicationJob();
  assert.equal(processed?.status, "blocked");
  assert.equal(processed?.last_error, "salla_delivery_review_consent_missing");
  assert.equal(
    deliveryReviewStore.get(ownerUid, "1001")?.status,
    "salla_delivery_review_consent_missing",
  );
});

test("consented allowlisted delivery sends the approved template and opens a rating session", async () => {
  const ownerUid = "delivery-sent-owner";
  const phone = "966501234567";
  process.env.OUTBOUND_TEST_PHONE_ALLOWLIST = phone;
  consent(ownerUid, phone);
  queue(ownerUid, "1002", phone);

  let sends = 0;
  globalThis.fetch = (async (_input, init) => {
    sends += 1;
    const payload = JSON.parse(String(init?.body || "{}")) as Record<string, any>;
    assert.equal(payload.type, "template");
    assert.equal(payload.template.name, "delivery_review_ar");
    assert.equal(payload.template.components[0].parameters.length, 2);
    return new Response(JSON.stringify({ messages: [{ id: "wamid.delivery-1002" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const processed = await processNextCommunicationJob();
  assert.equal(processed?.status, "sent");
  assert.equal(sends, 1);
  assert.equal(deliveryReviewStore.get(ownerUid, "1002")?.status, "sent");
  const session = getWhatsAppCommerceSession(db, ownerUid, phone);
  assert.equal(session?.step, "awaiting_delivery_rating");
  assert.equal(
    (session?.context.deliveryReview as { orderId?: string })?.orderId,
    "1002",
  );
});

test("a positive rating completes the review without creating an escalation task", async () => {
  const ownerUid = "delivery-positive-owner";
  const phone = "966501234568";
  process.env.OUTBOUND_TEST_PHONE_ALLOWLIST = phone;
  consent(ownerUid, phone);
  queue(ownerUid, "1003", phone);
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ messages: [{ id: "wamid.delivery-1003" }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  )) as typeof fetch;
  await processNextCommunicationJob();

  const result = await handleWhatsAppCommerceConversation({
    ownerUid,
    fromPhone: phone,
    text: "5",
  });
  assert.equal(result.kind, "delivery_rating_submitted");
  assert.equal(deliveryReviewStore.get(ownerUid, "1003")?.rating, 5);
  assert.equal(deliveryReviewStore.get(ownerUid, "1003")?.status, "submitted");
  assert.equal(getWhatsAppCommerceSession(db, ownerUid, phone), null);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM crm_tasks WHERE owner_uid = ?")
      .get(ownerUid) as { count: number }).count,
    0,
  );
});

test("a low rating creates an urgent CRM task and stores the customer's feedback", async () => {
  const ownerUid = "delivery-low-owner";
  const phone = "966501234569";
  process.env.OUTBOUND_TEST_PHONE_ALLOWLIST = phone;
  consent(ownerUid, phone);
  queue(ownerUid, "1004", phone);
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ messages: [{ id: "wamid.delivery-1004" }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  )) as typeof fetch;
  await processNextCommunicationJob();

  const rating = await handleWhatsAppCommerceConversation({
    ownerUid,
    fromPhone: phone,
    text: "2",
  });
  assert.equal(rating.kind, "delivery_rating_low");
  assert.equal(getWhatsAppCommerceSession(db, ownerUid, phone)?.step, "awaiting_delivery_feedback");
  const taskAfterRating = db.prepare(
    `SELECT id, priority, related_type FROM crm_tasks
      WHERE owner_uid = ? AND related_id = ?`,
  ).get(ownerUid, "1004") as Record<string, unknown>;
  assert.equal(taskAfterRating.priority, "high");
  assert.equal(taskAfterRating.related_type, "salla_delivery_review");

  const feedback = await handleWhatsAppCommerceConversation({
    ownerUid,
    fromPhone: phone,
    text: "التوصيل تأخر والمنتج وصل متضررًا",
  });
  assert.equal(feedback.kind, "delivery_feedback_escalated");
  const review = deliveryReviewStore.get(ownerUid, "1004");
  assert.equal(review?.status, "escalated");
  assert.match(String(review?.feedback), /التوصيل تأخر/);
  const task = db.prepare("SELECT notes FROM crm_tasks WHERE id = ?")
    .get(taskAfterRating.id) as { notes: string };
  assert.match(task.notes, /المنتج وصل متضررًا/);
  assert.equal(getWhatsAppCommerceSession(db, ownerUid, phone), null);
});
