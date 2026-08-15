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
    analytics_reservation_mode: null,
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
  assert.deepEqual(results.map((result) => result.status).sort(), ["retry_pending", "sent"]);
  assert.equal((ref.data().analytics as any).purchase.status, "sent");
});

test("keeps a refund retryable while a purchase lease is active", async () => {
  const ref = fakeOrderRef();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    await blocked;
    return new Response(null, { status: 204 });
  };
  const purchase = deliverOrderAnalytics("owner-a", "order-1", sample, collect, fetchImpl, ref);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const refund = await deliverOrderAnalytics(
    "owner-a",
    "order-1",
    { ...sample, eventType: "order.refunded", eventId: "refund-concurrent" },
    collect,
    fetchImpl,
    ref,
  );
  assert.equal(refund.status, "retry_pending");
  release();
  assert.equal((await purchase).status, "sent");
  assert.equal(calls, 1);
});

test("marks a stale collect lease ambiguous and never resends it automatically", async () => {
  const ref = fakeOrderRef({
    analytics_reservation_token: "abandoned-token",
    analytics_reservation_key: "purchase",
    analytics_reservation_at: "2020-01-01T00:00:00.000Z",
    analytics_reservation_mode: "collect",
  });
  let calls = 0;
  const result = await deliverOrderAnalytics("owner-a", "order-1", sample, collect, async () => {
    calls += 1;
    return new Response(null, { status: 204 });
  }, ref);
  assert.equal(result.status, "delivery_unknown");
  assert.equal(result.manual_reconciliation_required, true);
  assert.equal(calls, 0);
  assert.equal(ref.data().analytics_reservation_token, null);
  assert.equal(ref.data().analytics_delivery_reconciliation_required, true);
  assert.equal((ref.data().analytics as any).purchase.status, "delivery_unknown");
});

test("can reclaim a stale validate lease because it cannot record a production conversion", async () => {
  const ref = fakeOrderRef({
    analytics_reservation_token: "abandoned-validation-token",
    analytics_reservation_key: "purchase",
    analytics_reservation_at: "2020-01-01T00:00:00.000Z",
    analytics_reservation_mode: "validate",
  });
  let calls = 0;
  const result = await deliverOrderAnalytics("owner-a", "order-1", sample, configured, async () => {
    calls += 1;
    return new Response(JSON.stringify({ validationMessages: [] }), { status: 200 });
  }, ref);
  assert.equal(result.status, "validated");
  assert.equal(calls, 1);
  assert.equal(ref.data().analytics_reservation_token, null);
});

test("marks a stale purchase ambiguous before delivering a different refund event", async () => {
  const ref = fakeOrderRef({
    analytics_reservation_token: "abandoned-purchase-token",
    analytics_reservation_key: "purchase",
    analytics_reservation_at: "2020-01-01T00:00:00.000Z",
    analytics_reservation_mode: "collect",
  });
  let calls = 0;
  const result = await deliverOrderAnalytics(
    "owner-a",
    "order-1",
    { ...sample, eventType: "order.refunded", eventId: "refund-after-stale-purchase" },
    collect,
    async () => {
      calls += 1;
      return new Response(null, { status: 204 });
    },
    ref,
  );
  assert.equal(result.status, "sent");
  assert.equal(calls, 1);
  assert.equal((ref.data().analytics as any).purchase.status, "delivery_unknown");
  assert.equal((ref.data().analytics as any).refund_full.status, "sent");
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

test("does not let an ambiguous validate request suppress later collect delivery", async () => {
  const ref = fakeOrderRef();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) throw new Error("debug endpoint connection reset");
    return new Response(null, { status: 204 });
  };
  const validation = await deliverOrderAnalytics("owner-a", "order-1", sample, configured, fetchImpl, ref);
  const delivery = await deliverOrderAnalytics("owner-a", "order-1", sample, collect, fetchImpl, ref);
  assert.equal(validation.status, "delivery_unknown");
  assert.equal(delivery.status, "sent");
  assert.equal(calls, 2);
  assert.equal((ref.data().analytics as any).purchase.mode, "collect");
});
