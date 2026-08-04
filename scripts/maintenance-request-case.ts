import express from "express";
import type { AddressInfo } from "node:net";

const ownerUid = "maintenance-test-owner";
const queuedReasons: string[] = [];

const { adminDb } = await import("../server/firebaseAdmin");
const {
  registerMaintenanceRequestAdminRoutes,
  registerMaintenanceRequestPublicRoutes,
} = await import("../server/routes-maintenance-requests");
const { syncMaintenanceRequestFromBooking } = await import("../server/maintenanceRequestService");

await adminDb.collection("technicians").doc("tech-maintenance-1").set({
  createdBy: ownerUid,
  name: "فني الاختبار",
  phone: "966500000001",
  specialty: "تكييف",
  max_daily: 4,
  createdAt: "2026-08-02T08:00:00.000Z",
  updatedAt: "2026-08-02T08:00:00.000Z",
});

const app = express();
app.use(express.json({ limit: "64kb" }));
registerMaintenanceRequestPublicRoutes(app, {
  rateLimit: (_req, _res, next) => next(),
  ownerUid: () => ownerUid,
  queueFieldTechSync: (reason) => queuedReasons.push(reason),
});
app.use("/api", (req, _res, next) => {
  (req as any).user = {
    uid: ownerUid,
    role: "admin",
    permissions: {},
    active: true,
    local: true,
  };
  next();
});
registerMaintenanceRequestAdminRoutes(app, {
  queueFieldTechSync: (reason) => queuedReasons.push(reason),
});
app.use((error: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(error.status || 500).json({ error: error.message });
});

const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
});
const address = server.address() as AddressInfo;
const baseUrl = `http://127.0.0.1:${address.port}`;

function futureDate(days: number) {
  return new Date(Date.now() + days * 24 * 60 * 60_000).toISOString().slice(0, 10);
}

async function jsonFetch(path: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = await response.json();
  return { status: response.status, body };
}

const payload = {
  client_request_id: "client-maintenance-test-0001",
  customer_name: "عميل الصيانة",
  customer_phone: "050 123 4567",
  city: "الرياض",
  address: "حي الاختبار، شارع 1",
  service_type: "air_conditioning",
  product_name: "مكيف سبليت",
  issue_description: "المكيف لا يبرد ويصدر صوتاً مرتفعاً.",
  warranty_status: "unknown",
  preferred_date: futureDate(2),
  preferred_time: "10:00",
  accept_terms: true,
};

try {
  const created = await jsonFetch("/public/maintenance-requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const duplicate = await jsonFetch("/public/maintenance-requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const token = String(created.body.portal_token || "");
  const requestNumber = String(created.body.request?.request_number || "");
  const requestSnapshot = await adminDb.collection("maintenance_requests")
    .where("createdBy", "==", ownerUid)
    .limit(10)
    .get();
  const requestId = requestSnapshot.docs[0]?.id || "";

  const portalBefore = await jsonFetch(`/public/maintenance-request?token=${encodeURIComponent(token)}`);
  const invalidPortal = await jsonFetch("/public/maintenance-request?token=invalid.invalid");
  const approve = await jsonFetch(`/api/maintenance-requests/${requestId}/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "approve" }),
  });
  const assign = await jsonFetch(`/api/maintenance-requests/${requestId}/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "assign",
      technician_id: "tech-maintenance-1",
      date: futureDate(3),
      scheduled_time: "11:30",
      note: "الاتصال قبل الوصول",
    }),
  });
  const reschedule = await jsonFetch("/public/maintenance-request/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token,
      action: "request_reschedule",
      preferred_date: futureDate(4),
      preferred_time: "15:00",
      note: "الفترة المسائية مناسبة",
    }),
  });
  const bookingId = String(assign.body.request?.booking_id || "");
  const fieldProgress = await syncMaintenanceRequestFromBooking(
    bookingId,
    ownerUid,
    "progress",
    "بدأ الفني المهمة من تطبيق FieldTech.",
  );
  const closeWithoutEvidence = await jsonFetch(`/api/maintenance-requests/${requestId}/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "close", note: "تم تنظيف الوحدة وإعادة تعبئة الغاز." }),
  });
  const evidenceCapturedAt = new Date().toISOString();
  const evidenceHash = "a".repeat(64);
  await adminDb.collection("fieldtech_job_states").doc(bookingId).set({
    createdBy: ownerUid,
    booking_id: bookingId,
    technician_id: "tech-maintenance-1",
    app_status: "complete",
    before_photo_ref: "fieldtech/evidence/before-photo.jpg",
    before_photo_sha256: evidenceHash,
    before_photo_captured_at: evidenceCapturedAt,
    after_photo_ref: "fieldtech/evidence/after-photo.jpg",
    after_photo_sha256: evidenceHash,
    after_photo_captured_at: evidenceCapturedAt,
    signature_ref: "fieldtech/evidence/customer-signature.png",
    signature_sha256: evidenceHash,
    signature_captured_at: evidenceCapturedAt,
    evidence_complete: true,
    updatedAt: evidenceCapturedAt,
  });
  const close = await jsonFetch(`/api/maintenance-requests/${requestId}/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "close", note: "تم تنظيف الوحدة وإعادة تعبئة الغاز." }),
  });
  const portalAfter = await jsonFetch(`/public/maintenance-request?token=${encodeURIComponent(token)}`);
  const booking = bookingId ? await adminDb.collection("bookings").doc(bookingId).get() : null;
  const customers = await adminDb.collection("customers").where("createdBy", "==", ownerUid).limit(10).get();
  const events = await adminDb.collection("maintenance_request_events").where("request_id", "==", requestId).limit(50).get();

  process.stdout.write(JSON.stringify({
    createdStatus: created.status,
    duplicateStatus: duplicate.status,
    duplicate: duplicate.body.duplicate,
    sameRequestNumber: duplicate.body.request?.request_number === requestNumber,
    portalBeforeStatus: portalBefore.status,
    portalBeforeLifecycle: portalBefore.body.request?.status,
    invalidPortalStatus: invalidPortal.status,
    approveStatus: approve.status,
    assignStatus: assign.status,
    assignedLifecycle: assign.body.request?.status,
    rescheduleStatus: reschedule.status,
    customerChangeRequested: reschedule.body.request?.customer_change_requested,
    fieldProgressLifecycle: fieldProgress?.status,
    closeWithoutEvidenceStatus: closeWithoutEvidence.status,
    closeWithoutEvidenceCode: closeWithoutEvidence.body.code,
    closeStatus: close.status,
    closedLifecycle: close.body.request?.status,
    portalAfterStatus: portalAfter.body.request?.status,
    resolutionNote: portalAfter.body.request?.resolution_note,
    bookingStatus: booking?.data()?.status,
    bookingSource: booking?.data()?.source,
    customerCount: customers.size,
    eventCount: events.size,
    tokenPersisted: Boolean((requestSnapshot.docs[0]?.data() || {}).portal_token),
    queuedReasons,
  }));
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
