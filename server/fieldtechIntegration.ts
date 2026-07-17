import crypto from "crypto";
import type { Express, NextFunction, Request, Response } from "express";
import type { AuthedRequest } from "./auth";
import { completeBooking } from "./bookingLifecycle";
import { adminDb } from "./firebaseAdmin";
import { logError, logEvent } from "./logger";

const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const MAX_SNAPSHOT_ROWS = 1_000;
const replayNonces = new Map<string, number>();

type FieldTechRouteOptions = {
  webhookRateLimit: (req: Request, res: Response, next: NextFunction) => void;
  ownerUid: () => string;
};

type OwnedRecord = Record<string, any> & { id: string };

function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function integrationSecret() {
  return String(process.env.FIELDTECH_INTEGRATION_SECRET || "").trim();
}

function fieldTechServerUrl() {
  return String(process.env.FIELDTECH_SERVER_URL || "").trim().replace(/\/+$/, "");
}

function sha256(value: crypto.BinaryLike) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function signaturePayload(input: {
  timestamp: string;
  nonce: string;
  method: string;
  target: string;
  rawBody?: Buffer | string;
}) {
  return [
    input.timestamp,
    input.nonce,
    input.method.toUpperCase(),
    input.target,
    sha256(input.rawBody || ""),
  ].join("\n");
}

export function signFieldTechRequest(input: {
  secret: string;
  timestamp: string;
  nonce: string;
  method: string;
  target: string;
  rawBody?: Buffer | string;
}) {
  return crypto
    .createHmac("sha256", input.secret)
    .update(signaturePayload(input))
    .digest("hex");
}

function safeHexEqual(left: string, right: string) {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function pruneReplayNonces(now: number) {
  for (const [nonce, expiresAt] of replayNonces) {
    if (expiresAt <= now) replayNonces.delete(nonce);
  }
  while (replayNonces.size > 20_000) {
    const first = replayNonces.keys().next().value;
    if (!first) break;
    replayNonces.delete(first);
  }
}

function verifyFieldTechSignature(req: Request): { status: number; error: string } | null {
  const secret = integrationSecret();
  if (secret.length < 32) {
    return { status: 503, error: "FieldTech integration is not configured." };
  }

  const timestamp = String(req.get("x-fieldtech-timestamp") || "");
  const nonce = String(req.get("x-fieldtech-nonce") || "");
  const provided = String(req.get("x-fieldtech-signature") || "");
  const timestampMs = Number(timestamp);
  const now = Date.now();

  if (!Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > MAX_CLOCK_SKEW_MS) {
    return { status: 401, error: "Expired FieldTech request." };
  }
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) {
    return { status: 401, error: "Invalid FieldTech nonce." };
  }

  pruneReplayNonces(now);
  if (replayNonces.has(nonce)) {
    return { status: 409, error: "Replayed FieldTech request." };
  }

  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody || Buffer.alloc(0);
  const expected = signFieldTechRequest({
    secret,
    timestamp,
    nonce,
    method: req.method,
    target: req.originalUrl || req.url,
    rawBody,
  });
  if (!safeHexEqual(provided, expected)) {
    return { status: 401, error: "Invalid FieldTech signature." };
  }

  replayNonces.set(nonce, now + MAX_CLOCK_SKEW_MS);
  return null;
}

function requireFieldTechSignature(req: Request, res: Response, next: NextFunction) {
  const rejection = verifyFieldTechSignature(req);
  if (rejection) {
    res.status(rejection.status).json({ error: rejection.error });
    return;
  }
  next();
}

function documentData(doc: { id: string; data: () => Record<string, unknown> }): OwnedRecord {
  return { id: doc.id, ...doc.data() };
}

async function listOwned(collection: string, ownerUid: string, limit = MAX_SNAPSHOT_ROWS) {
  const snap = await adminDb
    .collection(collection)
    .where("createdBy", "==", ownerUid)
    .limit(limit)
    .get();
  return snap.docs.map(documentData);
}

function recordOwner(record: Record<string, unknown>) {
  return String(record.createdBy || record.owner_uid || "");
}

function jobType(value: unknown) {
  if (value === "installation") return "تركيب";
  if (value === "delivery") return "توصيل";
  return "صيانة";
}

function scheduledAt(date: unknown, time: unknown) {
  const day = String(date || "");
  const clock = String(time || "00:00");
  const value = new Date(`${day}T${clock.length === 5 ? `${clock}:00` : clock}+03:00`);
  return Number.isFinite(value.getTime()) ? value.toISOString() : null;
}

function checklistFor(type: string) {
  if (type === "تركيب") return ["معاينة موقع التركيب", "تنفيذ التركيب", "اختبار التشغيل", "تسليم العميل"];
  if (type === "توصيل") return ["مطابقة الطلب", "تسليم الطلب", "توثيق الاستلام"];
  return ["فحص الجهاز", "تنفيذ الصيانة", "اختبار التشغيل", "شرح النتيجة للعميل"];
}

export async function buildFieldTechSnapshot(ownerUid: string, updatedSince?: string) {
  const [technicians, bookings, customers, installations] = await Promise.all([
    listOwned("technicians", ownerUid),
    listOwned("bookings", ownerUid),
    listOwned("customers", ownerUid),
    listOwned("installations", ownerUid),
  ]);
  const customerById = new Map(customers.map((item) => [item.id, item]));
  const installationById = new Map(installations.map((item) => [item.id, item]));
  const sinceMs = updatedSince ? Date.parse(updatedSince) : Number.NaN;
  const changed = (item: OwnedRecord) => {
    if (!Number.isFinite(sinceMs)) return true;
    const updated = Date.parse(String(item.updatedAt || item.updated_at || item.createdAt || item.created_at || ""));
    return !Number.isFinite(updated) || updated >= sinceMs;
  };

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    ownerUid,
    technicians: technicians.filter(changed).map((technician) => ({
      id: technician.id,
      name: String(technician.name || ""),
      phone: String(technician.phone || ""),
      specialty: String(technician.specialty || ""),
      maxDaily: Number(technician.max_daily || technician.maxDaily || 4),
      updatedAt: technician.updatedAt || technician.updated_at || technician.createdAt || technician.created_at,
    })),
    bookings: bookings.filter(changed).map((booking) => {
      const customer = customerById.get(String(booking.customer_id || ""));
      const installation = installationById.get(String(booking.installation_id || ""));
      const type = jobType(booking.booking_type);
      const address = String(
        booking.customer_address ||
        booking.address ||
        installation?.customer_address ||
        installation?.address ||
        customer?.city ||
        "العنوان غير مسجل في CRM",
      ).trim();
      return {
        id: booking.id,
        technicianId: String(booking.technician_id || ""),
        customerId: String(booking.customer_id || ""),
        customerName: String(booking.customer_name || ""),
        customerPhone: String(booking.customer_phone || ""),
        contactName: String(booking.customer_name || ""),
        productId: String(booking.product_id || ""),
        productName: String(booking.product_name || ""),
        type,
        date: String(booking.date || ""),
        scheduledTime: String(booking.scheduled_time || ""),
        scheduledAt: scheduledAt(booking.date, booking.scheduled_time),
        address,
        status: String(booking.status || "confirmed"),
        priority: String(booking.priority || "عادي"),
        note: String(booking.notes || booking.note || booking.product_name || "").slice(0, 2_000),
        checklist: Array.isArray(booking.checklist) && booking.checklist.length
          ? booking.checklist.map(String).slice(0, 50)
          : checklistFor(type),
        storeOrderId: booking.store_order_id || null,
        storeOrderNumber: booking.store_order_number || null,
        updatedAt: booking.updatedAt || booking.updated_at || booking.createdAt || booking.created_at,
      };
    }),
  };
}

async function getOwnedDocument(collection: string, id: string, ownerUid: string) {
  const snap = await adminDb.collection(collection).doc(id).get();
  if (!snap.exists) return null;
  const data = documentData(snap);
  return recordOwner(data) === ownerUid ? data : null;
}

async function processJobStatusEvent(event: Record<string, any>, ownerUid: string) {
  const eventId = String(event.id || "").trim();
  const bookingId = String(event.bookingId || "").trim();
  const technicianId = String(event.technicianId || "").trim();
  const status = String(event.status || "").trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(eventId)) throw Object.assign(new Error("Invalid event id."), { status: 400 });
  if (!bookingId || !technicianId || !["scheduled", "progress", "complete", "cancelled"].includes(status)) {
    throw Object.assign(new Error("Invalid job status event."), { status: 400 });
  }

  const eventRef = adminDb.collection("fieldtech_events").doc(eventId);
  const previous = await eventRef.get();
  if (previous.exists) return { id: eventId, duplicate: true };

  const booking = await getOwnedDocument("bookings", bookingId, ownerUid);
  if (!booking) throw Object.assign(new Error("Booking was not found."), { status: 404 });
  if (String(booking.technician_id || "") !== technicianId) {
    throw Object.assign(new Error("Booking technician does not match the event."), { status: 409 });
  }

  if (status === "complete" && booking.status !== "completed") {
    await completeBooking(bookingId, ownerUid);
  }

  const now = new Date().toISOString();
  await adminDb.collection("fieldtech_job_states").doc(bookingId).set({
    createdBy: ownerUid,
    booking_id: bookingId,
    technician_id: technicianId,
    app_status: status,
    completion_note: String(event.completionNote || "").slice(0, 2_000),
    occurred_at: String(event.occurredAt || now),
    updatedAt: now,
  }, { merge: true });
  await eventRef.set({
    createdBy: ownerUid,
    event_type: "job_status",
    entity_id: bookingId,
    processed_at: now,
  });
  return { id: eventId, bookingId, status, duplicate: false };
}

async function processLocationEvent(event: Record<string, any>, ownerUid: string) {
  const technicianId = String(event.technicianId || "").trim();
  const latitude = Number(event.latitude);
  const longitude = Number(event.longitude);
  const accuracy = Number(event.accuracy || 0);
  if (!technicianId || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
      !Number.isFinite(longitude) || longitude < -180 || longitude > 180 ||
      !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 10_000) {
    throw Object.assign(new Error("Invalid technician location."), { status: 400 });
  }
  if (!(await getOwnedDocument("technicians", technicianId, ownerUid))) {
    throw Object.assign(new Error("Technician was not found."), { status: 404 });
  }
  const recordedAt = String(event.recordedAt || new Date().toISOString());
  await adminDb.collection("fieldtech_technician_locations").doc(technicianId).set({
    createdBy: ownerUid,
    technician_id: technicianId,
    latitude,
    longitude,
    accuracy,
    recorded_at: recordedAt,
    updatedAt: new Date().toISOString(),
  }, { merge: true });
  return { technicianId, recordedAt };
}

async function processEvents(events: unknown, ownerUid: string) {
  if (!Array.isArray(events) || events.length < 1 || events.length > 100) {
    throw Object.assign(new Error("events must contain between 1 and 100 items."), { status: 400 });
  }
  const results = [];
  for (const raw of events) {
    const event = raw && typeof raw === "object" ? raw as Record<string, any> : {};
    if (event.type === "job_status") results.push(await processJobStatusEvent(event, ownerUid));
    else if (event.type === "location") results.push(await processLocationEvent(event, ownerUid));
    else throw Object.assign(new Error("Unsupported FieldTech event type."), { status: 400 });
  }
  return results;
}

async function callFieldTech(pathname: string, init: { method?: string; body?: unknown } = {}) {
  const base = fieldTechServerUrl();
  const secret = integrationSecret();
  if (!base || secret.length < 32) {
    throw Object.assign(new Error("FieldTech server is not configured."), { status: 503 });
  }
  const url = new URL(pathname, `${base}/`);
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw Object.assign(new Error("FIELDTECH_SERVER_URL must use HTTPS in production."), { status: 503 });
  }
  const method = init.method || (init.body === undefined ? "GET" : "POST");
  const rawBody = init.body === undefined ? "" : JSON.stringify(init.body);
  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  const target = `${url.pathname}${url.search}`;
  const signature = signFieldTechRequest({ secret, timestamp, nonce, method, target, rawBody });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      method,
      body: rawBody || undefined,
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...(rawBody ? { "content-type": "application/json" } : {}),
        "x-fieldtech-timestamp": timestamp,
        "x-fieldtech-nonce": nonce,
        "x-fieldtech-signature": signature,
      },
    });
    const text = await response.text();
    let body: any = {};
    if (text) {
      try { body = JSON.parse(text); } catch { body = { error: text.slice(0, 500) }; }
    }
    if (!response.ok) {
      throw Object.assign(new Error(body.error || `FieldTech returned HTTP ${response.status}.`), { status: response.status });
    }
    return body;
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      throw Object.assign(new Error("FieldTech server did not respond in time."), { status: 504 });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function fieldTechIntegrationConfigured() {
  return Boolean(fieldTechServerUrl() && integrationSecret().length >= 32);
}

export async function requestFieldTechSync(reason: string) {
  if (!fieldTechIntegrationConfigured()) return { configured: false, skipped: true };
  try {
    return await callFieldTech("/api/integrations/breexe/sync", { body: { reason } });
  } catch (error) {
    logError("fieldtech.sync_request_failed", error, { reason });
    throw error;
  }
}

function requireOperationsRole(req: Request, res: Response, next: NextFunction) {
  const user = (req as AuthedRequest).user;
  if (user?.role === "admin" || user?.role === "manager") {
    next();
    return;
  }
  res.status(403).json({ error: "صلاحيات المدير مطلوبة لإدارة تطبيق الفني." });
}

export function registerFieldTechPublicRoutes(app: Express, options: FieldTechRouteOptions) {
  const { webhookRateLimit, ownerUid } = options;
  app.get(
    "/api/integrations/fieldtech/snapshot",
    webhookRateLimit,
    requireFieldTechSignature,
    asyncRoute(async (req, res) => {
      const updatedSince = typeof req.query.updated_since === "string" ? req.query.updated_since : undefined;
      res.json(await buildFieldTechSnapshot(ownerUid(), updatedSince));
    }),
  );
  app.post(
    "/api/integrations/fieldtech/events",
    webhookRateLimit,
    requireFieldTechSignature,
    asyncRoute(async (req, res) => {
      const results = await processEvents(req.body?.events, ownerUid());
      res.json({ accepted: results.length, results });
    }),
  );
}

export function registerFieldTechAdminRoutes(app: Express) {
  app.get(
    "/api/fieldtech/status",
    requireOperationsRole,
    asyncRoute(async (_req, res) => {
      if (!fieldTechIntegrationConfigured()) {
        res.json({ configured: false, connected: false, message: "لم يتم ضبط خادم تطبيق الفني بعد." });
        return;
      }
      const remote = await callFieldTech("/api/integrations/breexe/status");
      res.json({ configured: true, connected: true, ...remote });
    }),
  );
  app.post(
    "/api/fieldtech/sync",
    requireOperationsRole,
    asyncRoute(async (_req, res) => res.json(await requestFieldTechSync("manual_crm_sync"))),
  );
  app.post(
    "/api/fieldtech/technicians/:id/pairing",
    requireOperationsRole,
    asyncRoute(async (req, res) => {
      const result = await callFieldTech(
        `/api/integrations/breexe/technicians/${encodeURIComponent(req.params.id)}/pairing`,
        { body: {} },
      );
      res.status(201).json(result);
    }),
  );
  app.patch(
    "/api/fieldtech/technicians/:id/account",
    requireOperationsRole,
    asyncRoute(async (req, res) => {
      if (typeof req.body?.active !== "boolean") {
        res.status(400).json({ error: "active must be boolean." });
        return;
      }
      res.json(await callFieldTech(
        `/api/integrations/breexe/technicians/${encodeURIComponent(req.params.id)}/account`,
        { method: "PATCH", body: { active: req.body.active } },
      ));
    }),
  );
  app.get(
    "/api/fieldtech/technicians/:id/operations",
    requireOperationsRole,
    asyncRoute(async (req, res) => {
      res.json(await callFieldTech(
        `/api/integrations/breexe/technicians/${encodeURIComponent(req.params.id)}/operations`,
      ));
    }),
  );

  logEvent("info", "fieldtech.routes_registered", { configured: fieldTechIntegrationConfigured() });
}
