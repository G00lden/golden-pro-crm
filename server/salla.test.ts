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
const { __sallaTestables: salla, handleSallaAppWebhook } = sallaModule;
const originalFetch = globalThis.fetch;

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
  globalThis.fetch = originalFetch;
  salla.resetLocks();
  await rm(storePath, { force: true });
});

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
