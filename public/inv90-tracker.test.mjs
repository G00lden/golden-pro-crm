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
    },
    crypto: { getRandomValues: (bytes) => bytes.fill(7) },
    fetch: async (url, init) => {
      if (String(url).endsWith("/attribution-claim")) {
        claimed = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ claim_token: "signedPayload.signedValue" }), {
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
    },
    crypto: { getRandomValues: (bytes) => bytes.fill(8) },
    fetch: async (url) => {
      if (String(url).endsWith("/attribution-claim")) {
        return new Response(JSON.stringify({ claim_token: "signedPayload.signedValue" }), {
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
