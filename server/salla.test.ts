import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const testRoot = await mkdtemp(path.join(tmpdir(), "golden-salla-"));
const storePath = path.join(testRoot, "salla-integrations.json");
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
  __sallaTestables: salla,
  getSallaStatus,
  handleSallaAppWebhook,
  syncSallaCustomersForUser,
  syncSallaOrdersForUser,
} = sallaModule;
const { adminDb } = await import("./firebaseAdmin");
const {
  __storeWebhookTestables,
  getStoreOrderDocId,
  projectStoreOrderForUser,
} = await import("./storeWebhook");
const { subscribeStoreOrderChanges } = await import("./storeOrderRealtime");
const originalFetch = globalThis.fetch;
const baselineSallaEnv = Object.fromEntries([
  "SALLA_SCOPES",
  "SALLA_SYNC_MAX_PAGES",
  "SALLA_SYNC_PAGE_SIZE",
  "SALLA_CUSTOMER_SYNC_MAX_PAGES",
  "SALLA_CUSTOMER_SYNC_PAGE_SIZE",
  "SALLA_CUSTOMER_SYNC_INTERVAL_MINUTES",
].map((key) => [key, process.env[key]]));

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function captureRejection(task: () => Promise<unknown>) {
  let caught: unknown;
  try {
    await task();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, "Expected the promise to reject.");
  return caught;
}

beforeEach(async () => {
  process.env.NODE_ENV = "test";
  for (const [key, value] of Object.entries(baselineSallaEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = originalFetch;
  salla.resetLocks();
  __storeWebhookTestables.resetProductCatalogIndexCache();
  await rm(storePath, { force: true });
});

async function linkSallaOwner(uid: string) {
  await salla.writeIntegration(uid, {
    status: "connected",
    access_token: `access-${uid}`,
    refresh_token: `refresh-${uid}`,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    scope: "offline_access orders.read products.read customers.read",
  });
}

async function customersForOwner(uid: string) {
  const snapshot = await adminDb
    .collection("customers")
    .where("createdBy", "==", uid)
    .limit(10_000)
    .get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) })) as Array<Record<string, any>>;
}

async function recordsForOwner(collection: string, uid: string) {
  const snapshot = await adminDb
    .collection(collection)
    .where("createdBy", "==", uid)
    .limit(10_000)
    .get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) })) as Array<Record<string, any>>;
}

after(async () => {
  globalThis.fetch = originalFetch;
  await rm(testRoot, { recursive: true, force: true });
});

test("unwraps data.merchant, prefers store/info, and normalizes HTTPS", () => {
  const profile = salla.extractMerchantProfile(
    {
      status: 200,
      data: {
        merchant: {
          id: "merchant-from-user-info",
          name: "Fallback store",
          domain: "http://fallback.example.test",
        },
      },
    },
    {
      status: 200,
      data: {
        id: "merchant-from-store-info",
        name: "Canonical store",
        domain: "http://shop.example.test/catalog?tracking=1#top",
      },
    },
  );

  assert.deepEqual(profile, {
    merchantId: "merchant-from-store-info",
    storeName: "Canonical store",
    storeUrl: "https://shop.example.test/catalog",
  });
  assert.equal(salla.normalizeStorefrontUrl("javascript:alert(1)"), null);
});

test("retries safe GET requests for transient statuses and honors Retry-After", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return calls === 1
      ? jsonResponse({ message: "temporarily unavailable" }, 503, { "retry-after": "0" })
      : jsonResponse({ ok: true });
  }) as typeof fetch;

  const result = await salla.requestSallaJson<{ ok: boolean }>(
    "https://api.salla.dev/admin/v2/store/info",
    {},
    { maxRetries: 2, timeoutMs: 100 },
  );
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 2);
});

test("caps Salla pagination at 30 even when configuration requests 50", () => {
  const previous = process.env.SALLA_SYNC_PAGE_SIZE;
  process.env.SALLA_SYNC_PAGE_SIZE = "50";
  try {
    assert.equal(salla.pageSize(), 30);
  } finally {
    if (previous === undefined) delete process.env.SALLA_SYNC_PAGE_SIZE;
    else process.env.SALLA_SYNC_PAGE_SIZE = previous;
  }
});

test("order pagination is fixed at 30 rows and 200 pages independently of other sync settings", () => {
  process.env.SALLA_SYNC_PAGE_SIZE = "10";
  process.env.SALLA_SYNC_MAX_PAGES = "3";
  assert.equal(salla.orderPageSize(), 30);
  assert.equal(salla.orderMaxSyncPages(), 200);
  assert.equal(salla.pageSize(), 10);
});

test("collects all 2,618 orders across 88 sequential pages before projection", async () => {
  const total = 2_618;
  const totalPages = 88;
  const requestedPages: number[] = [];
  const result = await salla.collectCompleteSallaOrderPages(async (page: number) => {
    requestedPages.push(page);
    const start = (page - 1) * 30;
    const size = Math.min(30, total - start);
    return {
      data: Array.from({ length: size }, (_, index) => ({ id: start + index + 1 })),
      pagination: { total, totalPages, currentPage: page, perPage: 30 },
    };
  });

  assert.equal(result.fetched, total);
  assert.equal(result.orders.length, total);
  assert.equal(result.pages, totalPages);
  assert.equal(result.advertisedTotal, total);
  assert.equal(result.advertisedPages, totalPages);
  assert.deepEqual(requestedPages, Array.from({ length: totalPages }, (_, index) => index + 1));
});

test("rejects early empty, capped, and duplicate order snapshots as incomplete", async () => {
  await assert.rejects(
    salla.collectCompleteSallaOrderPages(async (page: number) => ({
      data: page === 2
        ? []
        : Array.from({ length: 30 }, (_, index) => ({ id: (page - 1) * 30 + index + 1 })),
      pagination: { total: 61, totalPages: 3 },
    })),
    /page 2 was empty/i,
  );

  let capCalls = 0;
  await assert.rejects(
    salla.collectCompleteSallaOrderPages(async () => {
      capCalls += 1;
      return {
        data: Array.from({ length: 30 }, (_, index) => ({ id: index + 1 })),
        pagination: { total: 6_030, totalPages: 201 },
      };
    }),
    /exceeds the 200-page safety cap/i,
  );
  assert.equal(capCalls, 1);

  await assert.rejects(
    salla.collectCompleteSallaOrderPages(async (page: number) => ({
      data: page === 1
        ? Array.from({ length: 30 }, (_, index) => ({ id: index + 1 }))
        : [{ id: 30 }],
      pagination: { total: 31, totalPages: 2 },
    })),
    /duplicate remote order 30/i,
  );
});

test("Salla order mapping preserves the remote product id separately from the line id", () => {
  const mapped = salla.mapSallaOrder({
    id: "remote-order-product-id",
    reference_id: "REF-PRODUCT-ID",
    created_at: "2026-07-13T00:00:00.000Z",
    customer: { name: "Catalog Customer", mobile: "0500000101" },
    items: [{
      id: "line-101",
      sku: "SALE-REMOTE-ID",
      quantity: 1,
      product: { id: "product-901", name: "Remote product" },
    }],
  });

  assert.ok(mapped);
  assert.equal(mapped.items[0].remoteItemId, "line-101");
  assert.equal(mapped.items[0].remoteProductId, "product-901");
});

test("catalog matching ignores archived exact rows and loads one index for many order items", async () => {
  const uid = "owner-catalog-index";
  await adminDb.collection("products").doc("product-archived").set({
    createdBy: uid,
    name: "Archived exact product",
    sku: "REUSED-VARIANT",
    source: "salla",
    store_product_id: "remote-archived",
    catalog_visible: false,
    store_status: "archived",
  });
  await adminDb.collection("products").doc("product-current").set({
    createdBy: uid,
    name: "Current product",
    sku: "CURRENT-PARENT",
    source: "salla",
    store_product_id: "remote-current",
    catalog_visible: true,
    variants: [{ id: "variant-current", sku: "REUSED-VARIANT" }],
  });

  const items = Array.from({ length: 24 }, (_, index) => ({
    name: `Variant item ${index + 1}`,
    sku: "REUSED-VARIANT",
    remoteItemId: `line-index-${index + 1}`,
    // Half the rows prove remote id wins first; the other half prove an
    // archived exact SKU cannot beat the one visible variant parent.
    remoteProductId: index % 2 === 0 ? "remote-current" : null,
    quantity: 1,
    maintenanceMonths: 3,
    orderType: "sale_only" as const,
    tags: [],
  }));

  const result = await projectStoreOrderForUser(uid, {
    provider: "salla",
    eventType: "salla.api.sync",
    eventId: "catalog-index-event",
    orderId: "catalog-index-order",
    orderNumber: "CATALOG-INDEX-1",
    status: "new",
    customerName: "Catalog Customer",
    customerPhone: "966500000102",
    customerCity: "Riyadh",
    orderDate: "2026-07-13",
    items,
  });

  assert.equal(result.items.length, items.length);
  assert.ok(result.items.every((item) => item.product_id === "product-current"));
  assert.equal(result.items[0].remote_product_id, "remote-current");
  assert.equal(__storeWebhookTestables.productCatalogIndexLoadCount(), 1);
  assert.equal((await adminDb.collection("products").doc("product-archived").get()).exists, true);
});

test("a remote product id reuses its archived identity and never falls through to a newer product with the same SKU", async () => {
  const uid = "owner-catalog-reused-sku";
  const archivedId = "product-reused-sku-archived";
  const currentId = "product-reused-sku-current";

  await adminDb.collection("products").doc(archivedId).set({
    createdBy: uid,
    name: "Original archived product",
    sku: "REUSED-EXACT-SKU",
    source: "salla",
    store_product_id: "remote-old",
    catalog_visible: false,
    store_status: "archived",
  });
  await adminDb.collection("products").doc(currentId).set({
    createdBy: uid,
    name: "New product reusing the SKU",
    sku: "REUSED-EXACT-SKU",
    source: "salla",
    store_product_id: "remote-new",
    catalog_visible: true,
    store_status: "sale",
  });

  const result = await projectStoreOrderForUser(uid, {
    provider: "salla",
    eventType: "salla.api.sync",
    eventId: "reused-sku-event",
    orderId: "reused-sku-order",
    orderNumber: "REUSED-SKU-1",
    status: "new",
    customerName: "Reused SKU Customer",
    customerPhone: "966500000103",
    customerCity: "Riyadh",
    orderDate: "2026-07-13",
    items: [
      {
        name: "Original historical line",
        sku: "REUSED-EXACT-SKU",
        remoteProductId: "remote-old",
        quantity: 1,
        maintenanceMonths: 3,
        orderType: "sale_only",
        tags: [],
      },
      {
        name: "Unknown historical identity",
        sku: "REUSED-EXACT-SKU",
        remoteProductId: "remote-missing",
        quantity: 1,
        maintenanceMonths: 3,
        orderType: "sale_only",
        tags: [],
      },
      {
        name: "SKU-only current line",
        sku: "REUSED-EXACT-SKU",
        remoteProductId: null,
        quantity: 1,
        maintenanceMonths: 3,
        orderType: "sale_only",
        tags: [],
      },
    ],
  });

  assert.equal(result.items[0].product_id, archivedId);
  assert.equal(result.items[2].product_id, currentId);
  assert.notEqual(result.items[1].product_id, archivedId);
  assert.notEqual(result.items[1].product_id, currentId);

  const dedicatedHistorical = await adminDb.collection("products").doc(String(result.items[1].product_id)).get();
  assert.equal(dedicatedHistorical.exists, true);
  assert.equal(dedicatedHistorical.data()?.store_product_id, "remote-missing");
  assert.ok([false, 0].includes(dedicatedHistorical.data()?.catalog_visible));
  assert.equal(dedicatedHistorical.data()?.store_status, "historical");
  assert.ok([false, 0].includes((await adminDb.collection("products").doc(archivedId).get()).data()?.catalog_visible));
  assert.ok([true, 1].includes((await adminDb.collection("products").doc(currentId).get()).data()?.catalog_visible));
});

test("historical projection preserves local workflow state and creates no operational records", async () => {
  const uid = "owner-order-projection";
  const remoteOrderId = "remote-order-projection";
  const orderDocId = getStoreOrderDocId(uid, "salla", remoteOrderId);
  const orderRef = adminDb.collection("store_orders").doc(orderDocId);
  await orderRef.set({
    createdBy: uid,
    provider: "salla",
    order_id: remoteOrderId,
    order_number: "LOCAL-1",
    journey_status: "completed",
    current_step: "completed",
    scheduled_date: "2026-08-20",
    scheduled_time: "14:30",
    installation_ids: ["installation-local"],
    booking_ids: ["booking-local"],
    items: [{
      name: "Old item name",
      sku: "OLD-SKU",
      remote_item_id: "line-1",
      quantity: 1,
      order_type: "install_maintenance",
      detected_type: "install_maintenance",
      manual_type: "install_maintenance",
      status: "booking_created",
      product_id: "product-local",
      installation_id: "installation-local",
      booking_id: "booking-local",
    }],
    imported_at: "2026-07-01T00:00:00.000Z",
    last_event_at: "2026-07-01T00:00:00.000Z",
  });

  const events: Array<{ type: string; source: string }> = [];
  const unsubscribe = subscribeStoreOrderChanges(uid, (event) => events.push(event));
  try {
    await projectStoreOrderForUser(uid, {
      provider: "salla",
      eventType: "salla.api.sync",
      eventId: "sync:projection",
      orderId: remoteOrderId,
      orderNumber: "REMOTE-1",
      status: "in_progress",
      customerName: "Projection Customer",
      customerPhone: "966500000101",
      customerCity: "Riyadh",
      orderDate: "2026-07-10",
      scheduledDate: "2026-09-01",
      scheduledTime: "09:00",
      total: 125,
      items: [{
        name: "Renamed remote item",
        sku: "NEW-SKU",
        remoteItemId: "line-1",
        quantity: 1,
        maintenanceMonths: 3,
        orderType: "install_maintenance",
        tags: [],
        unitPrice: 125,
        totalPrice: 125,
        currency: "SAR",
      }],
    }, {
      last_event_at: "2026-07-10T10:15:00.000Z",
      remote_updated_at: "2026-07-10T10:15:00.000Z",
      remote_synced_at: "2026-07-13T12:00:00.000Z",
      remote_status_id: "status-1",
      remote_status_name: "In progress",
      remote_status_slug: "in_progress",
      sync_origin: "salla_sync",
    });
  } finally {
    unsubscribe();
  }

  const projected = (await orderRef.get()).data() || {};
  const item = projected.items[0];
  assert.equal(item.remote_item_id, "line-1");
  assert.equal(item.sku, "NEW-SKU");
  assert.equal(item.manual_type, "install_maintenance");
  assert.equal(item.installation_id, "installation-local");
  assert.equal(item.booking_id, "booking-local");
  assert.equal(projected.scheduled_date, "2026-08-20");
  assert.equal(projected.scheduled_time, "14:30");
  assert.equal(projected.journey_status, "completed");
  assert.equal(projected.current_step, "completed");
  assert.equal(projected.last_event_at, "2026-07-10T10:15:00.000Z");
  assert.equal(projected.remote_updated_at, "2026-07-10T10:15:00.000Z");
  assert.equal(projected.remote_synced_at, "2026-07-13T12:00:00.000Z");
  assert.equal(projected.remote_status_slug, "in_progress");
  assert.equal(projected.sync_origin, "salla_sync");
  assert.equal((await recordsForOwner("installations", uid)).length, 0);
  assert.equal((await recordsForOwner("bookings", uid)).length, 0);
  assert.equal((await recordsForOwner("reminders", uid)).length, 0);
  assert.equal((await recordsForOwner("communication_jobs", uid)).length, 0);
  assert.deepEqual(events.map((event) => [event.type, event.source]), [["order.updated", "salla_sync"]]);
});

test("full order sync suppresses per-order realtime noise and publishes one completion event", async () => {
  const uid = "owner-order-sync-complete";
  await linkSallaOwner(uid);
  await adminDb.collection("store_orders").doc(getStoreOrderDocId(uid, "salla", "order-sync-1")).set({
    createdBy: uid,
    provider: "salla",
    order_id: "order-sync-1",
    order_number: "SYNC-1",
    total: 1,
    items: [{
      name: "Old sync item",
      sku: "INSTALL-SYNC-1",
      remote_item_id: "line-sync-1",
      quantity: 1,
      unit_price: 1,
      total_price: 1,
      order_type: "install_maintenance",
      status: "awaiting_schedule",
    }],
    last_event_at: "2026-07-12T11:00:00.000Z",
    imported_at: "2026-07-12T10:00:00.000Z",
  });
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/admin/v2/orders");
    assert.equal(url.searchParams.get("page"), "1");
    assert.equal(url.searchParams.get("per_page"), "30");
    return jsonResponse({
      data: [{
        id: "order-sync-1",
        reference_id: "SYNC-1",
        created_at: "2026-07-12T10:00:00.000Z",
        updated_at: "2026-07-12T11:00:00.000Z",
        status: { id: "status-2", name: "Under review", slug: "under_review" },
        customer: { name: "Sync Customer", mobile_code: "+966", mobile: "500000102" },
        items: [{ id: "line-sync-1", name: "Install item", sku: "INSTALL-SYNC-1", quantity: 1 }],
      }],
      pagination: { total: 1, totalPages: 1, currentPage: 1, perPage: 30 },
    });
  }) as typeof fetch;

  const events: Array<{ type: string; source: string }> = [];
  const unsubscribe = subscribeStoreOrderChanges(uid, (event) => events.push(event));
  let result;
  try {
    result = await syncSallaOrdersForUser(uid);
  } finally {
    unsubscribe();
  }

  assert.equal(result.success, true);
  assert.equal(result.complete, true);
  assert.equal(result.imported, 0);
  assert.equal(result.updated, 1);
  assert.equal(result.fetched, 1);
  assert.equal(result.advertised_count, 1);
  assert.equal(result.advertised_pages, 1);
  assert.deepEqual(events.map((event) => [event.type, event.source]), [["sync.completed", "salla_sync"]]);
  assert.equal((await recordsForOwner("installations", uid)).length, 0);
  assert.equal((await recordsForOwner("bookings", uid)).length, 0);

  const stored = (await salla.readLocalIntegrationStore())[uid];
  assert.equal(stored.last_order_sync_status, "success");
  assert.equal(stored.last_order_sync_complete, true);
  assert.equal(stored.last_order_sync_count, 1);
  assert.equal(stored.last_order_sync_advertised_count, 1);
  assert.equal(stored.last_order_sync_advertised_pages, 1);
  assert.equal(stored.last_order_sync_warning, null);

  const orderDoc = await adminDb
    .collection("store_orders")
    .doc(getStoreOrderDocId(uid, "salla", "order-sync-1"))
    .get();
  const orderData = orderDoc.data() || {};
  assert.equal(orderData.items[0].remote_item_id, "line-sync-1");
  assert.equal(orderData.remote_status_id, "status-2");
  assert.equal(orderData.remote_status_name, "Under review");
  assert.equal(orderData.remote_status_slug, "under_review");
  assert.equal(orderData.remote_updated_at, "2026-07-12T11:00:00.000Z");
  assert.equal(orderData.last_event_at, "2026-07-12T11:00:00.000Z");
  assert.equal(orderData.sync_origin, "salla_sync");
});

test("an older list page cannot lower a newer order watermark during metadata backfill", async () => {
  const uid = "owner-order-metadata-race";
  const remoteOrderId = "order-metadata-race";
  await linkSallaOwner(uid);
  const orderRef = adminDb.collection("store_orders").doc(getStoreOrderDocId(uid, "salla", remoteOrderId));
  await orderRef.set({
    createdBy: uid,
    provider: "salla",
    order_id: remoteOrderId,
    order_number: "RACE-1",
    customer_name: "Newer customer",
    customer_phone: "966500000777",
    total: 50,
    items: [{
      name: "Newer item",
      sku: "SALE-RACE-1",
      remote_item_id: "line-race-1",
      quantity: 1,
      unit_price: 50,
      total_price: 50,
      order_type: "sale_only",
      status: "sale_recorded",
    }],
    metadata_contract_version: 1,
    payment_method: "newer-payment",
    last_event_at: "2026-07-13T12:00:00.900Z",
    remote_updated_at: "2026-07-13T12:00:00.900Z",
    remote_synced_at: "2026-07-13T12:01:00.000Z",
    remote_status_id: "status-race",
    remote_status_name: "Processing",
    remote_status_slug: "processing",
    sync_origin: "salla_webhook",
    imported_at: "2026-07-13T10:00:00.000Z",
  });

  globalThis.fetch = (async () => jsonResponse({
    data: [{
      id: remoteOrderId,
      reference_id: "RACE-1",
      created_at: { date: "2026-07-12 10:00:00.000000", timezone: "Asia/Riyadh" },
      updated_at: "2026-07-13T12:00:00.100Z",
      payment_method: "older-payment",
      status: { id: "status-race", name: "Processing", slug: "processing" },
      customer: { name: "Older customer", mobile_code: "+966", mobile: "500000777" },
      amounts: { total: { amount: 50, currency: "SAR" } },
      items: [{
        id: "line-race-1",
        name: "Older item",
        sku: "SALE-RACE-1",
        quantity: 1,
        amounts: { price_without_tax: { amount: 50 }, total: { amount: 50 } },
      }],
    }],
    pagination: { total: 1, totalPages: 1, currentPage: 1, perPage: 30 },
  })) as typeof fetch;

  const result = await syncSallaOrdersForUser(uid);
  assert.equal(result.success, true);

  const stored = (await orderRef.get()).data() || {};
  assert.equal(stored.last_event_at, "2026-07-13T12:00:00.900Z");
  assert.equal(stored.remote_updated_at, "2026-07-13T12:00:00.900Z");
  assert.equal(stored.payment_method, "newer-payment");
  assert.equal(stored.customer_name, "Newer customer");
  assert.equal(stored.items[0].name, "Newer item");
  assert.equal(stored.metadata_contract_version, 1);
  assert.equal((await customersForOwner(uid)).length, 0);
  assert.equal((await recordsForOwner("products", uid)).length, 0);
});

test("uses independent customer pagination and requests bidirectional Salla scopes", () => {
  process.env.SALLA_SYNC_PAGE_SIZE = "10";
  process.env.SALLA_SYNC_MAX_PAGES = "3";
  process.env.SALLA_CUSTOMER_SYNC_PAGE_SIZE = "99";
  process.env.SALLA_CUSTOMER_SYNC_MAX_PAGES = "999";
  process.env.SALLA_SCOPES = "offline_access orders.read products.read";

  assert.equal(salla.pageSize(), 10);
  assert.equal(salla.customerPageSize(), 60);
  assert.equal(salla.customerMaxSyncPages(), 200);
  assert.equal(
    salla.defaultScopes(),
    "offline_access orders.read_write products.read_write customers.read_write webhooks.read_write",
  );
});

test("syncs 4,610 customers across all 77 advertised pages", async () => {
  const uid = "owner-customer-4610";
  const total = 4_610;
  const perPage = 60;
  const totalPages = Math.ceil(total / perPage);
  process.env.SALLA_CUSTOMER_SYNC_PAGE_SIZE = String(perPage);
  process.env.SALLA_CUSTOMER_SYNC_MAX_PAGES = "200";
  await linkSallaOwner(uid);

  const requestedPages: number[] = [];
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/admin/v2/customers");
    assert.equal(url.searchParams.get("per_page"), "60");
    const page = Number(url.searchParams.get("page"));
    requestedPages.push(page);
    const start = (page - 1) * perPage;
    const count = Math.max(0, Math.min(perPage, total - start));
    const data = Array.from({ length: count }, (_, offset) => {
      const index = start + offset;
      return {
        id: `remote-${index}`,
        name: `Customer ${index}`,
        mobile: `05${String(index).padStart(8, "0")}`,
        city: "Riyadh",
      };
    });
    return jsonResponse({
      data,
      pagination: { currentPage: page, totalPages, perPage, total },
    });
  }) as typeof fetch;

  const result = await syncSallaCustomersForUser(uid);
  assert.equal(result.success, true);
  assert.equal(result.partial, false);
  assert.equal(result.imported, total);
  assert.equal(result.updated, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.fetched, total);
  assert.equal(result.unique_fetched, total);
  assert.equal(result.advertised_count, total);
  assert.equal(result.warning, null);
  assert.equal(result.pages, totalPages);
  assert.deepEqual(requestedPages, Array.from({ length: totalPages }, (_, index) => index + 1));
  assert.equal((await customersForOwner(uid)).length, total);

  const stored = (await salla.readLocalIntegrationStore())[uid];
  assert.equal(stored.last_customer_sync_status, "success");
  assert.equal(stored.last_customer_sync_complete, true);
  assert.equal(stored.last_customer_sync_count, total);
  assert.equal(stored.last_customer_sync_error, null);
  assert.equal(stored.last_customer_sync_advertised_count, total);
  assert.equal(stored.last_customer_sync_warning, null);
});

test("accepts all advertised pages when Salla total exceeds the unique rows returned", async () => {
  const uid = "owner-customer-advertised-mismatch";
  const advertisedTotal = 4_610;
  const returnedTotal = 4_598;
  const perPage = 60;
  const totalPages = 77;
  process.env.SALLA_CUSTOMER_SYNC_PAGE_SIZE = String(perPage);
  process.env.SALLA_CUSTOMER_SYNC_MAX_PAGES = "200";
  await linkSallaOwner(uid);

  const requestedPages: number[] = [];
  globalThis.fetch = (async (input) => {
    const page = Number(new URL(String(input)).searchParams.get("page"));
    requestedPages.push(page);
    const start = (page - 1) * perPage;
    const count = Math.max(0, Math.min(perPage, returnedTotal - start));
    return jsonResponse({
      data: Array.from({ length: count }, (_, offset) => {
        const index = start + offset;
        return { id: `mismatch-${index}`, name: `Mismatch ${index}`, mobile: `05${String(index).padStart(8, "0")}` };
      }),
      pagination: { currentPage: page, totalPages, perPage, total: advertisedTotal },
    });
  }) as typeof fetch;

  const result = await syncSallaCustomersForUser(uid);
  assert.equal(result.success, true);
  assert.equal(result.partial, false);
  assert.equal(result.cap_reached, false);
  assert.equal(result.pages, totalPages);
  assert.equal(result.fetched, returnedTotal);
  assert.equal(result.unique_fetched, returnedTotal);
  assert.equal(result.imported, returnedTotal);
  assert.equal(result.advertised_count, advertisedTotal);
  assert.match(result.warning || "", /advertised 4610.*returned 4598 unique customers/i);
  assert.deepEqual(requestedPages, Array.from({ length: totalPages }, (_, index) => index + 1));
  assert.equal((await customersForOwner(uid)).length, returnedTotal);

  const stored = (await salla.readLocalIntegrationStore())[uid];
  assert.equal(stored.last_customer_sync_status, "success");
  assert.equal(stored.last_customer_sync_complete, true);
  assert.equal(stored.last_customer_sync_count, returnedTotal);
  assert.equal(stored.last_customer_sync_advertised_count, advertisedTotal);
  assert.equal(stored.last_customer_sync_error, null);
  assert.match(stored.last_customer_sync_warning || "", /accepted as complete/i);
});

test("fails after reading all pages when a mapped customer identity repeats across pages", async () => {
  const uid = "owner-customer-cross-page-duplicate";
  process.env.SALLA_CUSTOMER_SYNC_PAGE_SIZE = "2";
  process.env.SALLA_CUSTOMER_SYNC_MAX_PAGES = "10";
  await linkSallaOwner(uid);
  const requestedPages: number[] = [];
  globalThis.fetch = (async (input) => {
    const page = Number(new URL(String(input)).searchParams.get("page"));
    requestedPages.push(page);
    return jsonResponse({
      data: page === 1
        ? [
            { id: "duplicate-a", name: "A", mobile: "0501000001" },
            { id: "duplicate-b", name: "B", mobile: "0501000002" },
          ]
        : [
            { id: "duplicate-b", name: "B again", mobile: "0501000002" },
            { id: "duplicate-c", name: "C", mobile: "0501000003" },
          ],
      pagination: { currentPage: page, totalPages: 2, perPage: 2, total: 4 },
    });
  }) as typeof fetch;

  const result = await syncSallaCustomersForUser(uid);
  assert.equal(result.success, false);
  assert.equal(result.partial, true);
  assert.equal(result.pages, 2);
  assert.equal(result.fetched, 4);
  assert.equal(result.unique_fetched, 3);
  assert.equal(result.imported, 3);
  assert.deepEqual(requestedPages, [1, 2]);
  assert.match(result.last_error || "", /1 duplicate Salla customer identities.*across different pages/i);
  assert.equal((await customersForOwner(uid)).length, 3);
  const stored = (await salla.readLocalIntegrationStore())[uid];
  assert.equal(stored.last_customer_sync_complete, false);
  assert.equal(stored.last_customer_sync_count, 3);
});

test("fails a large advertised-count difference even without duplicate identities", async () => {
  const uid = "owner-customer-count-tolerance";
  const advertisedTotal = 120;
  const returnedTotal = 100;
  const perPage = 60;
  process.env.SALLA_CUSTOMER_SYNC_PAGE_SIZE = String(perPage);
  process.env.SALLA_CUSTOMER_SYNC_MAX_PAGES = "10";
  await linkSallaOwner(uid);
  globalThis.fetch = (async (input) => {
    const page = Number(new URL(String(input)).searchParams.get("page"));
    const start = (page - 1) * perPage;
    const count = Math.max(0, Math.min(perPage, returnedTotal - start));
    return jsonResponse({
      data: Array.from({ length: count }, (_, offset) => {
        const index = start + offset;
        return { id: `tolerance-${index}`, name: `Tolerance ${index}`, mobile: `05${String(index).padStart(8, "0")}` };
      }),
      pagination: { currentPage: page, totalPages: 2, perPage, total: advertisedTotal },
    });
  }) as typeof fetch;

  const result = await syncSallaCustomersForUser(uid);
  assert.equal(result.success, false);
  assert.equal(result.partial, true);
  assert.equal(result.cap_reached, false);
  assert.equal(result.pages, 2);
  assert.equal(result.unique_fetched, returnedTotal);
  assert.equal(result.advertised_count, advertisedTotal);
  assert.match(result.last_error || "", /differs by 20.*allowed tolerance of 5/i);
  assert.equal((await salla.readLocalIntegrationStore())[uid].last_customer_sync_complete, false);
});

test("keeps duplicate phones separate, follows a remote id through phone changes, and accepts no phone", async () => {
  const uid = "owner-customer-identity";
  process.env.SALLA_CUSTOMER_SYNC_PAGE_SIZE = "60";
  await linkSallaOwner(uid);

  let remoteCustomers = [
    { id: "remote-a", name: "A", mobile: "0500000001", city: "Riyadh" },
    { id: "remote-b", name: "B", mobile: "0500000001", city: "Jeddah" },
    { id: "remote-no-phone", name: "No phone", city: "Dammam" },
  ];
  globalThis.fetch = (async () => jsonResponse({
    data: remoteCustomers,
    pagination: { currentPage: 1, totalPages: 1, perPage: 60, total: remoteCustomers.length },
  })) as typeof fetch;

  const first = await syncSallaCustomersForUser(uid);
  assert.deepEqual(
    { success: first.success, imported: first.imported, updated: first.updated, failed: first.failed },
    { success: true, imported: 3, updated: 0, failed: 0 },
  );
  const initialRows = await customersForOwner(uid);
  const initialA = initialRows.find((row) => row.store_customer_id === "remote-a");
  const initialB = initialRows.find((row) => row.store_customer_id === "remote-b");
  const initialNoPhone = initialRows.find((row) => row.store_customer_id === "remote-no-phone");
  assert.ok(initialA && initialB && initialNoPhone);
  assert.notEqual(initialA.id, initialB.id);
  assert.equal(initialA.phone, initialB.phone);
  assert.equal(initialNoPhone.phone, "");

  await new Promise((resolve) => setTimeout(resolve, 5));
  remoteCustomers = [
    { id: "remote-a", name: "A changed", mobile: "0500000099", city: "Riyadh" },
    { id: "remote-b", name: "B", mobile: "0500000001", city: "Jeddah" },
    { id: "remote-no-phone", name: "No phone", city: "Dammam" },
  ];
  const second = await syncSallaCustomersForUser(uid);
  assert.deepEqual(
    { success: second.success, imported: second.imported, updated: second.updated, failed: second.failed },
    { success: true, imported: 0, updated: 3, failed: 0 },
  );
  const updatedRows = await customersForOwner(uid);
  const updatedA = updatedRows.find((row) => row.store_customer_id === "remote-a");
  assert.equal(updatedRows.length, 3);
  assert.equal(updatedA?.id, initialA.id);
  assert.notEqual(updatedA?.phone, initialA.phone);
  assert.equal(updatedA?.createdAt, initialA.createdAt);
  assert.notEqual(updatedA?.updatedAt, initialA.updatedAt);

  const fallbackOne = salla.mapSallaCustomer(uid, { name: "Fallback", email: "USER@example.com" });
  const fallbackTwo = salla.mapSallaCustomer(uid, { email: "user@example.com", name: "Fallback" });
  assert.equal(fallbackOne.documentId, fallbackTwo.documentId);
});

test("maps Salla customer fields used by the store-style filters", () => {
  const mapped = salla.mapSallaCustomer("owner-customer-metadata", {
    id: 404,
    name: "Customer filters",
    mobile: "0501112233",
    email: "FILTERS@EXAMPLE.COM",
    city: { id: 1, name: "الرياض" },
    country: { code: "SA", name: "السعودية" },
    gender: "female",
    groups: [{ id: 9, name: "عملاء مميزون" }, { id: 9, name: "مكرر" }, "جملة"],
    is_blocked: true,
    block_reason: "مراجعة الحساب",
    created_at: { date: "2024-02-10 08:30:00.000000", timezone: "Asia/Riyadh" },
    updated_at: { date: "2026-07-13 10:00:00.000000", timezone: "Asia/Riyadh" },
  });

  assert.deepEqual({
    email: mapped.email,
    city: mapped.city,
    country: mapped.country,
    gender: mapped.gender,
    groups: mapped.groups,
    isBlocked: mapped.isBlocked,
    blockReason: mapped.blockReason,
    remoteCreatedAt: mapped.remoteCreatedAt,
    remoteUpdatedAt: mapped.remoteUpdatedAt,
    remoteTimezone: mapped.remoteTimezone,
  }, {
    email: "filters@example.com",
    city: "الرياض",
    country: "السعودية",
    gender: "female",
    groups: [{ id: "9", name: "عملاء مميزون" }, { id: null, name: "جملة" }],
    isBlocked: true,
    blockReason: "مراجعة الحساب",
    remoteCreatedAt: "2024-02-10T05:30:00.000Z",
    remoteUpdatedAt: "2026-07-13T07:00:00.000Z",
    remoteTimezone: "Asia/Riyadh",
  });
});

test("remote timestamp equality keeps millisecond precision", () => {
  assert.equal(
    salla.sameRemoteStamp("2026-07-13T10:00:00.100Z", "2026-07-13T10:00:00.100Z"),
    true,
  );
  assert.equal(
    salla.sameRemoteStamp("2026-07-13T10:00:00.100Z", "2026-07-13T10:00:00.900Z"),
    false,
  );
});

test("newly available and explicitly cleared metadata refresh an existing order contract", () => {
  assert.equal(salla.filterMetadataDiffers({
    metadata_contract_version: 2,
    payment_method: null,
    is_read: null,
  }, {
    payment_method: "mada",
    is_read: false,
  }), true);
  assert.equal(salla.filterMetadataDiffers({
    payment_method: "mada",
    is_read: false,
    shipping_company: "Aramex",
    order_tags: ["VIP"],
  }, {
    payment_method: "mada",
    is_read: false,
    shipping_company: null,
    order_tags: [],
  }), true);
  assert.equal(salla.filterMetadataDiffers({
    payment_method: "mada",
    shipping_company: "Aramex",
  }, {
    payment_method: "mada",
  }), false);
});

test("remote sync watermark only moves forward regardless of page order", () => {
  assert.equal(
    salla.newestRemoteTimestamp("2026-07-13T10:00:00.900Z", "2026-07-13T09:00:00.000Z"),
    "2026-07-13T10:00:00.900Z",
  );
  assert.equal(
    salla.newestRemoteTimestamp("2026-07-13T10:00:00.100Z", "2026-07-13T10:00:00.900Z"),
    "2026-07-13T10:00:00.900Z",
  );
  assert.equal(salla.newestRemoteTimestamp(null, "not-a-date"), null);
});

test("list payload omissions preserve detail metadata while explicit empty fields clear it", () => {
  const omitted = salla.sallaOrderMetadata({
    id: 1,
    date: { date: "2026-07-13 12:00:00.000000", timezone: "Asia/Riyadh" },
  }, "2026-07-13T10:00:00.000Z");
  assert.equal(Object.prototype.hasOwnProperty.call(omitted, "shipping_company"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(omitted, "order_tags"), false);

  const cleared = salla.sallaOrderMetadata({
    id: 1,
    shipping_company: null,
    tags: [],
  }, "2026-07-13T10:00:00.000Z");
  assert.equal(cleared.shipping_company, null);
  assert.deepEqual(cleared.order_tags, []);
});

test("reuses an unbound legacy Salla customer without colliding with another provider", async () => {
  const uid = "owner-customer-legacy";
  await linkSallaOwner(uid);
  const collection = adminDb.collection("customers");
  await collection.doc("other-provider-row").set({
    createdBy: uid,
    name: "Other provider",
    phone: "966500000010",
    source: "odoo",
    store_provider: "odoo",
    store_customer_id: "remote-cross-provider",
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
  });
  await collection.doc("legacy-salla-row").set({
    createdBy: uid,
    name: "Legacy Salla",
    phone: "0500000020",
    source: "salla",
    store_provider: "salla",
    store_customer_id: null,
    createdAt: "2021-01-01T00:00:00.000Z",
    updatedAt: "2021-01-01T00:00:00.000Z",
  });

  globalThis.fetch = (async () => jsonResponse({
    data: [
      { id: "remote-cross-provider", name: "Salla cross", mobile: "0500000010" },
      { id: "remote-legacy", name: "Bound legacy", mobile: "0500000020" },
    ],
    pagination: { currentPage: 1, totalPages: 1, perPage: 60, total: 2 },
  })) as typeof fetch;

  const result = await syncSallaCustomersForUser(uid);
  assert.deepEqual(
    { success: result.success, imported: result.imported, updated: result.updated },
    { success: true, imported: 1, updated: 1 },
  );
  const rows = await customersForOwner(uid);
  const otherProvider = rows.find((row) => row.id === "other-provider-row");
  const crossProviderSalla = rows.find((row) => row.store_provider === "salla" && row.store_customer_id === "remote-cross-provider");
  const boundLegacy = rows.find((row) => row.store_customer_id === "remote-legacy");
  assert.equal(rows.length, 3);
  assert.equal(otherProvider?.name, "Other provider");
  assert.ok(crossProviderSalla);
  assert.notEqual(crossProviderSalla?.id, otherProvider?.id);
  assert.equal(boundLegacy?.id, "legacy-salla-row");
  assert.equal(boundLegacy?.createdAt, "2021-01-01T00:00:00.000Z");
});

test("returns a clear partial failure when the customer page cap is below totalPages", async () => {
  const uid = "owner-customer-cap";
  process.env.SALLA_CUSTOMER_SYNC_PAGE_SIZE = "2";
  process.env.SALLA_CUSTOMER_SYNC_MAX_PAGES = "2";
  await linkSallaOwner(uid);
  const requestedPages: number[] = [];
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    const page = Number(url.searchParams.get("page"));
    requestedPages.push(page);
    return jsonResponse({
      data: [0, 1].map((offset) => ({
        id: `cap-${page}-${offset}`,
        name: `Cap ${page}-${offset}`,
        mobile: `05010${page}${offset}000`,
      })),
      pagination: { currentPage: page, totalPages: 3, perPage: 2, total: 6 },
    });
  }) as typeof fetch;

  const result = await syncSallaCustomersForUser(uid);
  assert.equal(result.success, false);
  assert.equal(result.partial, true);
  assert.equal(result.cap_reached, true);
  assert.equal(result.failed, 0);
  assert.equal(result.imported, 4);
  assert.equal(result.pages, 2);
  assert.deepEqual(requestedPages, [1, 2]);
  assert.match(result.last_error || "", /page limit \(2 of 3 pages\)/i);

  const status = await getSallaStatus(uid, {
    protocol: "https",
    get: () => "crm.example.test",
  } as never);
  assert.equal(status.last_customer_sync_status, "failed");
  assert.equal(status.last_customer_sync_count, 4);
  assert.equal(status.last_customer_sync_complete, false);
  assert.match(status.last_customer_sync_error || "", /page limit/i);
});

test("treats an empty page before advertised totals as an incomplete sync", async () => {
  const uid = "owner-customer-empty-page";
  process.env.SALLA_CUSTOMER_SYNC_PAGE_SIZE = "2";
  process.env.SALLA_CUSTOMER_SYNC_MAX_PAGES = "10";
  await linkSallaOwner(uid);
  const requestedPages: number[] = [];
  globalThis.fetch = (async (input) => {
    const page = Number(new URL(String(input)).searchParams.get("page"));
    requestedPages.push(page);
    return jsonResponse({
      data: page === 1
        ? [
            { id: "empty-a", name: "A", mobile: "0501111111" },
            { id: "empty-b", name: "B", mobile: "0502222222" },
          ]
        : [],
      pagination: { currentPage: page, totalPages: 3, perPage: 2, total: 6 },
    });
  }) as typeof fetch;

  const result = await syncSallaCustomersForUser(uid);
  assert.equal(result.success, false);
  assert.equal(result.partial, true);
  assert.equal(result.cap_reached, false);
  assert.equal(result.fetched, 2);
  assert.equal(result.unique_fetched, 2);
  assert.equal(result.advertised_count, 6);
  assert.match(result.warning || "", /sync is incomplete/i);
  assert.deepEqual(requestedPages, [1, 2]);
  assert.match(result.last_error || "", /empty customer page at page 2/i);
  const stored = (await salla.readLocalIntegrationStore())[uid];
  assert.equal(stored.last_customer_sync_complete, false);
  assert.equal(stored.last_customer_sync_count, 2);
  assert.equal(stored.last_customer_sync_advertised_count, 6);
  assert.match(stored.last_customer_sync_warning || "", /sync is incomplete/i);
});

test("only delays complete scheduled customer syncs for the configured interval", () => {
  const now = Date.now();
  process.env.SALLA_CUSTOMER_SYNC_INTERVAL_MINUTES = "360";
  const recentComplete = {
    last_customer_sync_status: "success",
    last_customer_sync_complete: true,
    last_customer_sync_at: new Date(now - 30 * 60_000).toISOString(),
  };
  assert.equal(salla.customerSyncIntervalMinutes(), 360);
  assert.equal(salla.customerSyncIsDue(recentComplete as never, now), false);
  assert.equal(salla.customerSyncIsDue({ ...recentComplete, last_customer_sync_complete: undefined } as never, now), true);
  assert.equal(salla.customerSyncIsDue({ ...recentComplete, last_customer_sync_complete: false } as never, now), true);
  assert.equal(salla.customerSyncIsDue({ ...recentComplete, last_customer_sync_at: new Date(now - 361 * 60_000).toISOString() } as never, now), true);
});

test("coalesces overlapping customer syncs for one owner", async () => {
  const uid = "owner-customer-lock";
  await linkSallaOwner(uid);
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 15));
    return jsonResponse({
      data: [{ id: "locked-customer", name: "Locked", mobile: "0503333333" }],
      pagination: { currentPage: 1, totalPages: 1, perPage: 60, total: 1 },
    });
  }) as typeof fetch;

  const results = await Promise.all([
    syncSallaCustomersForUser(uid),
    syncSallaCustomersForUser(uid),
    syncSallaCustomersForUser(uid),
  ]);

  assert.equal(calls, 1);
  assert.deepEqual(results.map((result) => result.imported), [1, 1, 1]);
  assert.equal((await customersForOwner(uid)).length, 1);
});

test("preserves partial counters when a sync error is converted to a result", () => {
  const error = new Error("page 40 timed out") as Error & { detail?: Record<string, unknown> };
  error.detail = {
    imported: 2_340,
    updated: 120,
    failed: 0,
    fetched: 2_460,
    pages: 39,
    last_sync_at: "2026-07-12T20:00:00.000Z",
    last_error: "Salla customer page 40 timed out.",
  };

  assert.deepEqual(salla.syncFailureResult(error), {
    success: false,
    imported: 2_340,
    updated: 120,
    failed: 1,
    pages: 39,
    fetched: 2_460,
    last_sync_at: "2026-07-12T20:00:00.000Z",
    last_error: "Salla customer page 40 timed out.",
    partial: true,
    cap_reached: false,
  });
});

test("never retries a token POST after an explicit transient HTTP response", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return jsonResponse({ message: "temporarily unavailable" }, 503, { "retry-after": "0" });
  }) as typeof fetch;

  const error = await captureRejection(() => salla.requestSallaJson(
    "https://accounts.salla.sa/oauth2/token",
    { method: "POST", body: "grant_type=refresh_token" },
    { maxRetries: 4, timeoutMs: 100 },
  ));
  assert.equal(calls, 1);
  assert.equal(salla.isTransientSallaError(error), true);
  assert.equal(salla.statusAfterSyncFailure(error), "error");
});

test("only authentication failures latch the integration into error", async () => {
  assert.equal(salla.statusAfterSyncFailure(new Error("mapping failed")), "connected");
  globalThis.fetch = (async () => jsonResponse({ message: "unauthorized" }, 401)) as typeof fetch;
  const unauthorized = await captureRejection(() => salla.requestSallaJson(
    "https://api.salla.dev/admin/v2/orders",
    {},
    { maxRetries: 0, timeoutMs: 100 },
  ));
  assert.equal(salla.statusAfterSyncFailure(unauthorized), "error");
});

test("aborts a stalled request at the configured timeout", async () => {
  globalThis.fetch = ((_input, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    const abort = () => reject(new DOMException("aborted", "AbortError"));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  })) as typeof fetch;

  const error = await captureRejection(() => salla.requestSallaJson(
    "https://api.salla.dev/admin/v2/orders",
    {},
    { maxRetries: 0, timeoutMs: 20 },
  ));
  assert.match((error as Error).message, /timed out after 20ms/i);
  assert.equal(salla.isTransientSallaError(error), true);
});

test("serializes concurrent local writes and leaves valid atomic JSON", async () => {
  await Promise.all(Array.from({ length: 12 }, (_, index) => salla.writeIntegration(
    `owner-${index}`,
    {
      status: "connected",
      access_token: `access-${index}`,
      refresh_token: `refresh-${index}`,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    },
  )));

  const store = await salla.readLocalIntegrationStore();
  assert.equal(Object.keys(store).length, 12);
  for (let index = 0; index < 12; index += 1) {
    assert.equal(store[`owner-${index}`]?.createdBy, `owner-${index}`);
  }
  const rawStore = await readFile(storePath, "utf8");
  assert.doesNotThrow(() => JSON.parse(rawStore));
  const files = await readdir(testRoot);
  assert.equal(files.some((name) => name.endsWith(".tmp")), false);
});

test("does not treat a corrupt existing integration store as empty", async () => {
  await writeFile(storePath, "{not-json", "utf8");
  await assert.rejects(() => salla.readLocalIntegrationStore(), /corrupted and was not replaced/i);
  await assert.rejects(() => salla.writeIntegration("owner", { status: "connected" }), /corrupted and was not replaced/i);
  assert.equal(await readFile(storePath, "utf8"), "{not-json");
});

test("rejects integration-store path overrides outside the test environment", async () => {
  process.env.NODE_ENV = "production";
  try {
    await assert.rejects(
      () => salla.readLocalIntegrationStore(),
      /test-only and cannot override the production token store path/i,
    );
  } finally {
    process.env.NODE_ENV = "test";
  }
});

test("persists an Easy Mode authorization bundle before metadata completes", async () => {
  const uid = "owner-grant-window";
  process.env.SALLA_APP_OWNER_UID = uid;
  let metadataStartedResolve!: () => void;
  const metadataStarted = new Promise<void>((resolve) => {
    metadataStartedResolve = resolve;
  });
  let releaseMetadata!: () => void;
  const metadataGate = new Promise<void>((resolve) => {
    releaseMetadata = resolve;
  });

  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.includes("/oauth2/user/info") || url.includes("/store/info")) {
      metadataStartedResolve();
      await metadataGate;
      return url.includes("/store/info")
        ? jsonResponse({ data: { id: "merchant", name: "Store", domain: "shop.example.test" } })
        : jsonResponse({ data: { merchant: { id: "merchant", name: "Store", domain: "shop.example.test" } } });
    }
    throw new Error(`Unexpected mocked request: ${url}`);
  }) as typeof fetch;

  const body = {
    event: "app.store.authorize",
    merchant: "merchant",
    created_at: "2026-07-12 12:00:00",
    data: {
      access_token: "issued-access",
      refresh_token: "issued-refresh",
      expires: Math.floor(Date.now() / 1000) + 3600,
      scope: "offline_access orders.read",
      token_type: "bearer",
    },
  };
  const rawBody = Buffer.from(JSON.stringify(body));
  const request = {
    body,
    rawBody,
    get(name: string) {
      return name.toLowerCase() === "authorization"
        ? `Bearer ${process.env.SALLA_APP_WEBHOOK_SECRET}`
        : "";
    },
  };

  const pending = handleSallaAppWebhook(request as never);
  await metadataStarted;
  const storedBeforeMetadata = (await salla.readLocalIntegrationStore())[uid];
  assert.equal(storedBeforeMetadata.status, "connected");
  assert.equal(storedBeforeMetadata.access_token, "issued-access");
  assert.equal(storedBeforeMetadata.refresh_token, "issued-refresh");
  assert.equal(storedBeforeMetadata.store_url, undefined);

  releaseMetadata();
  const result = await pending;
  assert.equal(result.linked, true);
  const storedAfterMetadata = (await salla.readLocalIntegrationStore())[uid];
  assert.equal(storedAfterMetadata.store_url, "https://shop.example.test/");
});

test("quarantines a refresh token when the POST outcome is unknown", async () => {
  const uid = "owner-unknown-refresh";
  await salla.writeIntegration(uid, {
    status: "connected",
    access_token: "expired-access",
    refresh_token: "possibly-consumed-refresh",
    expires_at: new Date(Date.now() - 60_000).toISOString(),
    scope: "offline_access orders.read",
  });
  const stale = (await salla.readLocalIntegrationStore())[uid];
  let calls = 0;
  globalThis.fetch = (async (input) => {
    calls += 1;
    assert.match(String(input), /\/oauth2\/token$/);
    throw new TypeError("connection reset after request upload");
  }) as typeof fetch;

  const error = await captureRejection(() => salla.ensureFreshAccessToken(uid, stale));
  assert.equal(calls, 1);
  assert.equal(salla.statusAfterSyncFailure(error), "error");
  const stored = (await salla.readLocalIntegrationStore())[uid];
  assert.equal(stored.status, "error");
  assert.equal(stored.refresh_token, null);
  assert.match(stored.last_sync_error || "", /reconnect the salla app/i);
  assert.doesNotMatch(stored.last_sync_error || "", /possibly-consumed-refresh|expired-access/);
});

test("refresh mutex re-reads the record and consumes a refresh token once", async () => {
  const uid = "owner-refresh";
  await salla.writeIntegration(uid, {
    status: "connected",
    access_token: "expired-access",
    refresh_token: "single-use-refresh",
    expires_at: new Date(Date.now() - 60_000).toISOString(),
    scope: "offline_access orders.read",
  });
  const stale = (await salla.readLocalIntegrationStore())[uid];
  let tokenCalls = 0;

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("/oauth2/token")) {
      tokenCalls += 1;
      assert.equal(init?.method, "POST");
      await new Promise((resolve) => setTimeout(resolve, 5));
      return jsonResponse({
        access_token: "rotated-access",
        refresh_token: "rotated-refresh",
        expires_in: 3600,
        scope: "offline_access orders.read",
        token_type: "bearer",
      });
    }
    if (url.includes("/oauth2/user/info")) {
      return jsonResponse({ data: { merchant: { id: "merchant", name: "Store", domain: "shop.example.test" } } });
    }
    if (url.includes("/store/info")) {
      return jsonResponse({ data: { id: "merchant", name: "Store", domain: "shop.example.test" } });
    }
    throw new Error(`Unexpected mocked request: ${url}`);
  }) as typeof fetch;

  const tokens = await Promise.all([
    salla.ensureFreshAccessToken(uid, stale),
    salla.ensureFreshAccessToken(uid, stale),
    salla.ensureFreshAccessToken(uid, stale),
  ]);
  assert.deepEqual(tokens, ["rotated-access", "rotated-access", "rotated-access"]);
  assert.equal(tokenCalls, 1);
  const stored = (await salla.readLocalIntegrationStore())[uid];
  assert.equal(stored.access_token, "rotated-access");
  assert.equal(stored.refresh_token, "rotated-refresh");
  assert.equal(stored.store_url, "https://shop.example.test/");
});

test("refreshes once after a 401 and retries the safe GET with the new token", async () => {
  const uid = "owner-401";
  await salla.writeIntegration(uid, {
    status: "connected",
    access_token: "rejected-access",
    refresh_token: "refresh-after-401",
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    scope: "offline_access orders.read",
  });
  const session = { uid, accessToken: "rejected-access" };
  let tokenCalls = 0;
  let orderCalls = 0;

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("/oauth2/token")) {
      tokenCalls += 1;
      return jsonResponse({
        access_token: "accepted-access",
        refresh_token: "accepted-refresh",
        expires_in: 3600,
        scope: "offline_access orders.read",
        token_type: "bearer",
      });
    }
    if (url.includes("/oauth2/user/info") || url.includes("/store/info")) {
      return jsonResponse({ data: {} });
    }
    if (url.includes("/orders")) {
      orderCalls += 1;
      const authorization = new Headers(init?.headers).get("authorization");
      return authorization === "Bearer accepted-access"
        ? jsonResponse({ data: [] })
        : jsonResponse({ message: "unauthorized" }, 401);
    }
    throw new Error(`Unexpected mocked request: ${url}`);
  }) as typeof fetch;

  const result = await salla.authorizedSallaGet<{ data: unknown[] }>(
    session,
    "https://api.salla.dev/admin/v2/orders",
  );
  assert.deepEqual(result, { data: [] });
  assert.equal(session.accessToken, "accepted-access");
  assert.equal(tokenCalls, 1);
  assert.equal(orderCalls, 2);
});
