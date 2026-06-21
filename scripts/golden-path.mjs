#!/usr/bin/env node
/**
 * Golden-path smoke test — exercises the actual CRM workflow end-to-end:
 *
 *   auth → create customer → create quote → confirm quote → send WhatsApp → cleanup
 *
 * Assumes:
 *   - dev server is running on http://localhost:3000 (or APP_URL)
 *   - ALLOW_LOCAL_AUTH=true (uses Bearer local-dev:<uid>)
 *
 * Exit codes:
 *   0 = all assertions passed
 *   1 = one or more steps failed (details printed)
 *
 * Run: node scripts/golden-path.mjs
 *  or: npm run test:golden
 */
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const baseUrl = process.env.APP_URL || "http://localhost:3000";
const uid = process.env.GOLDEN_PATH_UID || "golden-path-test";
const authHeader = { Authorization: `Bearer local-dev:${uid}` };
const json = { "Content-Type": "application/json" };
const closeHeader = { Connection: "close" };

const results = [];
const created = { customerId: null, quoteId: null };

async function request(path, init = {}) {
  const url = new URL(path, baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { ...closeHeader, ...authHeader, ...json, ...(init.headers || {}) },
    });
    let body = null;
    const text = await res.text();
    if (text) {
      try { body = JSON.parse(text); } catch { body = { raw: text }; }
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

async function step(name, fn) {
  const start = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - start });
    console.log(`PASS  ${name}  (${Date.now() - start}ms)`);
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - start, error: err.message || String(err) });
    console.error(`FAIL  ${name}  (${Date.now() - start}ms)`);
    console.error(`      ${err.message || err}`);
  }
}

async function ensureHealthy() {
  for (let i = 0; i < 5; i++) {
    try {
      const { status, body } = await request("/api/health", { headers: {} });
      if (status === 200 && body?.status === "ok") return body;
    } catch { /* retry */ }
    await delay(1000);
  }
  throw new Error(`Dev server is not healthy at ${baseUrl}. Start it with: npm run dev`);
}

async function cleanup() {
  if (created.quoteId) {
    try { await request(`/api/quotes/${created.quoteId}`, { method: "DELETE" }); } catch {}
  }
  if (created.customerId) {
    try { await request(`/api/customers/${created.customerId}`, { method: "DELETE" }); } catch {}
  }
}

console.log(`\n=== Golden-path test against ${baseUrl} (uid=${uid}) ===\n`);

try {
  // -- 0. Preflight: dev server up & ALLOW_LOCAL_AUTH usable
  const health = await ensureHealthy();
  console.log(`Health ok. Timezone=${health.timeZone}. Outbound mode=${health.outbound?.mode}.`);
  console.log("");

  // -- 1. Auth: anonymous is rejected on protected route
  await step("auth rejects anonymous on /api/customers", async () => {
    const r = await fetch(new URL("/api/customers", baseUrl), { headers: closeHeader });
    assert.equal(r.status, 401, `expected 401, got ${r.status}`);
    await r.body?.cancel?.();
  });

  // -- 2. Auth: local-dev token is accepted
  await step("auth accepts local-dev token", async () => {
    const r = await request("/api/customers");
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  // -- 3. Create a customer
  await step("POST /api/customers creates a customer", async () => {
    const r = await request("/api/customers", {
      method: "POST",
      body: JSON.stringify({
        name: `Golden Path ${Date.now()}`,
        phone: "+966500000000",
        city: "Riyadh",
        source: "golden-path-test",
      }),
    });
    assert.equal(r.status, 201, `expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body?.id, "response must include id");
    created.customerId = r.body.id;
  });

  // -- 4. Create a quote for that customer
  await step("POST /api/quotes creates a quote", async () => {
    const r = await request("/api/quotes", {
      method: "POST",
      body: JSON.stringify({
        customer_name: `Golden Path Quote ${Date.now()}`,
        customer_phone: "+966500000000",
        title: "Golden path test quote",
        items: [
          { description: "Test item A", quantity: 1, unit_price: 100, total: 100 },
          { description: "Test item B", quantity: 2, unit_price: 50, total: 100 },
        ],
        currency: "SAR",
        notes: "Created by golden-path.mjs — safe to delete.",
      }),
    });
    assert.equal(r.status, 201, `expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body?.id, "response must include id");
    assert.ok(r.body?.quote, "response must include the quote object");
    created.quoteId = r.body.id;
  });

  // -- 5. Mark quote as confirmed (the conversion event)
  await step("POST /api/quotes/:id/status → confirmed", async () => {
    const r = await request(`/api/quotes/${created.quoteId}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "confirmed" }),
    });
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.quote?.status, "confirmed", `expected status=confirmed, got ${r.body?.quote?.status}`);
    assert.ok(r.body?.quote?.confirmed_at, "confirmed quote must have confirmed_at timestamp");
  });

  // -- 6. Send WhatsApp — accept either 200 (sent/dry-run) or a clean error
  //       The point is the endpoint exists and responds, not that the message lands.
  await step("POST /api/quotes/:id/send-whatsapp responds cleanly", async () => {
    const r = await request(`/api/quotes/${created.quoteId}/send-whatsapp`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.ok([200, 400, 409, 412, 424, 503].includes(r.status), `unexpected status ${r.status}: ${JSON.stringify(r.body)}`);
    if (r.status >= 400) {
      assert.ok(r.body && typeof r.body === "object", "error response must be JSON");
      assert.ok(r.body.error || r.body.message, "error response must include error/message field");
      console.log(`      (WA send returned ${r.status} — ${r.body.error || r.body.message}). This is OK; we only assert the endpoint exists and is well-behaved.`);
    }
  });

  // -- 7. Re-fetch the quote and verify it persisted
  await step("GET /api/quotes returns the created quote", async () => {
    const r = await request("/api/quotes");
    assert.equal(r.status, 200);
    const found = (r.body?.data || []).find((q) => q.id === created.quoteId);
    assert.ok(found, "created quote must appear in list");
    assert.equal(found.status, "confirmed", "list-view status must reflect confirmation");
  });
} finally {
  console.log("\n--- cleanup ---");
  await cleanup();
  if (created.quoteId) console.log(`deleted quote ${created.quoteId}`);
  if (created.customerId) console.log(`deleted customer ${created.customerId}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} steps passed ===`);
if (failed.length) {
  console.log("\nFailures:");
  for (const f of failed) console.log(`  - ${f.name}: ${f.error}`);
  process.exitCode = 1;
} else {
  process.exitCode = 0;
}
await delay(50);
