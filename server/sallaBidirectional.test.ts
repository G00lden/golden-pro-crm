import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const testRoot = await mkdtemp(path.join(tmpdir(), "golden-salla-bidirectional-"));
const storePath = path.join(testRoot, "integrations.json");
process.env.NODE_ENV = "test";
process.env.DATA_PROVIDER = "sqlite";
process.env.DB_PROVIDER = "sqlite";
process.env.DB_PATH = ":memory:";
process.env.SALLA_INTEGRATION_STORE_PATH = storePath;
process.env.SALLA_CLIENT_ID = "test-client";
process.env.SALLA_CLIENT_SECRET = "test-secret";
process.env.SALLA_APP_OWNER_UID = "test-owner";
process.env.SALLA_APP_WEBHOOK_SECRET = "test-webhook-secret";
process.env.SALLA_FETCH_RETRY_BASE_DELAY_MS = "0";
process.env.SALLA_FETCH_RETRY_MAX_DELAY_MS = "0";

const sallaModule = await import("./salla");
const {
  __sallaTestables,
  getSallaOrderStatusesForUser,
  handleSallaAppWebhook,
  importSallaProductsSnapshotForUser,
  syncSallaProductsForUser,
  updateSallaOrderForUser,
  updateSallaOrderStatusForUser,
} = sallaModule;
const { adminDb } = await import("./firebaseAdmin");
const { getStoreOrderDocId } = await import("./storeWebhook");
const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function remoteOrder(id: string, slug = "in_progress", withPhone = true) {
  return {
    id,
    reference_id: `REF-${id}`,
    created_at: "2026-07-13T00:00:00.000Z",
    updated_at: "2026-07-13T00:01:00.000Z",
    status: { id: slug === "completed" ? 20 : 10, name: slug === "completed" ? "تم" : "قيد التنفيذ", slug },
    customer: { name: "عميل اختبار", ...(withPhone ? { mobile: "0500000000" } : {}) },
    amounts: { total: { amount: 100, currency: "SAR" } },
    items: [{ id: `line-${id}`, name: "منتج", sku: `SALE-${id}`, quantity: 1, price: { amount: 100, currency: "SAR" } }],
  };
}

function statusPayload() {
  return { data: [
    { id: 10, name: "قيد التنفيذ", slug: "in_progress", is_active: true, sort: 1 },
    { id: 20, name: "تم", slug: "completed", is_active: true, sort: 2 },
  ] };
}

async function linkOwner(uid: string, scope = "offline_access orders.read_write products.read_write customers.read_write webhooks.read_write") {
  await __sallaTestables.writeIntegration(uid, {
    status: "connected",
    access_token: `access-${uid}`,
    refresh_token: `refresh-${uid}`,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    scope,
    merchant_id: "merchant-a",
  });
}

async function seedLocalOrder(uid: string, remoteId: string) {
  const id = getStoreOrderDocId(uid, "salla", remoteId);
  await adminDb.collection("store_orders").doc(id).set({
    createdBy: uid,
    provider: "salla",
    source: "salla",
    order_id: remoteId,
    order_number: `REF-${remoteId}`,
    imported_at: "2026-07-13T00:00:00.000Z",
    items: [],
  });
  return id;
}

function webhookRequest(body: Record<string, unknown>) {
  const rawBody = Buffer.from(JSON.stringify(body));
  return {
    body,
    rawBody,
    get(name: string) {
      return name.toLowerCase() === "authorization" ? "Bearer test-webhook-secret" : "";
    },
  };
}

beforeEach(async () => {
  globalThis.fetch = originalFetch;
  __sallaTestables.resetLocks();
  await rm(storePath, { force: true });
});

after(async () => {
  globalThis.fetch = originalFetch;
  await rm(testRoot, { recursive: true, force: true });
});

test("status update is a no-op when Salla already has the desired status", async () => {
  const uid = "owner-status-noop";
  await linkOwner(uid);
  const localId = await seedLocalOrder(uid, "101");
  let writes = 0;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/orders/statuses")) return jsonResponse(statusPayload());
    if (url.pathname.endsWith("/orders/101") && (!init?.method || init.method === "GET")) {
      return jsonResponse({ data: remoteOrder("101", "completed") });
    }
    writes += 1;
    return jsonResponse({ success: true }, 201);
  }) as typeof fetch;

  const result = await updateSallaOrderStatusForUser(uid, uid, localId, { slug: "completed" });
  assert.equal(result.changed, false);
  assert.equal(writes, 0);
});

test("status mutation writes once and reconciles an ambiguous network outcome", async () => {
  const uid = "owner-status-reconcile";
  await linkOwner(uid);
  const localId = await seedLocalOrder(uid, "102");
  let current = "in_progress";
  let writes = 0;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/orders/statuses")) return jsonResponse(statusPayload());
    if (url.pathname.endsWith("/orders/102/status") && init?.method === "POST") {
      writes += 1;
      current = "completed";
      throw new TypeError("connection reset after upload");
    }
    if (url.pathname.endsWith("/orders/102")) return jsonResponse({ data: remoteOrder("102", current) });
    throw new Error(`Unexpected request ${url.pathname}`);
  }) as typeof fetch;

  const result = await updateSallaOrderStatusForUser(uid, uid, localId, { slug: "completed" });
  assert.equal(result.reconciled, true);
  assert.equal(writes, 1);
  const stored = (await adminDb.collection("store_orders").doc(localId).get()).data() || {};
  assert.equal(stored.remote_status_slug, "completed");
});

test("a post-mutation read failure reconciles without sending the status twice", async () => {
  const uid = "owner-post-write-read";
  await linkOwner(uid);
  const localId = await seedLocalOrder(uid, "103");
  let current = "in_progress";
  let writes = 0;
  let failedReads = 0;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/orders/statuses")) return jsonResponse(statusPayload());
    if (url.pathname.endsWith("/orders/103/status") && init?.method === "POST") {
      writes += 1;
      current = "completed";
      return jsonResponse({ success: true }, 201);
    }
    if (url.pathname.endsWith("/orders/103")) {
      if (current === "completed" && failedReads < 2) {
        failedReads += 1;
        throw new TypeError("temporary read failure");
      }
      return jsonResponse({ data: remoteOrder("103", current) });
    }
    throw new Error(`Unexpected request ${url.pathname}`);
  }) as typeof fetch;

  const result = await updateSallaOrderStatusForUser(uid, uid, localId, { slug: "completed" });
  assert.equal(result.reconciled, true);
  assert.equal(writes, 1);
});

test("write scope and owner isolation are enforced before a remote mutation", async () => {
  const uid = "owner-read-only";
  await linkOwner(uid, "offline_access orders.read");
  const localId = await seedLocalOrder(uid, "104");
  await assert.rejects(
    () => updateSallaOrderStatusForUser(uid, uid, localId, { slug: "completed" }),
    /orders\.read_write/,
  );
  await assert.rejects(
    () => updateSallaOrderStatusForUser("different-owner", "different-owner", localId, { slug: "completed" }),
    /not connected|not found|do not own/i,
  );
});

test("order edit reconciles receiver, coupon, and unordered employee response shapes", async () => {
  const uid = "owner-order-update";
  await linkOwner(uid);
  const localId = await seedLocalOrder(uid, "109");
  let updated = false;
  let writes = 0;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/orders/109") && init?.method === "PUT") {
      writes += 1;
      const body = JSON.parse(String(init.body));
      assert.equal(body.receiver.notify, false);
      updated = true;
      return jsonResponse({ success: true });
    }
    if (url.pathname.endsWith("/orders/109")) {
      const order = remoteOrder("109", "in_progress") as Record<string, unknown>;
      if (updated) {
        order.receiver = { name: "مستلم", country_code: "SA", phone: "966500000000", email: "receiver@example.test" };
        order.coupon = { code: "SAVE10" };
        order.employees = [{ id: 2 }, { id: 1 }];
      }
      return jsonResponse({ data: order });
    }
    throw new Error(`Unexpected request ${url.pathname}`);
  }) as typeof fetch;

  const result = await updateSallaOrderForUser(uid, uid, localId, {
    receiver: {
      name: "مستلم",
      country_code: "SA",
      phone: "966500000000",
      email: "receiver@example.test",
      notify: false,
    },
    coupon_code: "SAVE10",
    employees: [1, 2],
  });
  assert.equal(result.changed, true);
  assert.equal(writes, 1);
});

test("status.updated webhook fetches authoritative details and identical retries run once", async () => {
  const uid = "test-owner";
  await linkOwner(uid);
  let detailReads = 0;
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/orders/105")) {
      detailReads += 1;
      return jsonResponse({ data: remoteOrder("105", "completed") });
    }
    throw new Error(`Unexpected request ${url.pathname}`);
  }) as typeof fetch;
  const body = { event: "order.status.updated", merchant: "merchant-a", data: { id: "105" } };
  const first = await handleSallaAppWebhook(webhookRequest(body) as never);
  const second = await handleSallaAppWebhook(webhookRequest(body) as never);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(detailReads, 1);
});

test("merchant mismatch is rejected before reading or mutating a Salla order", async () => {
  await linkOwner("test-owner");
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return jsonResponse({});
  }) as typeof fetch;
  const body = { event: "order.updated", merchant: "merchant-b", data: { id: "106" } };
  await assert.rejects(() => handleSallaAppWebhook(webhookRequest(body) as never), /merchant does not match/);
  assert.equal(calls, 0);
});

test("authorization for a different merchant cannot replace the connected store tokens", async () => {
  await linkOwner("test-owner");
  const body = {
    event: "app.store.authorize",
    merchant: "merchant-b",
    data: { access_token: "attacker-token", refresh_token: "attacker-refresh", expires: 3_600 },
  };
  await assert.rejects(
    () => handleSallaAppWebhook(webhookRequest(body) as never),
    /merchant does not match/,
  );
  const integration = await __sallaTestables.readIntegration("test-owner");
  assert.equal(integration?.access_token, "access-test-owner");
  assert.equal(integration?.merchant_id, "merchant-a");
});

test("a late deleted event cannot overwrite an order that Salla currently reports as restored", async () => {
  await linkOwner("test-owner");
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/orders/107")) return jsonResponse({ data: remoteOrder("107", "restored") });
    throw new Error(`Unexpected request ${url.pathname}`);
  }) as typeof fetch;
  const body = { event: "order.deleted", merchant: "merchant-a", created_at: "2026-07-12T00:00:00Z", data: { id: "107" } };
  await handleSallaAppWebhook(webhookRequest(body) as never);
  const localId = getStoreOrderDocId("test-owner", "salla", "107");
  const stored = (await adminDb.collection("store_orders").doc(localId).get()).data() || {};
  assert.equal(stored.remote_status_slug, "restored");
  assert.equal(stored.remote_deleted_at, null);
});

test("an order.created event without a phone is projected without operational side effects", async () => {
  await linkOwner("test-owner");
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/orders/108")) return jsonResponse({ data: remoteOrder("108", "in_progress", false) });
    throw new Error(`Unexpected request ${url.pathname}`);
  }) as typeof fetch;
  const body = { event: "order.created", merchant: "merchant-a", data: { id: "108" } };
  await handleSallaAppWebhook(webhookRequest(body) as never);
  const localId = getStoreOrderDocId("test-owner", "salla", "108");
  const stored = (await adminDb.collection("store_orders").doc(localId).get()).data() || {};
  assert.equal(stored.customer_id, "");
  const installations = await adminDb.collection("installations").where("createdBy", "==", "test-owner").get();
  const bookings = await adminDb.collection("bookings").where("createdBy", "==", "test-owner").get();
  assert.equal(installations.size, 0);
  assert.equal(bookings.size, 0);
});

test("status list remains dynamically sourced from the connected store", async () => {
  const uid = "owner-status-list";
  await linkOwner(uid);
  globalThis.fetch = (async () => jsonResponse(statusPayload())) as typeof fetch;
  const statuses = await getSallaOrderStatusesForUser(uid);
  assert.deepEqual(statuses.map((status) => status.slug), ["in_progress", "completed"]);
});

test("product synchronization reads every advertised page with strict totals", async () => {
  const uid = "owner-products-full";
  await linkOwner(uid);
  const total = 65;
  const pageSize = 30;
  const totalPages = 3;
  const requestedPages: number[] = [];
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/admin/v2/products");
    const page = Number(url.searchParams.get("page"));
    requestedPages.push(page);
    const start = (page - 1) * pageSize;
    const count = Math.max(0, Math.min(pageSize, total - start));
    return jsonResponse({
      data: Array.from({ length: count }, (_, offset) => ({
        id: `product-${start + offset}`,
        name: `Product ${start + offset}`,
        sku: `SALE-P-${start + offset}`,
        price: { amount: 10, currency: "SAR" },
      })),
      pagination: { total, totalPages, currentPage: page },
    });
  }) as typeof fetch;

  const result = await syncSallaProductsForUser(uid);
  assert.equal(result.success, true);
  assert.equal(result.fetched, total);
  assert.equal(result.unique_fetched, total);
  assert.equal(result.complete, true);
  assert.deepEqual(requestedPages, [1, 2, 3]);
});

test("an offline product snapshot uses the canonical importer without calling Salla", async () => {
  const uid = "owner-products-offline";
  await linkOwner(uid);
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("The offline importer must not call Salla.");
  }) as typeof fetch;

  const result = await importSallaProductsSnapshotForUser(uid, [
    { id: "offline-1", name: "Filter A", sku: "FILTER-A", price: { amount: 25, currency: "SAR" } },
    { id: "offline-2", name: "Filter B", sku: "FILTER-B", price: { amount: 35, currency: "SAR" } },
  ], { advertisedCount: 2, advertisedPages: 1, syncedAt: "2026-07-13T13:00:00.000Z" });

  assert.equal(fetchCalls, 0);
  assert.equal(result.success, true);
  assert.equal(result.fetched, 2);
  assert.equal(result.complete, true);
  const stored = await adminDb.collection("products").where("createdBy", "==", uid).get();
  assert.equal(stored.size, 2);
  assert.deepEqual(stored.docs.map((doc) => doc.data().store_product_id).sort(), ["offline-1", "offline-2"]);
});

test("a complete product snapshot hides historical Salla rows without deleting references", async () => {
  const uid = "owner-products-catalog-visibility";
  await linkOwner(uid);
  await adminDb.collection("products").doc("historical-order-product").set({
    createdBy: uid,
    name: "Historical order item",
    sku: "OLD-ORDER-SKU",
    source: "salla",
    catalog_visible: true,
  });
  await adminDb.collection("products").doc("stale-remote-product").set({
    createdBy: uid,
    name: "Stale remote product",
    sku: "STALE-SKU",
    source: "salla",
    store_product_id: "stale-remote",
    catalog_visible: true,
  });
  await adminDb.collection("products").doc("manual-product").set({
    createdBy: uid,
    name: "Manual product",
    sku: "MANUAL-SKU",
    source: "manual",
  });
  await adminDb.collection("products").doc("promoted-product").set({
    createdBy: uid,
    name: "Legacy row promoted by SKU",
    sku: "CURRENT-SKU",
    source: "salla",
    catalog_visible: false,
  });

  globalThis.fetch = (async () => {
    throw new Error("The offline importer must not call Salla.");
  }) as typeof fetch;
  const result = await importSallaProductsSnapshotForUser(uid, [
    { id: "current-remote", name: "Current product", sku: "CURRENT-SKU" },
  ], { advertisedCount: 1, advertisedPages: 1, syncedAt: "2026-07-13T14:00:00.000Z" });

  assert.equal(result.archived, 2);
  const historical = await adminDb.collection("products").doc("historical-order-product").get();
  const stale = await adminDb.collection("products").doc("stale-remote-product").get();
  const manual = await adminDb.collection("products").doc("manual-product").get();
  const promoted = await adminDb.collection("products").doc("promoted-product").get();
  assert.equal(historical.exists, true);
  assert.ok([false, 0].includes(historical.data()?.catalog_visible));
  assert.equal(historical.data()?.store_status, "historical");
  assert.equal(stale.exists, true);
  assert.ok([false, 0].includes(stale.data()?.catalog_visible));
  assert.equal(stale.data()?.store_status, "archived");
  assert.notEqual(manual.data()?.catalog_visible, false);
  assert.equal(promoted.data()?.store_product_id, "current-remote");
  assert.ok([true, 1].includes(promoted.data()?.catalog_visible));
});
