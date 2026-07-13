import test from "node:test";
import assert from "node:assert/strict";
import { submitPublicLead, type PublicLeadPayload } from "./publicLead";

const payload: PublicLeadPayload = {
  name: "عميل تجريبي",
  phone: "+966551234567",
  source: "landing",
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("public lead submission only succeeds after a confirmed 2xx response", async () => {
  let received: RequestInit | undefined;
  const result = await submitPublicLead(payload, async (_input, init) => {
    received = init;
    return jsonResponse(201, { success: true, lead_id: "lead-1" });
  });

  assert.equal(result.lead_id, "lead-1");
  assert.equal(received?.method, "POST");
  assert.deepEqual(JSON.parse(String(received?.body)), payload);
});

test("public lead submission rejects 404 instead of showing a false success", async () => {
  await assert.rejects(
    submitPublicLead(payload, async () => jsonResponse(404, { error: "Not found" })),
    /غير متاحة/,
  );
});

test("public lead submission exposes clear validation and throttling failures", async () => {
  await assert.rejects(
    submitPublicLead(payload, async () => jsonResponse(400, { error: "Validation failed" })),
    /تحقق/,
  );
  await assert.rejects(
    submitPublicLead(payload, async () => jsonResponse(429, { error: "Too many requests" })),
    /محاولات/,
  );
});

test("public lead submission rejects malformed successful responses", async () => {
  await assert.rejects(
    submitPublicLead(payload, async () => jsonResponse(200, { lead_id: "lead-1" })),
    /يؤكد|حفظ الطلب/,
  );
});

test("public lead submission turns network failures into a useful message", async () => {
  await assert.rejects(
    submitPublicLead(payload, async () => { throw new TypeError("fetch failed"); }),
    /تحقق من اتصالك/,
  );
});
