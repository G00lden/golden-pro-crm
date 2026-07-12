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
} = sallaModule;
const { adminDb } = await import("./firebaseAdmin");
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

test("uses independent customer pagination and always requests customers.read", () => {
  process.env.SALLA_SYNC_PAGE_SIZE = "10";
  process.env.SALLA_SYNC_MAX_PAGES = "3";
  process.env.SALLA_CUSTOMER_SYNC_PAGE_SIZE = "99";
  process.env.SALLA_CUSTOMER_SYNC_MAX_PAGES = "999";
  process.env.SALLA_SCOPES = "offline_access orders.read products.read";

  assert.equal(salla.pageSize(), 10);
  assert.equal(salla.customerPageSize(), 60);
  assert.equal(salla.customerMaxSyncPages(), 200);
  assert.equal(salla.defaultScopes(), "offline_access orders.read products.read customers.read");
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
  assert.equal(salla.statusAfterSyncFailure(error), "connected");
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
