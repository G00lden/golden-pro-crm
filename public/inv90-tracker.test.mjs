import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("extracts a GA4 GS2 session id from the current cookie format", async () => {
  const source = await readFile(new URL("./inv90-tracker.js", import.meta.url), "utf8");
  const storage = new Map();
  let tracker;
  let posted;
  let claimed;
  const window = {
    location: { search: "?gclid=click-1" },
    sessionStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    crypto: { getRandomValues: (bytes) => bytes.fill(7) },
    fetch: async (url, init) => {
      if (String(url).endsWith("/attribution-claim")) {
        claimed = JSON.parse(String(init.body));
        return new Response(JSON.stringify({
          claim_token: "signedPayload.signedValue",
          expires_at: new Date(Date.now() + 300_000).toISOString(),
        }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      posted = JSON.parse(String(init.body));
      return new Response(null, { status: 204 });
    },
    setTimeout,
    clearInterval,
    setInterval,
    Salla: {
      onReady: (callback) => callback(),
      analytics: { registerTracker: (value) => { tracker = value; } },
    },
  };
  vm.runInNewContext(source, {
    window,
    document: { cookie: "_ga=GA1.1.123456789.987654321; _ga_TEST=GS2.1.s1723456789$o1$g1$t1723456790" },
    URLSearchParams,
    Response,
    Number,
    JSON,
    decodeURIComponent,
  });

  tracker.track("Checkout Step Viewed", { checkout_id: "checkout-123", step: 1 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  tracker.track("Order Completed", { order_id: "SALLA-1", checkout_id: "checkout-123", total: 199, currency: "SAR" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(claimed.client_id, "123456789.987654321");
  assert.equal(claimed.session_id, "1723456789");
  assert.equal(claimed.gclid, "click-1");
  assert.equal(claimed.claim_nonce.length, 48);
  assert.equal(posted.claim_token, "signedPayload.signedValue");
  assert.equal(posted.checkout_id, "checkout-123");
  assert.equal(posted.client_id, undefined);
});

test("retries order attribution when the signed Salla webhook has not closed the claim yet", async () => {
  const source = await readFile(new URL("./inv90-tracker.js", import.meta.url), "utf8");
  const storage = new Map();
  let tracker;
  let attributionAttempts = 0;
  const window = {
    location: { search: "" },
    sessionStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    crypto: { getRandomValues: (bytes) => bytes.fill(8) },
    fetch: async (url) => {
      if (String(url).endsWith("/attribution-claim")) {
        return new Response(JSON.stringify({
          claim_token: "signedPayload.signedValue",
          expires_at: new Date(Date.now() + 300_000).toISOString(),
        }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      attributionAttempts += 1;
      return new Response(null, { status: attributionAttempts === 1 ? 404 : 204 });
    },
    setTimeout: (callback) => queueMicrotask(callback),
    clearInterval,
    setInterval,
    Salla: {
      onReady: (callback) => callback(),
      analytics: { registerTracker: (value) => { tracker = value; } },
    },
  };
  vm.runInNewContext(source, {
    window,
    document: { cookie: "_ga=GA1.1.123456789.987654321" },
    URLSearchParams,
    Response,
    Number,
    JSON,
    decodeURIComponent,
  });

  tracker.track("Checkout Step Viewed", { checkout_id: "checkout-race" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  tracker.track("Order Completed", { order_id: "SALLA-RACE", checkout_id: "checkout-race", total: 199, currency: "SAR" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(attributionAttempts, 2);
  assert.equal(storage.get("inv90_attribution_sent_SALLA-RACE"), "1");
});

test("retries transient claim acquisition after Order Completed", async () => {
  const source = await readFile(new URL("./inv90-tracker.js", import.meta.url), "utf8");
  const storage = new Map();
  let tracker;
  let claimAttempts = 0;
  let posted;
  const window = {
    location: { search: "?gclid=claim-retry" },
    sessionStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    crypto: { getRandomValues: (bytes) => bytes.fill(9) },
    fetch: async (url, init) => {
      if (String(url).endsWith("/attribution-claim")) {
        claimAttempts += 1;
        if (claimAttempts === 1) return new Response(null, { status: 503 });
        return new Response(JSON.stringify({
          claim_token: "retryPayload.retrySignature",
          expires_at: new Date(Date.now() + 300_000).toISOString(),
        }), { status: 201, headers: { "content-type": "application/json" } });
      }
      posted = JSON.parse(String(init.body));
      return new Response(null, { status: 204 });
    },
    setTimeout: (callback) => queueMicrotask(callback),
    clearInterval,
    setInterval,
    Salla: {
      onReady: (callback) => callback(),
      analytics: { registerTracker: (value) => { tracker = value; } },
    },
  };
  vm.runInNewContext(source, {
    window,
    document: { cookie: "_ga=GA1.1.123456789.987654321" },
    URLSearchParams,
    Response,
    Number,
    JSON,
    Date,
    Promise,
    decodeURIComponent,
  });

  tracker.track("Order Completed", { order_id: "SALLA-RETRY", checkout_id: "checkout-retry", total: 199, currency: "SAR" });
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(claimAttempts, 2);
  assert.equal(posted.claim_token, "retryPayload.retrySignature");
  assert.equal(storage.get("inv90_attribution_sent_SALLA-RETRY"), "1");
});

test("renews an expired stored claim before order completion", async () => {
  const source = await readFile(new URL("./inv90-tracker.js", import.meta.url), "utf8");
  const storage = new Map([
    ["inv90_attribution_claim_token_checkout-long", JSON.stringify({
      token: "expiredPayload.expiredSignature",
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    })],
    ["inv90_attribution_claim_nonce_checkout-long", "0a".repeat(24)],
  ]);
  let tracker;
  let claimAttempts = 0;
  let posted;
  const window = {
    location: { search: "" },
    sessionStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    crypto: { getRandomValues: (bytes) => bytes.fill(10) },
    fetch: async (url, init) => {
      if (String(url).endsWith("/attribution-claim")) {
        claimAttempts += 1;
        return new Response(JSON.stringify({
          claim_token: "renewedPayload.renewedSignature",
          expires_at: new Date(Date.now() + 300_000).toISOString(),
        }), { status: 201, headers: { "content-type": "application/json" } });
      }
      posted = JSON.parse(String(init.body));
      return new Response(null, { status: 204 });
    },
    setTimeout,
    clearInterval,
    setInterval,
    Salla: {
      onReady: (callback) => callback(),
      analytics: { registerTracker: (value) => { tracker = value; } },
    },
  };
  vm.runInNewContext(source, {
    window,
    document: { cookie: "_ga=GA1.1.123456789.987654321" },
    URLSearchParams,
    Response,
    Number,
    JSON,
    Date,
    decodeURIComponent,
  });

  tracker.track("Order Completed", { order_id: "SALLA-LONG", checkout_id: "checkout-long", total: 199, currency: "SAR" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(claimAttempts, 1);
  assert.equal(posted.claim_token, "renewedPayload.renewedSignature");
  assert.equal(JSON.parse(storage.get("inv90_attribution_claim_token_checkout-long")).token, "renewedPayload.renewedSignature");
});

test("accepts wrapped Salla checkout and order payloads", async () => {
  const source = await readFile(new URL("./inv90-tracker.js", import.meta.url), "utf8");
  const storage = new Map();
  const ga4Calls = [];
  let tracker;
  let claimed;
  let posted;
  const window = {
    location: { search: "?utm_source=tiktok&utm_medium=paid_social" },
    sessionStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    crypto: { getRandomValues: (bytes) => bytes.fill(11) },
    gtag: (...args) => ga4Calls.push(args),
    fetch: async (url, init) => {
      if (String(url).endsWith("/attribution-claim")) {
        claimed = JSON.parse(String(init.body));
        return new Response(JSON.stringify({
          claim_token: "wrappedPayload.wrappedSignature",
          expires_at: new Date(Date.now() + 300_000).toISOString(),
        }), { status: 201, headers: { "content-type": "application/json" } });
      }
      posted = JSON.parse(String(init.body));
      return new Response(null, { status: 204 });
    },
    setTimeout,
    clearInterval,
    setInterval,
    Salla: {
      onReady: (callback) => callback(),
      analytics: { registerTracker: (value) => { tracker = value; } },
    },
  };
  vm.runInNewContext(source, {
    window,
    document: { cookie: "_ga=GA1.1.123456789.987654321" },
    URLSearchParams,
    Response,
    Number,
    JSON,
    Date,
    decodeURIComponent,
  });

  const checkoutPayload = {
    type: "track",
    properties: {
      checkout_id: "checkout-wrapped",
      value: 418,
      currency: "sar",
      products: [
        { product_id: "SKU-1", name: "Safe product", price: 199, quantity: 2 },
        { product_id: "SKU-2", name: "Shipping add-on", price: 20, quantity: 1 },
      ],
    },
  };
  tracker.track("Checkout Step Completed", checkoutPayload);
  tracker.track("Checkout Step Completed", checkoutPayload);
  tracker.track("Payment Info Entered", checkoutPayload);
  tracker.track("Payment Info Entered", checkoutPayload);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(ga4Calls.length, 2);
  assert.equal(ga4Calls[0][0], "event");
  assert.equal(ga4Calls[0][1], "add_shipping_info");
  assert.equal(ga4Calls[0][2].value, 418);
  assert.equal(ga4Calls[0][2].currency, "SAR");
  assert.equal(ga4Calls[0][2].items.length, 2);
  assert.equal(ga4Calls[0][2].items[0].item_id, "SKU-1");
  assert.equal(ga4Calls[1][1], "add_payment_info");
  assert.equal(claimed.checkout_id, "checkout-wrapped");
  assert.equal(claimed.utm_source, "tiktok");
  assert.equal(claimed.utm_medium, "paid");

  tracker.track("Order Completed", {
    type: "track",
    properties: {
      order_id: "SALLA-WRAPPED",
      checkout_id: "checkout-wrapped",
      total: 418,
      currency: "SAR",
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(posted.order_id, "SALLA-WRAPPED");
  assert.equal(posted.checkout_id, "checkout-wrapped");
  assert.equal(posted.total, 418);
});

test("does not emit checkout events without a consented GA client cookie", async () => {
  const source = await readFile(new URL("./inv90-tracker.js", import.meta.url), "utf8");
  const storage = new Map();
  const dataLayer = [];
  let tracker;
  const window = {
    location: { search: "?utm_source=tiktok&utm_medium=paid" },
    dataLayer,
    sessionStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    fetch: async () => new Response(null, { status: 500 }),
    setTimeout,
    clearInterval: () => {},
    setInterval: () => 1,
    Salla: {
      onReady: (callback) => callback(),
      analytics: { registerTracker: (value) => { tracker = value; } },
    },
  };
  vm.runInNewContext(source, {
    window,
    document: { cookie: "" },
    URLSearchParams,
    Response,
    Number,
    JSON,
    decodeURIComponent,
  });

  tracker.track("Payment Info Entered", {
    properties: { cart_id: "cart-no-consent", value: 199, currency: "SAR" },
  });

  assert.equal(dataLayer.length, 0);
  assert.equal(storage.size, 0);
});
