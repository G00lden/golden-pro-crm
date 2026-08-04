import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.DATA_PROVIDER = "sqlite";
process.env.DB_PROVIDER = "sqlite";
process.env.DB_PATH = ":memory:";
process.env.MAINTENANCE_PORTAL_SECRET = "acceptance-test-maintenance-secret-32-characters";
process.env.MAINTENANCE_PORTAL_TOKEN_TTL_DAYS = "1";
process.env.MAINTENANCE_MIN_LEAD_HOURS = "2";

const { adminDb } = await import("./firebaseAdmin");
const {
  assignMaintenanceRequest,
  getMaintenanceRequestByPortalToken,
  maintenancePortalToken,
  maintenancePortalTokenForRequest,
  updateMaintenancePortalAccess,
} = await import("./maintenanceRequestService");
const { applyMaintenanceMutation } = await import("./maintenanceRequestAtomic");
const { assertMaintenanceLeadTime, maintenanceCalendarDate } = await import("./maintenanceRequestValidation");
const { assertStoredBookingCompletionEvidence } = await import("./fieldtechEvidence");

function futureDate(days: number) {
  return new Date(Date.now() + days * 24 * 60 * 60_000).toISOString().slice(0, 10);
}

function requestRecord(id: string, ownerUid: string, status = "new") {
  const now = new Date().toISOString();
  return {
    createdBy: ownerUid,
    request_number: `MR-${id}`,
    client_request_id: `client-${id}`,
    status,
    customer_name: "عميل اختبار القبول",
    customer_phone: "0500000000",
    address: "الرياض، حي الاختبار",
    service_type: "air_conditioning",
    product_name: "مكيف اختبار",
    issue_description: "وصف عطل صالح لاختبار دورة الصيانة.",
    warranty_status: "unknown",
    source: "maintenance_portal",
    portal_token_version: 1,
    portal_access_revoked_at: null,
    accepted_terms_at: now,
    createdAt: now,
    updatedAt: now,
  };
}

test("calendar dates and minimum lead time reject impossible or stale appointments", () => {
  assert.equal(maintenanceCalendarDate.safeParse("2026-02-30").success, false);
  assert.equal(maintenanceCalendarDate.safeParse("2026-13-01").success, false);
  assert.equal(maintenanceCalendarDate.safeParse("2028-02-29").success, true);
  assert.throws(() => assertMaintenanceLeadTime("2020-01-01", "10:00"), /ساعة|المستقبل/);
  assert.doesNotThrow(() => assertMaintenanceLeadTime(futureDate(2), "10:00"));
});

test("portal links expire, rotate, and revoke without persisting bearer tokens", async () => {
  const ownerUid = "owner-token-acceptance";
  const requestId = "mreq-token-acceptance";
  await adminDb.collection("maintenance_requests").doc(requestId).set(requestRecord(requestId, ownerUid));

  const snapshot = await adminDb.collection("maintenance_requests").doc(requestId).get();
  const request = { id: requestId, ...(snapshot.data() || {}) } as any;
  const firstToken = maintenancePortalTokenForRequest(request, ownerUid)!;
  assert.equal((await getMaintenanceRequestByPortalToken(firstToken)).id, requestId);

  const rotated = await updateMaintenancePortalAccess(requestId, ownerUid, "rotate", "admin-token-test");
  await assert.rejects(() => getMaintenanceRequestByPortalToken(firstToken), /غير صالح|منتهي/);
  const rotatedToken = maintenancePortalTokenForRequest(rotated, ownerUid)!;
  assert.equal((await getMaintenanceRequestByPortalToken(rotatedToken)).id, requestId);

  await updateMaintenancePortalAccess(requestId, ownerUid, "revoke", "admin-token-test");
  await assert.rejects(() => getMaintenanceRequestByPortalToken(rotatedToken), /غير صالح|منتهي/);

  const expiredId = "mreq-expired-acceptance";
  await adminDb.collection("maintenance_requests").doc(expiredId).set(requestRecord(expiredId, ownerUid));
  const expired = maintenancePortalToken(expiredId, ownerUid, 1, process.env, Date.now() - 2 * 24 * 60 * 60_000);
  await assert.rejects(() => getMaintenanceRequestByPortalToken(expired), /غير صالح|منتهي/);

  const persisted = (await adminDb.collection("maintenance_requests").doc(requestId).get()).data() || {};
  assert.equal("portal_token" in persisted, false);
});

test("concurrent assignment cannot exceed technician capacity or double-book a slot", async () => {
  const ownerUid = "owner-capacity-acceptance";
  const technicianId = "tech-capacity-acceptance";
  const date = futureDate(3);
  await adminDb.collection("technicians").doc(technicianId).set({
    createdBy: ownerUid,
    name: "فني السعة",
    max_daily: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  for (const id of ["mreq-capacity-a", "mreq-capacity-b"]) {
    await adminDb.collection("maintenance_requests").doc(id).set(requestRecord(id, ownerUid, "approved"));
  }

  const outcomes = await Promise.allSettled([
    assignMaintenanceRequest("mreq-capacity-a", ownerUid, { technician_id: technicianId, date, scheduled_time: "11:30" }),
    assignMaintenanceRequest("mreq-capacity-b", ownerUid, { technician_id: technicianId, date, scheduled_time: "11:30" }),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);

  const requests = await adminDb.collection("maintenance_requests").where("createdBy", "==", ownerUid).limit(10).get();
  const statuses = requests.docs.map((doc: any) => doc.data().status).sort();
  assert.deepEqual(statuses, ["approved", "scheduled"]);
  const bookings = await adminDb.collection("bookings").where("createdBy", "==", ownerUid).limit(10).get();
  assert.equal(bookings.size, 1);
  const events = await adminDb.collection("maintenance_request_events").where("createdBy", "==", ownerUid).limit(10).get();
  assert.equal(events.size, 1);
});

test("an evidence_complete flag cannot bypass missing photo hashes and signature artifacts", async () => {
  const ownerUid = "owner-evidence-acceptance";
  const bookingId = "book-evidence-acceptance";
  const capturedAt = new Date().toISOString();
  await adminDb.collection("bookings").doc(bookingId).set({
    createdBy: ownerUid,
    status: "confirmed",
    source: "maintenance_portal",
    fieldtech_require_before_photo: true,
    fieldtech_require_after_photo: true,
    fieldtech_require_signature: true,
    createdAt: capturedAt,
    updatedAt: capturedAt,
  });
  await adminDb.collection("fieldtech_job_states").doc(bookingId).set({
    createdBy: ownerUid,
    booking_id: bookingId,
    technician_id: "tech-evidence-acceptance",
    app_status: "complete",
    evidence_complete: true,
    updatedAt: capturedAt,
  });
  await assert.rejects(
    () => assertStoredBookingCompletionEvidence(bookingId, ownerUid),
    /safe reference|SHA-256|valid capture time/,
  );

  const sha256 = "b".repeat(64);
  await adminDb.collection("fieldtech_job_states").doc(bookingId).set({
    before_photo_ref: "fieldtech/evidence/before.jpg",
    before_photo_sha256: sha256,
    before_photo_captured_at: capturedAt,
    after_photo_ref: "fieldtech/evidence/after.jpg",
    after_photo_sha256: sha256,
    after_photo_captured_at: capturedAt,
    signature_ref: "fieldtech/evidence/signature.png",
    signature_sha256: sha256,
    signature_captured_at: capturedAt,
  }, { merge: true });
  assert.equal((await assertStoredBookingCompletionEvidence(bookingId, ownerUid)).evidence_complete, 1);
});

test("request, booking, and event roll back together when the final event write fails", async () => {
  const ownerUid = "owner-rollback-acceptance";
  const requestId = "mreq-rollback-acceptance";
  const bookingId = "book-rollback-acceptance";
  const eventId = "event-collision-acceptance";
  const now = new Date().toISOString();
  await adminDb.collection("maintenance_requests").doc(requestId).set(requestRecord(requestId, ownerUid));
  await adminDb.collection("bookings").doc(bookingId).set({
    createdBy: ownerUid,
    status: "confirmed",
    source: "maintenance_portal",
    createdAt: now,
    updatedAt: now,
  });
  await adminDb.collection("maintenance_request_events").doc(eventId).set({
    createdBy: ownerUid,
    request_id: requestId,
    request_number: `MR-${requestId}`,
    action: "collision_seed",
    actor_type: "system",
    customer_visible: false,
    metadata: {},
    createdAt: now,
    updatedAt: now,
  });

  await assert.rejects(() => applyMaintenanceMutation({
    requestId,
    ownerUid,
    expectedStatus: "new",
    requestPatch: { status: "approved", updatedAt: now },
    booking: { id: bookingId, data: { createdBy: ownerUid, status: "cancelled", updatedAt: now } },
    eventId,
    event: {
      createdBy: ownerUid,
      request_id: requestId,
      request_number: `MR-${requestId}`,
      action: "must_rollback",
      actor_type: "operator",
      customer_visible: false,
      metadata: {},
      createdAt: now,
      updatedAt: now,
    },
  }));

  assert.equal((await adminDb.collection("maintenance_requests").doc(requestId).get()).data()?.status, "new");
  assert.equal((await adminDb.collection("bookings").doc(bookingId).get()).data()?.status, "confirmed");
  assert.equal((await adminDb.collection("maintenance_request_events").doc(eventId).get()).data()?.action, "collision_seed");
});
