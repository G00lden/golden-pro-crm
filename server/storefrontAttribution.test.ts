import test from "node:test";
import assert from "node:assert/strict";
import {
  StorefrontAttributionError,
  normalizeStorefrontAttributionClaim,
  normalizeStorefrontOrderAttribution,
  storefrontAttributionOriginAllowed,
} from "./storefrontAttribution";

test("accepts only an exact configured HTTPS storefront origin", () => {
  const env = { STORE_ATTRIBUTION_ALLOWED_ORIGINS: "https://goldenksa.store" } as NodeJS.ProcessEnv;
  assert.equal(storefrontAttributionOriginAllowed("https://goldenksa.store", env), true);
  assert.equal(storefrontAttributionOriginAllowed("https://goldenksa.store.evil.example", env), false);
  assert.equal(storefrontAttributionOriginAllowed("http://goldenksa.store", env), false);
});

test("normalizes a privacy-safe signed checkout claim without customer fields", () => {
  assert.deepEqual(normalizeStorefrontAttributionClaim(JSON.stringify({
    checkout_id: "checkout-1",
    claim_nonce: "0123456789abcdefghijklmnop",
    client_id: "123456789.987654321",
    session_id: "1712345678",
    gclid: "abcDEF_123456",
    utm_source: "google",
    customer_name: "must not be retained",
    payment_method: "must not be retained",
  })), {
    checkoutId: "checkout-1",
    claimNonce: "0123456789abcdefghijklmnop",
    attribution: {
      clientId: "123456789.987654321",
      sessionId: "1712345678",
      gclid: "abcDEF_123456",
      utmSource: "google",
    },
  });
});

test("normalizes order completion only when a signed claim token is present", () => {
  assert.deepEqual(normalizeStorefrontOrderAttribution({
    order_id: "123456789",
    checkout_id: "checkout-1",
    claim_token: "signedPayload.signedValue",
    total: 199,
    currency: "sar",
    client_id: "must-not-be-accepted-from-this-request",
  }), {
    orderId: "123456789",
    checkoutId: "checkout-1",
    claimToken: "signedPayload.signedValue",
    total: 199,
    currency: "SAR",
  });
});

test("fails closed without a consented GA client id or strong claim nonce", () => {
  assert.throws(
    () => normalizeStorefrontAttributionClaim({
      checkout_id: "checkout-1",
      claim_nonce: "0123456789abcdefghijklmnop",
      gclid: "abcDEF_123456",
    }),
    (error: unknown) => error instanceof StorefrontAttributionError && error.status === 422,
  );
  assert.throws(
    () => normalizeStorefrontAttributionClaim({
      checkout_id: "checkout-1",
      claim_nonce: "weak",
      client_id: "123456789.987654321",
    }),
    (error: unknown) => error instanceof StorefrontAttributionError && error.status === 422,
  );
});

test("fails closed when order value binding is absent or not SAR", () => {
  assert.throws(
    () => normalizeStorefrontOrderAttribution({
      order_id: "123",
      checkout_id: "checkout-1",
      claim_token: "signedPayload.signedValue",
      client_id: "123456789.987654321",
      currency: "SAR",
    }),
    (error: unknown) => error instanceof StorefrontAttributionError && error.status === 422,
  );
  assert.throws(
    () => normalizeStorefrontOrderAttribution({
      order_id: "123",
      checkout_id: "checkout-1",
      claim_token: "signedPayload.signedValue",
      total: 199,
      currency: "USD",
      client_id: "123456789.987654321",
    }),
    (error: unknown) => error instanceof StorefrontAttributionError && error.status === 422,
  );
});
