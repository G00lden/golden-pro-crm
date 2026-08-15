import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { normalizeStorePayload } from "./storeWebhook";

test("normalizes private payment, attribution and SKU fields from a Salla order", () => {
  const body = {
    event: "order.created",
    event_id: "event-123",
    data: {
      id: 123,
      checkout_id: "checkout-123",
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
  assert.equal(normalized.checkoutId, "checkout-123");
  assert.equal(normalized.projectionExtras?.checkout_id, "checkout-123");
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

test("local webhook fallback accepts checkout-bearing payloads without persistent storage", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "crm-local-checkout-webhook-"));
  const moduleUrl = pathToFileURL(path.resolve("server/storeWebhook.ts")).href;
  const tsxLoader = import.meta.resolve("tsx");
  const source = `
    const { processStoreWebhook } = await import(${JSON.stringify(moduleUrl)});
    const body = {
      event: "order.created",
      event_id: "event-local-checkout",
      data: {
        id: 456,
        checkout_id: "checkout-local-456",
        reference_id: "ORD-LOCAL-456",
        status: { name: "new" },
        customer: { name: "Local Customer", mobile_code: "+966", mobile: "500000000" },
        amounts: { total: { amount: 199, currency: "SAR" } },
        items: [{ name: "Filter kit", sku: "BP-000392", quantity: 1, price: { amount: 199, currency: "SAR" } }],
      },
    };
    const rawBody = Buffer.from(JSON.stringify(body));
    const req = {
      body,
      rawBody,
      get(name) {
        const key = String(name).toLowerCase();
        if (key === "x-golden-webhook-secret") return "local-webhook-secret";
        if (key === "x-store-provider") return "salla";
        return undefined;
      },
    };
    const result = await processStoreWebhook(req);
    process.stdout.write(JSON.stringify(result));
  `;

  try {
    const env = { ...process.env };
    env.NODE_ENV = "development";
    env.STORE_WEBHOOK_OWNER_UID = "owner-local";
    env.STORE_WEBHOOK_SECRET = "local-webhook-secret";
    env.STORE_WEBHOOK_LOCAL_FALLBACK = "true";
    delete env.DATA_PROVIDER;
    delete env.DB_PROVIDER;
    delete env.FIREBASE_SERVICE_ACCOUNT_JSON;
    delete env.FIREBASE_SERVICE_ACCOUNT_PATH;
    delete env.GOOGLE_APPLICATION_CREDENTIALS;
    delete env.SUPABASE_SERVICE_ROLE_KEY;
    delete env.SUPABASE_SERVICE_KEY;
    const output = execFileSync(
      process.execPath,
      ["--import", tsxLoader, "--input-type=module", "--eval", source],
      { cwd: directory, env, encoding: "utf8" },
    );
    const result = JSON.parse(output);
    assert.equal(result.success, true);
    assert.equal(result.localFallback, true);
    assert.equal(result.order_id, "456");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
