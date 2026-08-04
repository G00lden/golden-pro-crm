import crypto from "crypto";
import { adminDb } from "./firebaseAdmin";
import { createOwnedRepository, snapshotData } from "./repositories/ownedRepository";
import { normalizePhone, phonesMatch } from "../shared/phone";
import {
  canTransitionMaintenanceRequest,
  isMaintenanceRequestStatus,
  type MaintenanceRequestStatus,
} from "../shared/maintenanceRequest";
import { assertMaintenanceLeadTime } from "./maintenanceRequestValidation";
import {
  applyMaintenanceMutation,
  type MaintenanceAtomicMutation,
} from "./maintenanceRequestAtomic";
import { assertStoredBookingCompletionEvidence } from "./fieldtechEvidence";

type UnknownRecord = Record<string, any>;

const repository = createOwnedRepository(adminDb as any);
const REQUEST_SCAN_LIMIT = 2_000;
const REQUEST_DISPLAY_LIMIT = 50;

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

function cleanText(value: unknown, maximum: number) {
  return String(value ?? "").trim().slice(0, maximum);
}

function digest(value: string, length = 32) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, length);
}

function nowIso() {
  return new Date().toISOString();
}

function ownerOf(record: UnknownRecord) {
  return String(record.createdBy ?? record.owner_uid ?? "");
}

function dataOf(snapshot: { id: string; data: () => UnknownRecord }) {
  return { id: snapshot.id, ...snapshot.data() };
}

export function maintenancePortalSecret(
  env: NodeJS.ProcessEnv = process.env,
) {
  const configured = String(env.MAINTENANCE_PORTAL_SECRET || "").trim();
  if (configured.length >= 32) return configured;
  if (env.NODE_ENV === "production") {
    throw httpError(503, "بوابة طلبات الصيانة غير مفعلة حتى يتم ضبط MAINTENANCE_PORTAL_SECRET بطول 32 حرفاً على الأقل.");
  }
  return "local-maintenance-portal-development-secret-only";
}

export function maintenancePortalToken(
  requestId: string,
  ownerUid: string,
  version = 1,
  env: NodeJS.ProcessEnv = process.env,
  issuedAtMs = Date.now(),
) {
  const issuedAt = Math.floor(issuedAtMs / 1_000);
  const expiresAt = issuedAt + maintenancePortalTokenTtlSeconds(env);
  const signature = crypto
    .createHmac("sha256", maintenancePortalSecret(env))
    .update(`v2:${ownerUid}:${requestId}:${version}:${issuedAt}:${expiresAt}`)
    .digest("base64url");
  return `v2.${requestId}.${version.toString(36)}.${issuedAt.toString(36)}.${expiresAt.toString(36)}.${signature}`;
}

export function maintenancePortalTokenTtlSeconds(env: NodeJS.ProcessEnv = process.env) {
  const parsedDays = Number(env.MAINTENANCE_PORTAL_TOKEN_TTL_DAYS);
  const days = Number.isFinite(parsedDays) && parsedDays > 0
    ? Math.min(365, parsedDays)
    : 30;
  return Math.max(3_600, Math.trunc(days * 24 * 60 * 60));
}

function portalTokenVersion(record: UnknownRecord) {
  const parsed = Number(record.portal_token_version ?? 1);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

export function maintenancePortalTokenForRequest(
  request: MaintenanceRequestRecord,
  ownerUid = ownerOf(request),
  env: NodeJS.ProcessEnv = process.env,
  issuedAtMs = Date.now(),
) {
  if (request.portal_access_revoked_at) return null;
  return maintenancePortalToken(request.id, ownerUid, portalTokenVersion(request), env, issuedAtMs);
}

function splitPortalToken(token: unknown) {
  const value = String(token || "").trim();
  const [format, requestId, rawVersion, rawIssuedAt, rawExpiresAt, signature, ...extra] = value.split(".");
  const version = Number.parseInt(rawVersion || "", 36);
  const issuedAt = Number.parseInt(rawIssuedAt || "", 36);
  const expiresAt = Number.parseInt(rawExpiresAt || "", 36);
  if (
    format !== "v2"
    || extra.length > 0
    || !/^[A-Za-z0-9_-]{8,128}$/.test(requestId || "")
    || !Number.isSafeInteger(version)
    || version < 1
    || !Number.isSafeInteger(issuedAt)
    || !Number.isSafeInteger(expiresAt)
    || !/^[A-Za-z0-9_-]{40,64}$/.test(signature || "")
  ) {
    throw httpError(404, "رابط الطلب غير صالح أو منتهي.");
  }
  return { requestId, signature, version, issuedAt, expiresAt };
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export type MaintenanceRequestRecord = UnknownRecord & {
  id: string;
  request_number: string;
  status: MaintenanceRequestStatus;
};

export type MaintenanceRequestEvent = UnknownRecord & { id: string };

async function eventForRequest(
  request: MaintenanceRequestRecord,
  input: {
    action: string;
    actorType: "customer" | "operator" | "technician" | "system";
    actorUid?: string | null;
    fromStatus?: MaintenanceRequestStatus | null;
    toStatus?: MaintenanceRequestStatus | null;
    message?: string;
    customerVisible?: boolean;
    metadata?: UnknownRecord;
  },
) {
  const mutation = eventMutationForRequest(request, input);
  await adminDb.collection("maintenance_request_events").doc(mutation.id).set(mutation.data);
}

function eventMutationForRequest(
  request: MaintenanceRequestRecord,
  input: {
    action: string;
    actorType: "customer" | "operator" | "technician" | "system";
    actorUid?: string | null;
    fromStatus?: MaintenanceRequestStatus | null;
    toStatus?: MaintenanceRequestStatus | null;
    message?: string;
    customerVisible?: boolean;
    metadata?: UnknownRecord;
  },
) {
  const timestamp = nowIso();
  const ref = adminDb.collection("maintenance_request_events").doc();
  return {
    id: ref.id,
    data: {
      createdBy: ownerOf(request),
      request_id: request.id,
      request_number: request.request_number,
      action: input.action,
      actor_type: input.actorType,
      actor_uid: input.actorUid || null,
      from_status: input.fromStatus || null,
      to_status: input.toStatus || null,
      message: cleanText(input.message, 2_000),
      customer_visible: input.customerVisible !== false,
      metadata: input.metadata || {},
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  };
}

function throwMutationFailure(result: Awaited<ReturnType<typeof applyMaintenanceMutation>>) {
  if (result === "request_not_found") throw httpError(404, "طلب الصيانة غير موجود.");
  if (result === "booking_owner_conflict") throw httpError(409, "معرف الحجز مرتبط بحساب آخر.");
  if (result === "booking_time_conflict") throw httpError(409, "لدى الفني حجز آخر في الوقت نفسه. اختر وقتًا مختلفًا.");
  if (result === "booking_capacity_exceeded") throw httpError(409, "اكتملت السعة اليومية للفني. اختر يومًا أو فنيًا آخر.");
  if (result !== "applied") throw httpError(409, "تغير الطلب أثناء المعالجة. حدث الصفحة ثم أعد المحاولة.");
}

async function applyRequestMutation(
  request: MaintenanceRequestRecord,
  requestPatch: UnknownRecord,
  eventInput: Parameters<typeof eventMutationForRequest>[1],
  options: Pick<MaintenanceAtomicMutation, "booking" | "capacity"> = {},
) {
  const event = eventMutationForRequest(request, eventInput);
  const result = await applyMaintenanceMutation({
    requestId: request.id,
    ownerUid: ownerOf(request),
    expectedStatus: request.status,
    requestPatch,
    eventId: event.id,
    event: event.data,
    ...options,
  });
  throwMutationFailure(result);
}

async function ownedRecords(collection: string, ownerUid: string, limit = REQUEST_SCAN_LIMIT) {
  const snapshot = await adminDb.collection(collection).where("createdBy", "==", ownerUid).limit(limit).get();
  return snapshot.docs.map(snapshotData);
}

async function findOrCreateCustomer(
  ownerUid: string,
  input: { customer_name: string; customer_phone: string; city?: string; address?: string },
) {
  const customers = await ownedRecords("customers", ownerUid, 10_000);
  const existing = customers.find((customer) => phonesMatch(customer.phone, input.customer_phone));
  if (existing) return existing.id;

  const id = `cust_portal_${digest(`${ownerUid}:${input.customer_phone}`, 20)}`;
  const ref = adminDb.collection("customers").doc(id) as any;
  const timestamp = nowIso();
  const record = {
    createdBy: ownerUid,
    name: input.customer_name,
    phone: input.customer_phone,
    city: cleanText(input.city, 160),
    address: cleanText(input.address, 1_000),
    customer_address: cleanText(input.address, 1_000),
    source: "maintenance_portal",
    notes: "أُنشئ تلقائياً من بوابة طلبات الصيانة.",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  try {
    if (typeof ref.create === "function") await ref.create(record);
    else await ref.set(record);
  } catch (error) {
    if (String((error as { code?: unknown })?.code || "") !== "ALREADY_EXISTS") throw error;
  }
  return id;
}

async function findRelatedInstallation(ownerUid: string, customerId: string, productName: string) {
  const installations = await ownedRecords("installations", ownerUid, 10_000);
  const candidates = installations.filter((item) => String(item.customer_id || "") === customerId);
  if (!candidates.length) return null;
  const normalizedProduct = productName.trim().toLocaleLowerCase("ar");
  return candidates.find((item) => String(item.product_name || "").trim().toLocaleLowerCase("ar") === normalizedProduct)
    || candidates.find((item) => item.status === "active")
    || candidates[0];
}

export type PublicMaintenanceRequestInput = {
  client_request_id: string;
  customer_name: string;
  customer_phone: string;
  city?: string;
  address: string;
  service_type: string;
  product_name: string;
  issue_description: string;
  warranty_status?: string;
  invoice_number?: string;
  preferred_date?: string;
  preferred_time?: string;
};

export async function createPublicMaintenanceRequest(
  ownerUid: string,
  rawInput: PublicMaintenanceRequestInput,
) {
  if (!ownerUid.trim()) throw httpError(503, "استقبال طلبات الصيانة غير مهيأ بحساب مالك.");
  const phone = normalizePhone(rawInput.customer_phone);
  if (!phone.valid) throw httpError(400, "أدخل رقم جوال صحيحاً مع مفتاح الدولة عند الحاجة.");
  if (rawInput.preferred_date) {
    assertMaintenanceLeadTime(rawInput.preferred_date, rawInput.preferred_time);
  }

  // Calling this here deliberately fails closed in production before customer
  // data is written if the portal signing secret has not been configured.
  maintenancePortalSecret();

  const clientRequestId = cleanText(rawInput.client_request_id, 128);
  const requestId = `mreq_${digest(`${ownerUid}:${clientRequestId}`, 32)}`;
  const requestRef = adminDb.collection("maintenance_requests").doc(requestId) as any;
  const existing = await requestRef.get();
  if (existing.exists) {
    const record = dataOf(existing) as MaintenanceRequestRecord;
    if (ownerOf(record) !== ownerUid) throw httpError(409, "تعذر تثبيت الطلب. أعد المحاولة.");
    const portalToken = maintenancePortalTokenForRequest(record, ownerUid);
    if (!portalToken) throw httpError(410, "تم إلغاء رابط متابعة هذا الطلب. تواصل مع خدمة العملاء لإصدار رابط جديد.");
    return { request: record, portal_token: portalToken, duplicate: true };
  }

  const customerName = cleanText(rawInput.customer_name, 200);
  const customerPhone = phone.digits;
  const customerId = await findOrCreateCustomer(ownerUid, {
    customer_name: customerName,
    customer_phone: customerPhone,
    city: rawInput.city,
    address: rawInput.address,
  });
  const installation = await findRelatedInstallation(ownerUid, customerId, rawInput.product_name);
  const timestamp = nowIso();
  const requestNumber = `SR-${timestamp.slice(0, 10).replace(/-/g, "")}-${requestId.slice(-8).toUpperCase()}`;
  const record = {
    createdBy: ownerUid,
    request_number: requestNumber,
    client_request_id: clientRequestId,
    status: "new" satisfies MaintenanceRequestStatus,
    customer_id: customerId,
    customer_name: customerName,
    customer_phone: customerPhone,
    city: cleanText(rawInput.city, 160),
    address: cleanText(rawInput.address, 1_000),
    service_type: cleanText(rawInput.service_type, 80),
    product_id: cleanText(installation?.product_id, 128),
    product_name: cleanText(installation?.product_name || rawInput.product_name, 240),
    installation_id: cleanText(installation?.id, 128),
    issue_description: cleanText(rawInput.issue_description, 4_000),
    warranty_status: cleanText(rawInput.warranty_status || "unknown", 32),
    invoice_number: cleanText(rawInput.invoice_number, 120),
    preferred_date: cleanText(rawInput.preferred_date, 10),
    preferred_time: cleanText(rawInput.preferred_time, 5),
    scheduled_date: "",
    scheduled_time: "",
    technician_id: "",
    technician_name: "",
    booking_id: "",
    customer_change_requested: false,
    customer_change_note: "",
    resolution_note: "",
    portal_token_version: 1,
    portal_access_revoked_at: null,
    source: "maintenance_portal",
    accepted_terms_at: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  try {
    if (typeof requestRef.create === "function") await requestRef.create(record);
    else await requestRef.set(record);
  } catch (error) {
    if (String((error as { code?: unknown })?.code || "") !== "ALREADY_EXISTS") throw error;
    const duplicate = dataOf(await requestRef.get()) as MaintenanceRequestRecord;
    const portalToken = maintenancePortalTokenForRequest(duplicate, ownerUid);
    if (!portalToken) throw httpError(410, "تم إلغاء رابط متابعة هذا الطلب. تواصل مع خدمة العملاء لإصدار رابط جديد.");
    return { request: duplicate, portal_token: portalToken, duplicate: true };
  }

  const request = { id: requestId, ...record } as MaintenanceRequestRecord;
  await eventForRequest(request, {
    action: "created",
    actorType: "customer",
    toStatus: "new",
    message: "تم استلام طلب الصيانة.",
  });
  return { request, portal_token: maintenancePortalTokenForRequest(request, ownerUid)!, duplicate: false };
}

export async function getMaintenanceRequestByPortalToken(token: unknown) {
  const { requestId, signature, version, issuedAt, expiresAt } = splitPortalToken(token);
  const now = Math.floor(Date.now() / 1_000);
  const maximumLifetime = 365 * 24 * 60 * 60;
  if (issuedAt > now + 5 * 60 || expiresAt <= now || expiresAt <= issuedAt || expiresAt - issuedAt > maximumLifetime) {
    throw httpError(404, "رابط الطلب غير صالح أو منتهي.");
  }
  const snapshot = await adminDb.collection("maintenance_requests").doc(requestId).get();
  if (!snapshot.exists) throw httpError(404, "رابط الطلب غير صالح أو منتهي.");
  const request = dataOf(snapshot) as MaintenanceRequestRecord;
  if (request.portal_access_revoked_at || version !== portalTokenVersion(request)) {
    throw httpError(404, "رابط الطلب غير صالح أو منتهي.");
  }
  const expected = crypto
    .createHmac("sha256", maintenancePortalSecret())
    .update(`v2:${ownerOf(request)}:${requestId}:${version}:${issuedAt}:${expiresAt}`)
    .digest("base64url");
  if (!safeEqual(signature, expected)) throw httpError(404, "رابط الطلب غير صالح أو منتهي.");
  return request;
}

export async function getOwnedMaintenanceRequest(id: string, ownerUid: string) {
  const request = await repository.get("maintenance_requests", id, ownerUid);
  if (!request) throw httpError(404, "طلب الصيانة غير موجود.");
  if (!isMaintenanceRequestStatus(request.status)) throw httpError(409, "حالة طلب الصيانة غير معروفة.");
  return request as MaintenanceRequestRecord;
}

export async function updateMaintenancePortalAccess(
  id: string,
  ownerUid: string,
  action: "rotate" | "revoke",
  actorUid: string,
) {
  const request = await getOwnedMaintenanceRequest(id, ownerUid);
  const updatedAt = nowIso();
  const patch = {
    portal_token_version: portalTokenVersion(request) + 1,
    portal_access_revoked_at: action === "revoke" ? updatedAt : null,
    updatedAt,
  };
  await applyRequestMutation(request, patch, {
    action: action === "revoke" ? "portal_link_revoked" : "portal_link_rotated",
    actorType: "operator",
    actorUid,
    fromStatus: request.status,
    toStatus: request.status,
    customerVisible: false,
    message: action === "revoke" ? "تم إلغاء رابط متابعة العميل." : "تم إصدار رابط متابعة جديد وإبطال الرابط السابق.",
  });
  return { ...request, ...patch } as MaintenanceRequestRecord;
}

export async function maintenanceRequestEvents(requestId: string, ownerUid: string) {
  const snapshot = await adminDb.collection("maintenance_request_events")
    .where("request_id", "==", requestId)
    .limit(500)
    .get();
  return snapshot.docs
    .map(dataOf)
    .filter((event: UnknownRecord) => ownerOf(event) === ownerUid)
    .sort((left: UnknownRecord, right: UnknownRecord) => String(left.createdAt || left.created_at).localeCompare(String(right.createdAt || right.created_at)));
}

export async function listMaintenanceRequests(
  ownerUid: string,
  filters: { status?: string; search?: string } = {},
) {
  let requests = (await ownedRecords("maintenance_requests", ownerUid, REQUEST_SCAN_LIMIT)) as MaintenanceRequestRecord[];
  if (filters.status === "active") {
    requests = requests.filter((request) => ["approved", "scheduled", "in_progress"].includes(request.status));
  } else if (filters.status && isMaintenanceRequestStatus(filters.status)) {
    requests = requests.filter((request) => request.status === filters.status);
  }
  const search = cleanText(filters.search, 200).toLocaleLowerCase("ar");
  if (search) {
    requests = requests.filter((request) => [
      request.request_number,
      request.customer_name,
      request.customer_phone,
      request.product_name,
      request.technician_name,
    ].some((value) => String(value || "").toLocaleLowerCase("ar").includes(search)));
  }
  requests.sort((left, right) => String(right.createdAt || right.created_at).localeCompare(String(left.createdAt || left.created_at)));

  const all = filters.status || search
    ? (await ownedRecords("maintenance_requests", ownerUid, REQUEST_SCAN_LIMIT)) as MaintenanceRequestRecord[]
    : requests;
  const stats = {
    total: all.length,
    new: all.filter((request) => request.status === "new").length,
    active: all.filter((request) => ["approved", "scheduled", "in_progress"].includes(request.status)).length,
    closed: all.filter((request) => request.status === "closed").length,
    customer_changes: all.filter((request) => Boolean(request.customer_change_requested)).length,
  };
  return {
    data: requests.slice(0, REQUEST_DISPLAY_LIMIT).map((request) => ({
      ...request,
      customer_change_requested: Boolean(request.customer_change_requested),
      portal_token: maintenancePortalTokenForRequest(request, ownerUid),
    })),
    stats,
    capped: requests.length > REQUEST_DISPLAY_LIMIT || requests.length >= REQUEST_SCAN_LIMIT,
  };
}

export async function transitionMaintenanceRequest(
  id: string,
  ownerUid: string,
  toStatus: MaintenanceRequestStatus,
  input: {
    actorType?: "customer" | "operator" | "technician" | "system";
    actorUid?: string | null;
    action?: string;
    message?: string;
    customerVisible?: boolean;
    metadata?: UnknownRecord;
    patch?: UnknownRecord;
  } = {},
) {
  const request = await getOwnedMaintenanceRequest(id, ownerUid);
  if (request.status === toStatus) return request;
  if (!canTransitionMaintenanceRequest(request.status, toStatus)) {
    throw httpError(409, `لا يمكن نقل الطلب من ${request.status} إلى ${toStatus}.`);
  }
  const updatedAt = nowIso();
  const requestPatch = { ...(input.patch || {}), status: toStatus, updatedAt };
  await applyRequestMutation(request, requestPatch, {
    action: input.action || toStatus,
    actorType: input.actorType || "operator",
    actorUid: input.actorUid,
    fromStatus: request.status,
    toStatus,
    message: input.message,
    customerVisible: input.customerVisible,
    metadata: input.metadata,
  });
  const updated = { ...request, ...(input.patch || {}), status: toStatus, updatedAt } as MaintenanceRequestRecord;
  return updated;
}

export async function assignMaintenanceRequest(
  id: string,
  ownerUid: string,
  input: { technician_id: string; date: string; scheduled_time: string; note?: string; actor_uid?: string },
) {
  const request = await getOwnedMaintenanceRequest(id, ownerUid);
  if (!["new", "approved", "scheduled"].includes(request.status)) {
    throw httpError(409, "لا يمكن إسناد طلب مغلق أو قيد التنفيذ.");
  }
  const technician = await repository.get("technicians", input.technician_id, ownerUid);
  if (!technician) throw httpError(400, "الفني المحدد غير موجود أو لا يتبع هذا الحساب.");

  const bookingId = String(request.booking_id || `book_mreq_${digest(`${ownerUid}:${id}`, 20)}`);
  assertMaintenanceLeadTime(input.date, input.scheduled_time);
  const bookings = await ownedRecords("bookings", ownerUid, 10_000);
  const sameDayBookings = bookings.filter((booking) => (
    booking.id !== bookingId
    && String(booking.technician_id || "") === technician.id
    && String(booking.date || "") === input.date
    && String(booking.status || "confirmed") !== "cancelled"
  ));
  if (sameDayBookings.some((booking) => String(booking.scheduled_time || "") === input.scheduled_time)) {
    throw httpError(409, "لدى الفني حجز آخر في الوقت نفسه. اختر وقتًا مختلفًا.");
  }
  const maxDaily = Math.max(1, Math.min(100, Number(technician.max_daily || technician.maxDaily || 4)));
  if (sameDayBookings.length >= maxDaily) {
    throw httpError(409, `اكتملت السعة اليومية للفني (${maxDaily.toLocaleString("ar-SA")} طلبات). اختر يومًا أو فنيًا آخر.`);
  }
  const bookingRef = adminDb.collection("bookings").doc(bookingId) as any;
  const currentBooking = await bookingRef.get();
  if (currentBooking.exists && ownerOf(currentBooking.data() || {}) !== ownerUid) {
    throw httpError(409, "معرف الحجز مرتبط بحساب آخر.");
  }
  const timestamp = nowIso();
  const booking = {
    createdBy: ownerUid,
    installation_id: request.installation_id || "",
    customer_id: request.customer_id,
    customer_name: request.customer_name,
    customer_phone: request.customer_phone,
    product_id: request.product_id || "",
    product_name: request.product_name,
    technician_id: technician.id,
    tech_name: technician.name,
    date: input.date,
    scheduled_time: input.scheduled_time,
    status: "confirmed",
    booking_type: request.installation_id ? "maintenance" : "external_maintenance",
    source: "maintenance_portal",
    customer_address: request.address || "",
    notes: [`طلب الصيانة: ${request.request_number}`, request.issue_description, cleanText(input.note, 2_000)].filter(Boolean).join("\n"),
    parts: [],
    fieldtech_require_before_photo: true,
    fieldtech_require_after_photo: true,
    fieldtech_require_signature: true,
    createdAt: currentBooking.exists ? currentBooking.data()?.createdAt || currentBooking.data()?.created_at || timestamp : timestamp,
    updatedAt: timestamp,
  };
  const requestPatch = {
    status: "scheduled",
    technician_id: technician.id,
    technician_name: technician.name,
    booking_id: bookingId,
    scheduled_date: input.date,
    scheduled_time: input.scheduled_time,
    customer_change_requested: false,
    customer_change_note: "",
    updatedAt: timestamp,
  };
  await applyRequestMutation(request, requestPatch, {
    action: request.status === "scheduled" ? "rescheduled" : "assigned",
    actorType: "operator",
    actorUid: input.actor_uid,
    fromStatus: request.status,
    toStatus: "scheduled",
    message: `تم تحديد الموعد ${input.date} الساعة ${input.scheduled_time} مع الفني ${technician.name}.`,
  }, {
    booking: { id: bookingId, data: booking },
    capacity: {
      technicianId: technician.id,
      date: input.date,
      scheduledTime: input.scheduled_time,
      maxDaily,
      excludeBookingId: bookingId,
    },
  });

  const updated = {
    ...request,
    status: "scheduled",
    technician_id: technician.id,
    technician_name: technician.name,
    booking_id: bookingId,
    scheduled_date: input.date,
    scheduled_time: input.scheduled_time,
    customer_change_requested: false,
    customer_change_note: "",
    updatedAt: timestamp,
  } as MaintenanceRequestRecord;
  return updated;
}

export async function cancelMaintenanceRequest(
  id: string,
  ownerUid: string,
  input: {
    actorType?: "customer" | "operator" | "technician" | "system";
    actorUid?: string | null;
    action?: string;
    message: string;
    reason?: string;
  },
) {
  const request = await getOwnedMaintenanceRequest(id, ownerUid);
  if (request.status === "cancelled") return { request, bookingCancelled: false };
  if (!canTransitionMaintenanceRequest(request.status, "cancelled")) {
    throw httpError(409, "لا يمكن إلغاء الطلب بعد إغلاقه أو رفضه.");
  }

  const timestamp = nowIso();
  const bookingId = cleanText(request.booking_id, 128);
  const booking = bookingId ? await repository.get("bookings", bookingId, ownerUid) : null;
  const requestPatch = {
    status: "cancelled",
    cancellation_reason: cleanText(input.reason, 2_000),
    updatedAt: timestamp,
  };
  await applyRequestMutation(request, requestPatch, {
    action: input.action || "cancelled",
    actorType: input.actorType || "operator",
    actorUid: input.actorUid,
    fromStatus: request.status,
    toStatus: "cancelled",
    message: input.message,
  }, booking ? {
    booking: {
      id: bookingId,
      data: { createdBy: ownerUid, status: "cancelled", updatedAt: timestamp },
    },
  } : {});

  return {
    request: { ...request, ...requestPatch } as MaintenanceRequestRecord,
    bookingCancelled: Boolean(booking),
  };
}

export async function closeMaintenanceRequest(
  id: string,
  ownerUid: string,
  input: {
    actorType?: "operator" | "technician" | "system";
    actorUid?: string | null;
    action?: string;
    message: string;
    resolutionNote?: string;
    evidenceOverride?: boolean;
    overrideReason?: string;
    metadata?: UnknownRecord;
  },
) {
  const request = await getOwnedMaintenanceRequest(id, ownerUid);
  if (request.status === "closed") return request;
  if (!canTransitionMaintenanceRequest(request.status, "closed")) {
    throw httpError(409, `لا يمكن إغلاق الطلب من الحالة ${request.status}.`);
  }
  const bookingId = cleanText(request.booking_id, 128);
  if (!bookingId) throw httpError(409, "يجب إسناد الطلب وإنشاء حجز قبل إغلاقه.");
  const booking = await repository.get("bookings", bookingId, ownerUid);
  if (!booking) throw httpError(409, "الحجز المرتبط بالطلب غير موجود.");
  if (!input.evidenceOverride) await assertStoredBookingCompletionEvidence(bookingId, ownerUid);

  const timestamp = nowIso();
  const resolutionNote = cleanText(input.resolutionNote, 2_000);
  const overrideReason = cleanText(input.overrideReason, 2_000);
  const requestPatch = {
    status: "closed",
    closed_at: timestamp,
    ...(resolutionNote ? { resolution_note: resolutionNote } : {}),
    ...(input.evidenceOverride ? { completion_override_reason: overrideReason } : {}),
    updatedAt: timestamp,
  };
  await applyRequestMutation(request, requestPatch, {
    action: input.action || (input.evidenceOverride ? "closed_with_evidence_override" : "closed"),
    actorType: input.actorType || "operator",
    actorUid: input.actorUid,
    fromStatus: request.status,
    toStatus: "closed",
    message: input.message,
    metadata: {
      evidence_override: Boolean(input.evidenceOverride),
      ...(input.metadata || {}),
    },
  }, {
    booking: {
      id: bookingId,
      data: {
        createdBy: ownerUid,
        status: "completed",
        completed_at: timestamp,
        updatedAt: timestamp,
      },
    },
  });
  return { ...request, ...requestPatch } as MaintenanceRequestRecord;
}

export async function requestCustomerReschedule(
  request: MaintenanceRequestRecord,
  input: { preferred_date: string; preferred_time?: string; note?: string },
) {
  if (!["new", "approved", "scheduled"].includes(request.status)) {
    throw httpError(409, "لا يمكن طلب تغيير الموعد بعد بدء التنفيذ أو إغلاق الطلب.");
  }
  assertMaintenanceLeadTime(input.preferred_date, input.preferred_time);
  const patch = {
    preferred_date: input.preferred_date,
    preferred_time: cleanText(input.preferred_time, 5),
    customer_change_requested: true,
    customer_change_note: cleanText(input.note, 1_000),
    updatedAt: nowIso(),
  };
  await applyRequestMutation(request, patch, {
    action: "reschedule_requested",
    actorType: "customer",
    fromStatus: request.status,
    toStatus: request.status,
    message: `طلب العميل تغيير الموعد إلى ${input.preferred_date}${input.preferred_time ? ` الساعة ${input.preferred_time}` : ""}.`,
  });
  return { ...request, ...patch } as MaintenanceRequestRecord;
}

export async function addMaintenanceResolutionNote(
  id: string,
  ownerUid: string,
  note: string,
  actorUid?: string,
  options: { action?: string; metadata?: UnknownRecord; message?: string } = {},
) {
  const request = await getOwnedMaintenanceRequest(id, ownerUid);
  const resolutionNote = cleanText(note, 2_000);
  if (!resolutionNote) return request;
  const patch = { resolution_note: resolutionNote, updatedAt: nowIso() };
  await applyRequestMutation(request, patch, {
    action: options.action || "resolution_note",
    actorType: "operator",
    actorUid,
    fromStatus: request.status,
    toStatus: request.status,
    message: options.message || resolutionNote,
    metadata: options.metadata,
  });
  return { ...request, ...patch } as MaintenanceRequestRecord;
}

export async function syncMaintenanceRequestFromBooking(
  bookingId: string,
  ownerUid: string,
  fieldStatus: "scheduled" | "progress" | "complete" | "cancelled",
  message?: string,
) {
  const requests = (await ownedRecords("maintenance_requests", ownerUid, REQUEST_SCAN_LIMIT)) as MaintenanceRequestRecord[];
  const request = requests.find((item) => String(item.booking_id || "") === bookingId);
  if (!request || ["closed", "rejected", "cancelled"].includes(request.status)) return null;
  const target: MaintenanceRequestStatus | null = fieldStatus === "progress"
    ? "in_progress"
    : fieldStatus === "complete"
      ? "closed"
      : fieldStatus === "cancelled"
        ? "cancelled"
        : null;
  if (!target) return request;
  if (target === "closed") {
    return closeMaintenanceRequest(request.id, ownerUid, {
      actorType: "technician",
      action: `fieldtech_${fieldStatus}`,
      message: message || "أكمل الفني المهمة وأغلق الطلب.",
      resolutionNote: message,
    });
  }
  if (target === "cancelled") {
    const cancelled = await cancelMaintenanceRequest(request.id, ownerUid, {
      actorType: "technician",
      action: `fieldtech_${fieldStatus}`,
      message: message || "ألغى الفني المهمة.",
      reason: message,
    });
    return cancelled.request;
  }
  return transitionMaintenanceRequest(request.id, ownerUid, target, {
    actorType: "technician",
    action: `fieldtech_${fieldStatus}`,
    message: message || "بدأ الفني تنفيذ المهمة.",
  });
}

export function publicMaintenanceRequest(record: MaintenanceRequestRecord, events: MaintenanceRequestEvent[]) {
  return {
    request_number: record.request_number,
    status: record.status,
    customer_name: record.customer_name,
    service_type: record.service_type,
    product_name: record.product_name,
    issue_description: record.issue_description,
    preferred_date: record.preferred_date || null,
    preferred_time: record.preferred_time || null,
    scheduled_date: record.scheduled_date || null,
    scheduled_time: record.scheduled_time || null,
    technician_name: record.technician_name || null,
    customer_change_requested: Boolean(record.customer_change_requested),
    resolution_note: record.status === "closed" ? record.resolution_note || null : null,
    created_at: record.createdAt || record.created_at,
    updated_at: record.updatedAt || record.updated_at,
    events: events
      .filter((event) => Boolean(event.customer_visible))
      .map((event) => ({
        action: event.action,
        from_status: event.from_status || null,
        to_status: event.to_status || null,
        message: event.message || "",
        created_at: event.createdAt || event.created_at,
      })),
  };
}
