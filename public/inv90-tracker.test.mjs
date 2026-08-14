import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("extracts a GA4 GS2 session id from the current cookie format", async () => {
  const source = await readFile(new URL("./inv90-tracker.js", import.meta.url), "utf8");
  const storage = new Map();
  let tracker;
  let posted;
  const window = {
    location: { search: "?gclid=click-1" },
    sessionStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, String(value)),
    },
    fetch: async (_url, init) => {
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

  tracker.track("Order Completed", { order_id: "SALLA-1", total: 199, currency: "SAR" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(posted.client_id, "123456789.987654321");
  assert.equal(posted.session_id, "1723456789");
  assert.equal(posted.gclid, "click-1");
});
