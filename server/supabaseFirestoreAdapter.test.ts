import assert from "node:assert/strict";
import test from "node:test";
import { createSupabaseFirestoreAdapter } from "./supabaseFirestoreAdapter";

function mockedRows(total: number, calls: URL[]) {
  return async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    calls.push(url);
    const limit = Number(url.searchParams.get("limit") || 1_000);
    const offset = Number(url.searchParams.get("offset") || 0);
    const length = Math.max(0, Math.min(limit, total - offset));
    const rows = Array.from({ length }, (_, index) => ({
      id: `customer-${offset + index}`,
      owner_uid: "owner-a",
    }));
    return new Response(JSON.stringify(rows), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

async function withMockedSupabase(total: number, run: (calls: URL[]) => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const calls: URL[] = [];
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
  globalThis.fetch = mockedRows(total, calls) as typeof fetch;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
  }
}

test("Supabase adapter splits limits above 1000 into deterministic pages", async () => {
  await withMockedSupabase(2_505, async (calls) => {
    const adapter = createSupabaseFirestoreAdapter();
    const snapshot = await adapter
      .collection("customers")
      .where("createdBy", "==", "owner-a")
      .orderBy("name")
      .limit(2_505)
      .get();

    assert.equal(snapshot.size, 2_505);
    assert.deepEqual(calls.map((url) => url.searchParams.get("limit")), ["1000", "1000", "505"]);
    assert.deepEqual(calls.map((url) => url.searchParams.get("offset")), ["0", "1000", "2000"]);
    assert.ok(calls.every((url) => url.searchParams.get("order") === "name.asc,id.asc"));
    assert.ok(calls.every((url) => url.searchParams.has("owner_uid")));
  });
});

test("Supabase adapter stops after the first short page", async () => {
  await withMockedSupabase(1_500, async (calls) => {
    const snapshot = await createSupabaseFirestoreAdapter()
      .collection("customers")
      .limit(10_000)
      .get();

    assert.equal(snapshot.size, 1_500);
    assert.deepEqual(calls.map((url) => url.searchParams.get("offset")), ["0", "1000"]);
  });
});

test("Supabase adapter maps Salla order-sync fields and preserves JSON payloads", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  let stored: Record<string, unknown> | undefined;
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") {
      stored = (JSON.parse(String(init.body)) as Array<Record<string, unknown>>)[0];
      return new Response(JSON.stringify([stored]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(stored ? [stored] : []), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const adapter = createSupabaseFirestoreAdapter();
    const inboxRef = adapter.collection("salla_order_inbox").doc();
    const commandRef = adapter.collection("salla_order_commands").doc();
    assert.match(inboxRef.id, /^soi_/);
    assert.match(commandRef.id, /^soc_/);

    await commandRef.create({
      ownerUid: "owner-a",
      orderDocId: "store-order-1",
      remoteOrderId: "SALLA-1",
      commandType: "status.update",
      desiredHash: "desired-hash-1",
      attemptCount: 2,
      actorUid: "actor-a",
      payload: { status: "completed", metadata: { source: "unit-test" } },
    });

    assert.equal(stored?.owner_uid, "owner-a");
    assert.equal(stored?.order_doc_id, "store-order-1");
    assert.equal(stored?.remote_order_id, "SALLA-1");
    assert.equal(stored?.command_type, "status.update");
    assert.deepEqual(stored?.payload, { status: "completed", metadata: { source: "unit-test" } });

    const snapshot = await commandRef.get();
    const data = snapshot.data() as Record<string, unknown>;
    assert.equal(data.orderDocId, "store-order-1");
    assert.equal(data.remoteOrderId, "SALLA-1");
    assert.equal(data.commandType, "status.update");
    assert.equal(data.attemptCount, 2);
    assert.deepEqual(data.payload, { status: "completed", metadata: { source: "unit-test" } });

    const storeOrderRef = adapter.collection("store_orders").doc("store-order-1");
    await storeOrderRef.set({
      createdBy: "owner-a",
      remoteStatusName: "Completed",
      remoteSyncedAt: "2026-07-13T00:00:00.000Z",
      syncOrigin: "api",
    });
    assert.equal(stored?.remote_status_name, "Completed");
    assert.equal(stored?.remote_synced_at, "2026-07-13T00:00:00.000Z");
    assert.equal(stored?.sync_origin, "api");
    const storeOrderSnapshot = await storeOrderRef.get();
    const storeOrderData = storeOrderSnapshot.data() as Record<string, unknown>;
    assert.equal(storeOrderData.remoteStatusName, "Completed");
    assert.equal(storeOrderData.remoteSyncedAt, "2026-07-13T00:00:00.000Z");
    assert.equal(storeOrderData.syncOrigin, "api");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
  }
});

test("Supabase merge and lease claims use conditional PATCH instead of partial upsert", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const calls: Array<{ url: URL; method: string; body: Record<string, unknown> }> = [];
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    calls.push({ url, method: init?.method || "GET", body });
    return new Response(JSON.stringify([{ id: "command-1", ...body }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const ref = createSupabaseFirestoreAdapter().collection("salla_order_commands").doc("command-1");
    await ref.set({ status: "completed", completedAt: "2026-07-13T00:00:00.000Z" }, { merge: true });
    const claimed = await ref.compareAndSet(
      { status: "processing", leaseToken: "lease-a" },
      { status: "completed", leaseToken: null },
    );

    assert.equal(claimed, true);
    assert.deepEqual(calls.map((call) => call.method), ["PATCH", "PATCH"]);
    assert.equal(calls[0].url.searchParams.has("id"), true);
    assert.equal(calls[0].url.searchParams.has("on_conflict"), false);
    assert.deepEqual(calls[0].body, {
      status: "completed",
      completed_at: "2026-07-13T00:00:00.000Z",
    });
    assert.equal(calls[1].url.searchParams.has("status"), true);
    assert.equal(calls[1].url.searchParams.has("lease_token"), true);
    assert.deepEqual(calls[1].body, { status: "completed", lease_token: null });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
  }
});
