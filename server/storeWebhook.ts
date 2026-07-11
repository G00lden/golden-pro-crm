import crypto from "crypto";
import fs from "fs";
import path from "path";
import type { Request } from "express";
import { adminDb } from "./firebaseAdmin";
import { addCalendarMonths } from "../shared/date";

type RawBodyRequest = Request & { rawBody?: Buffer };

export type StoreItemType =
  | "sale_only"
  | "install_maintenance"
  | "maintenance_existing"
  | "external_maintenance"
  | "needs_review";

export type StoreJourneyStatus =
  | "received"
  | "sale_recorded"
  | "installation_created"
  | "awaiting_schedule"
  | "booking_created"
  | "maintenance_matched"
  | "needs_review"
  | "completed"
  | "cancelled";

export type StoreWebhookItem = {
  name: string;
  sku: string;
  quantity: number;
  maintenanceMonths: number;
  orderType: StoreItemType;
  tags: string[];
  unitPrice?: number | null;
  totalPrice?: number | null;
  currency?: string | null;
};

export type StoreWebhookOrder = {
  provider: string;
  eventType: string;
  eventId: string;
  orderId: string;
  orderNumber: string;
  status: string;
  customerName: string;
  customerPhone: string;
  customerCity: string;
  orderDate: string;
  scheduledDate?: string;
  scheduledTime?: string;
  total?: number;
  items: StoreWebhookItem[];
};

type ImportedOrderItem = {
  name: string;
  sku: string;
  quantity: number;
  unit_price?: number | null;
  total_price?: number | null;
  currency?: string | null;
  tags?: string[];
  order_type: StoreItemType;
  detected_type?: StoreItemType | null;
  manual_type?: StoreItemType | null;
  status: StoreJourneyStatus;
  product_id?: string | null;
  installation_id?: string | null;
  booking_id?: string | null;
  reason?: string | null;
};

export type ImportedOrderResult = {
  customer_id: string;
  product_ids: string[];
  installation_ids: string[];
  booking_ids: string[];
  journey_status: StoreJourneyStatus;
  items: ImportedOrderItem[];
};

type AssignStoreOrderPayload = {
  itemSku?: string;
  technicianId: string;
  scheduledDate: string;
  scheduledTime?: string;
};

const timeZone = process.env.APP_TIMEZONE || "Asia/Riyadh";
const defaultMaintenanceMonths = Number(process.env.STORE_WEBHOOK_DEFAULT_MAINTENANCE_MONTHS || 3);
const createBookings = process.env.STORE_WEBHOOK_CREATE_BOOKINGS !== "false";
const localDevOwnerFile = path.resolve(process.cwd(), ".store-webhook-owner");
const localStoreFile = path.resolve(process.cwd(), ".store-webhook-local.json");

function recentWebhookAttempts(limit = 12) {
  const attemptsPath = path.join(process.cwd(), ".store-webhook-attempts.log");
  if (!fs.existsSync(attemptsPath)) return [];

  try {
    return fs
      .readFileSync(attemptsPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .reverse()
      .slice(0, limit)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return {
            at: null,
            accepted: false,
            statusCode: 0,
            error: "Could not parse webhook attempt log line.",
          };
        }
      });
  } catch {
    return [];
  }
}

function httpError(status: number, message: string) {
  const err = new Error(message) as Error & { status?: number };
  err.status = status;
  return err;
}

function webhookSecret() {
  return process.env.STORE_WEBHOOK_SECRET || "";
}

function webhookOwnerUid() {
  const configuredOwner = process.env.STORE_WEBHOOK_OWNER_UID || "";
  if (configuredOwner) return configuredOwner;

  if (!localWebhookOwnerEnabled()) return "";

  try {
    return fs.readFileSync(localDevOwnerFile, "utf8").trim();
  } catch {
    return "";
  }
}

function localWebhookOwnerEnabled() {
  return process.env.NODE_ENV !== "production" && process.env.ALLOW_LOCAL_AUTH === "true";
}

function ensureLocalWebhookOwner(currentUid: string) {
  if (process.env.STORE_WEBHOOK_OWNER_UID || !localWebhookOwnerEnabled() || !currentUid) return;

  const existingOwner = webhookOwnerUid();
  if (existingOwner === currentUid) return;

  fs.writeFileSync(localDevOwnerFile, currentUid, "utf8");
}

function localStoreFallbackEnabled() {
  const usesSupabase = process.env.DATA_PROVIDER === "supabase" || process.env.DB_PROVIDER === "supabase";
  const hasAdminCredential = Boolean(
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
      process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS ||
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SERVICE_KEY,
  );
  return (
    process.env.NODE_ENV !== "production" &&
    !usesSupabase &&
    process.env.STORE_WEBHOOK_LOCAL_FALLBACK !== "false" &&
    !hasAdminCredential
  );
}

function usingSupabaseAdapter() {
  return process.env.DATA_PROVIDER === "supabase" || process.env.DB_PROVIDER === "supabase";
}

function saveRawPayloadEnabled() {
  return process.env.STORE_WEBHOOK_SAVE_RAW_PAYLOAD === "true";
}

function defaultTechId() {
  return process.env.STORE_WEBHOOK_DEFAULT_TECHNICIAN_ID || "";
}

function defaultTechName() {
  return process.env.STORE_WEBHOOK_DEFAULT_TECHNICIAN_NAME || "";
}

function hash(value: string, length = 32) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, length);
}

function hmac(value: Buffer, secret: string) {
  return crypto.createHmac("sha256", secret).update(value).digest("hex");
}

function safeEquals(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function cleanSignature(value?: string) {
  return String(value || "").trim().replace(/^sha256=/i, "");
}

function verifyStoreWebhook(req: RawBodyRequest) {
  const secret = webhookSecret();
  if (!secret) throw httpError(503, "STORE_WEBHOOK_SECRET is missing.");

  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  const authorization = String(req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const sharedSecret = String(req.get("x-golden-webhook-secret") || authorization || "");
  if (sharedSecret && safeEquals(sharedSecret, secret)) {
    return { authMode: "shared-secret", rawBody };
  }

  const signature = cleanSignature(
    req.get("x-golden-signature") ||
      req.get("x-salla-signature") ||
      req.get("x-store-signature") ||
      req.get("x-hub-signature-256"),
  );
  const expected = hmac(rawBody, secret);
  if (signature && safeEquals(signature, expected)) {
    return { authMode: "hmac-sha256", rawBody };
  }

  throw httpError(401, "Invalid or missing webhook signature.");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function at(source: unknown, path: string) {
  return path.split(".").reduce<unknown>((current, key) => asRecord(current)[key], source);
}

function text(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value).trim();
  return "";
}

function firstText(...values: unknown[]) {
  for (const value of values) {
    const found = text(value);
    if (found) return found;
  }
  return "";
}

function truncate(value: string, max: number) {
  return value.length > max ? value.slice(0, max) : value;
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const normalized = value.replace(/[^\d.-]/g, "");
    // No digit at all (empty or purely non-numeric like "" / "-" / "N/A") is
    // "absent", not zero. Returning 0 here made optionalNumberValue stop at the
    // first empty field and zero out prices that were present in a later field.
    if (!/\d/.test(normalized)) return undefined;
    const n = Number(normalized);
    return Number.isFinite(n) ? n : undefined;
  }

  const record = asRecord(value);
  if (Object.keys(record).length) {
    return numericValue(record.amount ?? record.value ?? record.total ?? record.price);
  }

  return undefined;
}

function numberValue(value: unknown, fallback = 0) {
  return numericValue(value) ?? fallback;
}

function optionalNumberValue(...values: unknown[]) {
  for (const value of values) {
    const n = numericValue(value);
    if (n !== undefined) return n;
  }
  return undefined;
}

function itemsArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.map(asRecord).filter((item) => Object.keys(item).length > 0);
}

function tagsFrom(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === "string") {
    return value.split(/[,،|]/).map((item) => item.trim()).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value
      .flatMap((item) => {
        const record = asRecord(item);
        return firstText(item, record.name, record.title, record.value, record.slug);
      })
      .map((item) => item.trim())
      .filter(Boolean);
  }
  const record = asRecord(value);
  return [firstText(record.name, record.title, record.value, record.slug)].filter(Boolean);
}

function dateOnly(value: unknown, fallback = new Date()) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed =
    typeof value === "number"
      ? new Date(value > 10_000_000_000 ? value : value * 1000)
      : value
        ? new Date(String(value))
        : fallback;
  const safeDate = Number.isNaN(parsed.getTime()) ? fallback : parsed;
  return safeDate.toLocaleDateString("en-CA", { timeZone });
}

// Canonical phone form used across the CRM: digits only, KSA-normalized to a
// 966 prefix (mirrors normalizePhone/toJid in server/whatsapp.ts) so store
// imports match manually-entered customers and outbound WhatsApp resolves.
function normalizedPhone(value: string) {
  let digits = String(value || "").trim().replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = `966${digits.slice(1)}`;
  if (digits.length === 9 && digits.startsWith("5")) digits = `966${digits}`;
  return truncate(digits, 24);
}

// Salla splits the number into `mobile` (e.g. 551496683) and `mobile_code`
// (e.g. "+966"). Join them so the country code is never dropped; an already
// international number (starts with +) is returned as-is.
function joinCountryCode(code: unknown, number: unknown) {
  const num = String(number ?? "").trim();
  if (!num || num.startsWith("+")) return num;
  const dialCode = String(code ?? "").trim();
  return dialCode ? `${dialCode}${num}` : num;
}

function skuMatchKey(value?: string | null) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/^(EXT-MAINT|EXTMAINT|INSTALL|MAINT|SALE|EXT)-/, "")
    .replace(/\s+/g, "");
}

function classifyStoreItem(sku: string, tags: string[], explicitType = ""): StoreItemType {
  const upperSku = sku.toUpperCase();
  const haystack = [sku, explicitType, ...tags].join(" ").toLowerCase();

  if (upperSku.startsWith("SALE-") || haystack.includes("sale_only") || haystack.includes("بيع فقط")) {
    return "sale_only";
  }
  if (
    upperSku.startsWith("INSTALL-") ||
    haystack.includes("install_maintenance") ||
    haystack.includes("installation") ||
    haystack.includes("تركيب")
  ) {
    return "install_maintenance";
  }
  if (
    upperSku.startsWith("EXT-") ||
    upperSku.startsWith("EXTMAINT-") ||
    upperSku.startsWith("EXT-MAINT-") ||
    haystack.includes("external_maintenance") ||
    haystack.includes("external maintenance") ||
    haystack.includes("صيانة خارجية")
  ) {
    return "external_maintenance";
  }
  if (
    upperSku.startsWith("MAINT-") ||
    haystack.includes("maintenance_existing") ||
    haystack.includes("maintenance") ||
    haystack.includes("صيانة")
  ) {
    return "maintenance_existing";
  }
  return "needs_review";
}

function parseItems(order: Record<string, unknown>, provider: string, orderId: string) {
  const rawItems = itemsArray(
    order.items ||
      order.line_items ||
      order.products ||
      at(order, "cart.items") ||
      at(order, "details.items"),
  );

  const items = rawItems.map((item, index) => {
    const product = asRecord(item.product);
    const name = firstText(item.name, item.title, item.product_name, product.name) || "منتج متجر";
    const sku =
      firstText(item.sku, item.SKU, item.product_sku, product.sku, product.SKU) ||
      `${provider}-${hash(`${orderId}:${name}:${index}`, 12)}`;
    const quantity = Math.max(1, Math.round(numberValue(item.quantity || item.qty, 1)));
    const unitPrice = optionalNumberValue(
      item.unit_price,
      item.price,
      item.sale_price,
      item.amount,
      at(item, "price.amount"),
      at(product, "price.amount"),
      product.price,
    );
    const totalPrice = optionalNumberValue(
      item.total,
      item.total_price,
      item.amounts,
      at(item, "total.amount"),
      unitPrice !== undefined ? unitPrice * quantity : undefined,
    );
    const maintenanceMonths = Math.max(
      1,
      Math.round(numberValue(item.maintenance_months || item.interval_months || product.maintenance_months, defaultMaintenanceMonths)),
    );
    const tags = [
      ...tagsFrom(item.tags),
      ...tagsFrom(item.tag),
      ...tagsFrom(product.tags),
      ...tagsFrom(at(item, "metadata.tags")),
    ];
    const explicitType = firstText(
      item.crm_type,
      item.order_type,
      item.service_type,
      item.item_type,
      product.crm_type,
      at(item, "metadata.crm_type"),
    );

    return {
      name: truncate(name, 80),
      sku: truncate(sku, 80),
      quantity,
      unitPrice: unitPrice ?? null,
      totalPrice: totalPrice ?? null,
      currency: truncate(firstText(item.currency, product.currency, at(item, "price.currency"), "SAR"), 12),
      maintenanceMonths,
      orderType: classifyStoreItem(sku, tags, explicitType),
      tags: tags.map((tag) => truncate(tag, 80)),
    };
  });

  if (items.length) return items;

  const fallbackSku = `${provider}-${hash(orderId, 12)}`;
  return [{
    name: "طلب متجر",
    sku: fallbackSku,
    quantity: 1,
    unitPrice: null,
    totalPrice: null,
    currency: "SAR",
    maintenanceMonths: Math.max(1, defaultMaintenanceMonths),
    orderType: classifyStoreItem(fallbackSku, [], ""),
    tags: [],
  }];
}

export function normalizeStorePayload(req: Request, rawBody: Buffer): StoreWebhookOrder {
  const body = asRecord(req.body);
  const data = asRecord(body.data);
  const order = asRecord(body.order || data.order || data || body);
  const customer = asRecord(order.customer || order.client || order.user || body.customer || data.customer);
  const shipping = asRecord(order.shipping || order.shipping_address || order.delivery || body.shipping);
  const billing = asRecord(order.billing || order.billing_address || body.billing);

  const provider = truncate(
    firstText(req.get("x-store-provider"), body.provider, body.source, order.provider) || "salla",
    40,
  );
  const eventType = truncate(
    firstText(req.get("x-store-event"), body.event, body.type, body.event_type, order.event_type) || "order.created",
    80,
  );
  const orderId = truncate(
    firstText(order.id, order.order_id, order.uuid, body.order_id, data.order_id, order.reference, order.number) ||
      hash(rawBody.toString("utf8"), 24),
    80,
  );
  const orderNumber = truncate(firstText(order.number, order.order_number, order.reference, orderId), 80);
  const eventId = truncate(
    firstText(req.get("x-store-event-id"), body.event_id, body.id, data.event_id) ||
      `${provider}:${eventType}:${orderId}`,
    160,
  );

  const firstName = firstText(customer.first_name, customer.firstname);
  const lastName = firstText(customer.last_name, customer.lastname);
  const customerName = truncate(
    firstText(
      customer.name,
      customer.full_name,
      `${firstName} ${lastName}`.trim(),
      order.customer_name,
      shipping.name,
      billing.name,
    ) || "عميل متجر",
    80,
  );
  const customerPhone = normalizedPhone(
    firstText(
      customer.phone,
      joinCountryCode(customer.mobile_code, customer.mobile),
      customer.mobile,
      customer.phone_number,
      order.customer_phone,
      order.phone,
      shipping.phone,
      joinCountryCode(shipping.mobile_code, shipping.mobile),
      shipping.mobile,
      billing.phone,
      joinCountryCode(billing.mobile_code, billing.mobile),
      billing.mobile,
    ),
  );
  if (!customerPhone) throw httpError(422, "Store order does not include a customer phone number.");

  const orderDate = dateOnly(firstText(order.created_at, order.createdAt, order.date, body.created_at));
  const scheduledDateRaw = firstText(
    order.installation_date,
    order.appointment_date,
    order.delivery_date,
    shipping.delivery_date,
  );
  const scheduledTime = truncate(
    firstText(order.installation_time, order.appointment_time, order.delivery_time, shipping.delivery_time, "10:00"),
    20,
  );

  return {
    provider,
    eventType,
    eventId,
    orderId,
    orderNumber,
    status: truncate(firstText(order.status, body.status, "new"), 40),
    customerName,
    customerPhone,
    customerCity: truncate(firstText(customer.city, shipping.city, billing.city), 80),
    orderDate,
    scheduledDate: scheduledDateRaw ? dateOnly(scheduledDateRaw) : undefined,
    scheduledTime,
    total: optionalNumberValue(order.total, order.total_price, order.amount, at(order, "amounts.total.amount")),
    items: parseItems(order, provider, orderId),
  };
}

async function findCustomer(uid: string, phone: string) {
  const snap = await adminDb
    .collection("customers")
    .where("createdBy", "==", uid)
    .where("phone", "==", phone)
    .limit(1)
    .get();
  return snap.docs[0] || null;
}

async function findProduct(uid: string, sku: string) {
  const snap = await adminDb
    .collection("products")
    .where("createdBy", "==", uid)
    .where("sku", "==", sku)
    .limit(1)
    .get();
  return snap.docs[0] || null;
}

async function findInstallationByPhoneAndSku(uid: string, phone: string, sku: string) {
  const requestedKey = skuMatchKey(sku);
  const bySku = await adminDb
    .collection("installations")
    .where("createdBy", "==", uid)
    .where("customer_phone", "==", phone)
    .where("product_sku", "==", sku)
    .where("status", "==", "active")
    .limit(1)
    .get();
  if (!bySku.empty) return bySku.docs[0];

  const activeForCustomer = await adminDb
    .collection("installations")
    .where("createdBy", "==", uid)
    .where("customer_phone", "==", phone)
    .where("status", "==", "active")
    .limit(30)
    .get();
  const normalizedMatch = activeForCustomer.docs.find((doc) => {
    const data = doc.data() || {};
    return skuMatchKey(data.product_sku) === requestedKey;
  });
  if (normalizedMatch) return normalizedMatch;

  const product = await findProduct(uid, sku);
  if (!product) return null;

  const byProduct = await adminDb
    .collection("installations")
    .where("createdBy", "==", uid)
    .where("customer_phone", "==", phone)
    .where("product_id", "==", product.id)
    .where("status", "==", "active")
    .limit(1)
    .get();
  return byProduct.docs[0] || null;
}

async function upsertCustomer(uid: string, order: StoreWebhookOrder, now: string) {
  const existing = await findCustomer(uid, order.customerPhone);
  if (existing) {
    const data = existing.data();
    await existing.ref.set({
      name: order.customerName,
      phone: order.customerPhone,
      city: order.customerCity || "",
      source: data.source || "salla",
      store_provider: order.provider,
      store_customer_id: data.store_customer_id || null,
      createdBy: uid,
      createdAt: data.createdAt || now,
      updatedAt: now,
    }, { merge: true });
    return existing.id;
  }

  const ref = adminDb.collection("customers").doc();
  await ref.set({
    name: order.customerName,
    phone: order.customerPhone,
    city: order.customerCity || "",
    source: "salla",
    store_provider: order.provider,
    store_customer_id: null,
    createdBy: uid,
    createdAt: now,
    updatedAt: now,
  });
  return ref.id;
}

async function upsertProduct(uid: string, item: StoreWebhookItem, now: string) {
  const existing = await findProduct(uid, item.sku);
  if (existing) {
    const data = existing.data();
    await existing.ref.set({
      name: item.name,
      interval_months: Number(data.interval_months || item.maintenanceMonths || defaultMaintenanceMonths),
      category: data.category || "متجر",
      sku: item.sku,
      remind_text: data.remind_text || "",
      source: data.source || "salla",
      product_type: data.product_type || item.orderType,
      createdBy: uid,
      createdAt: data.createdAt || now,
      updatedAt: now,
    }, { merge: true });
    return existing.id;
  }

  const ref = adminDb.collection("products").doc();
  await ref.set({
    name: item.name,
    interval_months: item.maintenanceMonths,
    category: "متجر",
    sku: item.sku,
    remind_text: "",
    source: "salla",
    product_type: item.orderType,
    createdBy: uid,
    createdAt: now,
    updatedAt: now,
  });
  return ref.id;
}

function createBookingAllowed(order: StoreWebhookOrder) {
  return Boolean(createBookings && order.scheduledDate && defaultTechId() && defaultTechName());
}

async function createStoreBooking(params: {
  uid: string;
  order: StoreWebhookOrder;
  customerId: string;
  productId: string;
  item: StoreWebhookItem;
  installationId: string;
  bookingType: "installation" | "maintenance" | "external_maintenance";
  now: string;
}) {
  const { uid, order, customerId, productId, item, installationId, bookingType, now } = params;
  if (!createBookingAllowed(order)) return null;

  const bookingId = `store_${hash(`${installationId}:${order.orderId}:${item.sku}:${bookingType}:booking`)}`;
  const bookingRef = adminDb.collection("bookings").doc(bookingId);
  const existingBooking = await bookingRef.get();
  const previous = existingBooking.exists ? existingBooking.data() || {} : {};

  await bookingRef.set({
    installation_id: installationId,
    customer_id: customerId,
    customer_name: order.customerName,
    customer_phone: order.customerPhone,
    product_id: productId,
    product_name: item.name,
    technician_id: defaultTechId(),
    tech_name: defaultTechName(),
    date: order.scheduledDate,
    scheduled_time: order.scheduledTime || "10:00",
    status: previous.status || "confirmed",
    booking_type: bookingType,
    source: "salla",
    store_order_id: `store_${hash(`${uid}:${order.provider}:${order.orderId}`)}`,
    store_order_number: order.orderNumber,
    createdBy: uid,
    createdAt: previous.createdAt || now,
    updatedAt: now,
  }, { merge: true });

  return bookingId;
}

function resolveJourneyStatus(items: ImportedOrderItem[]): StoreJourneyStatus {
  if (!items.length) return "received";
  if (items.some((item) => item.status === "needs_review")) return "needs_review";
  if (items.some((item) => item.status === "booking_created")) return "booking_created";
  if (items.some((item) => item.status === "awaiting_schedule")) return "awaiting_schedule";
  if (items.some((item) => item.status === "installation_created")) return "installation_created";
  if (items.some((item) => item.status === "maintenance_matched")) return "maintenance_matched";
  if (items.every((item) => item.status === "sale_recorded")) return "sale_recorded";
  return "received";
}

function isStoreItemType(value: unknown): value is StoreItemType {
  return (
    value === "sale_only" ||
    value === "install_maintenance" ||
    value === "maintenance_existing" ||
    value === "external_maintenance" ||
    value === "needs_review"
  );
}

function hydrateImportedOrderItem(item: any): ImportedOrderItem {
  const effectiveType = isStoreItemType(item?.order_type) ? item.order_type : "needs_review";
  return {
    name: String(item?.name || "Store item"),
    sku: String(item?.sku || ""),
    quantity: Math.max(1, Number(item?.quantity || 1)),
    unit_price: optionalNumberValue(item?.unit_price) ?? null,
    total_price: optionalNumberValue(item?.total_price) ?? null,
    currency: item?.currency || null,
    tags: Array.isArray(item?.tags) ? item.tags.map((tag: unknown) => String(tag || "").trim()).filter(Boolean) : [],
    order_type: effectiveType,
    detected_type: isStoreItemType(item?.detected_type) ? item.detected_type : effectiveType,
    manual_type: isStoreItemType(item?.manual_type) ? item.manual_type : null,
    status: (item?.status as StoreJourneyStatus) || "received",
    product_id: item?.product_id || null,
    installation_id: item?.installation_id || null,
    booking_id: item?.booking_id || null,
    reason: item?.reason || null,
  };
}

function importedItemBase(item: StoreWebhookItem) {
  return {
    name: item.name,
    sku: item.sku,
    quantity: item.quantity,
    unit_price: item.unitPrice ?? null,
    total_price: item.totalPrice ?? (item.unitPrice !== undefined && item.unitPrice !== null ? item.unitPrice * item.quantity : null),
    currency: item.currency || "SAR",
    tags: item.tags || [],
  };
}

function effectiveItemType(item: ImportedOrderItem) {
  return item.manual_type && isStoreItemType(item.manual_type) ? item.manual_type : item.order_type;
}

function applyManualClassification(item: ImportedOrderItem, manualType: StoreItemType) {
  const next: ImportedOrderItem = {
    ...item,
    detected_type: item.detected_type || item.order_type,
    manual_type: manualType,
    order_type: manualType,
  };

  if (manualType === "sale_only") {
    next.status = "sale_recorded";
    next.installation_id = null;
    next.booking_id = null;
    next.reason = null;
    return next;
  }

  if (manualType === "install_maintenance") {
    next.status = next.booking_id ? "booking_created" : "awaiting_schedule";
    next.reason = next.booking_id ? null : "بانتظار تعيين فني وموعد.";
    return next;
  }

  if (manualType === "external_maintenance") {
    next.status = next.booking_id ? "booking_created" : "awaiting_schedule";
    next.reason = next.booking_id ? null : "طلب صيانة خارجي بانتظار تعيين فني وموعد.";
    return next;
  }

  if (manualType === "maintenance_existing") {
    if (next.installation_id) {
      next.status = next.booking_id ? "booking_created" : "maintenance_matched";
      next.reason = next.booking_id ? null : "تم ربط الطلب بتركيب سابق ويحتاج جدولة.";
    } else {
      next.status = "needs_review";
      next.reason = "اختر تركيبا سابقا لهذا البند قبل تحويله إلى الفني.";
    }
    return next;
  }

  next.status = "needs_review";
  next.reason = "يحتاج تصنيف يدوي قبل التنفيذ.";
  next.installation_id = null;
  next.booking_id = null;
  return next;
}

function mergeImportedItemsWithExisting(nextItems: ImportedOrderItem[], existingOrder: Record<string, any> = {}) {
  const previousItems = Array.isArray(existingOrder.items)
    ? existingOrder.items.map(hydrateImportedOrderItem)
    : [];

  return nextItems.map((nextItem) => {
    const previous =
      previousItems.find((item) => item.sku === nextItem.sku) ||
      previousItems.find((item) => item.name === nextItem.name);
    if (!previous) return nextItem;

    const merged: ImportedOrderItem = {
      ...nextItem,
      detected_type: previous.detected_type || nextItem.detected_type || nextItem.order_type,
      manual_type: previous.manual_type || null,
      product_id: nextItem.product_id || previous.product_id || null,
      installation_id: previous.installation_id || nextItem.installation_id || null,
      booking_id: previous.booking_id || nextItem.booking_id || null,
      reason: previous.manual_type ? previous.reason : nextItem.reason,
    };

    if (previous.manual_type && isStoreItemType(previous.manual_type)) {
      return applyManualClassification(merged, previous.manual_type);
    }

    if (previous.booking_id || previous.installation_id) {
      return {
        ...merged,
        status: previous.status || nextItem.status,
        reason: previous.reason || nextItem.reason,
      };
    }

    return merged;
  });
}

function uniqueValues(values: unknown[]) {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
}

async function importStoreOrder(uid: string, order: StoreWebhookOrder): Promise<ImportedOrderResult> {
  const now = new Date().toISOString();
  const customerId = await upsertCustomer(uid, order, now);
  const productIds: string[] = [];
  const installationIds: string[] = [];
  const bookingIds: string[] = [];
  const itemJourneys: ImportedOrderItem[] = [];

  for (const [index, item] of order.items.entries()) {
    const productId = await upsertProduct(uid, item, now);
    productIds.push(productId);

    if (item.orderType === "sale_only") {
      itemJourneys.push({
        ...importedItemBase(item),
        order_type: item.orderType,
        detected_type: item.orderType,
        manual_type: null,
        status: "sale_recorded",
        product_id: productId,
      });
      continue;
    }

    if (item.orderType === "needs_review") {
      itemJourneys.push({
        ...importedItemBase(item),
        order_type: item.orderType,
        detected_type: item.orderType,
        manual_type: null,
        status: "needs_review",
        product_id: productId,
        reason: "SKU/tag did not match SALE-, INSTALL-, MAINT-, or EXT- classification.",
      });
      continue;
    }

    if (item.orderType === "external_maintenance") {
      const installationId = `store_${hash(`${uid}:${order.provider}:${order.orderId}:${item.sku}:${index}:external`)}`;
      const installationRef = adminDb.collection("installations").doc(installationId);
      const existingInstallation = await installationRef.get();
      const existing = existingInstallation.exists ? existingInstallation.data() || {} : {};
      const serviceDate = order.scheduledDate || order.orderDate;
      const nextMaintenance = addCalendarMonths(serviceDate, item.maintenanceMonths);

      await installationRef.set({
        customer_id: customerId,
        customer_name: order.customerName,
        customer_phone: order.customerPhone,
        product_id: productId,
        product_name: item.name,
        product_sku: item.sku,
        install_date: existing.install_date || serviceDate,
        next_maintenance: existing.next_maintenance || nextMaintenance,
        remind_count: Number(existing.remind_count || 0),
        next_remind_type: existing.next_remind_type || "first",
        label: truncate(`External maintenance ${order.orderNumber} x ${item.quantity}`, 120),
        status: existing.status || "pending_external_service",
        completed_date: existing.completed_date || null,
        last_remind_at: existing.last_remind_at || null,
        last_remind_attempt_at: existing.last_remind_attempt_at || null,
        source: "salla",
        store_order_id: `store_${hash(`${uid}:${order.provider}:${order.orderId}`)}`,
        store_order_number: order.orderNumber,
        order_item_type: item.orderType,
        createdBy: uid,
        createdAt: existing.createdAt || now,
        updatedAt: now,
      }, { merge: true });
      installationIds.push(installationId);

      const bookingId = await createStoreBooking({
        uid,
        order,
        customerId,
        productId,
        item,
        installationId,
        bookingType: "external_maintenance",
        now,
      });
      if (bookingId) bookingIds.push(bookingId);

      itemJourneys.push({
        ...importedItemBase(item),
        order_type: item.orderType,
        detected_type: item.orderType,
        manual_type: null,
        status: bookingId ? "booking_created" : "awaiting_schedule",
        product_id: productId,
        installation_id: installationId,
        booking_id: bookingId,
        reason: bookingId ? null : "External maintenance request is waiting for scheduling.",
      });
      continue;
    }

    if (item.orderType === "maintenance_existing") {
      const existingInstallation = await findInstallationByPhoneAndSku(uid, order.customerPhone, item.sku);
      if (!existingInstallation) {
        itemJourneys.push({
          ...importedItemBase(item),
          order_type: item.orderType,
          detected_type: item.orderType,
          manual_type: null,
          status: "needs_review",
          product_id: productId,
          reason: "No active installation found for customer phone + SKU.",
        });
        continue;
      }

      const bookingId = await createStoreBooking({
        uid,
        order,
        customerId,
        productId,
        item,
        installationId: existingInstallation.id,
        bookingType: "maintenance",
        now,
      });

      installationIds.push(existingInstallation.id);
      if (bookingId) bookingIds.push(bookingId);
      itemJourneys.push({
        ...importedItemBase(item),
        order_type: item.orderType,
        detected_type: item.orderType,
        manual_type: null,
        status: bookingId ? "booking_created" : "maintenance_matched",
        product_id: productId,
        installation_id: existingInstallation.id,
        booking_id: bookingId,
      });
      continue;
    }

    const installationId = `store_${hash(`${uid}:${order.provider}:${order.orderId}:${item.sku}:${index}`)}`;
    const installationRef = adminDb.collection("installations").doc(installationId);
    const existingInstallation = await installationRef.get();
    const existing = existingInstallation.exists ? existingInstallation.data() || {} : {};
    const installDate = order.scheduledDate || order.orderDate;
    const nextMaintenance = addCalendarMonths(installDate, item.maintenanceMonths);

    await installationRef.set({
      customer_id: customerId,
      customer_name: order.customerName,
      customer_phone: order.customerPhone,
      product_id: productId,
      product_name: item.name,
      product_sku: item.sku,
      install_date: existing.install_date || installDate,
      next_maintenance: existing.next_maintenance || nextMaintenance,
      remind_count: Number(existing.remind_count || 0),
      next_remind_type: existing.next_remind_type || "first",
      label: truncate(`طلب متجر ${order.orderNumber} × ${item.quantity}`, 120),
      status: existing.status || "pending_installation",
      completed_date: existing.completed_date || null,
      last_remind_at: existing.last_remind_at || null,
      last_remind_attempt_at: existing.last_remind_attempt_at || null,
      source: "salla",
      store_order_id: `store_${hash(`${uid}:${order.provider}:${order.orderId}`)}`,
      store_order_number: order.orderNumber,
      order_item_type: item.orderType,
      createdBy: uid,
      createdAt: existing.createdAt || now,
      updatedAt: now,
    }, { merge: true });
    installationIds.push(installationId);

    const bookingId = await createStoreBooking({
      uid,
      order,
      customerId,
      productId,
      item,
      installationId,
      bookingType: "installation",
      now,
    });
    if (bookingId) bookingIds.push(bookingId);

    itemJourneys.push({
      ...importedItemBase(item),
      order_type: item.orderType,
      detected_type: item.orderType,
      manual_type: null,
      status: bookingId ? "booking_created" : "awaiting_schedule",
      product_id: productId,
      installation_id: installationId,
      booking_id: bookingId,
      reason: bookingId ? null : "No appointment date or default technician is configured.",
    });
  }

  const orderKey = getStoreOrderDocId(uid, order.provider, order.orderId);
  const orderRef = adminDb.collection("store_orders").doc(orderKey);
  const existingOrderDoc = await orderRef.get();
  const existingOrder = existingOrderDoc.exists ? existingOrderDoc.data() || {} : {};
  const mergedItems = mergeImportedItemsWithExisting(itemJourneys, existingOrder);
  const finalProductIds = uniqueValues([
    ...productIds,
    ...mergedItems.map((item) => item.product_id),
    ...(Array.isArray(existingOrder.product_ids) ? existingOrder.product_ids : []),
  ]);
  const finalInstallationIds = uniqueValues([
    ...(Array.isArray(existingOrder.installation_ids) ? existingOrder.installation_ids : []),
    ...installationIds,
    ...mergedItems.map((item) => item.installation_id),
  ]);
  const finalBookingIds = uniqueValues([
    ...(Array.isArray(existingOrder.booking_ids) ? existingOrder.booking_ids : []),
    ...bookingIds,
    ...mergedItems.map((item) => item.booking_id),
  ]);
  const journeyStatus = resolveJourneyStatus(mergedItems);

  await orderRef.set({
    createdBy: uid,
    source: "salla",
    provider: order.provider,
    event_type: order.eventType,
    order_id: order.orderId,
    order_number: order.orderNumber,
    status: order.status,
    journey_status: journeyStatus,
    current_step: journeyStatus,
    customer_id: customerId,
    customer_name: order.customerName,
    customer_phone: order.customerPhone,
    customer_city: order.customerCity || null,
    product_ids: finalProductIds,
    installation_ids: finalInstallationIds,
    booking_ids: finalBookingIds,
    order_types: uniqueValues(mergedItems.map((item) => effectiveItemType(item))),
    items: mergedItems,
    scheduled_date: order.scheduledDate || null,
    scheduled_time: order.scheduledTime || null,
    order_date: order.orderDate,
    total: order.total ?? null,
    imported_at: existingOrder.imported_at || now,
    last_event_at: now,
    updatedAt: now,
  }, { merge: true });

  return {
    customer_id: customerId,
    product_ids: finalProductIds,
    installation_ids: finalInstallationIds,
    booking_ids: finalBookingIds,
    journey_status: journeyStatus,
    items: mergedItems,
  };
}

export function getStoreOrderDocId(uid: string, provider: string, orderId: string) {
  return `store_${hash(`${uid}:${provider}:${orderId}`)}`;
}

export async function importStoreOrderForUser(
  uid: string,
  order: StoreWebhookOrder,
  extras: Record<string, unknown> = {},
): Promise<ImportedOrderResult> {
  const imported = await importStoreOrder(uid, order);

  if (!localStoreFallbackEnabled()) {
    const orderKey = getStoreOrderDocId(uid, order.provider, order.orderId);
    await adminDb.collection("store_orders").doc(orderKey).update({
      createdBy: uid,
      ...extras,
      updatedAt: new Date().toISOString(),
    });
  }

  return imported;
}

type LocalStoreDb = {
  customers: Record<string, any>;
  products: Record<string, any>;
  installations: Record<string, any>;
  bookings: Record<string, any>;
  store_orders: Record<string, any>;
  store_webhook_events: Record<string, any>;
};

function emptyLocalStore(): LocalStoreDb {
  return {
    customers: {},
    products: {},
    installations: {},
    bookings: {},
    store_orders: {},
    store_webhook_events: {},
  };
}

function loadLocalStore(): LocalStoreDb {
  try {
    return { ...emptyLocalStore(), ...JSON.parse(fs.readFileSync(localStoreFile, "utf8")) };
  } catch {
    return emptyLocalStore();
  }
}

function saveLocalStore(data: LocalStoreDb) {
  fs.writeFileSync(localStoreFile, JSON.stringify(data, null, 2), "utf8");
}

function localId(prefix: string, seed: string) {
  return `${prefix}_${hash(seed, 20)}`;
}

function localRecords(collection: Record<string, any>, uid: string) {
  return Object.entries(collection)
    .filter(([, value]) => value?.createdBy === uid)
    .map(([id, value]) => ({ id, ...value }));
}

function localFindCustomer(data: LocalStoreDb, uid: string, phone: string) {
  return localRecords(data.customers, uid).find((item) => item.phone === phone) || null;
}

function localFindProduct(data: LocalStoreDb, uid: string, sku: string) {
  return localRecords(data.products, uid).find((item) => item.sku === sku) || null;
}

function localFindInstallationByPhoneAndSku(data: LocalStoreDb, uid: string, phone: string, sku: string) {
  const requestedKey = skuMatchKey(sku);
  return localRecords(data.installations, uid).find((item) =>
    item.customer_phone === phone &&
    item.status === "active" &&
    (item.product_sku === sku || skuMatchKey(item.product_sku) === requestedKey),
  ) || null;
}

function localUpsertCustomer(data: LocalStoreDb, uid: string, order: StoreWebhookOrder, now: string) {
  const existing = localFindCustomer(data, uid, order.customerPhone);
  const id = existing?.id || localId("cust", `${uid}:${order.customerPhone}`);
  data.customers[id] = {
    ...(existing || {}),
    name: order.customerName,
    phone: order.customerPhone,
    city: order.customerCity || "",
    source: existing?.source || "salla",
    store_provider: order.provider,
    store_customer_id: existing?.store_customer_id || null,
    createdBy: uid,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  return id;
}

function localUpsertProduct(data: LocalStoreDb, uid: string, item: StoreWebhookItem, now: string) {
  const existing = localFindProduct(data, uid, item.sku);
  const id = existing?.id || localId("prod", `${uid}:${item.sku}`);
  data.products[id] = {
    ...(existing || {}),
    name: item.name,
    interval_months: Number(existing?.interval_months || item.maintenanceMonths || defaultMaintenanceMonths),
    category: existing?.category || "متجر",
    sku: item.sku,
    remind_text: existing?.remind_text || "",
    source: existing?.source || "salla",
    product_type: existing?.product_type || item.orderType,
    createdBy: uid,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  return id;
}

function localCreateBooking(params: {
  data: LocalStoreDb;
  uid: string;
  order: StoreWebhookOrder;
  customerId: string;
  productId: string;
  item: StoreWebhookItem;
  installationId: string;
  bookingType: "installation" | "maintenance" | "external_maintenance";
  now: string;
}) {
  const { data, uid, order, customerId, productId, item, installationId, bookingType, now } = params;
  if (!createBookingAllowed(order)) return null;

  const bookingId = localId("book", `${installationId}:${order.orderId}:${item.sku}:${bookingType}:booking`);
  const previous = data.bookings[bookingId] || {};
  data.bookings[bookingId] = {
    ...previous,
    installation_id: installationId,
    customer_id: customerId,
    customer_name: order.customerName,
    customer_phone: order.customerPhone,
    product_id: productId,
    product_name: item.name,
    technician_id: defaultTechId(),
    tech_name: defaultTechName(),
    date: order.scheduledDate,
    scheduled_time: order.scheduledTime || "10:00",
    status: previous.status || "confirmed",
    booking_type: bookingType,
    source: "salla",
    store_order_id: localId("store", `${uid}:${order.provider}:${order.orderId}`),
    store_order_number: order.orderNumber,
    createdBy: uid,
    createdAt: previous.createdAt || now,
    updatedAt: now,
  };
  return bookingId;
}

function localImportStoreOrder(data: LocalStoreDb, uid: string, order: StoreWebhookOrder): ImportedOrderResult {
  const now = new Date().toISOString();
  const customerId = localUpsertCustomer(data, uid, order, now);
  const productIds: string[] = [];
  const installationIds: string[] = [];
  const bookingIds: string[] = [];
  const itemJourneys: ImportedOrderItem[] = [];

  for (const [index, item] of order.items.entries()) {
    const productId = localUpsertProduct(data, uid, item, now);
    productIds.push(productId);

    if (item.orderType === "sale_only") {
      itemJourneys.push({
        ...importedItemBase(item),
        order_type: item.orderType,
        status: "sale_recorded",
        product_id: productId,
      });
      continue;
    }

    if (item.orderType === "needs_review") {
      itemJourneys.push({
        ...importedItemBase(item),
        order_type: item.orderType,
        status: "needs_review",
        product_id: productId,
        reason: "SKU/tag did not match SALE-, INSTALL-, MAINT-, or EXT- classification.",
      });
      continue;
    }

    if (item.orderType === "maintenance_existing") {
      const existingInstallation = localFindInstallationByPhoneAndSku(data, uid, order.customerPhone, item.sku);
      if (!existingInstallation) {
        itemJourneys.push({
          ...importedItemBase(item),
          order_type: item.orderType,
          status: "needs_review",
          product_id: productId,
          reason: "No active installation found for customer phone + SKU.",
        });
        continue;
      }

      const bookingId = localCreateBooking({
        data,
        uid,
        order,
        customerId,
        productId,
        item,
        installationId: existingInstallation.id,
        bookingType: "maintenance",
        now,
      });
      installationIds.push(existingInstallation.id);
      if (bookingId) bookingIds.push(bookingId);
      itemJourneys.push({
        ...importedItemBase(item),
        order_type: item.orderType,
        status: bookingId ? "booking_created" : "maintenance_matched",
        product_id: productId,
        installation_id: existingInstallation.id,
        booking_id: bookingId,
      });
      continue;
    }

    const isExternal = item.orderType === "external_maintenance";
    const installationId = localId(
      "inst",
      `${uid}:${order.provider}:${order.orderId}:${item.sku}:${index}:${isExternal ? "external" : "install"}`,
    );
    const existing = data.installations[installationId] || {};
    const startDate = order.scheduledDate || order.orderDate;
    const nextMaintenance = addCalendarMonths(startDate, item.maintenanceMonths);
    data.installations[installationId] = {
      ...existing,
      customer_id: customerId,
      customer_name: order.customerName,
      customer_phone: order.customerPhone,
      product_id: productId,
      product_name: item.name,
      product_sku: item.sku,
      install_date: existing.install_date || startDate,
      next_maintenance: existing.next_maintenance || nextMaintenance,
      remind_count: Number(existing.remind_count || 0),
      next_remind_type: existing.next_remind_type || "first",
      label: truncate(`${isExternal ? "External maintenance" : "Store order"} ${order.orderNumber} x ${item.quantity}`, 120),
      status: existing.status || (isExternal ? "pending_external_service" : "pending_installation"),
      completed_date: existing.completed_date || null,
      last_remind_at: existing.last_remind_at || null,
      last_remind_attempt_at: existing.last_remind_attempt_at || null,
      source: "salla",
      store_order_id: localId("store", `${uid}:${order.provider}:${order.orderId}`),
      store_order_number: order.orderNumber,
      order_item_type: item.orderType,
      createdBy: uid,
      createdAt: existing.createdAt || now,
      updatedAt: now,
    };
    installationIds.push(installationId);

    const bookingId = localCreateBooking({
      data,
      uid,
      order,
      customerId,
      productId,
      item,
      installationId,
      bookingType: isExternal ? "external_maintenance" : "installation",
      now,
    });
    if (bookingId) bookingIds.push(bookingId);

    itemJourneys.push({
      ...importedItemBase(item),
      order_type: item.orderType,
      status: bookingId ? "booking_created" : "awaiting_schedule",
      product_id: productId,
      installation_id: installationId,
      booking_id: bookingId,
      reason: bookingId ? null : "No appointment date or default technician is configured.",
    });
  }

  const orderKey = localId("store", `${uid}:${order.provider}:${order.orderId}`);
  const existingOrder = data.store_orders[orderKey] || {};
  const mergedItems = mergeImportedItemsWithExisting(itemJourneys, existingOrder);
  const finalProductIds = uniqueValues([
    ...productIds,
    ...mergedItems.map((item) => item.product_id),
    ...(Array.isArray(existingOrder.product_ids) ? existingOrder.product_ids : []),
  ]);
  const finalInstallationIds = uniqueValues([
    ...(Array.isArray(existingOrder.installation_ids) ? existingOrder.installation_ids : []),
    ...installationIds,
    ...mergedItems.map((item) => item.installation_id),
  ]);
  const finalBookingIds = uniqueValues([
    ...(Array.isArray(existingOrder.booking_ids) ? existingOrder.booking_ids : []),
    ...bookingIds,
    ...mergedItems.map((item) => item.booking_id),
  ]);
  const journeyStatus = resolveJourneyStatus(mergedItems);

  data.store_orders[orderKey] = {
    ...existingOrder,
    createdBy: uid,
    source: "salla",
    provider: order.provider,
    event_type: order.eventType,
    order_id: order.orderId,
    order_number: order.orderNumber,
    status: order.status,
    journey_status: journeyStatus,
    current_step: journeyStatus,
    customer_id: customerId,
    customer_name: order.customerName,
    customer_phone: order.customerPhone,
    customer_city: order.customerCity || null,
    product_ids: finalProductIds,
    installation_ids: finalInstallationIds,
    booking_ids: finalBookingIds,
    order_types: uniqueValues(mergedItems.map((item) => effectiveItemType(item))),
    items: mergedItems,
    scheduled_date: order.scheduledDate || null,
    scheduled_time: order.scheduledTime || null,
    order_date: order.orderDate,
    total: order.total ?? null,
    imported_at: existingOrder.imported_at || now,
    last_event_at: now,
    updatedAt: now,
  };

  return {
    customer_id: customerId,
    product_ids: finalProductIds,
    installation_ids: finalInstallationIds,
    booking_ids: finalBookingIds,
    journey_status: journeyStatus,
    items: mergedItems,
  };
}

function localStoreDiagnostics(currentUid: string) {
  const data = loadLocalStore();
  const recentEvents = localRecords(data.store_webhook_events, currentUid)
    .sort((a, b) => String(b.received_at || "").localeCompare(String(a.received_at || "")))
    .slice(0, 10)
    .map((event) => ({
      id: event.id,
      provider: event.provider,
      event_type: event.event_type,
      order_id: event.order_id,
      order_number: event.order_number,
      status: event.status,
      received_at: event.received_at,
      processed_at: event.processed_at,
      error: event.error,
      imported: event.imported,
    }));

  return {
    success: true,
    ...getStoreWebhookPublicState(),
    ownerMatchesCurrentUser: webhookOwnerUid() === currentUid,
    localFallback: true,
    createBookings,
    defaultMaintenanceMonths,
    defaultTechnicianConfigured: Boolean(defaultTechId() && defaultTechName()),
    recentEvents,
    recentAttempts: recentWebhookAttempts(),
  };
}

function localStoreOrders(currentUid: string, type?: string) {
  const data = loadLocalStore();
  const orders = localRecords(data.store_orders, currentUid)
    .map((order) => ({
      ...order,
      items: Array.isArray(order.items) ? order.items.map(hydrateImportedOrderItem) : [],
    }))
    .sort((a, b) => String(b.imported_at || "").localeCompare(String(a.imported_at || "")));
  if (!type || type === "all") return orders;
  if (type === "needs_review") return orders.filter((order) => order.journey_status === "needs_review");
  return orders.filter((order) => Array.isArray(order.order_types) && order.order_types.includes(type));
}

function localStoreOrder(currentUid: string, orderDocId: string) {
  const data = loadLocalStore();
  const order = data.store_orders[orderDocId];
  if (!order) throw httpError(404, "Store order was not found.");
  if (order.createdBy !== currentUid) throw httpError(403, "You do not own this store order.");
  return {
    id: orderDocId,
    ...order,
    items: Array.isArray(order.items) ? order.items.map(hydrateImportedOrderItem) : [],
  };
}

async function readOwnedStoreOrder(currentUid: string, orderDocId: string) {
  const orderRef = adminDb.collection("store_orders").doc(orderDocId);
  const orderDoc = await orderRef.get();
  if (!orderDoc.exists) throw httpError(404, "Store order was not found.");
  const order = orderDoc.data() || {};
  if (order.createdBy !== currentUid) throw httpError(403, "You do not own this store order.");
  return { orderRef, orderDoc, order };
}

async function readOwnedTechnician(currentUid: string, technicianId: string) {
  const technicianDoc = await adminDb.collection("technicians").doc(technicianId).get();
  if (!technicianDoc.exists) throw httpError(404, "Technician was not found.");
  const technician = technicianDoc.data() || {};
  if (technician.createdBy !== currentUid) throw httpError(403, "You do not own this technician.");
  if (!technician.phone) throw httpError(422, "Technician phone is missing.");
  return { id: technicianDoc.id, ...technician } as Record<string, any> & { id: string };
}

async function ensureManualInstallationForOrderItem(params: {
  currentUid: string;
  orderDocId: string;
  order: Record<string, any>;
  customerId: string;
  item: ImportedOrderItem;
  itemIndex: number;
  now: string;
}) {
  const { currentUid, orderDocId, order, customerId, item, itemIndex, now } = params;
  if (item.installation_id) {
    const existing = await adminDb.collection("installations").doc(item.installation_id).get();
    if (existing.exists) return existing.id;
  }

  const effectiveType = effectiveItemType(item);
  if (effectiveType !== "install_maintenance" && effectiveType !== "external_maintenance") {
    throw httpError(400, "This order item requires linking to an existing installation first.");
  }

  const productId = String(item.product_id || "");
  if (!productId) throw httpError(422, "Product was not linked to this order item.");

  const productDoc = await adminDb.collection("products").doc(productId).get();
  const product = productDoc.exists ? productDoc.data() || {} : {};
  const intervalMonths = Math.max(1, Number(product.interval_months || defaultMaintenanceMonths));
  const installDate = String(order.scheduled_date || order.order_date || now.slice(0, 10));
  const installationId = `store_${hash(`${currentUid}:${orderDocId}:${item.sku}:${itemIndex}:manual-install`)}`;
  const status = effectiveType === "external_maintenance" ? "pending_external_service" : "pending_installation";

  await adminDb.collection("installations").doc(installationId).set({
    customer_id: customerId,
    customer_name: String(order.customer_name || ""),
    customer_phone: String(order.customer_phone || ""),
    product_id: productId,
    product_name: item.name,
    product_sku: item.sku,
    install_date: installDate,
    next_maintenance: addCalendarMonths(installDate, intervalMonths),
    remind_count: 0,
    next_remind_type: "first",
    label: truncate(`Store order ${order.order_number || order.order_id} x ${item.quantity}`, 120),
    status,
    completed_date: null,
    last_remind_at: null,
    last_remind_attempt_at: null,
    source: "salla",
    store_order_id: orderDocId,
    store_order_number: String(order.order_number || order.order_id || orderDocId),
    order_item_type: effectiveType,
    createdBy: currentUid,
    createdAt: now,
    updatedAt: now,
  }, { merge: true });

  return installationId;
}

async function createOrUpdateManualStoreBooking(params: {
  currentUid: string;
  orderDocId: string;
  order: Record<string, any>;
  item: ImportedOrderItem;
  installationId: string;
  technicianId: string;
  scheduledDate: string;
  scheduledTime: string;
  now: string;
}) {
  const { currentUid, orderDocId, order, item, installationId, technicianId, scheduledDate, scheduledTime, now } = params;
  const technician = await readOwnedTechnician(currentUid, technicianId);
  const effectiveType = effectiveItemType(item);
  const bookingType =
    effectiveType === "external_maintenance"
      ? "external_maintenance"
      : effectiveType === "install_maintenance"
        ? "installation"
        : "maintenance";

  const bookingId = item.booking_id || `store_${hash(`${installationId}:${technicianId}:${item.sku}:${bookingType}:manual-booking`)}`;
  const bookingRef = adminDb.collection("bookings").doc(bookingId);
  const existingBooking = await bookingRef.get();
  const previous = existingBooking.exists ? existingBooking.data() || {} : {};

  await bookingRef.set({
    installation_id: installationId,
    customer_id: String(order.customer_id || ""),
    customer_name: String(order.customer_name || ""),
    customer_phone: String(order.customer_phone || ""),
    product_id: String(item.product_id || ""),
    product_name: item.name,
    technician_id: technician.id,
    tech_name: String(technician.name || ""),
    date: scheduledDate,
    scheduled_time: scheduledTime,
    status: "confirmed",
    booking_type: bookingType,
    source: "salla",
    store_order_id: orderDocId,
    store_order_number: String(order.order_number || order.order_id || orderDocId),
    createdBy: currentUid,
    createdAt: previous.createdAt || now,
    updatedAt: now,
  }, { merge: true });

  return {
    bookingId,
    technicianId: technician.id,
    technicianName: String(technician.name || ""),
  };
}

function localProcessStoreWebhook(
  ownerUid: string,
  authMode: string,
  rawBody: Buffer,
  order: StoreWebhookOrder,
  rawPayload: unknown,
) {
  const data = loadLocalStore();
  const eventKey = `evt_${hash(`${ownerUid}:${order.eventId}`)}`;
  const existingEvent = data.store_webhook_events[eventKey];

  if (existingEvent?.status === "processed") {
    return {
      success: true,
      duplicate: true,
      event_id: order.eventId,
      order_id: order.orderId,
      imported: existingEvent.imported || null,
      localFallback: true,
    };
  }

  const now = new Date().toISOString();
  data.store_webhook_events[eventKey] = {
    ...(existingEvent || {}),
    createdBy: ownerUid,
    provider: order.provider,
    event_type: order.eventType,
    event_id: order.eventId,
    order_id: order.orderId,
    order_number: order.orderNumber,
    status: "processing",
    auth_mode: authMode,
    received_at: existingEvent?.received_at || now,
    payload_hash: hash(rawBody.toString("utf8"), 64),
    raw_payload: saveRawPayloadEnabled() ? rawPayload : undefined,
  };

  try {
    const imported = localImportStoreOrder(data, ownerUid, order);
    data.store_webhook_events[eventKey] = {
      ...data.store_webhook_events[eventKey],
      status: "processed",
      processed_at: new Date().toISOString(),
      imported,
      error: null,
    };
    saveLocalStore(data);
    return {
      success: true,
      duplicate: false,
      provider: order.provider,
      event_type: order.eventType,
      event_id: order.eventId,
      order_id: order.orderId,
      order_number: order.orderNumber,
      imported,
      localFallback: true,
    };
  } catch (error) {
    data.store_webhook_events[eventKey] = {
      ...data.store_webhook_events[eventKey],
      status: "failed",
      processed_at: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    };
    saveLocalStore(data);
    throw error;
  }
}

export function getStoreWebhookPublicState() {
  return {
    configured: Boolean(webhookSecret() && webhookOwnerUid()),
    ownerConfigured: Boolean(webhookOwnerUid()),
    hmacHeader: "X-Golden-Signature",
    sallaSignatureHeader: "X-Salla-Signature",
    secretHeader: "X-Golden-Webhook-Secret",
    endpoint: "/api/store/webhook",
    itemClassification: {
      sale_only: "SALE- or sale_only tag",
      install_maintenance: "INSTALL- or install_maintenance tag",
      maintenance_existing: "MAINT- or maintenance_existing tag",
      external_maintenance: "EXT- or external_maintenance tag",
    },
  };
}

export async function getStoreWebhookDiagnostics(currentUid: string) {
  ensureLocalWebhookOwner(currentUid);

  if (localStoreFallbackEnabled()) return localStoreDiagnostics(currentUid);

  const snap = await adminDb
    .collection("store_webhook_events")
    .where("createdBy", "==", currentUid)
    .orderBy("received_at", "desc")
    .limit(10)
    .get();

  return {
    success: true,
    ...getStoreWebhookPublicState(),
    ownerMatchesCurrentUser: webhookOwnerUid() === currentUid,
    createBookings,
    defaultMaintenanceMonths,
    defaultTechnicianConfigured: Boolean(defaultTechId() && defaultTechName()),
    recentAttempts: recentWebhookAttempts(),
    recentEvents: snap.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        provider: data.provider,
        event_type: data.event_type,
        order_id: data.order_id,
        order_number: data.order_number,
        status: data.status,
        received_at: data.received_at,
        processed_at: data.processed_at,
        error: data.error,
        imported: data.imported,
      };
    }),
  };
}

export async function getStoreOrdersForUser(currentUid: string, type?: string) {
  ensureLocalWebhookOwner(currentUid);

  if (localStoreFallbackEnabled()) return localStoreOrders(currentUid, type);

  const snap = await adminDb
    .collection("store_orders")
    .where("createdBy", "==", currentUid)
    .orderBy("imported_at", "desc")
    .limit(100)
    .get();

  const orders = snap.docs.map((doc) => {
    const data = doc.data() || {};
    return {
      id: doc.id,
      ...data,
      items: Array.isArray(data.items) ? data.items.map(hydrateImportedOrderItem) : [],
    };
  });
  if (!type || type === "all") return orders;
  if (type === "needs_review") return orders.filter((order: any) => order.journey_status === "needs_review");
  return orders.filter((order: any) => Array.isArray(order.order_types) && order.order_types.includes(type));
}

export async function getStoreOrderForUser(currentUid: string, orderDocId: string) {
  if (localStoreFallbackEnabled()) return localStoreOrder(currentUid, orderDocId);

  const doc = await adminDb.collection("store_orders").doc(orderDocId).get();
  if (!doc.exists) throw httpError(404, "Store order was not found.");
  const data = doc.data() || {};
  if (data.createdBy !== currentUid) throw httpError(403, "You do not own this store order.");
  return {
    id: doc.id,
    ...data,
    items: Array.isArray(data.items) ? data.items.map(hydrateImportedOrderItem) : [],
  };
}

export async function classifyStoreOrderItem(
  currentUid: string,
  orderDocId: string,
  payload: { itemSku?: string; manualType?: StoreItemType },
) {
  const manualType = payload.manualType;
  if (!manualType || !isStoreItemType(manualType)) throw httpError(400, "manualType is required.");
  if (localStoreFallbackEnabled()) throw httpError(501, "Manual classification requires configured server storage.");

  const { orderRef, order } = await readOwnedStoreOrder(currentUid, orderDocId);
  const items = Array.isArray(order.items) ? order.items.map(hydrateImportedOrderItem) : [];
  const targetIndex = items.findIndex((item) => (payload.itemSku ? item.sku === payload.itemSku : true));
  if (targetIndex < 0) throw httpError(404, "Order item was not found.");

  items[targetIndex] = applyManualClassification(items[targetIndex], manualType);
  const journeyStatus = resolveJourneyStatus(items);
  const now = new Date().toISOString();

  await orderRef.update({
    items,
    order_types: Array.from(new Set(items.map((item) => effectiveItemType(item)))),
    journey_status: journeyStatus,
    current_step: journeyStatus,
    updatedAt: now,
  });

  return {
    success: true,
    order_id: orderDocId,
    item_sku: items[targetIndex].sku,
    manual_type: manualType,
    journey_status: journeyStatus,
  };
}

export async function assignStoreOrderTechnician(
  currentUid: string,
  orderDocId: string,
  payload: AssignStoreOrderPayload,
) {
  if (!payload.technicianId) throw httpError(400, "technicianId is required.");
  if (!payload.scheduledDate) throw httpError(400, "scheduledDate is required.");
  if (localStoreFallbackEnabled()) throw httpError(501, "Technician assignment requires configured server storage.");

  const { orderRef, order } = await readOwnedStoreOrder(currentUid, orderDocId);
  const items = Array.isArray(order.items) ? order.items.map(hydrateImportedOrderItem) : [];
  const targetIndex = items.findIndex((item) => (payload.itemSku ? item.sku === payload.itemSku : true));
  if (targetIndex < 0) throw httpError(404, "Order item was not found.");

  const targetItem = items[targetIndex];
  const effectiveType = effectiveItemType(targetItem);
  if (effectiveType === "sale_only" || effectiveType === "needs_review") {
    throw httpError(400, "This order item must be classified as service or installation before assigning a technician.");
  }

  const customerId = String(order.customer_id || "");
  if (!customerId) throw httpError(422, "Customer is not linked to this store order.");

  let installationId = targetItem.installation_id || null;
  if (effectiveType === "maintenance_existing" && !installationId) {
    throw httpError(400, "Link this maintenance request to a previous installation first.");
  }

  if (!installationId) {
    installationId = await ensureManualInstallationForOrderItem({
      currentUid,
      orderDocId,
      order,
      customerId,
      item: targetItem,
      itemIndex: targetIndex,
      now: new Date().toISOString(),
    });
  }

  const now = new Date().toISOString();
  const booking = await createOrUpdateManualStoreBooking({
    currentUid,
    orderDocId,
    order: { ...order, customer_id: customerId },
    item: targetItem,
    installationId,
    technicianId: payload.technicianId,
    scheduledDate: payload.scheduledDate,
    scheduledTime: payload.scheduledTime || "10:00",
    now,
  });

  items[targetIndex] = {
    ...targetItem,
    installation_id: installationId,
    booking_id: booking.bookingId,
    status: "booking_created",
    reason: null,
  };

  const journeyStatus = resolveJourneyStatus(items);
  const installationIds = Array.from(new Set([...(Array.isArray(order.installation_ids) ? order.installation_ids : []), installationId]));
  const bookingIds = Array.from(new Set([...(Array.isArray(order.booking_ids) ? order.booking_ids : []), booking.bookingId]));

  await orderRef.update({
    items,
    installation_ids: installationIds,
    booking_ids: bookingIds,
    order_types: Array.from(new Set(items.map((item) => effectiveItemType(item)))),
    journey_status: journeyStatus,
    current_step: journeyStatus,
    scheduled_date: payload.scheduledDate,
    scheduled_time: payload.scheduledTime || "10:00",
    updatedAt: now,
  });

  return {
    success: true,
    order_id: orderDocId,
    item_sku: targetItem.sku,
    installation_id: installationId,
    booking_id: booking.bookingId,
    technician_id: booking.technicianId,
    technician_name: booking.technicianName,
    journey_status: journeyStatus,
  };
}

export async function linkStoreOrderInstallation(currentUid: string, orderDocId: string, installationId: string, itemSku?: string) {
  if (!installationId) throw httpError(400, "installationId is required.");

  if (localStoreFallbackEnabled()) {
    throw httpError(501, "Manual linking is available after configuring Firebase Admin credentials.");
  }

  const orderRef = adminDb.collection("store_orders").doc(orderDocId);
  const [orderDoc, installationDoc] = await Promise.all([
    orderRef.get(),
    adminDb.collection("installations").doc(installationId).get(),
  ]);

  if (!orderDoc.exists) throw httpError(404, "Store order was not found.");
  if (!installationDoc.exists) throw httpError(404, "Installation was not found.");

  const order = orderDoc.data() || {};
  const installation = installationDoc.data() || {};
  if (order.createdBy !== currentUid) throw httpError(403, "You do not own this store order.");
  if (installation.createdBy !== currentUid) throw httpError(403, "You do not own this installation.");
  if (order.customer_phone && installation.customer_phone && order.customer_phone !== installation.customer_phone) {
    throw httpError(400, "Installation customer phone does not match the store order customer phone.");
  }

  const items = Array.isArray(order.items) ? order.items.map(hydrateImportedOrderItem) : [];
  const targetIndex = items.findIndex((item: any) =>
    itemSku
      ? item.sku === itemSku
      : item.status === "needs_review" || item.order_type === "maintenance_existing",
  );
  if (targetIndex < 0) throw httpError(404, "No reviewable order item was found.");

  const now = new Date().toISOString();
  const targetItem = items[targetIndex] as ImportedOrderItem;
  const bookingId = await createStoreBooking({
    uid: currentUid,
    order: {
      provider: String(order.provider || "salla"),
      eventType: String(order.event_type || "manual.link"),
      eventId: String(order.event_id || orderDoc.id),
      orderId: String(order.order_id || orderDoc.id),
      orderNumber: String(order.order_number || order.order_id || orderDoc.id),
      status: String(order.status || "linked"),
      customerName: String(order.customer_name || installation.customer_name || ""),
      customerPhone: String(order.customer_phone || installation.customer_phone || ""),
      customerCity: String(order.customer_city || ""),
      orderDate: String(order.order_date || now.slice(0, 10)),
      scheduledDate: order.scheduled_date || undefined,
      scheduledTime: order.scheduled_time || undefined,
      total: typeof order.total === "number" ? order.total : undefined,
      items: [],
    },
    customerId: String(order.customer_id || installation.customer_id || ""),
    productId: String(installation.product_id || targetItem.product_id || ""),
    item: {
      name: String(targetItem.name || installation.product_name || "Maintenance"),
      sku: String(targetItem.sku || installation.product_sku || ""),
      quantity: Number(targetItem.quantity || 1),
      maintenanceMonths: defaultMaintenanceMonths,
      orderType: "maintenance_existing",
      tags: [],
    },
    installationId: installationDoc.id,
    bookingType: "maintenance",
    now,
  });

  items[targetIndex] = {
    ...targetItem,
    order_type: "maintenance_existing",
    detected_type: targetItem.detected_type || targetItem.order_type,
    manual_type: "maintenance_existing",
    status: bookingId ? "booking_created" : "maintenance_matched",
    installation_id: installationDoc.id,
    product_id: installation.product_id || targetItem.product_id || null,
    booking_id: bookingId || targetItem.booking_id || null,
    reason: bookingId ? null : "Linked manually. No appointment date or default technician is configured.",
  };

  const installationIds = Array.from(new Set([...(order.installation_ids || []), installationDoc.id]));
  const bookingIds = bookingId
    ? Array.from(new Set([...(Array.isArray(order.booking_ids) ? order.booking_ids : []), bookingId]))
    : (Array.isArray(order.booking_ids) ? order.booking_ids : []);
  const journeyStatus = resolveJourneyStatus(items as ImportedOrderItem[]);
  await orderRef.update({
    items,
    installation_ids: installationIds,
    booking_ids: bookingIds,
    order_types: Array.from(new Set(items.map((item: any) => item.order_type))),
    journey_status: journeyStatus,
    current_step: journeyStatus,
    updatedAt: now,
  });

  return {
    success: true,
    order_id: orderDoc.id,
    installation_id: installationDoc.id,
    booking_id: bookingId,
    journey_status: journeyStatus,
  };
}

export async function processStoreWebhook(req: RawBodyRequest) {
  const ownerUid = webhookOwnerUid();
  if (!ownerUid) throw httpError(503, "STORE_WEBHOOK_OWNER_UID is missing.");

  const { authMode, rawBody } = verifyStoreWebhook(req);
  const order = normalizeStorePayload(req, rawBody);

  if (localStoreFallbackEnabled()) {
    return localProcessStoreWebhook(ownerUid, authMode, rawBody, order, req.body);
  }

  const eventKey = `evt_${hash(`${ownerUid}:${order.eventId}`)}`;
  const eventRef = adminDb.collection("store_webhook_events").doc(eventKey);
  const existingEvent = await eventRef.get();

  if (existingEvent.exists && existingEvent.data()?.status === "processed") {
    return {
      success: true,
      duplicate: true,
      event_id: order.eventId,
      order_id: order.orderId,
      imported: existingEvent.data()?.imported || null,
    };
  }

  const now = new Date().toISOString();
  await eventRef.set({
    createdBy: ownerUid,
    provider: order.provider,
    event_type: order.eventType,
    event_id: order.eventId,
    order_id: order.orderId,
    order_number: order.orderNumber,
    status: "processing",
    auth_mode: authMode,
    received_at: now,
    raw_payload: saveRawPayloadEnabled() ? req.body : undefined,
  }, { merge: true });

  try {
      const imported = await importStoreOrderForUser(ownerUid, order, {
        source: "salla",
        provider: order.provider,
        event_type: order.eventType,
      });
    const processedAt = new Date().toISOString();
    await eventRef.set({
      createdBy: ownerUid,
      provider: order.provider,
      event_type: order.eventType,
      event_id: order.eventId,
      order_id: order.orderId,
      order_number: order.orderNumber,
      auth_mode: authMode,
      received_at: now,
      status: "processed",
      processed_at: processedAt,
      imported,
      error: null,
    }, { merge: true });

    return {
      success: true,
      duplicate: false,
      provider: order.provider,
      event_type: order.eventType,
      event_id: order.eventId,
      order_id: order.orderId,
      order_number: order.orderNumber,
      imported,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await eventRef.set({
      createdBy: ownerUid,
      provider: order.provider,
      event_type: order.eventType,
      event_id: order.eventId,
      order_id: order.orderId,
      order_number: order.orderNumber,
      auth_mode: authMode,
      received_at: now,
      status: "failed",
      processed_at: new Date().toISOString(),
      error: errorMessage,
    }, { merge: true });
    throw error;
  }
}
