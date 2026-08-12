import assert from "node:assert/strict";
import test from "node:test";
import { normalizeStorePayload } from "./storeWebhook";

test("normalizes private payment, attribution and SKU fields from a Salla order", () => {
  const body = {
    event: "order.created",
    event_id: "event-123",
    data: {
      id: 123,
      reference_id: "ORD-123",
      status: { name: "جاري التجهيز" },
      payment_status: "paid",
      payment_method: { name: "مدى" },
      customer: { name: "Private Customer", mobile_code: "+966", mobile: "500000000" },
      amounts: {
        total: { amount: 224, currency: "SAR" },
        sub_total: { amount: 199, currency: "SAR" },
        shipping_cost: { amount: 25, currency: "SAR" },
        tax: { amount: 0, currency: "SAR" },
      },
      metadata: {
        ga_client_id: "123456789.987654321",
        ga_session_id: "1723456789",
        gclid: "test-click-id",
        utm_campaign: "SA_INV90_Search_Ship_Exact_202608",
      },
      items: [{
        name: "Filter kit",
        sku: "BP-000392",
        quantity: 1,
        price: { amount: 199, currency: "SAR" },
        total: { amount: 199, currency: "SAR" },
        product: { id: "2137390305" },
        variant: { name: "One unit" },
      }],
    },
  };
  const req = {
    body,
    get(name: string) {
      if (name.toLowerCase() === "x-store-provider") return "salla";
      return undefined;
    },
  } as any;

  const normalized = normalizeStorePayload(req, Buffer.from(JSON.stringify(body)));
  assert.equal(normalized.orderNumber, "ORD-123");
  assert.equal(normalized.customerName, "Private Customer");
  assert.equal(normalized.paymentMethodRaw, "مدى");
  assert.equal(normalized.paymentTypeGroup, "Mada");
  assert.equal(normalized.subtotal, 199);
  assert.equal(normalized.shipping, 25);
  assert.equal(normalized.attribution?.clientId, "123456789.987654321");
  assert.equal(normalized.attribution?.gclid, "test-click-id");
  assert.equal(normalized.items[0].sku, "BP-000392");
  assert.equal(normalized.items[0].sallaProductId, "2137390305");
  assert.equal(normalized.items[0].variant, "One unit");
});
