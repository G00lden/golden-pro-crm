#!/usr/bin/env node
/**
 * Golden-path smoke test — exercises the actual CRM workflow end-to-end:
 *
 *   auth → create customer → create quote → confirm quote → send WhatsApp → cleanup
 *
 * Assumes:
 *   - dev server is running on http://localhost:3000 (or APP_URL)
 *   - loopback test server with explicit, signed local auth enabled
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
import { getLocalTestToken } from "./local-test-auth.mjs";

const baseUrl = process.env.APP_URL || "http://localhost:3000";
const uid = process.env.GOLDEN_PATH_UID || "golden-path-test";
let authHeader = {};
const json = { "Content-Type": "application/json" };
const closeHeader = { Connection: "close" };

const results = [];
const created = { customerId: null, quoteId: null, invoiceId: null, directInvoiceId: null };

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
  if (created.directInvoiceId) {
    try { await request(`/api/invoices/${created.directInvoiceId}`, { method: "DELETE" }); } catch {}
  }
  if (created.invoiceId) {
    try { await request(`/api/invoices/${created.invoiceId}`, { method: "DELETE" }); } catch {}
  }
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
  authHeader = { Authorization: `Bearer ${await getLocalTestToken(baseUrl, uid)}` };

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

  await step("local identities remain distinct and least-privileged", async () => {
    const owner = await request("/api/me");
    assert.equal(owner.status, 200);
    assert.equal(owner.body?.role, "admin");
    assert.equal(owner.body?.email, null);

    const secondToken = await getLocalTestToken(baseUrl, "golden-path-secondary");
    const secondary = await fetch(new URL("/api/me", baseUrl), {
      headers: { Authorization: `Bearer ${secondToken}`, ...closeHeader },
    });
    assert.equal(secondary.status, 200);
    const body = await secondary.json();
    assert.equal(body.role, "user");
    assert.equal(body.email, null);
  });

  await step("validation rejects malformed CRM payloads", async () => {
    const customer = await request("/api/customers", {
      method: "POST",
      body: JSON.stringify({ name: "", phone: "0500000000" }),
    });
    assert.equal(customer.status, 400);
    const quote = await request("/api/quotes", {
      method: "POST",
      body: JSON.stringify({
        customer_name: "Invalid",
        discount_mode: "percent",
        discount_value: 101,
        items: [{ description: "X", quantity: 1, unit_price: 10 }],
      }),
    });
    assert.equal(quote.status, 400);
  });

  // -- 3. Create a customer
  await step("POST /api/customers creates a customer", async () => {
    const r = await request("/api/customers", {
      method: "POST",
      body: JSON.stringify({
        name: `Golden Path ${Date.now()}`,
        phone: "+966500000000",
        city: "Riyadh",
        source: "manual",
        role: "admin",
      }),
    });
    assert.equal(r.status, 201, `expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body?.id, "response must include id");
    created.customerId = r.body.id;
    const list = await request("/api/customers");
    const stored = (list.body?.data || []).find((item) => item.id === created.customerId);
    assert.equal(stored?.role, undefined, "unknown privilege fields must be stripped");
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
        discount_mode: "percent",
        discount_value: 10,
        vat_percent: 15,
        tax: 7,
        currency: "SAR",
        notes: "Created by golden-path.mjs — safe to delete.",
      }),
    });
    assert.equal(r.status, 201, `expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body?.id, "response must include id");
    assert.ok(r.body?.quote, "response must include the quote object");
    assert.equal(r.body.quote.discount, 20, "10% of 200 must persist as a 20 SAR discount");
    assert.equal(r.body.quote.vat_amount, 27, "VAT must be calculated after discount");
    assert.equal(r.body.quote.tax, 7, "the quote additional fee must persist");
    assert.equal(r.body.quote.total, 214, "quote total must include the 7 SAR additional fee");
    created.quoteId = r.body.id;
  });

  await step("invoice drafts preserve fees and become immutable after issuance", async () => {
    const create = await request("/api/invoices", {
      method: "POST",
      body: JSON.stringify({
        customer_id: created.customerId,
        customer_name: "Golden Path Direct Invoice",
        customer_phone: "+966500000000",
        title: "Direct invoice additional-fee validation",
        items: [{ description: "VAT-inclusive item", quantity: 1, unit_price: 1000, vat_excluded: false }],
        discount_mode: "percent",
        discount_value: 10,
        vat_percent: 15,
        additional_fee: 50,
        currency: "SAR",
        status: "draft",
      }),
    });
    assert.equal(create.status, 201, `expected 201, got ${create.status}: ${JSON.stringify(create.body)}`);
    created.directInvoiceId = create.body?.id;
    assert.equal(create.body?.invoice?.additional_fee, 50);
    assert.equal(create.body?.invoice?.total_with_vat, 950);

    const update = await request(`/api/invoices/${created.directInvoiceId}`, {
      method: "PUT",
      body: JSON.stringify({
        customer_id: created.customerId,
        customer_name: "Golden Path Direct Invoice",
        customer_phone: "+966500000000",
        title: "Direct invoice additional-fee validation",
        items: [{ description: "VAT-inclusive item", quantity: 1, unit_price: 1000, vat_excluded: false }],
        discount_mode: "percent",
        discount_value: 10,
        vat_percent: 15,
        additional_fee: 60,
        currency: "SAR",
        status: "draft",
      }),
    });
    assert.equal(update.status, 200, `expected 200, got ${update.status}: ${JSON.stringify(update.body)}`);
    assert.equal(update.body?.invoice?.additional_fee, 60);
    assert.equal(update.body?.invoice?.total_with_vat, 960);

    const issue = await request(`/api/invoices/${created.directInvoiceId}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "issued" }),
    });
    assert.equal(issue.status, 200, `expected 200, got ${issue.status}: ${JSON.stringify(issue.body)}`);
    assert.equal(issue.body?.invoice?.status, "issued");
    assert.equal(issue.body?.invoice?.additional_fee, 60);
    assert.equal(issue.body?.invoice?.total_with_vat, 960);

    const immutableUpdate = await request(`/api/invoices/${created.directInvoiceId}`, {
      method: "PUT",
      body: JSON.stringify({
        customer_id: created.customerId,
        customer_name: "Golden Path Direct Invoice",
        items: [{ description: "VAT-inclusive item", quantity: 1, unit_price: 1000, vat_excluded: false }],
        discount_mode: "percent",
        discount_value: 10,
        vat_percent: 15,
        additional_fee: 70,
        currency: "SAR",
        status: "draft",
      }),
    });
    assert.equal(immutableUpdate.status, 409, `expected 409, got ${immutableUpdate.status}: ${JSON.stringify(immutableUpdate.body)}`);
  });

  await step("POST /api/quotes/:id/convert-to-invoice preserves totals", async () => {
    const r = await request(`/api/quotes/${created.quoteId}/convert-to-invoice`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 201, `expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.invoice?.discount, 20);
    assert.equal(r.body?.invoice?.discount_mode, "percent");
    assert.equal(r.body?.invoice?.discount_value, 10);
    assert.equal(r.body?.invoice?.vat_amount, 27);
    assert.equal(r.body?.invoice?.additional_fee, 7, "the quote fee must survive invoice conversion");
    assert.equal(r.body?.invoice?.total_with_vat, 214, "the converted invoice total must match the quote total");
    assert.equal(r.body?.invoice?.invoice_type, "simplified", "B2C invoices stay simplified regardless of total");
    created.invoiceId = r.body?.id;
    const qr = await request(`/api/invoices/${created.invoiceId}/qr`);
    assert.equal(qr.status, 200);
    assert.equal(qr.body?.fields?.length, 5);
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
  if (created.invoiceId) console.log(`deleted invoice ${created.invoiceId}`);
  if (created.directInvoiceId) console.log(`deleted direct invoice ${created.directInvoiceId}`);
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
