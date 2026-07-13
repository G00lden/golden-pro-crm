import crypto from "crypto";
import { adminDb } from "./firebaseAdmin";
import { isDryRunSendResult } from "./outboundSafety";
import { todayInTimeZone } from "./reminderEngine";
import { whatsappService } from "./whatsapp";
import type { ImportedOrderResult, StoreWebhookOrder } from "./storeWebhook";

type ServiceTask = {
  key: string;
  name: string;
  interval_value: number;
  interval_unit: "days" | "months";
  lead_days: number;
  start_event: "purchase" | "delivery" | "installation" | "service_completion";
  template: string;
  media_type: "none" | "image" | "video";
  media_url: string;
  cta: "auto" | "reorder" | "booking" | "both" | "contact";
  active: boolean;
};

type ProductPolicyInput = {
  service_mode?: "none" | "asset_maintenance" | "consumable_replacement" | "service";
  policy_active?: boolean;
  service_tasks?: ServiceTask[];
  compatibility_group?: string;
  warranty_enabled?: boolean;
  warranty_months?: number;
  reminder_media_type?: "none" | "image" | "video";
  reminder_media_url?: string;
  reminder_cta?: string;
};

type AssetActivationInput = {
  customer_id?: string;
  customer_name?: string;
  customer_phone?: string;
  customer_city?: string;
  customer_type?: "retail" | "wholesale" | "unknown";
  product_id: string;
  manufacturer_serial?: string;
  location_label?: string;
  purchase_date?: string;
  installation_date?: string;
  origin?: "sold" | "legacy" | "external";
  source?: "manual" | "salla" | "odoo" | "import";
  notes?: string;
};

type Doc = { id: string; exists?: boolean; data: () => Record<string, any> };

const ACTIVE_CYCLE_STATUSES = new Set(["active", "due", "overdue", "booked"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function nowIso() {
  return new Date().toISOString();
}

function clean<T extends Record<string, unknown>>(data: T) {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
}

function httpError(status: number, message: string) {
  const error = new Error(message) as Error & { status?: number };
  error.status = status;
  return error;
}

function normalizePhone(value: unknown) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = `966${digits.slice(1)}`;
  if (digits.length === 9 && digits.startsWith("5")) digits = `966${digits}`;
  return digits;
}

function validDate(value: unknown, fallback = todayInTimeZone()) {
  const text = String(value || "");
  return DATE_RE.test(text) ? text : fallback;
}

function addDays(date: string, days: number) {
  const [year, month, day] = validDate(date).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function nextOverdueReminderDate(today: string, intensiveCountAfterSend: number) {
  return addDays(today, intensiveCountAfterSend <= 12 ? 10 : 30);
}

export function addServiceInterval(date: string, value: number, unit: "days" | "months") {
  if (unit === "days") return addDays(date, Math.max(1, value));
  const [year, month, day] = validDate(date).split("-").map(Number);
  const targetMonth = month - 1 + Math.max(1, value);
  const targetYear = year + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, normalizedMonth, Math.min(day, lastDay))).toISOString().slice(0, 10);
}

function newId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function newAssetCode() {
  const year = new Date().getUTCFullYear();
  return `GP-${year}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

function publicSecret() {
  const secret = process.env.ASSET_PUBLIC_TOKEN_SECRET || process.env.STORE_WEBHOOK_SECRET || process.env.SALLA_STATE_SECRET
    || (process.env.NODE_ENV === "production" ? "" : "golden-pro-local-asset-token");
  if (!secret) throw httpError(503, "اضبط ASSET_PUBLIC_TOKEN_SECRET قبل طباعة ملصقات QR.");
  return secret;
}

export function createAssetPublicToken(assetId: string) {
  const encoded = Buffer.from(assetId, "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", publicSecret()).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function assetIdFromToken(token: string) {
  const [encoded, supplied] = String(token || "").split(".");
  if (!encoded || !supplied) throw httpError(404, "رابط الجهاز غير صالح.");
  const expected = crypto.createHmac("sha256", publicSecret()).update(encoded).digest("base64url");
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw httpError(404, "رابط الجهاز غير صالح.");
  const id = Buffer.from(encoded, "base64url").toString("utf8");
  if (!/^asset_[a-z0-9]+$/i.test(id)) throw httpError(404, "رابط الجهاز غير صالح.");
  return id;
}

function publicBaseUrl() {
  return String(process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/$/, "");
}

function docData(doc: Doc): Record<string, any> & { id: string } {
  return { id: doc.id, ...doc.data() };
}

async function listOwned(table: string, uid: string, limit = 1000): Promise<Array<Record<string, any> & { id: string }>> {
  const snap = await adminDb.collection(table).where("createdBy", "==", uid).limit(limit).get();
  return snap.docs.map((doc: Doc) => docData(doc));
}

async function getOwned(table: string, id: string, uid: string): Promise<(Record<string, any> & { id: string }) | null> {
  const snap = await adminDb.collection(table).doc(id).get();
  if (!snap.exists) return null;
  const row = docData(snap as Doc);
  return (row.createdBy ?? row.owner_uid) === uid ? row : null;
}

function parseTasks(value: unknown): ServiceTask[] {
  let raw = value;
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { raw = []; }
  }
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 12).map((item, index) => {
    const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const unit = row.interval_unit === "days" ? "days" : "months";
    const startEvent = ["purchase", "delivery", "installation", "service_completion"].includes(String(row.start_event))
      ? String(row.start_event) as ServiceTask["start_event"]
      : "installation";
    const mediaType = ["image", "video"].includes(String(row.media_type)) ? String(row.media_type) as "image" | "video" : "none";
    const cta = ["reorder", "booking", "both", "contact"].includes(String(row.cta)) ? String(row.cta) as ServiceTask["cta"] : "auto";
    return {
      key: String(row.key || `task_${index + 1}`).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 50),
      name: String(row.name || `مهمة صيانة ${index + 1}`).trim().slice(0, 100),
      interval_value: Math.max(1, Math.min(120, Number(row.interval_value || 1))),
      interval_unit: unit,
      lead_days: Math.max(0, Math.min(90, Number(row.lead_days ?? 14))),
      start_event: startEvent,
      template: String(row.template || "").trim().slice(0, 1500),
      media_type: mediaType,
      media_url: String(row.media_url || "").trim().slice(0, 1000),
      cta,
      active: row.active !== false,
    };
  });
}

function startDateForTask(task: ServiceTask, asset: Record<string, any>) {
  if (task.start_event === "purchase") return validDate(asset.purchase_date || asset.installation_date);
  if (task.start_event === "delivery") return validDate(asset.purchase_date || asset.installation_date);
  return validDate(asset.installation_date || asset.purchase_date);
}

async function recordAssetEvent(uid: string, assetId: string, type: string, summary: string, performedBy: string, metadata: Record<string, unknown> = {}, cycleId?: string) {
  const ref = adminDb.collection("asset_events").doc(newId("aevt"));
  await ref.set({
    asset_id: assetId,
    service_cycle_id: cycleId || null,
    event_type: type,
    summary,
    metadata,
    performed_by: performedBy,
    createdBy: uid,
    createdAt: nowIso(),
  });
}

async function createCycle(uid: string, asset: Record<string, any>, task: ServiceTask, startDate: string, sourceCycleId?: string) {
  const dueDate = addServiceInterval(startDate, task.interval_value, task.interval_unit);
  const nextReminder = addDays(dueDate, -task.lead_days);
  const ref = adminDb.collection("service_cycles").doc(newId("cycle"));
  const now = nowIso();
  await ref.set({
    asset_id: asset.id,
    customer_id: asset.customer_id || null,
    customer_name: asset.customer_name || "",
    customer_phone: asset.customer_phone || "",
    product_id: asset.product_id || null,
    product_name: asset.product_name || "",
    task_key: task.key,
    task_name: task.name,
    status: "active",
    start_date: startDate,
    due_date: dueDate,
    interval_value: task.interval_value,
    interval_unit: task.interval_unit,
    lead_days: task.lead_days,
    reminder_template: task.template,
    reminder_media_type: task.media_type,
    reminder_media_url: task.media_url,
    reminder_cta: task.cta,
    reminder_count: 0,
    intensive_count: 0,
    last_reminder_at: null,
    next_reminder_at: nextReminder < todayInTimeZone() ? todayInTimeZone() : nextReminder,
    source_cycle_id: sourceCycleId || null,
    createdBy: uid,
    createdAt: now,
    updatedAt: now,
  });
  await recordAssetEvent(uid, asset.id, "cycle_created", `تم إنشاء دورة ${task.name}`, uid, { due_date: dueDate }, ref.id);
  return ref.id;
}

export async function updateProductServicePolicy(uid: string, productId: string, input: ProductPolicyInput) {
  const product = await getOwned("products", productId, uid);
  if (!product) throw httpError(404, "المنتج غير موجود.");
  const mode = ["asset_maintenance", "consumable_replacement", "service"].includes(String(input.service_mode))
    ? input.service_mode
    : "none";
  const tasks = parseTasks(input.service_tasks);
  if (input.policy_active && mode !== "none" && !tasks.some((task) => task.active)) {
    throw httpError(400, "أضف مهمة صيانة نشطة واحدة على الأقل قبل تفعيل المنتج.");
  }
  const warrantyMonths = Math.max(0, Math.min(120, Number(input.warranty_months || 0)));
  await adminDb.collection("products").doc(productId).update(clean({
    service_mode: mode,
    policy_active: Boolean(input.policy_active),
    service_tasks: tasks,
    compatibility_group: String(input.compatibility_group || "").trim().slice(0, 80),
    warranty_enabled: Boolean(input.warranty_enabled && warrantyMonths > 0),
    warranty_months: warrantyMonths,
    reminder_media_type: input.reminder_media_type || "none",
    reminder_media_url: String(input.reminder_media_url || "").trim().slice(0, 1000),
    reminder_cta: input.reminder_cta || "auto",
    updatedAt: nowIso(),
  }));
  return { success: true, product_id: productId, tasks: tasks.length };
}

export async function createUnassignedAssets(uid: string, count: number, productId?: string) {
  const safeCount = Math.max(1, Math.min(100, Math.floor(Number(count || 1))));
  const product = productId ? await getOwned("products", productId, uid) : null;
  if (productId && !product) throw httpError(404, "المنتج غير موجود.");
  const created = [];
  for (let index = 0; index < safeCount; index += 1) {
    const ref = adminDb.collection("customer_assets").doc(newId("asset"));
    const row = {
      id: ref.id,
      asset_code: newAssetCode(),
      status: "unassigned",
      origin: "sold",
      customer_id: null,
      customer_name: "",
      customer_phone: "",
      product_id: product?.id || null,
      product_name: product?.name || "",
      product_sku: product?.sku || "",
      manufacturer_serial: "",
      location_label: "",
      warranty_months: Number(product?.warranty_enabled ? product.warranty_months || 0 : 0),
      source: "manual",
      notes: "",
      createdBy: uid,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    await ref.set(clean(row));
    created.push({ ...row, public_url: `${publicBaseUrl()}/public/assets/${createAssetPublicToken(ref.id)}` });
  }
  return created;
}

async function resolveCustomer(uid: string, input: AssetActivationInput) {
  if (input.customer_id) {
    const existing = await getOwned("customers", input.customer_id, uid);
    if (!existing) throw httpError(404, "العميل غير موجود.");
    return existing;
  }
  const phone = normalizePhone(input.customer_phone);
  const name = String(input.customer_name || "").trim();
  if (!/^\d{9,15}$/.test(phone) || !name) throw httpError(400, "أدخل اسم العميل ورقم جوال صالحاً لتفعيل الجهاز.");
  const customers = await listOwned("customers", uid, 2000);
  const existing = customers.find((customer) => normalizePhone(customer.phone) === phone);
  if (existing) return existing;
  const ref = adminDb.collection("customers").doc(newId("cust"));
  const now = nowIso();
  const customer = {
    id: ref.id,
    name: name.slice(0, 80),
    phone,
    city: String(input.customer_city || "").trim().slice(0, 80),
    source: input.source || "manual",
    customer_type: input.customer_type || "unknown",
    createdBy: uid,
    createdAt: now,
    updatedAt: now,
  };
  await ref.set(customer);
  return customer;
}

export async function activateAsset(uid: string, assetId: string, input: AssetActivationInput, actorUid = uid) {
  const asset = await getOwned("customer_assets", assetId, uid);
  if (!asset) throw httpError(404, "رمز الجهاز غير موجود.");
  if (asset.status !== "unassigned") throw httpError(409, "هذا الملصق مفعّل مسبقاً ولا يمكن إعادة ربطه من رابط التفعيل.");
  const product = await getOwned("products", input.product_id || asset.product_id, uid);
  if (!product) throw httpError(404, "اختر منتجًا صالحًا قبل التفعيل.");
  const customer = await resolveCustomer(uid, input);
  const manufacturerSerial = String(input.manufacturer_serial || "").trim().slice(0, 120);
  if (manufacturerSerial) {
    const assets = await listOwned("customer_assets", uid, 2000);
    const duplicate = assets.find((row) => row.id !== assetId && row.manufacturer_serial === manufacturerSerial);
    if (duplicate) throw httpError(409, "رقم المصنع مستخدم لجهاز آخر.");
  }
  const purchaseDate = validDate(input.purchase_date || asset.purchase_date || input.installation_date);
  const installationDate = validDate(input.installation_date || asset.installation_date || purchaseDate);
  const warrantyMonths = Number(product.warranty_enabled ? product.warranty_months || 0 : 0);
  const warrantyStart = warrantyMonths > 0 ? purchaseDate : null;
  const warrantyEnd = warrantyStart ? addServiceInterval(warrantyStart, warrantyMonths, "months") : null;
  const now = nowIso();
  const activated: Record<string, any> & { id: string } = {
    ...asset,
    id: assetId,
    status: "active",
    origin: input.origin || asset.origin || "sold",
    customer_id: customer.id,
    customer_name: customer.name,
    customer_phone: normalizePhone(customer.phone),
    product_id: product.id,
    product_name: product.name,
    product_sku: product.sku || "",
    manufacturer_serial: manufacturerSerial,
    location_label: String(input.location_label || "").trim().slice(0, 120),
    purchase_date: purchaseDate,
    installation_date: installationDate,
    warranty_months: warrantyMonths,
    warranty_start: warrantyStart,
    warranty_end: warrantyEnd,
    source: input.source || asset.source || "manual",
    notes: String(input.notes || "").trim().slice(0, 1000),
    activated_at: now,
    activated_by: actorUid,
    updatedAt: now,
  };
  const { id: _id, createdBy: _owner, createdAt: _created, owner_uid: _ownerUid, ...safeUpdate } = activated;
  await adminDb.collection("customer_assets").doc(assetId).update(safeUpdate);

  const existingCycles = (await listOwned("service_cycles", uid, 3000))
    .filter((cycle) => cycle.asset_id === assetId && ACTIVE_CYCLE_STATUSES.has(String(cycle.status)));
  const tasks = product.policy_active ? parseTasks(product.service_tasks).filter((task) => task.active) : [];
  for (const task of tasks) {
    if (existingCycles.some((cycle) => cycle.task_key === task.key)) continue;
    await createCycle(uid, activated, task, startDateForTask(task, activated));
  }
  await recordAssetEvent(uid, assetId, "activated", `تم تفعيل ${activated.asset_code} وربطه بالعميل ${customer.name}`, actorUid, {
    customer_id: customer.id,
    product_id: product.id,
    warranty_end: warrantyEnd,
  });
  return getAssetDetail(uid, assetId);
}

export async function getAssetWorkspace(uid: string) {
  const [assets, cycles, products, customers, campaigns, replacementLinks] = await Promise.all([
    listOwned("customer_assets", uid, 3000),
    listOwned("service_cycles", uid, 5000),
    listOwned("products", uid, 2000),
    listOwned("customers", uid, 3000),
    listOwned("marketing_campaigns", uid, 200),
    listOwned("replacement_links", uid, 1000),
  ]);
  const today = todayInTimeZone();
  const decoratedAssets: Array<Record<string, any> & { id: string }> = assets.map((asset) => {
    const warrantyDays = asset.warranty_end
      ? Math.ceil((Date.parse(`${asset.warranty_end}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000)
      : null;
    return {
      ...asset,
      warranty_days_remaining: warrantyDays,
      public_url: `${publicBaseUrl()}/public/assets/${createAssetPublicToken(asset.id)}`,
    } as Record<string, any> & { id: string };
  }).sort((a, b) => String(b.createdAt || b.created_at).localeCompare(String(a.createdAt || a.created_at)));
  const decoratedCycles: Array<Record<string, any> & { id: string }> = cycles.map((cycle) => ({
    ...cycle,
    computed_status: cycle.status === "active" && cycle.due_date < today ? "overdue" : cycle.status,
    days_until: Math.ceil((Date.parse(`${cycle.due_date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000),
  } as Record<string, any> & { id: string })).sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));
  return {
    assets: decoratedAssets,
    cycles: decoratedCycles,
    products,
    customers,
    campaigns: campaigns.sort((a, b) => String(b.createdAt || b.created_at).localeCompare(String(a.createdAt || a.created_at))),
    replacement_links: replacementLinks.sort((a, b) => String(b.createdAt || b.created_at).localeCompare(String(a.createdAt || a.created_at))),
    stats: {
      unassigned: assets.filter((asset) => asset.status === "unassigned").length,
      active_assets: assets.filter((asset) => asset.status === "active").length,
      due: decoratedCycles.filter((cycle) => cycle.days_until === 0 && ACTIVE_CYCLE_STATUSES.has(String(cycle.status))).length,
      overdue: decoratedCycles.filter((cycle) => cycle.days_until < 0 && ACTIVE_CYCLE_STATUSES.has(String(cycle.status))).length,
      warranty_expiring: decoratedAssets.filter((asset) => typeof asset.warranty_days_remaining === "number" && asset.warranty_days_remaining >= 0 && asset.warranty_days_remaining <= 60).length,
    },
  };
}

export async function linkReplacementToAsset(uid: string, linkId: string, assetId: string, actorUid: string) {
  const link = await getOwned("replacement_links", linkId, uid);
  if (!link) throw httpError(404, "عملية استبدال الفلتر غير موجودة.");
  if (link.status === "linked") return { success: true, already_linked: true, asset_id: link.selected_asset_id };
  const asset = await getOwned("customer_assets", assetId, uid);
  if (!asset || asset.status !== "active" || asset.customer_id !== link.customer_id) throw httpError(400, "الجهاز المختار لا يخص هذا العميل أو غير نشط.");
  const candidates = Array.isArray(link.candidate_asset_ids) ? link.candidate_asset_ids.map(String) : [];
  if (candidates.length && !candidates.includes(assetId)) throw httpError(400, "الجهاز غير متوافق مع هذا المنتج.");
  const product = await getOwned("products", link.product_id, uid);
  if (!product) throw httpError(404, "منتج الاستبدال غير موجود.");
  const tasks = parseTasks(product.service_tasks).filter((task) => task.active);
  const cycles = await listOwned("service_cycles", uid, 5000);
  for (const task of tasks) {
    for (const cycle of cycles.filter((row) => row.asset_id === assetId && row.product_id === product.id && row.task_key === task.key && ACTIVE_CYCLE_STATUSES.has(String(row.status)))) {
      await adminDb.collection("service_cycles").doc(cycle.id).update({ status: "superseded", completed_at: nowIso(), completion_notes: "استبدال جديد بدأ دورة أحدث", updatedAt: nowIso() });
    }
    await createCycle(uid, { ...asset, product_id: product.id, product_name: product.name }, task, validDate(link.purchase_date));
  }
  await adminDb.collection("replacement_links").doc(linkId).update({ status: "linked", selected_asset_id: assetId, linked_at: nowIso(), updatedAt: nowIso() });
  await recordAssetEvent(uid, assetId, "replacement_linked", `تم ربط ${product.name} بالجهاز وبدء مواعيده المستقلة`, actorUid, { replacement_link_id: linkId, product_id: product.id });
  return { success: true, asset_id: assetId, cycles_created: tasks.length };
}

export async function getAssetDetail(uid: string, assetId: string) {
  const asset = await getOwned("customer_assets", assetId, uid);
  if (!asset) throw httpError(404, "الجهاز غير موجود.");
  const [cycles, events] = await Promise.all([
    listOwned("service_cycles", uid, 5000),
    listOwned("asset_events", uid, 5000),
  ]);
  return {
    asset: { ...asset, public_url: `${publicBaseUrl()}/public/assets/${createAssetPublicToken(assetId)}` },
    cycles: cycles.filter((cycle) => cycle.asset_id === assetId).sort((a, b) => String(b.createdAt || b.created_at).localeCompare(String(a.createdAt || a.created_at))),
    events: events.filter((event) => event.asset_id === assetId).sort((a, b) => String(b.createdAt || b.created_at).localeCompare(String(a.createdAt || a.created_at))),
  };
}

export async function completeServiceCycle(uid: string, cycleId: string, completedDate?: string, notes?: string, actorUid = uid) {
  const cycle = await getOwned("service_cycles", cycleId, uid);
  if (!cycle) throw httpError(404, "دورة الصيانة غير موجودة.");
  if (!ACTIVE_CYCLE_STATUSES.has(String(cycle.status))) throw httpError(400, "هذه الدورة مغلقة بالفعل.");
  const asset = await getOwned("customer_assets", cycle.asset_id, uid);
  if (!asset) throw httpError(404, "الجهاز المرتبط غير موجود.");
  const doneDate = validDate(completedDate);
  const now = nowIso();
  await adminDb.collection("service_cycles").doc(cycleId).update({
    status: "completed",
    completed_at: now,
    completed_by: actorUid,
    completion_notes: String(notes || "").trim().slice(0, 1000),
    next_reminder_at: null,
    updatedAt: now,
  });
  const task: ServiceTask = {
    key: cycle.task_key,
    name: cycle.task_name,
    interval_value: Number(cycle.interval_value || 1),
    interval_unit: cycle.interval_unit === "days" ? "days" : "months",
    lead_days: Number(cycle.lead_days ?? 14),
    start_event: "service_completion",
    template: cycle.reminder_template || "",
    media_type: cycle.reminder_media_type || "none",
    media_url: cycle.reminder_media_url || "",
    cta: cycle.reminder_cta || "auto",
    active: true,
  };
  const nextCycleId = await createCycle(uid, asset, task, doneDate, cycleId);
  await recordAssetEvent(uid, asset.id, "service_completed", `تم تنفيذ ${cycle.task_name}`, actorUid, { completed_date: doneDate, next_cycle_id: nextCycleId }, cycleId);
  return { success: true, cycle_id: cycleId, next_cycle_id: nextCycleId, completed_date: doneDate };
}

export async function setAssetStatus(uid: string, assetId: string, status: "active" | "paused" | "retired", actorUid = uid) {
  const asset = await getOwned("customer_assets", assetId, uid);
  if (!asset) throw httpError(404, "الجهاز غير موجود.");
  await adminDb.collection("customer_assets").doc(assetId).update({ status, updatedAt: nowIso() });
  const cycles = (await listOwned("service_cycles", uid, 5000)).filter((cycle) => cycle.asset_id === assetId && ACTIVE_CYCLE_STATUSES.has(String(cycle.status)));
  for (const cycle of cycles) {
    await adminDb.collection("service_cycles").doc(cycle.id).update({
      status: status === "active" ? "active" : "paused",
      updatedAt: nowIso(),
    });
  }
  await recordAssetEvent(uid, assetId, `asset_${status}`, `تم تغيير حالة الجهاز إلى ${status}`, actorUid);
  return { success: true, asset_id: assetId, status };
}

function renderReminder(cycle: Record<string, any>, asset: Record<string, any>) {
  const fallback = `عزيزي ${cycle.customer_name}، حان موعد ${cycle.task_name} لجهاز ${asset.asset_code} (${cycle.product_name}).`;
  const template = String(cycle.reminder_template || fallback);
  const link = `${publicBaseUrl()}/public/assets/${createAssetPublicToken(asset.id)}`;
  return template
    .replaceAll("{customer_name}", String(cycle.customer_name || ""))
    .replaceAll("{product_name}", String(cycle.product_name || ""))
    .replaceAll("{task_name}", String(cycle.task_name || ""))
    .replaceAll("{due_date}", String(cycle.due_date || ""))
    .replaceAll("{asset_code}", String(asset.asset_code || ""))
    .replaceAll("{link}", link)
    .concat(template.includes("{link}") ? "" : `\n${link}`);
}

export async function runAssetReminders(options: { uid?: string; limit?: number; trigger?: string } = {}) {
  const today = todayInTimeZone();
  const snap = await adminDb.collection("service_cycles").where("next_reminder_at", "<=", today).limit(options.limit || 100).get();
  const candidates = snap.docs.map((doc: Doc) => docData(doc)).filter((cycle) =>
    ACTIVE_CYCLE_STATUSES.has(String(cycle.status)) && (!options.uid || (cycle.createdBy ?? cycle.owner_uid) === options.uid),
  );
  const results: Array<Record<string, unknown>> = [];
  for (const cycle of candidates) {
    const uid = cycle.createdBy ?? cycle.owner_uid;
    const asset = await getOwned("customer_assets", cycle.asset_id, uid);
    if (!asset || asset.status !== "active" || !cycle.customer_phone) {
      results.push({ cycle_id: cycle.id, success: false, skipped: true, reason: "الجهاز غير نشط أو رقم العميل مفقود." });
      continue;
    }
    const message = renderReminder(cycle, asset);
    const now = nowIso();
    try {
      const mediaType = ["image", "video"].includes(String(cycle.reminder_media_type))
        ? cycle.reminder_media_type as "image" | "video"
        : null;
      const result = mediaType && cycle.reminder_media_url
        ? await whatsappService.sendMedia(cycle.customer_phone, { type: mediaType, url: cycle.reminder_media_url, caption: message })
        : await whatsappService.sendText(cycle.customer_phone, message);
      const reminderRef = adminDb.collection("reminders").doc(newId("rem"));
      await reminderRef.set({
        asset_id: asset.id,
        service_cycle_id: cycle.id,
        customer_id: cycle.customer_id || null,
        customer_name: cycle.customer_name || "",
        customer_phone: cycle.customer_phone,
        product_id: cycle.product_id || null,
        product_name: cycle.product_name || "",
        message,
        reminder_type: cycle.due_date > today ? "upcoming" : "overdue",
        status: isDryRunSendResult(result) ? "dry_run" : "sent",
        trigger: options.trigger || "scheduled",
        sent_at: now,
        whatsapp_jid: result.jid || "",
        whatsapp_message_id: result.messageId || null,
        createdBy: uid,
        createdAt: now,
      });
      if (isDryRunSendResult(result)) {
        results.push({ cycle_id: cycle.id, success: false, skipped: true, reason: result.reason });
        continue;
      }
      const overdue = cycle.due_date <= today;
      const intensiveCount = overdue ? Number(cycle.intensive_count || 0) + 1 : Number(cycle.intensive_count || 0);
      const nextDate = overdue
        ? nextOverdueReminderDate(today, intensiveCount)
        : cycle.due_date;
      await adminDb.collection("service_cycles").doc(cycle.id).update({
        status: overdue ? "overdue" : "active",
        reminder_count: Number(cycle.reminder_count || 0) + 1,
        intensive_count: intensiveCount,
        last_reminder_at: now,
        next_reminder_at: nextDate,
        updatedAt: now,
      });
      await recordAssetEvent(uid, asset.id, "reminder_sent", `تم إرسال تذكير ${cycle.task_name}`, "system", { next_reminder_at: nextDate }, cycle.id);
      results.push({ cycle_id: cycle.id, success: true, next_reminder_at: nextDate });
    } catch (error) {
      results.push({ cycle_id: cycle.id, success: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    success: true,
    checked: candidates.length,
    sent: results.filter((row) => row.success).length,
    failed: results.filter((row) => !row.success && !row.skipped).length,
    skipped: results.filter((row) => row.skipped).length,
    results,
  };
}

export async function getPublicAsset(token: string) {
  const assetId = assetIdFromToken(token);
  const snap = await adminDb.collection("customer_assets").doc(assetId).get();
  if (!snap.exists) throw httpError(404, "الجهاز غير موجود.");
  const asset = docData(snap as Doc);
  const uid = asset.createdBy ?? asset.owner_uid;
  const product = asset.product_id ? await getOwned("products", asset.product_id, uid) : null;
  const cycles = (await listOwned("service_cycles", uid, 5000))
    .filter((cycle) => cycle.asset_id === assetId && ACTIVE_CYCLE_STATUSES.has(String(cycle.status)))
    .map((cycle) => ({ task_name: cycle.task_name, due_date: cycle.due_date, status: cycle.due_date < todayInTimeZone() ? "overdue" : cycle.status }));
  return {
    asset_code: asset.asset_code,
    status: asset.status,
    product_name: asset.product_name || "جهاز غير مفعّل",
    location_label: asset.location_label || "",
    warranty_start: asset.warranty_start || null,
    warranty_end: asset.warranty_end || null,
    cycles,
    activated: asset.status !== "unassigned",
    cta_type: product?.service_mode === "consumable_replacement" ? "reorder" : "booking",
  };
}

export async function createCampaign(uid: string, input: Record<string, any>) {
  const customerIds = Array.isArray(input.selected_customer_ids) ? input.selected_customer_ids.map(String).slice(0, 1000) : [];
  if (!customerIds.length) throw httpError(400, "اختر عميلًا واحدًا على الأقل.");
  const message = String(input.message || "").trim();
  if (!message) throw httpError(400, "نص الحملة مطلوب.");
  const ref = adminDb.collection("marketing_campaigns").doc(newId("camp"));
  const now = nowIso();
  await ref.set({
    name: String(input.name || "حملة منتجات جديدة").trim().slice(0, 120),
    status: "draft",
    message: message.slice(0, 2000),
    media_type: ["image", "video"].includes(String(input.media_type)) ? input.media_type : "none",
    media_url: String(input.media_url || "").trim().slice(0, 1000),
    selected_customer_ids: customerIds,
    selected_product_ids: Array.isArray(input.selected_product_ids) ? input.selected_product_ids.map(String).slice(0, 100) : [],
    sent_count: 0,
    failed_count: 0,
    createdBy: uid,
    createdAt: now,
    updatedAt: now,
  });
  return { id: ref.id };
}

export async function sendCampaign(uid: string, campaignId: string) {
  const campaign = await getOwned("marketing_campaigns", campaignId, uid);
  if (!campaign) throw httpError(404, "الحملة غير موجودة.");
  if (campaign.status === "sent") throw httpError(409, "تم إرسال هذه الحملة سابقًا.");
  const selected = new Set(Array.isArray(campaign.selected_customer_ids) ? campaign.selected_customer_ids : []);
  const customers = (await listOwned("customers", uid, 3000)).filter((customer) => selected.has(customer.id));
  let sent = 0;
  let failed = 0;
  for (const customer of customers) {
    if (!customer.phone) { failed += 1; continue; }
    try {
      const message = String(campaign.message).replaceAll("{customer_name}", customer.name || "");
      const mediaType = ["image", "video"].includes(String(campaign.media_type))
        ? campaign.media_type as "image" | "video"
        : null;
      const result = mediaType && campaign.media_url
        ? await whatsappService.sendMedia(customer.phone, { type: mediaType, url: campaign.media_url, caption: message })
        : await whatsappService.sendText(customer.phone, message);
      if (!isDryRunSendResult(result)) sent += 1;
    } catch {
      failed += 1;
    }
  }
  await adminDb.collection("marketing_campaigns").doc(campaignId).update({
    status: failed === customers.length ? "failed" : "sent",
    sent_count: sent,
    failed_count: failed,
    sent_at: nowIso(),
    updatedAt: nowIso(),
  });
  return { success: failed === 0, sent, failed, total: customers.length };
}

export async function importOdooRows(uid: string, rows: Array<Record<string, any>>, commit = false) {
  const normalized = rows.slice(0, 5000).map((row) => ({
    odoo_id: String(row.odoo_id || row.id || row.external_id || "").trim(),
    name: String(row.name || row.customer_name || row.display_name || "").trim().slice(0, 80),
    phone: normalizePhone(row.phone || row.mobile || row.customer_phone),
    city: String(row.city || row.customer_city || "").trim().slice(0, 80),
    customer_type: String(row.customer_type || row.type || "").toLowerCase().includes("wholesale") || String(row.customer_type || "").includes("جملة") ? "wholesale" : "unknown",
  })).filter((row) => row.name && row.phone);
  const existing = await listOwned("customers", uid, 5000);
  let imported = 0;
  let updated = 0;
  if (commit) {
    for (const row of normalized) {
      const match = existing.find((customer) => (row.odoo_id && customer.odoo_id === row.odoo_id) || normalizePhone(customer.phone) === row.phone);
      if (match) {
        await adminDb.collection("customers").doc(match.id).update({ ...row, source: "odoo", updatedAt: nowIso() });
        updated += 1;
      } else {
        const ref = adminDb.collection("customers").doc(newId("cust"));
        await ref.set({ ...row, source: "odoo", createdBy: uid, createdAt: nowIso(), updatedAt: nowIso() });
        imported += 1;
      }
    }
  }
  const run = adminDb.collection("odoo_import_runs").doc(newId("odoo"));
  await run.set({
    mode: "csv",
    status: commit ? "completed" : "preview",
    imported,
    updated,
    failed: rows.length - normalized.length,
    summary: { valid: normalized.length, total: rows.length },
    createdBy: uid,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
  return {
    committed: commit,
    valid: normalized.length,
    invalid: rows.length - normalized.length,
    created: imported,
    imported,
    updated,
    skipped: rows.length - normalized.length,
    preview: normalized.slice(0, 50),
    sample: normalized.slice(0, 10),
  };
}

export async function stageAssetsFromStoreOrder(uid: string, order: StoreWebhookOrder, imported: ImportedOrderResult) {
  const created: string[] = [];
  const customer = await getOwned("customers", imported.customer_id, uid);
  if (!customer) return created;

  for (const [itemIndex, item] of imported.items.entries()) {
    if (!item.product_id) continue;
    const product = await getOwned("products", item.product_id, uid);
    if (!product?.policy_active) continue;
    if (product.service_mode === "consumable_replacement") {
      const assets = (await listOwned("customer_assets", uid, 3000)).filter((asset) => asset.customer_id === customer.id && asset.status === "active");
      const group = String(product.compatibility_group || "").trim();
      const candidateIds: string[] = [];
      if (group) {
        for (const asset of assets) {
          const assetProduct = asset.product_id ? await getOwned("products", asset.product_id, uid) : null;
          if (String(assetProduct?.compatibility_group || "").trim() === group) candidateIds.push(asset.id);
        }
      }
      const linkId = `repl_${crypto.createHash("sha256").update(`${uid}:${order.provider}:${order.orderId}:${itemIndex}`).digest("hex").slice(0, 20)}`;
      const ref = adminDb.collection("replacement_links").doc(linkId);
      const existing = await ref.get();
      if (!existing.exists) {
        const now = nowIso();
        await ref.set({ customer_id: customer.id, customer_name: customer.name || order.customerName, customer_phone: normalizePhone(customer.phone || order.customerPhone), product_id: product.id, product_name: product.name || item.name, compatibility_group: group, candidate_asset_ids: candidateIds, selected_asset_id: null, status: "pending", purchase_date: validDate(order.orderDate), store_order_id: order.orderId, store_order_number: order.orderNumber, createdBy: uid, createdAt: now, updatedAt: now });
        if (candidateIds.length === 1) await linkReplacementToAsset(uid, linkId, candidateIds[0], "system");
      }
      continue;
    }
    if (product.service_mode !== "asset_maintenance") continue;
    const quantity = Math.max(1, Math.min(25, Number(order.items[itemIndex]?.quantity || 1)));
    for (let unit = 0; unit < quantity; unit += 1) {
      const digest = crypto.createHash("sha256")
        .update(`${uid}:${order.provider}:${order.orderId}:${itemIndex}:${unit}`)
        .digest("hex").slice(0, 20);
      const id = `asset_${digest}`;
      const ref = adminDb.collection("customer_assets").doc(id);
      const existing = await ref.get();
      if (existing.exists) continue;
      const now = nowIso();
      await ref.set({
        asset_code: newAssetCode(),
        status: "unassigned",
        origin: "sold",
        customer_id: customer.id,
        customer_name: customer.name || order.customerName,
        customer_phone: normalizePhone(customer.phone || order.customerPhone),
        product_id: product.id,
        product_name: product.name || item.name,
        product_sku: product.sku || item.sku || "",
        purchase_date: validDate(order.orderDate),
        source: "salla",
        store_provider: order.provider,
        store_order_id: order.orderId,
        store_order_number: order.orderNumber,
        store_item_index: itemIndex,
        createdBy: uid,
        createdAt: now,
        updatedAt: now,
      });
      await recordAssetEvent(uid, id, "store_order_staged", `تم إنشاء جهاز بانتظار تفعيل الفني من الطلب ${order.orderNumber}`, "system", {
        store_order_id: order.orderId,
        product_id: product.id,
      });
      created.push(id);
    }
  }
  return created;
}
