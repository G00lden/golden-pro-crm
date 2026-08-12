import assert from "node:assert/strict";
import test from "node:test";
import { sendGa4OrderEvent, type Ga4MeasurementConfig } from "./orderAnalytics";
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
