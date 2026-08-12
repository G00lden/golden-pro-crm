import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGa4CommerceEvent,
  buildGa4MeasurementBody,
  buildGoogleAdsMatchRecord,
  classifyGa4CommerceEvent,
  commerceValue,
  type AnalyticsOrder,
} from "./orderAnalyticsPayload";

function order(overrides: Partial<AnalyticsOrder> = {}): AnalyticsOrder {
  return {
    eventType: "order.created",
    eventId: "evt-1",
    orderId: "123",
    orderNumber: "ORD-123",
    status: "جاري التجهيز",
    paymentStatus: "paid",
    paymentTypeGroup: "Mada",
    currency: "SAR",
    total: 224,
    subtotal: 199,
    shipping: 25,
    tax: 0,
    coupon: "INV90",
    attribution: {
      clientId: "123456789.987654321",
      sessionId: "1723456789",
      gclid: "test-click-id",
    },
    items: [{
      name: "حزمة تبديل فلاتر",
      sku: "BP-000392",
      quantity: 1,
      unitPrice: 199,
      totalPrice: 199,
      currency: "SAR",
      variant: "قطعة واحدة",
      sallaProductId: "2137390305",
    }],
    ...overrides,
  };
}

test("builds a privacy-safe GA4 purchase with SKU and Salla product id", () => {
  const built = buildGa4CommerceEvent(order());
  assert.equal(built?.name, "purchase");
  assert.equal(built?.params.transaction_id, "ORD-123");
  assert.equal(built?.params.value, 199);
  assert.equal(built?.params.payment_type_group, "Mada");
  const [item] = built?.params.items as Array<Record<string, unknown>>;
  assert.equal(item.item_id, "BP-000392");
  assert.equal(item.salla_product_id, "2137390305");
  assert.equal("customer_name" in built!.params, false);
  assert.equal("payment_method" in built!.params, false);
  assert.equal(JSON.stringify(built).includes("test-click-id"), false);
});

test("requires the browser client id before creating a Measurement Protocol body", () => {
  assert.equal(buildGa4MeasurementBody(order({ attribution: { gclid: "click-only" } })), null);
  const body = buildGa4MeasurementBody(order());
  assert.equal(body?.client_id, "123456789.987654321");
  assert.equal(body?.events.length, 1);
});

test("deduces merchandise value without shipping and tax", () => {
  assert.equal(commerceValue(order({ subtotal: undefined, items: [], total: 224, shipping: 20, tax: 5 })), 199);
});

test("maps cancellations and refunds to refund but ignores failed purchases", () => {
  assert.equal(classifyGa4CommerceEvent(order({ eventType: "order.cancelled" })), "refund");
  assert.equal(classifyGa4CommerceEvent(order({ eventType: "order.refunded" })), "refund");
  assert.equal(classifyGa4CommerceEvent(order({ paymentStatus: "failed" })), null);
  assert.equal(classifyGa4CommerceEvent(order({ eventType: "order.updated", paymentStatus: "paid" })), "purchase");
});

test("builds a private Ads matching record only when a click id exists", () => {
  const match = buildGoogleAdsMatchRecord(order());
  assert.equal(match?.status, "pending_configuration");
  assert.equal(match?.click_id_type, "gclid");
  assert.equal(match?.transaction_id, "ORD-123");
  assert.equal(buildGoogleAdsMatchRecord(order({ attribution: { clientId: "1.2" } })), null);
});
