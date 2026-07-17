import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("FieldTech snapshot maps Breexe technicians and bookings and signature matches the wire contract", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "breexe-fieldtech-crm-"));
  process.env.DATA_PROVIDER = "sqlite";
  process.env.DB_PROVIDER = "sqlite";
  process.env.DB_PATH = join(dir, "crm.sqlite");
  const [{ adminDb }, integration, dbModule] = await Promise.all([
    import("./firebaseAdmin"),
    import("./fieldtechIntegration"),
    import("./db"),
  ]);
  t.after(() => {
    dbModule.default.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const ownerUid = "fieldtech-test-owner";
  await adminDb.collection("technicians").doc("tech-1").set({
    createdBy: ownerUid,
    name: "فني الاختبار",
    phone: "0500000000",
    specialty: "تركيب",
    max_daily: 4,
    createdAt: "2026-07-17T10:00:00.000Z",
    updatedAt: "2026-07-17T10:00:00.000Z",
  });
  await adminDb.collection("customers").doc("cust-1").set({
    createdBy: ownerUid,
    name: "عميل الاختبار",
    phone: "0511111111",
    city: "الرياض",
    createdAt: "2026-07-17T10:00:00.000Z",
    updatedAt: "2026-07-17T10:00:00.000Z",
  });
  await adminDb.collection("bookings").doc("book-1").set({
    createdBy: ownerUid,
    customer_id: "cust-1",
    customer_name: "عميل الاختبار",
    customer_phone: "0511111111",
    product_id: "prod-1",
    product_name: "جهاز اختبار",
    technician_id: "tech-1",
    tech_name: "فني الاختبار",
    date: "2026-07-17",
    scheduled_time: "10:30",
    booking_type: "installation",
    status: "confirmed",
    createdAt: "2026-07-17T10:00:00.000Z",
    updatedAt: "2026-07-17T10:00:00.000Z",
  });

  const snapshot = await integration.buildFieldTechSnapshot(ownerUid);
  assert.equal(snapshot.technicians.length, 1);
  assert.equal(snapshot.bookings.length, 1);
  assert.equal(snapshot.bookings[0].type, "تركيب");
  assert.equal(snapshot.bookings[0].address, "الرياض");
  assert.equal(snapshot.bookings[0].scheduledAt, "2026-07-17T07:30:00.000Z");

  const input = {
    secret: "a-secret-value-that-is-at-least-32-characters",
    timestamp: "1234567890",
    nonce: "nonce_1234567890123456",
    method: "POST",
    target: "/api/integrations/fieldtech/events",
    rawBody: '{"events":[]}',
  };
  const bodyHash = crypto.createHash("sha256").update(input.rawBody).digest("hex");
  const expected = crypto.createHmac("sha256", input.secret).update([input.timestamp, input.nonce, input.method, input.target, bodyHash].join("\n")).digest("hex");
  assert.equal(integration.signFieldTechRequest(input), expected);
});
