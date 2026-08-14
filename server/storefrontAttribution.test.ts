import test from "node:test";
import assert from "node:assert/strict";
import {
  StorefrontAttributionError,
  normalizeStorefrontOrderAttribution,
  storefrontAttributionOriginAllowed,
} from "./storefrontAttribution";

test("accepts only an exact configured HTTPS storefront origin", () => {
  const env = { STORE_ATTRIBUTION_ALLOWED_ORIGINS: "https://goldenksa.store" } as NodeJS.ProcessEnv;
  assert.equal(storefrontAttributionOriginAllowed("https://goldenksa.store", env), true);
  assert.equal(storefrontAttributionOriginAllowed("https://goldenksa.store.evil.example", env), false);
  assert.equal(storefrontAttributionOriginAllowed("http://goldenksa.store", env), false);
});

test("normalizes a privacy-safe attribution payload without customer fields", () => {
  assert.deepEqual(normalizeStorefrontOrderAttribution(JSON.stringify({
    order_id: "123456789",
    checkout_id: "checkout-1",
    total: 199,
    currency: "sar",
    client_id: "123456789.987654321",
    session_id: "1712345678",
    gclid: "abcDEF_123456",
    utm_source: "google",
    customer_name: "must not be retained",
    payment_method: "must not be retained",
  })), {
    orderId: "123456789",
    checkoutId: "checkout-1",
    total: 199,
    currency: "SAR",
    attribution: {
      clientId: "123456789.987654321",
      sessionId: "1712345678",
      gclid: "abcDEF_123456",
      utmSource: "google",
    },
  });
});

test("fails closed without a consented GA client id", () => {
  assert.throws(
    () => normalizeStorefrontOrderAttribution({
      order_id: "123",
      total: 199,
      currency: "SAR",
      gclid: "abcDEF_123456",
    }),
    (error: unknown) => error instanceof StorefrontAttributionError && error.status === 422,
  );
});

test("fails closed when order value binding is absent or not SAR", () => {
  assert.throws(
    () => normalizeStorefrontOrderAttribution({
      order_id: "123",
      client_id: "123456789.987654321",
      currency: "SAR",
    }),
    (error: unknown) => error instanceof StorefrontAttributionError && error.status === 422,
  );
  assert.throws(
    () => normalizeStorefrontOrderAttribution({
      order_id: "123",
      total: 199,
      currency: "USD",
      client_id: "123456789.987654321",
    }),
    (error: unknown) => error instanceof StorefrontAttributionError && error.status === 422,
  );
});
