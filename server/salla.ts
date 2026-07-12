import crypto from "crypto";
import { promises as fs } from "fs";
import path from "path";
import type { Request } from "express";
import { normalizePhoneDigits } from "../shared/phone";
import { adminDb } from "./firebaseAdmin";
import {
  getStoreOrderDocId,
  importStoreOrderForUser,
  normalizeStorePayload,
  type StoreItemType,
  type StoreWebhookOrder,
} from "./storeWebhook";

type SallaIntegrationRecord = {
  provider: "salla";
  createdBy: string;
  status: "not_configured" | "ready_to_connect" | "connected" | "error";
  access_token?: string | null;
  refresh_token?: string | null;
  expires_at?: string | null;
  scope?: string;
  token_type?: string;
  merchant_id?: string | number | null;
  store_name?: string | null;
  store_url?: string | null;
  auth_mode?: "easy" | "custom" | null;
  last_authorized_at?: string | null;
  last_event_at?: string | null;
  last_event_type?: string | null;
  last_sync_at?: string | null;
  last_sync_status?: "success" | "error" | "idle" | null;
  last_sync_count?: number;
  last_sync_error?: string | null;
  last_product_sync_at?: string | null;
  last_product_sync_count?: number;
  last_product_sync_error?: string | null;
  last_customer_sync_at?: string | null;
  last_customer_sync_status?: "success" | "failed" | "error" | "idle" | null;
  last_customer_sync_count?: number;
  last_customer_sync_error?: string | null;
  last_remote_update_at?: string | null;
  updatedAt?: string;
  createdAt?: string;
};

type SallaTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
};

type SyncResult = {
  success: boolean;
  imported: number;
  updated: number;
  failed: number;
  pages: number;
  fetched: number;
  last_sync_at: string;
  last_error?: string | null;
};

const SALLA_AUTHORIZE_URL = "https://accounts.salla.sa/oauth2/auth";
const SALLA_TOKEN_URL = "https://accounts.salla.sa/oauth2/token";
const SALLA_USERINFO_URL = "https://accounts.salla.sa/oauth2/user/info";
const SALLA_API_BASE = "https://api.salla.dev/admin/v2";
const SALLA_CALLBACK_PATH = "/api/integrations/salla/callback";
const SALLA_APP_WEBHOOK_PATH = "/api/integrations/salla/webhook";
const LOCAL_SALLA_STORE_PATH = path.resolve(process.cwd(), ".runtime", "salla-integrations.json");

function nowIso() {
  return new Date().toISOString();
}

function toSettingsShape(data: Partial<SallaIntegrationRecord>) {
  const next: Record<string, unknown> = {
    salla_provider: "salla",
  };
  for (const [key, value] of Object.entries(data)) {
    next[`salla_${key}`] = value;
  }
  return next;
}

function usingSupabaseAdapter() {
  // True for ANY non-Firestore backend (Supabase or local SQLite). Both lack
  // the `settings.salla_*` columns the Firestore adapter expects, so the local
  // JSON store at .runtime/salla-integrations.json is the durable record.
  const provider = (process.env.DATA_PROVIDER || process.env.DB_PROVIDER || "").toLowerCase();
  return provider === "supabase" || provider === "sqlite";
}

async function readLocalIntegrationStore(): Promise<Record<string, SallaIntegrationRecord>> {
  try {
    const raw = await fs.readFile(LOCAL_SALLA_STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Record<string, SallaIntegrationRecord>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeLocalIntegrationStore(data: Record<string, SallaIntegrationRecord>) {
  await fs.mkdir(path.dirname(LOCAL_SALLA_STORE_PATH), { recursive: true });
  await fs.writeFile(LOCAL_SALLA_STORE_PATH, JSON.stringify(data, null, 2), "utf8");
}

function fromSettingsShape(data: Record<string, any> | null | undefined): SallaIntegrationRecord | null {
  if (!data) return null;
  const status = firstText(data.salla_status);
  const token = firstText(data.salla_access_token);
  const refresh = firstText(data.salla_refresh_token);
  if (!status && !token && !refresh) return null;

  return {
    provider: "salla",
    createdBy: firstText(data.createdBy, data.owner_uid),
    status: (status || "error") as SallaIntegrationRecord["status"],
    access_token: token || undefined,
    refresh_token: refresh || undefined,
    expires_at: firstText(data.salla_expires_at) || null,
    scope: firstText(data.salla_scope) || undefined,
    token_type: firstText(data.salla_token_type) || undefined,
    merchant_id: firstText(data.salla_merchant_id) || null,
    store_name: firstText(data.salla_store_name) || null,
    store_url: firstText(data.salla_store_url) || null,
    auth_mode: (firstText(data.salla_auth_mode) || "easy") as SallaIntegrationRecord["auth_mode"],
    last_authorized_at: firstText(data.salla_last_authorized_at) || null,
    last_event_at: firstText(data.salla_last_event_at) || null,
    last_event_type: firstText(data.salla_last_event_type) || null,
    last_sync_at: firstText(data.salla_last_sync_at) || null,
    last_sync_status: (firstText(data.salla_last_sync_status) || "idle") as SallaIntegrationRecord["last_sync_status"],
    last_sync_count: Number(data.salla_last_sync_count || 0),
    last_sync_error: firstText(data.salla_last_sync_error) || null,
    last_product_sync_at: firstText(data.salla_last_product_sync_at) || null,
    last_product_sync_count: Number(data.salla_last_product_sync_count || 0),
    last_product_sync_error: firstText(data.salla_last_product_sync_error) || null,
    last_remote_update_at: firstText(data.salla_last_remote_update_at) || null,
    updatedAt: firstText(data.salla_updatedAt || data.updatedAt) || undefined,
    createdAt: firstText(data.salla_createdAt || data.createdAt) || undefined,
  };
}

function stateSecret() {
  // Security (H2): never fall back to a hardcoded constant — a known state
  // secret lets an attacker forge the OAuth `state` and bind a Salla
  // connection to an arbitrary uid. Require an explicit secret.
  const secret = process.env.SALLA_STATE_SECRET || process.env.STORE_WEBHOOK_SECRET || "";
  if (!secret) {
    throw new Error(
      "SALLA_STATE_SECRET (or STORE_WEBHOOK_SECRET) must be set to sign Salla OAuth state.",
    );
  }
  return secret;
}

// Security (M5): OAuth state must expire so a captured/signed state cannot be
// replayed indefinitely.
function stateMaxAgeMs() {
  return Math.max(60_000, Number(process.env.SALLA_STATE_MAX_AGE_MS || 600_000));
}

function clientId() {
  return process.env.SALLA_CLIENT_ID || "";
}

function clientSecret() {
  return process.env.SALLA_CLIENT_SECRET || "";
}

function defaultScopes() {
  return process.env.SALLA_SCOPES || "offline_access orders.read products.read";
}

function authMode(): "easy" | "custom" {
  return process.env.SALLA_AUTH_MODE === "custom" ? "custom" : "easy";
}

function syncSchedule() {
  return process.env.SALLA_SYNC_CRON_SCHEDULE || "*/15 * * * *";
}

function syncEnabled() {
  return process.env.SALLA_SYNC_CRON_ENABLED === "true";
}

function maxSyncPages() {
  return Math.max(1, Math.min(200, Number(process.env.SALLA_SYNC_MAX_PAGES || 3)));
}

function pageSize() {
  return Math.max(10, Math.min(100, Number(process.env.SALLA_SYNC_PAGE_SIZE || 50)));
}

function configured() {
  return Boolean(clientId() && clientSecret());
}

function sallaAppWebhookSecret() {
  return process.env.SALLA_APP_WEBHOOK_SECRET || process.env.STORE_WEBHOOK_SECRET || "";
}

function sallaAppOwnerUid() {
  return process.env.SALLA_APP_OWNER_UID || process.env.STORE_WEBHOOK_OWNER_UID || process.env.LOCAL_AUTH_SHARED_UID || "";
}

function base64url(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function fromBase64url(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function hmac(value: string) {
  return crypto.createHmac("sha256", stateSecret()).update(value).digest("hex");
}

function signState(payload: Record<string, unknown>) {
  const encoded = base64url(JSON.stringify(payload));
  return `${encoded}.${hmac(encoded)}`;
}

function verifyState(state: string) {
  const [encoded, signature] = String(state || "").split(".");
  if (!encoded || !signature) throw new Error("Invalid Salla OAuth state.");
  // Security (H2): constant-time signature comparison.
  const expected = Buffer.from(hmac(encoded));
  const provided = Buffer.from(signature);
  if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
    throw new Error("Salla OAuth state signature is invalid.");
  }
  const payload = JSON.parse(fromBase64url(encoded)) as {
    uid: string;
    redirectUri: string;
    appUrl: string;
    issuedAt: string;
  };
  // Security (M5): reject expired state to prevent replay.
  const issuedAtMs = Date.parse(payload.issuedAt || "");
  if (!Number.isFinite(issuedAtMs) || Date.now() - issuedAtMs > stateMaxAgeMs()) {
    throw new Error("Salla OAuth state has expired. Please restart the connection.");
  }
  return payload;
}

function firstText(...values: unknown[]) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value).trim();
  }
  return "";
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const normalized = value.replace(/[^\d.-]/g, "");
    const n = Number(normalized);
    return Number.isFinite(n) ? n : undefined;
  }

  const record = asRecord(value);
  if (Object.keys(record).length) {
    return numericValue(record.amount ?? record.value ?? record.total ?? record.price);
  }

  return undefined;
}

function optionalNumberValue(...values: unknown[]) {
  for (const value of values) {
    const n = numericValue(value);
    if (n !== undefined) return n;
  }
  return undefined;
}

function asArray(value: unknown): Record<string, any>[] {
  if (!Array.isArray(value)) return [];
  return value.map(asRecord);
}

function truncate(value: string, max: number) {
  return value.length > max ? value.slice(0, max) : value;
}

function safeEquals(left: string, right: string) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function bodyHmac(rawBody: Buffer, secret: string) {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

function cleanSignature(value?: string) {
  return String(value || "").trim().replace(/^sha256=/i, "");
}

// Salla splits the buyer number into `mobile` (551496683) and `mobile_code`
// ("+966"); join them so the country code is never dropped.
function joinCountryCode(code: unknown, number: unknown) {
  const num = String(number ?? "").trim();
  if (!num || num.startsWith("+")) return num;
  const dialCode = String(code ?? "").trim();
  return dialCode ? `${dialCode}${num}` : num;
}

function dateOnly(value: unknown, fallback = new Date()) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = value ? new Date(String(value)) : fallback;
  const safeDate = Number.isNaN(parsed.getTime()) ? fallback : parsed;
  return safeDate.toISOString().slice(0, 10);
}

function classifyItemType(sku: string, tags: string[], explicitType = ""): StoreItemType {
  const upperSku = sku.toUpperCase();
  const haystack = [sku, explicitType, ...tags].join(" ").toLowerCase();

  if (upperSku.startsWith("SALE-") || haystack.includes("sale_only")) return "sale_only";
  if (upperSku.startsWith("INSTALL-") || haystack.includes("install_maintenance") || haystack.includes("installation")) {
    return "install_maintenance";
  }
  if (upperSku.startsWith("EXT-") || haystack.includes("external_maintenance")) return "external_maintenance";
  if (upperSku.startsWith("MAINT-") || haystack.includes("maintenance_existing") || haystack.includes("maintenance")) {
    return "maintenance_existing";
  }
  return "needs_review";
}

function collectTags(item: Record<string, any>) {
  return [
    ...asArray(item.tags).map((tag) => firstText(tag.name, tag.title, tag.slug, tag.value)),
    ...asArray(asRecord(item.product).tags).map((tag) => firstText(tag.name, tag.title, tag.slug, tag.value)),
  ].filter(Boolean);
}

function readRedirectUri(req: Request) {
  if (process.env.SALLA_REDIRECT_URI) return process.env.SALLA_REDIRECT_URI;
  return `${req.protocol}://${req.get("host")}${SALLA_CALLBACK_PATH}`;
}

function readAppUrl(req: Request) {
  if (process.env.APP_URL) return process.env.APP_URL;
  return `${req.protocol}://${req.get("host")}`;
}

function readWebhookUrl(req: Request) {
  return `${readAppUrl(req)}${SALLA_APP_WEBHOOK_PATH}`;
}

function expiresAt(expiresIn?: number) {
  if (!expiresIn || !Number.isFinite(expiresIn)) return null;
  return new Date(Date.now() + expiresIn * 1000).toISOString();
}

function expiresAtFromUnixOrSeconds(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  if (parsed > 2_000_000_000) return new Date(parsed).toISOString();
  if (parsed > 1_000_000_000) return new Date(parsed * 1000).toISOString();
  return new Date(Date.now() + parsed * 1000).toISOString();
}

async function readIntegration(uid: string): Promise<SallaIntegrationRecord | null> {
  if (usingSupabaseAdapter()) {
    const store = await readLocalIntegrationStore();
    return store[uid] || null;
  }
  const snap = await adminDb.collection("settings").doc(uid).get();
  return snap.exists ? fromSettingsShape(snap.data()) : null;
}

async function writeIntegration(uid: string, data: Partial<SallaIntegrationRecord>) {
  const now = nowIso();
  if (usingSupabaseAdapter()) {
    const store = await readLocalIntegrationStore();
    const previous = store[uid] || {
      provider: "salla" as const,
      createdBy: uid,
      status: configured() ? "ready_to_connect" : "not_configured",
      createdAt: now,
    };
    store[uid] = {
      ...previous,
      ...data,
      provider: "salla",
      createdBy: uid,
      updatedAt: now,
      createdAt: previous.createdAt || data.createdAt || now,
    };
    await writeLocalIntegrationStore(store);
    return;
  }
  await adminDb.collection("settings").doc(uid).set({
    createdBy: uid,
    updatedAt: now,
    createdAt: data.createdAt || now,
    ...toSettingsShape({
      provider: "salla",
      updatedAt: now,
      createdAt: data.createdAt || now,
      ...data,
    }),
  }, { merge: true });
}

function verifySallaAppWebhook(req: Request & { rawBody?: Buffer }) {
  const secret = sallaAppWebhookSecret();
  if (!secret) {
    const err = new Error("SALLA_APP_WEBHOOK_SECRET is missing.") as Error & { status?: number };
    err.status = 503;
    throw err;
  }

  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  const signature = cleanSignature(req.get("x-salla-signature") || req.get("x-golden-signature"));
  const expected = bodyHmac(rawBody, secret);
  if (signature && safeEquals(signature, expected)) {
    return { mode: "signature" as const, rawBody };
  }

  const authorization = String(req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const sharedSecret = String(req.get("x-golden-webhook-secret") || authorization || "");
  if (sharedSecret && safeEquals(sharedSecret, secret)) {
    return { mode: "token" as const, rawBody };
  }

  const err = new Error("Invalid or missing Salla app webhook signature.") as Error & { status?: number };
  err.status = 401;
  throw err;
}

async function exchangeToken(params: URLSearchParams) {
  const response = await fetch(SALLA_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: params.toString(),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error_description || body?.message || `Salla token exchange failed (${response.status}).`);
  }
  return body as SallaTokenResponse;
}

async function fetchUserInfo(token: string) {
  const response = await fetch(SALLA_USERINFO_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.message || `Salla user info failed (${response.status}).`);
  }
  return body;
}

async function ensureFreshAccessToken(uid: string, integration: SallaIntegrationRecord) {
  const expiry = integration.expires_at ? Date.parse(integration.expires_at) : NaN;
  const stillValid = Number.isFinite(expiry) ? expiry - Date.now() > 120_000 : Boolean(integration.access_token);
  if (stillValid && integration.access_token) return integration.access_token;
  if (!integration.refresh_token) throw new Error("Salla refresh token is missing.");

  const token = await exchangeToken(new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: integration.refresh_token,
    client_id: clientId(),
    client_secret: clientSecret(),
  }));

  await writeIntegration(uid, {
    status: "connected",
    access_token: token.access_token,
    refresh_token: token.refresh_token || integration.refresh_token,
    expires_at: expiresAt(token.expires_in),
    scope: token.scope || integration.scope,
    token_type: token.token_type || integration.token_type || "Bearer",
    last_sync_error: null,
  });

  return token.access_token;
}

async function fetchOrdersPage(token: string, page: number) {
  const url = new URL(`${SALLA_API_BASE}/orders`);
  url.searchParams.set("page", String(page));
  url.searchParams.set("per_page", String(pageSize()));

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.message || `Salla orders sync failed (${response.status}).`);
  }
  return body;
}

async function fetchProductsPage(token: string, page: number) {
  const url = new URL(`${SALLA_API_BASE}/products`);
  url.searchParams.set("page", String(page));
  url.searchParams.set("per_page", String(pageSize()));

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.message || `Salla products sync failed (${response.status}).`);
  }
  return body;
}

function productDocId(uid: string, remoteProductId: string) {
  const hash = crypto.createHash("sha1").update(`${uid}:salla:${remoteProductId}`).digest("hex").slice(0, 24);
  return `prod_salla_${hash}`;
}

function firstImageUrl(product: Record<string, any>) {
  const image = asRecord(product.image);
  const thumbnail = asRecord(product.thumbnail);
  const mainImage = asRecord(product.main_image);
  const images = asArray(product.images);
  return firstText(
    product.image_url,
    product.thumbnail_url,
    image.url,
    image.src,
    thumbnail.url,
    thumbnail.src,
    mainImage.url,
    mainImage.src,
    images[0]?.url,
    images[0]?.src,
  );
}

function mapSallaProduct(remoteProduct: Record<string, any>, syncedAt: string) {
  const productId = firstText(remoteProduct.id, remoteProduct.product_id, remoteProduct.uuid);
  if (!productId) return null;

  const price = asRecord(remoteProduct.price);
  const salePrice = asRecord(remoteProduct.sale_price);
  const regularPrice = asRecord(remoteProduct.regular_price);
  const category = asRecord(remoteProduct.category);
  const categories = asArray(remoteProduct.categories);
  const sku = truncate(firstText(remoteProduct.sku, remoteProduct.code, remoteProduct.product_code) || `SALLA-${productId}`, 80);
  const tags = [
    ...asArray(remoteProduct.tags).map((tag) => firstText(tag.name, tag.title, tag.slug, tag.value)),
    ...categories.map((item) => firstText(item.name, item.title, item.slug)),
  ].filter(Boolean);
  const maintenanceMonths = Number(
    remoteProduct.maintenance_months ||
    remoteProduct.interval_months ||
    asRecord(remoteProduct.metadata).maintenance_months ||
    process.env.STORE_WEBHOOK_DEFAULT_MAINTENANCE_MONTHS ||
    3,
  );

  return {
    remoteId: productId,
    data: {
      name: truncate(firstText(remoteProduct.name, remoteProduct.title) || `Salla product ${productId}`, 120),
      interval_months: Math.max(1, Number.isFinite(maintenanceMonths) ? maintenanceMonths : 3),
      category: truncate(firstText(category.name, categories[0]?.name, categories[0]?.title, remoteProduct.category_name), 80),
      sku,
      remind_text: firstText(remoteProduct.remind_text) || "",
      source: "salla",
      store_provider: "salla",
      store_product_id: productId,
      price: optionalNumberValue(remoteProduct.price, price.amount, regularPrice.amount) ?? null,
      sale_price: optionalNumberValue(remoteProduct.sale_price, salePrice.amount, remoteProduct.discounted_price) ?? null,
      currency: truncate(firstText(remoteProduct.currency, price.currency, salePrice.currency, regularPrice.currency, "SAR"), 12),
      image_url: truncate(firstImageUrl(remoteProduct), 500),
      stock_quantity: optionalNumberValue(remoteProduct.quantity, remoteProduct.stock_quantity, remoteProduct.available_quantity, remoteProduct.stock) ?? null,
      store_status: truncate(firstText(asRecord(remoteProduct.status).name, asRecord(remoteProduct.status).slug, remoteProduct.status, remoteProduct.is_available === false ? "unavailable" : "available"), 40),
      product_type: classifyItemType(sku, tags, firstText(remoteProduct.crm_type, remoteProduct.order_type)),
      last_synced_at: syncedAt,
    },
  };
}

function mapSallaOrder(remoteOrder: Record<string, any>): StoreWebhookOrder | null {
  const customer = asRecord(remoteOrder.customer);
  const shipping = asRecord(remoteOrder.shipping);
  const billing = asRecord(remoteOrder.billing);
  const items = asArray(
    remoteOrder.items ||
    remoteOrder.products ||
    remoteOrder.order_items ||
    asRecord(remoteOrder.details).items,
  ).map((item, index) => {
    const product = asRecord(item.product);
    const itemPrice = asRecord(item.price);
    const itemAmounts = asRecord(item.amounts);
    const itemTotal = asRecord(item.total);
    const productPrice = asRecord(product.price);
    const sku = firstText(item.sku, product.sku, item.product_sku) || `SALLA-${remoteOrder.id}-${index + 1}`;
    const tags = collectTags(item);
    const explicitType = firstText(item.crm_type, item.order_type, product.crm_type);
    const maintenanceMonths = Number(item.maintenance_months || product.maintenance_months || product.interval_months || process.env.STORE_WEBHOOK_DEFAULT_MAINTENANCE_MONTHS || 3);
    const quantity = Math.max(1, Number(item.quantity || item.qty || 1));
    const unitPrice = optionalNumberValue(
      item.unit_price,
      item.price,
      item.sale_price,
      item.amount,
      itemPrice.amount,
      itemAmounts.price,
      product.price,
      productPrice.amount,
    );
    const totalPrice = optionalNumberValue(
      item.total,
      item.total_price,
      itemAmounts.total,
      itemTotal.amount,
      unitPrice !== undefined ? unitPrice * quantity : undefined,
    );

    return {
      name: truncate(firstText(item.name, product.name, item.title) || "Salla item", 80),
      sku: truncate(sku, 80),
      quantity,
      unitPrice: unitPrice ?? null,
      totalPrice: totalPrice ?? null,
      currency: truncate(firstText(item.currency, itemPrice.currency, itemAmounts.currency, product.currency, productPrice.currency, "SAR"), 12),
      maintenanceMonths: Math.max(1, Number.isFinite(maintenanceMonths) ? maintenanceMonths : 3),
      orderType: classifyItemType(sku, tags, explicitType),
      tags,
    };
  });

  const phone = normalizePhoneDigits(
    firstText(
      joinCountryCode(customer.mobile_code, customer.mobile),
      customer.mobile,
      customer.phone,
      remoteOrder.mobile,
      remoteOrder.phone,
      joinCountryCode(shipping.mobile_code, shipping.mobile),
      shipping.mobile,
      shipping.phone,
      joinCountryCode(billing.mobile_code, billing.mobile),
      billing.mobile,
      billing.phone,
    ),
  );
  if (!phone) return null;

  const statusRecord = asRecord(remoteOrder.status);
  const orderId = firstText(remoteOrder.id, remoteOrder.order_id, remoteOrder.reference_id);
  if (!orderId) return null;
  const amounts = asRecord(remoteOrder.amounts);

  return {
    provider: "salla",
    eventType: "salla.api.sync",
    eventId: `salla:sync:${orderId}:${firstText(remoteOrder.updated_at, remoteOrder.created_at, nowIso())}`,
    orderId: truncate(orderId, 80),
    orderNumber: truncate(firstText(remoteOrder.reference_id, remoteOrder.number, orderId), 80),
    status: truncate(firstText(statusRecord.name, statusRecord.slug, remoteOrder.status, "new"), 40),
    customerName: truncate(
      firstText(customer.name, customer.full_name, shipping.name, billing.name) || "Salla customer",
      80,
    ),
    customerPhone: phone,
    customerCity: truncate(firstText(customer.city, shipping.city, billing.city), 80),
    orderDate: dateOnly(firstText(remoteOrder.created_at, remoteOrder.date)),
    scheduledDate: firstText(
      remoteOrder.installation_date,
      remoteOrder.appointment_date,
      shipping.delivery_date,
      asRecord(remoteOrder.metadata).installation_date,
    ) ? dateOnly(firstText(
      remoteOrder.installation_date,
      remoteOrder.appointment_date,
      shipping.delivery_date,
      asRecord(remoteOrder.metadata).installation_date,
    )) : undefined,
    scheduledTime: truncate(firstText(
      remoteOrder.installation_time,
      remoteOrder.appointment_time,
      shipping.delivery_time,
      asRecord(remoteOrder.metadata).installation_time,
      "10:00",
    ), 20),
    total: optionalNumberValue(
      remoteOrder.total,
      remoteOrder.amount,
      remoteOrder.total_amount,
      amounts.total,
      asRecord(amounts.total).amount,
    ),
    items: items.length ? items : [{
      name: "Salla order",
      sku: `SALLA-${orderId}`,
      quantity: 1,
      unitPrice: null,
      totalPrice: null,
      currency: "SAR",
      maintenanceMonths: 3,
      orderType: "needs_review",
      tags: [],
    }],
  };
}

function syncSummaryStatus(failed: number) {
  return failed > 0 ? "error" : "success";
}

function sameRemoteStamp(existing: unknown, incoming: string | null) {
  if (!incoming) return false;
  const left = String(existing || "");
  const right = String(incoming || "");
  return left === right || left.startsWith(right) || left.slice(0, 19) === right.slice(0, 19);
}

function normalizedOrderHasMoney(order: StoreWebhookOrder) {
  return (
    typeof order.total === "number" ||
    order.items.some((item) => typeof item.totalPrice === "number" || typeof item.unitPrice === "number")
  );
}

function existingOrderNeedsMoneyRefresh(order: Record<string, unknown>) {
  if (order.total === null || order.total === undefined) return true;
  const items = Array.isArray(order.items) ? order.items : [];
  return items.some((item) => {
    const record = asRecord(item);
    return record.total_price === null || record.total_price === undefined || record.unit_price === null || record.unit_price === undefined;
  });
}

export async function getSallaStatus(currentUid: string, req: Request) {
  const integration = await readIntegration(currentUid);
  const linked = Boolean(integration?.access_token || integration?.refresh_token);
  return {
    provider: "salla",
    storage_mode: usingSupabaseAdapter() ? "local_file" : "settings_collection",
    auth_mode: authMode(),
    configured: configured(),
    linked,
    status: integration?.status || (configured() ? "ready_to_connect" : "not_configured"),
    redirect_uri: readRedirectUri(req),
    webhook_url: readWebhookUrl(req),
    connect_supported: authMode() === "custom",
    webhook_secret_configured: Boolean(sallaAppWebhookSecret()),
    owner_uid_configured: Boolean(sallaAppOwnerUid()),
    scopes: defaultScopes(),
    sync_schedule: syncSchedule(),
    sync_enabled: syncEnabled(),
    store_name: integration?.store_name || null,
    store_url: integration?.store_url || null,
    merchant_id: integration?.merchant_id || null,
    expires_at: integration?.expires_at || null,
    has_refresh_token: Boolean(integration?.refresh_token),
    last_authorized_at: integration?.last_authorized_at || null,
    last_event_at: integration?.last_event_at || null,
    last_event_type: integration?.last_event_type || null,
    last_sync_at: integration?.last_sync_at || null,
    last_sync_status: integration?.last_sync_status || "idle",
    last_sync_count: integration?.last_sync_count || 0,
    last_sync_error: integration?.last_sync_error || null,
    last_product_sync_at: integration?.last_product_sync_at || null,
    last_product_sync_count: integration?.last_product_sync_count || 0,
    last_product_sync_error: integration?.last_product_sync_error || null,
  };
}

export async function getSallaConnectUrl(currentUid: string, req: Request) {
  if (authMode() === "easy") {
    throw new Error("This Salla app uses Easy Mode. Add the app webhook URL in Salla Partners and approve the app installation instead of using a callback connect button.");
  }
  if (!configured()) {
    throw new Error("SALLA_CLIENT_ID and SALLA_CLIENT_SECRET are required before connecting Salla.");
  }

  const redirectUri = readRedirectUri(req);
  const appUrl = readAppUrl(req);
  const state = signState({
    uid: currentUid,
    redirectUri,
    appUrl,
    issuedAt: nowIso(),
  });

  const url = new URL(SALLA_AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId());
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", defaultScopes());
  url.searchParams.set("state", state);

  return {
    url: url.toString(),
    redirect_uri: redirectUri,
    scopes: defaultScopes(),
  };
}

function htmlEscape(value: string) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function htmlRedirect(target: string, message: string) {
  // Security (M2): HTML-encode every interpolated value to prevent reflected
  // content injection / XSS in the OAuth callback page. The previous inline
  // <script> redirect is dropped — it would be blocked by the hardened CSP
  // (no 'unsafe-inline' scripts), and meta refresh + link redirect safely.
  const safeTarget = htmlEscape(target);
  const safeMessage = htmlEscape(message);
  return `<!doctype html><html lang="ar"><head><meta charset="utf-8"><title>Breexe Pro CRM</title><meta http-equiv="refresh" content="0;url=${safeTarget}"></head><body style="font-family:Arial,sans-serif;padding:24px;direction:rtl"><p>${safeMessage}</p><p><a href="${safeTarget}">العودة إلى النظام</a></p></body></html>`;
}

export async function handleSallaCallback(req: Request) {
  if (authMode() === "easy") {
    const target = `${readAppUrl(req)}/?salla=waiting_webhook`;
    return {
      status: 409,
      html: htmlRedirect(
        target,
        "هذا التطبيق يعمل عبر Salla Easy Mode. أكمل تثبيت التطبيق من سلة وانتظر حدث app.store.authorize عبر Webhook التطبيق.",
      ),
    };
  }

  const error = firstText(req.query.error, req.query.error_description);
  const stateValue = firstText(req.query.state);
  const code = firstText(req.query.code);
  const fallbackTarget = `${readAppUrl(req)}/?salla=error`;

  try {
    if (error) {
      return {
        status: 400,
        html: htmlRedirect(`${fallbackTarget}&reason=oauth_denied`, `تعذر ربط سلة: ${error}`),
      };
    }
    if (!code || !stateValue) {
      return {
        status: 400,
        html: htmlRedirect(`${fallbackTarget}&reason=missing_code`, "تعذر ربط سلة: بيانات التفويض ناقصة."),
      };
    }
    if (!configured()) {
      return {
        status: 503,
        html: htmlRedirect(`${fallbackTarget}&reason=missing_config`, "تعذر ربط سلة: مفاتيح التطبيق غير مضبوطة."),
      };
    }

    const state = verifyState(stateValue);
    const token = await exchangeToken(new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId(),
      client_secret: clientSecret(),
      redirect_uri: state.redirectUri,
    }));
    const profile = await fetchUserInfo(token.access_token);
    const merchant = asRecord(profile.merchant);

    await writeIntegration(state.uid, {
      status: "connected",
      access_token: token.access_token,
      refresh_token: token.refresh_token || null,
      expires_at: expiresAt(token.expires_in),
      scope: token.scope || defaultScopes(),
      token_type: token.token_type || "Bearer",
      merchant_id: firstText(merchant.id, profile.merchant_id) || null,
      store_name: firstText(merchant.name, merchant.store_name, profile.name) || null,
      store_url: firstText(merchant.domain, merchant.url, merchant.permalink) || null,
      last_sync_status: "idle",
      last_sync_error: null,
    });

    return {
      status: 200,
      html: htmlRedirect(`${state.appUrl}/?salla=connected`, "تم ربط سلة بنجاح. سيتم إعادتك إلى النظام."),
    };
  } catch (callbackError) {
    const message = callbackError instanceof Error ? callbackError.message : "تعذر إكمال ربط سلة.";
    return {
      status: 500,
      html: htmlRedirect(`${fallbackTarget}&reason=callback_failed`, message),
    };
  }
}

export async function handleSallaAppWebhook(req: Request & { rawBody?: Buffer }) {
  verifySallaAppWebhook(req);

  const body = asRecord(req.body);
  const event = firstText(body.event, body.type);
  const merchantId = firstText(body.merchant, body.merchant_id);
  const occurredAt = firstText(body.created_at, body.updated_at) || nowIso();
  const uid = sallaAppOwnerUid();

  // Persistent audit trail of every accepted (signature-passed) Salla event,
  // so we can reconstruct exactly what arrived from the merchant. Logged AFTER
  // verifySallaAppWebhook so we never log unverified payloads.
  try {
    const line = JSON.stringify({
      at: nowIso(),
      event: event || "unknown",
      merchant: merchantId || null,
      has_access_token: Boolean(firstText(asRecord(body.data).access_token)),
      data_keys: Object.keys(asRecord(body.data)).slice(0, 30),
      body_keys: Object.keys(body).slice(0, 30),
    }) + "\n";
    const fsync = await import("fs");
    fsync.appendFileSync(".runtime/salla-webhook.log", line, "utf8");
  } catch {
    // Logging best-effort; never fail the webhook handler over a log write.
  }

  if (!uid) {
    throw new Error("SALLA_APP_OWNER_UID is required before receiving app authorization events.");
  }

  await writeIntegration(uid, {
    status: (await readIntegration(uid))?.status || (configured() ? "ready_to_connect" : "not_configured"),
    last_event_at: occurredAt,
    last_event_type: event || "unknown",
  });

  if (event === "app.store.authorize") {
    const data = asRecord(body.data);
    const accessToken = firstText(data.access_token);
    if (!accessToken) {
      throw new Error("Salla app authorization payload is missing access_token.");
    }

    const refreshToken = firstText(data.refresh_token) || null;
    const profile = await fetchUserInfo(accessToken).catch(() => ({}));
    const merchant = asRecord(asRecord(profile).merchant);

    await writeIntegration(uid, {
      status: "connected",
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: expiresAtFromUnixOrSeconds(data.expires),
      scope: firstText(data.scope) || defaultScopes(),
      token_type: firstText(data.token_type) || "bearer",
      merchant_id: firstText(merchant.id, profile && asRecord(profile).merchant_id, merchantId) || null,
      store_name: firstText(merchant.name, merchant.store_name, asRecord(profile).name) || null,
      store_url: firstText(merchant.domain, merchant.url, merchant.permalink) || null,
      last_authorized_at: occurredAt,
      last_sync_status: "idle",
      last_sync_error: null,
    });

    return {
      success: true,
      event,
      owner_uid: uid,
      merchant_id: firstText(merchant.id, merchantId) || null,
      store_name: firstText(merchant.name, merchant.store_name, asRecord(profile).name) || null,
      linked: true,
    };
  }

  if (event === "app.uninstalled") {
    await writeIntegration(uid, {
      status: configured() ? "ready_to_connect" : "not_configured",
      access_token: null,
      refresh_token: null,
      expires_at: null,
      last_sync_error: null,
    });
    return { success: true, event, owner_uid: uid, linked: false };
  }

  // Salla pushes order.* lifecycle events to the app webhook URL. Forward
  // them through the shared store-webhook normalizer so they land in
  // store_orders alongside the records Salla sync imports later.
  if (event === "order.created" || event === "order.updated" || event === "order.refunded" || event === "order.cancelled") {
    try {
      const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body ?? ""));
      const order = normalizeStorePayload(req, rawBody);
      const imported = await importStoreOrderForUser(uid, order);
      return {
        success: true,
        event,
        owner_uid: uid,
        order_id: order.orderId,
        order_number: order.orderNumber,
        imported,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await writeIntegration(uid, { last_sync_error: message });
      return { success: false, event, owner_uid: uid, error: message };
    }
  }

  // Product lifecycle events: log only for now — the CRM products table is
  // owner-curated; we don't auto-overwrite it from Salla.
  if (event === "product.created" || event === "product.updated" || event === "product.deleted") {
    const data = asRecord(body.data);
    const productId = firstText(data.id, data.uuid) || null;
    const sync = await syncSallaProductsForUser(uid).catch((error) => ({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }));
    return {
      success: Boolean((sync as { success?: boolean }).success),
      event,
      owner_uid: uid,
      product_id: productId,
      product_name: firstText(data.name) || null,
      sync,
    };
  }

  return {
    success: true,
    event: event || "unknown",
    owner_uid: uid,
    ignored: true,
  };
}

export async function syncSallaOrdersForUser(currentUid: string): Promise<SyncResult> {
  if (!configured()) throw new Error("Salla integration is not configured on the server.");

  const integration = await readIntegration(currentUid);
  if (!integration) throw new Error("Salla is not linked for this CRM user.");
  if (integration.status !== "connected" || (!integration.access_token && !integration.refresh_token)) {
    throw new Error("Salla is not connected. Reinstall the Salla app or start the Salla connection again, then run sync.");
  }

  const token = await ensureFreshAccessToken(currentUid, integration);
  const importedAt = nowIso();
  const existingOrdersSnap = await adminDb
    .collection("store_orders")
    .where("createdBy", "==", currentUid)
    .limit(500)
    .get();
  const existingOrders = new Map<string, Record<string, any>>(
    existingOrdersSnap.docs.map((doc: any) => [String(doc.id), doc.data() || {}] as [string, Record<string, any>]),
  );
  const seen = new Set<string>();
  let imported = 0;
  let updated = 0;
  let failed = 0;
  let fetched = 0;
  let pages = 0;
  let lastRemoteUpdate = integration.last_remote_update_at || null;
  let firstFailureMessage: string | null = null;

  try {
    for (let page = 1; page <= maxSyncPages(); page += 1) {
      const payload = await fetchOrdersPage(token, page);
      const orders = asArray(payload.data || payload.orders || payload.items);
      if (!orders.length) break;
      pages += 1;
      fetched += orders.length;

      for (const remoteOrder of orders) {
        const normalized = mapSallaOrder(remoteOrder);
        if (!normalized) {
          failed += 1;
          continue;
        }

        const dedupeKey = `${normalized.provider}:${normalized.orderId}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        const orderDocId = getStoreOrderDocId(currentUid, normalized.provider, normalized.orderId);
        const existing = existingOrders.get(orderDocId);
        const remoteUpdatedAt =
          firstText(remoteOrder.updated_at, remoteOrder.created_at, remoteOrder.date, normalized.orderDate) || null;

        const shouldRefreshMoney =
          existing &&
          normalizedOrderHasMoney(normalized) &&
          existingOrderNeedsMoneyRefresh(existing as Record<string, unknown>);

        if (existing && sameRemoteStamp((existing as Record<string, unknown>).last_event_at, remoteUpdatedAt) && !shouldRefreshMoney) {
          updated += 1;
          lastRemoteUpdate = remoteUpdatedAt || lastRemoteUpdate;
          continue;
        }

        try {
          await importStoreOrderForUser(currentUid, normalized, {
            source: "salla",
            provider: "salla",
            order_date: normalized.orderDate,
            last_event_at: remoteUpdatedAt,
          });
          if (existing) updated += 1;
          else imported += 1;
          lastRemoteUpdate = remoteUpdatedAt || lastRemoteUpdate;
        } catch (orderImportError) {
          failed += 1;
          if (!firstFailureMessage) {
            firstFailureMessage =
              orderImportError instanceof Error
                ? orderImportError.message
                : "Unknown Salla order import failure.";
          }
        }
      }

      const pagination = asRecord(payload.pagination);
      const totalPages = Number(pagination.total_pages || pagination.last_page || 0);
      if (totalPages && page >= totalPages) break;
      if (orders.length < pageSize()) break;
    }

    await writeIntegration(currentUid, {
      status: "connected",
      last_sync_at: importedAt,
      last_sync_status: syncSummaryStatus(failed),
      last_sync_count: imported + updated,
      last_sync_error: failed
        ? `${failed} orders could not be imported.${firstFailureMessage ? ` First error: ${firstFailureMessage}` : ""}`
        : null,
      last_remote_update_at: lastRemoteUpdate,
    });

    return {
      success: failed === 0,
      imported,
      updated,
      failed,
      pages,
      fetched,
      last_sync_at: importedAt,
      last_error: failed
        ? `${failed} orders could not be imported.${firstFailureMessage ? ` First error: ${firstFailureMessage}` : ""}`
        : null,
    };
  } catch (syncError) {
    const message = syncError instanceof Error ? syncError.message : "Salla sync failed.";
    await writeIntegration(currentUid, {
      status: "error",
      last_sync_at: importedAt,
      last_sync_status: "error",
      last_sync_count: imported + updated,
      last_sync_error: message,
    });
    throw syncError;
  }
}

export async function syncSallaProductsForUser(currentUid: string): Promise<SyncResult> {
  if (!configured()) throw new Error("Salla integration is not configured on the server.");

  const integration = await readIntegration(currentUid);
  if (!integration) throw new Error("Salla is not linked for this CRM user.");
  if (integration.status !== "connected" || (!integration.access_token && !integration.refresh_token)) {
    throw new Error("Salla is not connected. Reinstall the Salla app or start the Salla connection again, then run sync.");
  }

  const token = await ensureFreshAccessToken(currentUid, integration);
  const syncedAt = nowIso();
  const existingProductsSnap = await adminDb
    .collection("products")
    .where("createdBy", "==", currentUid)
    .limit(1000)
    .get();
  const existingByRemoteId = new Map<string, { id: string; data: Record<string, any> }>();
  const existingBySku = new Map<string, { id: string; data: Record<string, any> }>();
  for (const doc of existingProductsSnap.docs as Array<{ id: string; data: () => Record<string, any> }>) {
    const data = doc.data() || {};
    const remoteId = firstText(data.store_product_id);
    const sku = firstText(data.sku).toLowerCase();
    if (remoteId) existingByRemoteId.set(remoteId, { id: doc.id, data });
    if (sku && !existingBySku.has(sku)) existingBySku.set(sku, { id: doc.id, data });
  }

  let imported = 0;
  let updated = 0;
  let failed = 0;
  let fetched = 0;
  let pages = 0;
  let firstFailureMessage: string | null = null;

  try {
    for (let page = 1; page <= maxSyncPages(); page += 1) {
      const payload = await fetchProductsPage(token, page);
      const products = asArray(payload.data || payload.products || payload.items);
      if (!products.length) break;
      pages += 1;
      fetched += products.length;

      for (const remoteProduct of products) {
        const mapped = mapSallaProduct(remoteProduct, syncedAt);
        if (!mapped) {
          failed += 1;
          continue;
        }

        try {
          const skuKey = firstText(mapped.data.sku).toLowerCase();
          const existing = existingByRemoteId.get(mapped.remoteId) || existingBySku.get(skuKey);
          const docId = existing?.id || productDocId(currentUid, mapped.remoteId);
          await adminDb.collection("products").doc(docId).set({
            ...mapped.data,
            createdBy: currentUid,
            createdAt: existing?.data?.createdAt || existing?.data?.created_at || syncedAt,
            updatedAt: syncedAt,
          }, { merge: true });

          const nextEntry = { id: docId, data: { ...(existing?.data || {}), ...mapped.data } };
          existingByRemoteId.set(mapped.remoteId, nextEntry);
          if (skuKey) existingBySku.set(skuKey, nextEntry);
          if (existing) updated += 1;
          else imported += 1;
        } catch (productImportError) {
          failed += 1;
          if (!firstFailureMessage) {
            firstFailureMessage =
              productImportError instanceof Error
                ? productImportError.message
                : "Unknown Salla product import failure.";
          }
        }
      }

      const pagination = asRecord(payload.pagination);
      const totalPages = Number(pagination.total_pages || pagination.last_page || 0);
      if (totalPages && page >= totalPages) break;
      if (products.length < pageSize()) break;
    }

    const errorMessage = failed
      ? `${failed} products could not be imported.${firstFailureMessage ? ` First error: ${firstFailureMessage}` : ""}`
      : null;
    await writeIntegration(currentUid, {
      status: "connected",
      last_product_sync_at: syncedAt,
      last_product_sync_count: imported + updated,
      last_product_sync_error: errorMessage,
    });

    return {
      success: failed === 0,
      imported,
      updated,
      failed,
      pages,
      fetched,
      last_sync_at: syncedAt,
      last_error: errorMessage,
    };
  } catch (syncError) {
    const message = syncError instanceof Error ? syncError.message : "Salla products sync failed.";
    await writeIntegration(currentUid, {
      status: "error",
      last_product_sync_at: syncedAt,
      last_product_sync_count: imported + updated,
      last_product_sync_error: message,
    });
    throw syncError;
  }
}

async function fetchCustomersPage(token: string, page: number) {
  const url = new URL(`${SALLA_API_BASE}/customers`);
  url.searchParams.set("page", String(page));
  url.searchParams.set("per_page", String(pageSize()));

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.message || `Salla customers sync failed (${response.status}).`);
  }
  return body;
}

export async function syncSallaCustomersForUser(currentUid: string): Promise<SyncResult> {
  if (!configured()) throw new Error("Salla integration is not configured on the server.");

  const integration = await readIntegration(currentUid);
  if (!integration) throw new Error("Salla is not linked for this CRM user.");
  if (integration.status !== "connected" || (!integration.access_token && !integration.refresh_token)) {
    throw new Error("Salla is not connected.");
  }

  const token = await ensureFreshAccessToken(currentUid, integration);
  const syncedAt = nowIso();

  let imported = 0;
  let updated = 0;
  let failed = 0;
  let fetched = 0;
  let pages = 0;
  let firstFailureMessage: string | null = null;

  try {
    for (let page = 1; page <= maxSyncPages(); page += 1) {
      const payload = await fetchCustomersPage(token, page);
      const customers = asArray(payload.data || payload.customers || payload.items);
      if (!customers.length) break;
      pages += 1;
      fetched += customers.length;

      for (const remoteCustomer of customers) {
        const phone = firstText(
          remoteCustomer.mobile, remoteCustomer.phone,
          asRecord(remoteCustomer.mobile)?.number,
        )?.replace(/[^\d]/g, "");
        if (!phone) { failed += 1; continue; }

        const name = firstText(remoteCustomer.name, remoteCustomer.full_name, remoteCustomer.first_name)
          || "Salla customer";
        const city = firstText(remoteCustomer.city);

        try {
          const customerDocId = `cust_${crypto.createHash("sha1").update(`${currentUid}:salla:${phone}`).digest("hex").slice(0, 20)}`;

          await adminDb.collection("customers").doc(customerDocId).set({
            createdBy: currentUid,
            name,
            phone,
            city: city || null,
            source: "salla",
            store_provider: "salla",
            store_customer_id: String(remoteCustomer.id || ""),
            createdAt: syncedAt,
            updatedAt: syncedAt,
          }, { merge: true });

          imported += 1;
        } catch {
          failed += 1;
        }
      }

      const pagination = asRecord(payload.pagination);
      const totalPages = Number(pagination.total_pages || pagination.last_page || 0);
      if (totalPages && page >= totalPages) break;
      if (customers.length < pageSize()) break;
    }

    await writeIntegration(currentUid, {
      last_customer_sync_at: syncedAt,
      last_customer_sync_status: "success",
      last_customer_sync_count: imported + updated,
      last_customer_sync_error: null,
    });

    return {
      success: true,
      imported,
      updated,
      failed,
      fetched,
      pages,
      last_sync_at: syncedAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeIntegration(currentUid, {
      last_customer_sync_at: syncedAt,
      last_customer_sync_status: "failed",
      last_customer_sync_count: imported + updated,
      last_customer_sync_error: message,
    });
    const syncError = new Error(`Salla customer sync failed: ${message}`);
    (syncError as any).detail = {
      success: false,
      imported,
      updated,
      failed,
      fetched,
      pages,
      last_sync_at: syncedAt,
      last_error: message,
    };
    throw syncError;
  }
}

export async function syncSallaStoreForUser(currentUid: string): Promise<SyncResult & { orders: SyncResult; products: SyncResult; customers: SyncResult }> {
  const failedResult = (message: string): SyncResult => ({
    success: false,
    imported: 0,
    updated: 0,
    failed: 1,
    pages: 0,
    fetched: 0,
    last_sync_at: nowIso(),
    last_error: message,
  });
  const customers = await syncSallaCustomersForUser(currentUid).catch((error) =>
    failedResult(error instanceof Error ? error.message : String(error)),
  );
  const products = await syncSallaProductsForUser(currentUid).catch((error) =>
    failedResult(error instanceof Error ? error.message : String(error)),
  );
  const orders = await syncSallaOrdersForUser(currentUid).catch((error) =>
    failedResult(error instanceof Error ? error.message : String(error)),
  );
  if (!products.success && !orders.success && !customers.success) {
    throw new Error(orders.last_error || products.last_error || customers.last_error || "Salla sync failed.");
  }
  return {
    ...orders,
    success: products.success && orders.success && customers.success,
    imported: orders.imported,
    updated: orders.updated,
    failed: orders.failed,
    fetched: orders.fetched,
    pages: orders.pages,
    last_sync_at: orders.last_sync_at,
    last_error: orders.last_error || products.last_error || customers.last_error || null,
    orders,
    products,
    customers,
  };
}

export async function syncAllLinkedSallaIntegrations() {
  if (!configured()) return { checked: 0, synced: 0, failed: 0 };
  if (usingSupabaseAdapter()) {
    const store = await readLocalIntegrationStore();
    const docs = Object.values(store).filter((item) => item?.status === "connected" && item?.createdBy);
    let synced = 0;
    let failed = 0;
    for (const item of docs) {
      try {
        await syncSallaStoreForUser(String(item.createdBy));
        synced += 1;
      } catch {
        failed += 1;
      }
    }
    return { checked: docs.length, synced, failed };
  }
  const snap = await adminDb
    .collection("settings")
    .where("salla_provider", "==", "salla")
    .where("salla_status", "==", "connected")
    .limit(100)
    .get();

  let synced = 0;
  let failed = 0;
  for (const doc of snap.docs) {
    const data = fromSettingsShape(doc.data()) as SallaIntegrationRecord | null;
    if (!data?.createdBy) continue;
    try {
      await syncSallaStoreForUser(String(data.createdBy));
      synced += 1;
    } catch {
      failed += 1;
    }
  }

  return { checked: snap.docs.length, synced, failed };
}
