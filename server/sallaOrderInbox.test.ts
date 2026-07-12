import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.DATA_PROVIDER = "sqlite";
process.env.DB_PROVIDER = "sqlite";
process.env.DB_PATH = ":memory:";

const { processSallaOrderInbox, sallaOrderInboxIdentity, SALLA_ORDER_EVENTS } = await import("./sallaOrderInbox");
const { adminDb } = await import("./firebaseAdmin");

function input(raw = '{"event":"order.updated","created_at":"2026-07-13T00:00:00Z"}') {
  return {
    ownerUid: "owner-a",
    merchantId: "merchant-a",
    eventType: "order.updated",
    remoteOrderId: "100",
    rawBody: Buffer.from(raw),
    occurredAt: "2026-07-13T00:00:00Z",
  };
}

test("identical Salla retries resolve to one inbox identity", () => {
  assert.deepEqual(sallaOrderInboxIdentity(input()), sallaOrderInboxIdentity(input()));
});

test("a changed event payload receives a new inbox identity", () => {
  assert.notEqual(
    sallaOrderInboxIdentity(input()).id,
    sallaOrderInboxIdentity(input('{"event":"order.updated","created_at":"2026-07-13T00:01:00Z"}')).id,
  );
});

test("all order events enabled in Salla Partners are accepted", () => {
  for (const event of [
    "order.customer.updated",
    "order.shipment.return.creating",
    "order.shipment.return.created",
    "order.shipment.return.cancelled",
  ]) {
    assert.equal(SALLA_ORDER_EVENTS.has(event), true, `${event} must be handled`);
  }
});

test("a stale processing event is recovered and failure details stay private", async () => {
  const staleInput = input();
  const identity = sallaOrderInboxIdentity(staleInput);
  const ref = adminDb.collection("salla_order_inbox").doc(identity.id);
  await ref.set({
    ownerUid: staleInput.ownerUid,
    merchantId: staleInput.merchantId,
    eventType: staleInput.eventType,
    remoteOrderId: staleInput.remoteOrderId,
    payloadHash: identity.payloadHash,
    status: "processing",
    attempts: 1,
    receivedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    createdAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
  });

  const failure = Object.assign(new Error("private@example.test +966500000000"), { status: 422 });
  await assert.rejects(() => processSallaOrderInbox(staleInput, async () => {
    throw failure;
  }), /private@example/);
  const stored = (await ref.get()).data() as Record<string, unknown>;
  assert.equal(stored.status, "failed");
  assert.equal(String(stored.error).includes("private@example.test"), false);
  assert.equal(stored.error, "Error:422");
});
