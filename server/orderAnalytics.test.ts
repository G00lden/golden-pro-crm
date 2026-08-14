import assert from "node:assert/strict";
import test from "node:test";
import { deliverOrderAnalytics, sendGa4OrderEvent, type Ga4MeasurementConfig } from "./orderAnalytics";
import type { AnalyticsOrder } from "./orderAnalyticsPayload";

const sample: AnalyticsOrder = {
  eventType: "order.created",
  eventId: "evt-1",
  orderId: "1",
  orderNumber: "ORDER-1",
  status: "new",
  currency: "SAR",
  subtotal: 199,
  attribution: { clientId: "123.456" },
  items: [{ name: "Filter", sku: "BP-000392", quantity: 1, unitPrice: 199 }],
};

const configured: Ga4MeasurementConfig = {
  mode: "validate",
  measurementId: "G-TEST123456",
  apiSecret: "test-secret",
};

test("does not send when Measurement Protocol is disabled", async () => {
  let called = false;
  const result = await sendGa4OrderEvent(sample, { ...configured, mode: "disabled" }, async () => {
    called = true;
    return new Response(null, { status: 204 });
  });
  assert.equal(result.status, "disabled");
  assert.equal(called, false);
});

test("blocks attribution-poor payloads instead of inventing a client id", async () => {
  const result = await sendGa4OrderEvent({ ...sample, attribution: { gclid: "click-only" } }, configured);
  assert.equal(result.status, "blocked_missing_client_id");
});

test("uses the GA4 debug endpoint and strict validation in validate mode", async () => {
  let seenUrl = "";
  let seenBody: Record<string, unknown> = {};
  const result = await sendGa4OrderEvent(sample, configured, async (input, init) => {
    seenUrl = String(input);
    seenBody = JSON.parse(String(init?.body || "{}"));
    return new Response(JSON.stringify({ validationMessages: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  assert.equal(result.status, "validated");
  assert.match(seenUrl, /\/debug\/mp\/collect/);
  assert.equal(seenBody.validation_behavior, "ENFORCE_RECOMMENDATIONS");
});

test("surfaces strict validation messages without claiming delivery", async () => {
  const result = await sendGa4OrderEvent(sample, configured, async () => new Response(JSON.stringify({
    validationMessages: [{ fieldPath: "events", description: "bad", validationCode: "VALUE_INVALID" }],
  }), { status: 200, headers: { "content-type": "application/json" } }));
  assert.equal(result.status, "validation_failed");
  assert.equal(result.validation_messages?.length, 1);
});

function fakeOrderRef(initial: Record<string, unknown> = {}) {
  let record: Record<string, unknown> = {
    createdBy: "owner-a",
    analytics: {},
    analytics_reservation_token: null,
    analytics_reservation_key: null,
    analytics_reservation_at: null,
    ...initial,
  };
  return {
    get: async () => ({
      exists: true,
      data: () => structuredClone(record),
    }),
    compareAndSet: async (expected: Record<string, unknown>, patch: Record<string, unknown>) => {
      const matches = Object.entries(expected).every(([key, value]) => (
        value === null || value === undefined
          ? record[key] === null || record[key] === undefined
          : record[key] === value
      ));
      if (!matches) return false;
      record = { ...record, ...structuredClone(patch) };
      return true;
    },
    data: () => structuredClone(record),
  };
}

const collect: Ga4MeasurementConfig = { ...configured, mode: "collect" };

test("atomically permits only one concurrent purchase delivery", async () => {
  const ref = fakeOrderRef();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return new Response(null, { status: 204 });
  };
  const results = await Promise.all([
    deliverOrderAnalytics("owner-a", "order-1", sample, collect, fetchImpl, ref),
    deliverOrderAnalytics("owner-a", "order-1", sample, collect, fetchImpl, ref),
  ]);

  assert.equal(calls, 1);
  assert.deepEqual(results.map((result) => result.status).sort(), ["ignored", "sent"]);
  assert.equal((ref.data().analytics as any).purchase.status, "sent");
});

test("deduplicates a full refund across cancelled and refunded webhooks", async () => {
  const ref = fakeOrderRef();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(null, { status: 204 });
  };
  const cancelled = await deliverOrderAnalytics(
    "owner-a",
    "order-1",
    { ...sample, eventType: "order.cancelled", eventId: "cancel-1" },
    collect,
    fetchImpl,
    ref,
  );
  const refunded = await deliverOrderAnalytics(
    "owner-a",
    "order-1",
    { ...sample, eventType: "order.refunded", eventId: "refund-1" },
    collect,
    fetchImpl,
    ref,
  );

  assert.equal(cancelled.status, "sent");
  assert.equal(refunded.status, "ignored");
  assert.equal(calls, 1);
  assert.equal((ref.data().analytics as any).refund_full.status, "sent");
});

test("allows a validated event to be collected after mode switches to collect", async () => {
  const ref = fakeOrderRef();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return calls === 1
      ? new Response(JSON.stringify({ validationMessages: [] }), { status: 200 })
      : new Response(null, { status: 204 });
  };

  const validation = await deliverOrderAnalytics("owner-a", "order-1", sample, configured, fetchImpl, ref);
  const delivery = await deliverOrderAnalytics("owner-a", "order-1", sample, collect, fetchImpl, ref);
  assert.equal(validation.status, "validated");
  assert.equal(delivery.status, "sent");
  assert.equal(calls, 2);
});

test("fails closed after an ambiguous network delivery error", async () => {
  const ref = fakeOrderRef();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error("socket closed after upload");
  };
  const first = await deliverOrderAnalytics("owner-a", "order-1", sample, collect, fetchImpl, ref);
  const second = await deliverOrderAnalytics("owner-a", "order-1", sample, collect, fetchImpl, ref);
  assert.equal(first.status, "delivery_unknown");
  assert.equal(second.status, "ignored");
  assert.equal(calls, 1);
});
