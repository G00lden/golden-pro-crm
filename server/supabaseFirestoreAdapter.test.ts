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
