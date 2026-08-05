import crypto from "node:crypto";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { adminDb } from "./firebaseAdmin";
import { normalizePhone } from "../shared/phone";
import { whatsappService } from "./whatsapp";
import {
  compatibleMaintenanceKits,
  isMaintenanceKitProduct,
  type MaintenanceCatalogProduct,
} from "./maintenanceKitCompatibility";

type AnyRecord = Record<string, any>;

export type MaintenancePortalSettings = {
  slot_times: string[];
  closed_weekdays: number[];
  booking_horizon_days: number;
  slot_capacity: number;
  min_lead_hours: number;
  location_required: boolean;
  attachments_enabled: boolean;
  whatsapp_verification_required: boolean;
};

const DEFAULT_SETTINGS: MaintenancePortalSettings = {
  slot_times: ["09:00", "11:00", "14:00", "16:00"],
  closed_weekdays: [5],
  booking_horizon_days: 21,
  slot_capacity: 1,
  min_lead_hours: 2,
  location_required: true,
  attachments_enabled: true,
  whatsapp_verification_required: true,
};

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

function secret(env: NodeJS.ProcessEnv = process.env) {
  const value = String(env.MAINTENANCE_PORTAL_SECRET || "").trim();
  if (value.length >= 32) return value;
  if (env.NODE_ENV === "production") throw httpError(503, "بوابة الصيانة غير مهيأة بأمان.");
  return "local-maintenance-portal-development-secret-only";
}

function hmac(value: string) {
  return crypto.createHmac("sha256", secret()).update(value).digest("hex");
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function snapshotRecord(snapshot: any) {
  return { id: snapshot.id, ...(snapshot.data() || {}) } as AnyRecord;
}

function bool(value: unknown, fallback: boolean) {
  if (value === undefined || value === null) return fallback;
  return value === true || value === 1 || value === "1";
}

function bounded(value: unknown, fallback: number, min: number, max: number) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.trunc(number))) : fallback;
}

function normalizedSettings(record: AnyRecord = {}): MaintenancePortalSettings {
  const slotTimes = Array.isArray(record.slot_times) ? record.slot_times : DEFAULT_SETTINGS.slot_times;
  const closed = Array.isArray(record.closed_weekdays) ? record.closed_weekdays : DEFAULT_SETTINGS.closed_weekdays;
  return {
    slot_times: [...new Set(slotTimes.map(String).filter((value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value)))].sort().slice(0, 12),
    closed_weekdays: [...new Set(closed.map(Number).filter((value) => Number.isInteger(value) && value >= 0 && value <= 6))].sort(),
    booking_horizon_days: bounded(record.booking_horizon_days, 21, 1, 60),
    slot_capacity: bounded(record.slot_capacity, 1, 1, 20),
    min_lead_hours: bounded(record.min_lead_hours, 2, 0, 72),
    location_required: bool(record.location_required, true),
    attachments_enabled: bool(record.attachments_enabled, true),
    whatsapp_verification_required: bool(record.whatsapp_verification_required, true),
  };
}

export async function getMaintenancePortalSettings(ownerUid: string) {
  const snapshot = await adminDb.collection("maintenance_portal_settings").doc(ownerUid).get();
  return normalizedSettings(snapshot.exists ? snapshot.data() : {});
}

export async function saveMaintenancePortalSettings(ownerUid: string, input: MaintenancePortalSettings) {
  const settings = normalizedSettings(input);
  if (!settings.slot_times.length) throw httpError(400, "أضف وقتاً واحداً متاحاً على الأقل.");
  const ref = adminDb.collection("maintenance_portal_settings").doc(ownerUid) as any;
  const current = await ref.get();
  const timestamp = new Date().toISOString();
  await ref.set({
    createdBy: ownerUid,
    ...settings,
    createdAt: current.exists ? current.data()?.createdAt || current.data()?.created_at || timestamp : timestamp,
    updatedAt: timestamp,
  });
  return settings;
}

function safeProductImage(value: unknown) {
  const raw = String(value || "").trim();
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

export type MaintenanceProduct = {
  id: string;
  name: string;
  category: string;
  sku: string;
  image_url: string;
};

export type MaintenanceKitOption = MaintenanceProduct & {
  kind: "filter_change" | "cooling_cells";
  compatibility_note: string;
};

async function visibleMaintenanceCatalog(ownerUid: string) {
  const snapshot = await adminDb.collection("products").where("createdBy", "==", ownerUid).limit(2_000).get();
  return snapshot.docs
    .map(snapshotRecord)
    .filter((item: AnyRecord) => bool(item.catalog_visible, true) && bool(item.is_available, true) && !item.merged_into) as MaintenanceCatalogProduct[];
}

function publicMaintenanceProduct(item: MaintenanceCatalogProduct): MaintenanceProduct {
  return {
    id: String(item.id),
    name: String(item.name || "").trim(),
    category: String(item.category || "").trim(),
    sku: String(item.sku || "").trim(),
    image_url: safeProductImage(item.image_url || item.imageUrl),
  };
}

export async function searchMaintenanceProducts(
  ownerUid: string,
  query = "",
  limit = 24,
  requestType: "repair" | "periodic" = "repair",
) {
  const catalog = await visibleMaintenanceCatalog(ownerUid);
  const needle = String(query || "").trim().toLocaleLowerCase("ar");
  const products = catalog
    .filter((item) => !isMaintenanceKitProduct(item))
    .filter((item) => requestType !== "periodic" || compatibleMaintenanceKits(item, catalog).length > 0)
    .filter((item: AnyRecord) => !needle || [item.name, item.category, item.sku].some((value) => String(value || "").toLocaleLowerCase("ar").includes(needle)))
    .sort((a: AnyRecord, b: AnyRecord) => Number(Boolean(b.image_url)) - Number(Boolean(a.image_url)) || String(a.name).localeCompare(String(b.name), "ar"))
    .slice(0, Math.max(1, Math.min(30, limit)))
    .map(publicMaintenanceProduct);
  return products.filter((item: MaintenanceProduct) => item.name);
}

export async function listCompatibleMaintenanceKits(ownerUid: string, productId: string): Promise<MaintenanceKitOption[]> {
  const catalog = await visibleMaintenanceCatalog(ownerUid);
  const device = catalog.find((item) => String(item.id) === String(productId || "").trim());
  if (!device || isMaintenanceKitProduct(device)) throw httpError(400, "اختر جهازاً صالحاً من منتجات BreeXe Pro.");
  return compatibleMaintenanceKits(device, catalog).map((match) => ({
    ...publicMaintenanceProduct(match.product),
    kind: match.kind,
    compatibility_note: match.compatibility_note,
  }));
}

export async function requireCompatibleMaintenanceKit(ownerUid: string, productId: string, kitId: string) {
  const kits = await listCompatibleMaintenanceKits(ownerUid, productId);
  const kit = kits.find((item) => item.id === String(kitId || "").trim());
  if (!kit) throw httpError(400, "الطقم المحدد غير متوافق مع الجهاز. اختر طقماً من القائمة المعتمدة.");
  return kit;
}

export async function requireMaintenanceProduct(ownerUid: string, productId: string) {
  const snapshot = await adminDb.collection("products").doc(String(productId || "").trim()).get();
  if (!snapshot.exists) throw httpError(400, "اختر منتجاً من قائمة منتجات BreeXe Pro.");
  const item = snapshotRecord(snapshot);
  if (String(item.createdBy || item.owner_uid) !== ownerUid || !bool(item.catalog_visible, true) || !bool(item.is_available, true) || item.merged_into) {
    throw httpError(400, "المنتج المحدد غير متاح للصيانة حالياً.");
  }
  return {
    id: item.id,
    name: String(item.name || "").trim(),
    category: String(item.category || "").trim(),
    sku: String(item.sku || "").trim(),
    image_url: safeProductImage(item.image_url || item.imageUrl),
  };
}

function datePartsInRiyadh(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Riyadh", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function dateRange(days: number) {
  const [year, month, day] = datePartsInRiyadh().split("-").map(Number);
  const base = Date.UTC(year, month - 1, day);
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(base + index * 86_400_000);
    return { date: date.toISOString().slice(0, 10), weekday: date.getUTCDay() };
  });
}

export async function getMaintenanceAvailability(ownerUid: string) {
  const settings = await getMaintenancePortalSettings(ownerUid);
  const [techniciansSnapshot, bookingsSnapshot] = await Promise.all([
    adminDb.collection("technicians").where("createdBy", "==", ownerUid).limit(500).get(),
    adminDb.collection("bookings").where("createdBy", "==", ownerUid).limit(10_000).get(),
  ]);
  const technicians = techniciansSnapshot.docs.map(snapshotRecord).filter((item: AnyRecord) => item.id && item.name);
  const bookings = bookingsSnapshot.docs.map(snapshotRecord).filter((item: AnyRecord) => String(item.status || "confirmed") !== "cancelled");
  const minimum = Date.now() + settings.min_lead_hours * 3_600_000;
  const dates = dateRange(settings.booking_horizon_days)
    .filter((item) => !settings.closed_weekdays.includes(item.weekday))
    .map((item) => ({
      date: item.date,
      slots: settings.slot_times.map((time) => {
        const scheduledAt = new Date(`${item.date}T${time}:00+03:00`).getTime();
        const availableTechnicians = technicians.filter((technician: AnyRecord) => {
          const own = bookings.filter((booking: AnyRecord) => String(booking.technician_id) === String(technician.id) && String(booking.date) === item.date);
          const maxDaily = bounded(technician.max_daily ?? technician.maxDaily, 4, 1, 100);
          return own.length < maxDaily && !own.some((booking: AnyRecord) => String(booking.scheduled_time) === time);
        });
        return {
          time,
          available: scheduledAt >= minimum && availableTechnicians.length > 0,
          capacity: Math.min(settings.slot_capacity, availableTechnicians.length),
        };
      }).filter((slot) => slot.available),
    }))
    .filter((item) => item.slots.length > 0);
  return { dates, settings: { location_required: settings.location_required, attachments_enabled: settings.attachments_enabled }, ready: technicians.length > 0 && dates.length > 0 };
}

export async function assertMaintenanceSlotAvailable(ownerUid: string, date: string, time: string) {
  const availability = await getMaintenanceAvailability(ownerUid);
  if (!availability.dates.some((item) => item.date === date && item.slots.some((slot) => slot.time === time))) {
    throw httpError(409, "الموعد المحدد لم يعد متاحاً. اختر موعداً آخر من الجدول.");
  }
}

function verificationTtlMinutes() {
  return bounded(process.env.MAINTENANCE_OTP_TTL_MINUTES, 10, 3, 30);
}

export async function requestMaintenancePhoneVerification(
  ownerUid: string,
  rawPhone: string,
  internal: { canaryCode?: string } = {},
) {
  const phone = normalizePhone(rawPhone);
  if (!phone.valid) throw httpError(400, "أدخل رقم جوال صحيحاً لاستخدام واتساب.");
  const phoneHash = hmac(`phone:${ownerUid}:${phone.digits}`);
  const recent = await adminDb.collection("maintenance_phone_verifications")
    .where("createdBy", "==", ownerUid).where("phone_hash", "==", phoneHash).limit(20).get();
  const oneHourAgo = Date.now() - 3_600_000;
  if (recent.docs.map(snapshotRecord).filter((item: AnyRecord) => new Date(item.createdAt || item.created_at).getTime() >= oneHourAgo).length >= 3) {
    throw httpError(429, "تم بلوغ حد إرسال رموز التحقق لهذا الرقم. حاول بعد ساعة.");
  }
  const id = `mpv_${crypto.randomUUID().replaceAll("-", "")}`;
  if (internal.canaryCode && (process.env.MAINTENANCE_INTERNAL_CANARY !== "true" || !/^\d{6}$/.test(internal.canaryCode))) {
    throw httpError(403, "Internal maintenance canary is not authorized.");
  }
  const code = internal.canaryCode || crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
  const timestamp = new Date();
  const expiresAt = new Date(timestamp.getTime() + verificationTtlMinutes() * 60_000).toISOString();
  const ref = adminDb.collection("maintenance_phone_verifications").doc(id) as any;
  await ref.create({
    createdBy: ownerUid,
    phone_hash: phoneHash,
    code_hash: hmac(`code:${id}:${phone.digits}:${code}`),
    token_hash: null,
    status: "pending",
    attempts: 0,
    provider_message_id: null,
    expires_at: expiresAt,
    token_expires_at: null,
    verified_at: null,
    consumed_at: null,
    createdAt: timestamp.toISOString(),
    updatedAt: timestamp.toISOString(),
  });
  try {
    const result = await whatsappService.sendMaintenanceOtp(phone.digits, code);
    await ref.update({ provider_message_id: result.messageId, updatedAt: new Date().toISOString() });
  } catch (error) {
    await ref.update({ status: "invalid", updatedAt: new Date().toISOString() });
    throw httpError(503, error instanceof Error ? error.message : "تعذر إرسال رمز واتساب حالياً.");
  }
  return { verification_id: id, expires_in_seconds: verificationTtlMinutes() * 60, phone_hint: `***${phone.digits.slice(-3)}` };
}

async function verificationRecord(ownerUid: string, verificationId: string) {
  if (!/^mpv_[a-f0-9]{32}$/.test(verificationId)) throw httpError(400, "جلسة التحقق غير صالحة.");
  const ref = adminDb.collection("maintenance_phone_verifications").doc(verificationId) as any;
  const snapshot = await ref.get();
  if (!snapshot.exists) throw httpError(400, "جلسة التحقق غير صالحة.");
  const record = snapshotRecord(snapshot);
  if (String(record.createdBy || record.owner_uid) !== ownerUid) throw httpError(400, "جلسة التحقق غير صالحة.");
  return { ref, record };
}

export async function verifyMaintenancePhone(ownerUid: string, verificationId: string, rawPhone: string, code: string) {
  const phone = normalizePhone(rawPhone);
  if (!phone.valid || !/^\d{6}$/.test(code)) throw httpError(400, "تحقق من رقم الجوال ورمز التحقق.");
  const { ref, record } = await verificationRecord(ownerUid, verificationId);
  if (record.status !== "pending" || new Date(record.expires_at).getTime() <= Date.now()) throw httpError(410, "انتهت صلاحية رمز التحقق. اطلب رمزاً جديداً.");
  if (!safeEqual(String(record.phone_hash), hmac(`phone:${ownerUid}:${phone.digits}`))) throw httpError(400, "رقم الجوال لا يطابق جلسة التحقق.");
  const attempts = bounded(record.attempts, 0, 0, 100) + 1;
  if (attempts > 5) {
    await ref.update({ status: "invalid", attempts, updatedAt: new Date().toISOString() });
    throw httpError(429, "تجاوزت الحد المسموح لمحاولات الرمز. اطلب رمزاً جديداً.");
  }
  const matches = safeEqual(String(record.code_hash), hmac(`code:${verificationId}:${phone.digits}:${code}`));
  if (!matches) {
    await ref.update({ attempts, updatedAt: new Date().toISOString() });
    throw httpError(400, "رمز التحقق غير صحيح.");
  }
  const token = crypto.randomBytes(32).toString("base64url");
  const now = new Date();
  await ref.update({
    status: "verified",
    attempts,
    token_hash: hmac(`token:${verificationId}:${token}`),
    token_expires_at: new Date(now.getTime() + 30 * 60_000).toISOString(),
    verified_at: now.toISOString(),
    updatedAt: now.toISOString(),
  });
  return { verification_token: token, expires_in_seconds: 1_800 };
}

export async function requireMaintenanceVerification(ownerUid: string, verificationId: string, token: string, rawPhone?: string) {
  const { ref, record } = await verificationRecord(ownerUid, verificationId);
  if (record.status !== "verified" || new Date(record.token_expires_at || 0).getTime() <= Date.now()) throw httpError(401, "أعد التحقق من رقم واتساب.");
  if (!safeEqual(String(record.token_hash), hmac(`token:${verificationId}:${token}`))) throw httpError(401, "جلسة التحقق غير صالحة.");
  if (rawPhone) {
    const phone = normalizePhone(rawPhone);
    if (!phone.valid || !safeEqual(String(record.phone_hash), hmac(`phone:${ownerUid}:${phone.digits}`))) throw httpError(401, "رقم الجوال لا يطابق جلسة التحقق.");
  }
  return { ref, record };
}

export async function consumeMaintenanceVerification(ownerUid: string, verificationId: string, token: string, phone: string) {
  const { ref, record } = await requireMaintenanceVerification(ownerUid, verificationId, token, phone);
  const timestamp = new Date().toISOString();
  if (typeof ref.compareAndSet === "function") {
    const applied = await ref.compareAndSet({ status: "verified", token_hash: record.token_hash }, { status: "consumed", consumed_at: timestamp, updatedAt: timestamp });
    if (!applied) throw httpError(409, "استخدمت جلسة التحقق مسبقاً. تحقق من الرقم مرة أخرى.");
  } else {
    await ref.update({ status: "consumed", consumed_at: timestamp, updatedAt: timestamp });
  }
  return record.verified_at || timestamp;
}

export async function restoreMaintenanceVerification(ownerUid: string, verificationId: string, token: string, phone: string) {
  const { ref, record } = await verificationRecord(ownerUid, verificationId);
  const normalized = normalizePhone(phone);
  if (
    record.status !== "consumed"
    || !normalized.valid
    || !safeEqual(String(record.phone_hash), hmac(`phone:${ownerUid}:${normalized.digits}`))
    || !safeEqual(String(record.token_hash), hmac(`token:${verificationId}:${token}`))
    || new Date(record.token_expires_at || 0).getTime() <= Date.now()
  ) return false;
  if (typeof ref.compareAndSet === "function") {
    return ref.compareAndSet({ status: "consumed", token_hash: record.token_hash }, { status: "verified", consumed_at: null, updatedAt: new Date().toISOString() });
  }
  await ref.update({ status: "verified", consumed_at: null, updatedAt: new Date().toISOString() });
  return true;
}

function attachmentRoot() {
  const configured = String(process.env.MAINTENANCE_ATTACHMENT_DIR || "").trim();
  if (configured) return path.resolve(configured);
  const dbPath = String(process.env.DB_PATH || path.join(process.cwd(), "data", "golden-crm.db"));
  return path.join(path.dirname(path.resolve(dbPath === ":memory:" ? path.join(process.cwd(), "data", "test.db") : dbPath)), "maintenance-attachments");
}

function mediaContract(contentType: string, body: Buffer) {
  const image = contentType === "image/jpeg" && body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff
    ? { kind: "image", ext: "jpg", max: 8 * 1024 * 1024 }
    : contentType === "image/png" && body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? { kind: "image", ext: "png", max: 8 * 1024 * 1024 }
      : contentType === "image/webp" && body.length >= 12 && body.subarray(0, 4).toString() === "RIFF" && body.subarray(8, 12).toString() === "WEBP"
        ? { kind: "image", ext: "webp", max: 8 * 1024 * 1024 }
        : ["video/mp4", "video/quicktime"].includes(contentType) && body.length >= 12 && body.subarray(4, 8).toString() === "ftyp"
          ? { kind: "video", ext: "mp4", max: 25 * 1024 * 1024 }
          : null;
  if (!image) throw httpError(415, "الملف يجب أن يكون صورة JPG/PNG/WEBP أو مقطع MP4/MOV صالحاً.");
  if (!body.length || body.length > image.max) throw httpError(413, image.kind === "video" ? "حجم المقطع يتجاوز 25MB." : "حجم الصورة يتجاوز 8MB.");
  return image;
}

export async function storeMaintenanceAttachment(ownerUid: string, verificationId: string, token: string, contentType: string, body: Buffer) {
  await requireMaintenanceVerification(ownerUid, verificationId, token);
  const existing = await adminDb.collection("maintenance_request_attachments").where("verification_id", "==", verificationId).limit(10).get();
  const records = existing.docs.map(snapshotRecord);
  const contract = mediaContract(contentType, body);
  if (records.length >= 5 || (contract.kind === "video" && records.some((item: AnyRecord) => item.kind === "video"))) {
    throw httpError(409, "يمكن إرفاق 5 ملفات كحد أقصى، بينها مقطع واحد.");
  }
  const id = `mra_${crypto.randomUUID().replaceAll("-", "")}`;
  const filename = `${crypto.randomBytes(24).toString("hex")}.${contract.ext}`;
  const root = attachmentRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(path.join(root, filename), body, { mode: 0o600, flag: "wx" });
  const timestamp = new Date().toISOString();
  await adminDb.collection("maintenance_request_attachments").doc(id).create({
    createdBy: ownerUid,
    verification_id: verificationId,
    request_id: null,
    kind: contract.kind,
    media_type: contentType,
    byte_size: body.length,
    sha256: crypto.createHash("sha256").update(body).digest("hex"),
    storage_ref: filename,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return { id, kind: contract.kind, media_type: contentType, byte_size: body.length };
}

export async function claimMaintenanceAttachments(ownerUid: string, verificationId: string, requestId: string, attachmentIds: string[]) {
  const ids = [...new Set(attachmentIds)].slice(0, 5);
  for (const id of ids) {
    const ref = adminDb.collection("maintenance_request_attachments").doc(id) as any;
    const snapshot = await ref.get();
    if (!snapshot.exists) throw httpError(400, "أحد المرفقات غير موجود.");
    const item = snapshotRecord(snapshot);
    if (String(item.createdBy || item.owner_uid) !== ownerUid || item.verification_id !== verificationId || item.request_id) throw httpError(400, "أحد المرفقات لا يتبع جلسة التحقق الحالية.");
    await ref.update({ request_id: requestId, updatedAt: new Date().toISOString() });
  }
  return ids.length;
}

export async function assertMaintenanceAttachments(ownerUid: string, verificationId: string, attachmentIds: string[]) {
  const ids = [...new Set(attachmentIds)].slice(0, 5);
  if (ids.length !== attachmentIds.length) throw httpError(400, "قائمة المرفقات غير صالحة.");
  let videos = 0;
  for (const id of ids) {
    const snapshot = await adminDb.collection("maintenance_request_attachments").doc(id).get();
    if (!snapshot.exists) throw httpError(400, "أحد المرفقات غير موجود.");
    const item = snapshotRecord(snapshot);
    if (String(item.createdBy || item.owner_uid) !== ownerUid || item.verification_id !== verificationId || item.request_id) {
      throw httpError(400, "أحد المرفقات لا يتبع جلسة التحقق الحالية.");
    }
    if (item.kind === "video") videos += 1;
  }
  if (videos > 1) throw httpError(400, "يسمح بمقطع واحد فقط.");
  return ids;
}

export async function listMaintenanceAttachments(ownerUid: string, requestId: string) {
  const snapshot = await adminDb.collection("maintenance_request_attachments").where("request_id", "==", requestId).limit(10).get();
  return snapshot.docs.map(snapshotRecord).filter((item: AnyRecord) => String(item.createdBy || item.owner_uid) === ownerUid).map((item: AnyRecord) => ({
    id: item.id, kind: item.kind, media_type: item.media_type, byte_size: Number(item.byte_size || 0),
  }));
}

export async function readMaintenanceAttachment(ownerUid: string, requestId: string, attachmentId: string) {
  const snapshot = await adminDb.collection("maintenance_request_attachments").doc(attachmentId).get();
  if (!snapshot.exists) throw httpError(404, "المرفق غير موجود.");
  const item = snapshotRecord(snapshot);
  if (String(item.createdBy || item.owner_uid) !== ownerUid || String(item.request_id) !== requestId || !/^[a-f0-9]{48}\.(jpg|png|webp|mp4)$/.test(String(item.storage_ref))) {
    throw httpError(404, "المرفق غير موجود.");
  }
  return { body: await readFile(path.join(attachmentRoot(), item.storage_ref)), media_type: String(item.media_type) };
}
