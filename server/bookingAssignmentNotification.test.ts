import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.DATA_PROVIDER = "sqlite";
process.env.DB_PROVIDER = "sqlite";
process.env.DB_PATH = ":memory:";
process.env.WHATSAPP_BOOKING_TECHNICIAN_NOTIFY_ENABLED = "true";
process.env.OUTBOUND_MODE = "allowlist";
process.env.OUTBOUND_TEST_PHONE_ALLOWLIST = "966511111111";
process.env.WHATSAPP_PROVIDER = "cloud_api";
process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID = "phone-id-test";
process.env.WHATSAPP_CLOUD_API_TOKEN = "token-test";
process.env.WHATSAPP_CLOUD_TEMPLATE_TECHNICIAN_ASSIGNED = "technician_assigned_ar";
process.env.WHATSAPP_CLOUD_TEMPLATE_LANGUAGE = "ar";
delete process.env.OUTBOUND_CONFIRM_CODE;

const db = (await import("./db")).default;
const { queueBookingAssignmentNotification } = await import("./bookingAssignmentNotification");
const { processNextCommunicationJob } = await import("./communicationWorker");
const originalFetch = globalThis.fetch;

function assignment(technicianPhone = "0511111111") {
  return {
    ownerUid: "booking-notify-owner",
    bookingId: "booking-notify-1",
    technicianId: "tech-notify-1",
    technicianName: "الفني أحمد",
    technicianPhone,
    customerId: "customer-notify-1",
    customerName: "عميل الحجز",
    customerPhone: "0500000001",
    customerAddress: "الرياض، حي الياسمين، شارع أنس",
    productId: "product-notify-1",
    productName: "تركيب فلتر",
    date: "2026-07-28",
    scheduledTime: "14:00",
    createdAt: "2026-07-27T09:00:00.000Z",
  };
}

test.beforeEach(() => {
  globalThis.fetch = originalFetch;
  process.env.WHATSAPP_BOOKING_TECHNICIAN_NOTIFY_ENABLED = "true";
  process.env.OUTBOUND_TEST_PHONE_ALLOWLIST = "966511111111";
  for (const table of [
    "crm_tasks",
    "technician_notifications",
    "communication_jobs",
  ]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
});

test("a booking queues one approved technician template and records confirmed delivery", async () => {
  const first = queueBookingAssignmentNotification(assignment());
  const duplicate = queueBookingAssignmentNotification(assignment());
  assert.equal(first.queued, true);
  assert.equal(duplicate.job?.id, first.job?.id);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM communication_jobs").get() as { count: number }).count,
    1,
  );

  let sends = 0;
  globalThis.fetch = (async (_input, init) => {
    sends += 1;
    const payload = JSON.parse(String(init?.body || "{}")) as Record<string, any>;
    assert.equal(payload.type, "template");
    assert.equal(payload.to, "966511111111");
    assert.equal(payload.template.name, "technician_assigned_ar");
    assert.equal(payload.template.components[0].parameters.length, 8);
    return new Response(JSON.stringify({ messages: [{ id: "wamid.tech-booking-1" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const processed = await processNextCommunicationJob();
  assert.equal(processed?.status, "sent");
  assert.equal(sends, 1);
  const notification = db.prepare(
    "SELECT status, whatsapp_message_id FROM technician_notifications WHERE booking_id = ?",
  ).get("booking-notify-1") as Record<string, unknown>;
  assert.equal(notification.status, "sent");
  assert.equal(notification.whatsapp_message_id, "wamid.tech-booking-1");
});

test("a missing technician phone keeps the booking follow-up visible as an urgent CRM task", () => {
  const result = queueBookingAssignmentNotification(assignment(""));
  assert.equal(result.queued, false);
  assert.equal(result.reason, "invalid_technician_phone");
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM communication_jobs").get() as { count: number }).count,
    0,
  );
  const notification = db.prepare(
    "SELECT status, error FROM technician_notifications WHERE booking_id = ?",
  ).get("booking-notify-1") as Record<string, unknown>;
  assert.equal(notification.status, "invalid_phone");
  assert.equal(notification.error, "invalid_technician_phone");
  const task = db.prepare(
    "SELECT priority, related_type, related_id FROM crm_tasks WHERE owner_uid = ?",
  ).get("booking-notify-owner") as Record<string, unknown>;
  assert.equal(task.priority, "high");
  assert.equal(task.related_type, "booking_notification");
  assert.equal(task.related_id, "booking-notify-1");
});
