import { adminDb } from "./firebaseAdmin";
import { deliverOrderAnalytics } from "./orderAnalytics";
import { getStoreOrderDocId, type StoreOrderAttribution } from "./storeWebhook";

export type StorefrontOrderAttributionInput = {
  orderId: string;
  checkoutId?: string;
  total: number;
  currency: string;
  attribution: StoreOrderAttribution;
};

export class StorefrontAttributionError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "StorefrontAttributionError";
    this.status = status;
  }
}

const defaultStorefrontOrigins = ["https://goldenksa.store", "https://www.goldenksa.store"];

function clean(value: unknown, max: number) {
  return String(value ?? "").trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max);
}

function optionalCampaignValue(value: unknown) {
  const normalized = clean(value, 200);
  return normalized || undefined;
}

function optionalClickId(value: unknown) {
  const normalized = clean(value, 200);
  if (!normalized) return undefined;
  if (!/^[A-Za-z0-9._~-]{6,200}$/.test(normalized)) {
    throw new StorefrontAttributionError(422, "Invalid advertising click identifier.");
  }
  return normalized;
}

function requiredOrderTotal(value: unknown) {
  const normalized = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isFinite(normalized) || normalized <= 0 || normalized > 10_000_000) {
    throw new StorefrontAttributionError(422, "A valid order total is required.");
  }
  return Math.round(normalized * 100) / 100;
}

export function storefrontAttributionAllowedOrigins(env: NodeJS.ProcessEnv = process.env) {
  const configured = String(env.STORE_ATTRIBUTION_ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const source = configured.length ? configured : defaultStorefrontOrigins;
  return new Set(source.map((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" ? url.origin : "";
    } catch {
      return "";
    }
  }).filter(Boolean));
}

export function storefrontAttributionOriginAllowed(
  origin: unknown,
  env: NodeJS.ProcessEnv = process.env,
) {
  const candidate = clean(origin, 300);
  if (!candidate) return false;
  try {
    return storefrontAttributionAllowedOrigins(env).has(new URL(candidate).origin);
  } catch {
    return false;
  }
}

export function normalizeStorefrontOrderAttribution(body: unknown): StorefrontOrderAttributionInput {
  let value = body;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new StorefrontAttributionError(400, "Invalid attribution payload.");
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StorefrontAttributionError(400, "Invalid attribution payload.");
  }
  const record = value as Record<string, unknown>;
  const orderId = clean(record.order_id, 80);
  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(orderId)) {
    throw new StorefrontAttributionError(422, "Invalid order identifier.");
  }
  const clientId = clean(record.client_id, 80);
  if (!/^\d{1,20}\.\d{1,20}$/.test(clientId)) {
    throw new StorefrontAttributionError(422, "A valid consented GA client identifier is required.");
  }
  const sessionId = clean(record.session_id, 40);
  if (sessionId && !/^\d{1,20}$/.test(sessionId)) {
    throw new StorefrontAttributionError(422, "Invalid GA session identifier.");
  }
  const gclid = optionalClickId(record.gclid);
  const gbraid = optionalClickId(record.gbraid);
  const wbraid = optionalClickId(record.wbraid);
  const utmSource = optionalCampaignValue(record.utm_source);
  const utmMedium = optionalCampaignValue(record.utm_medium);
  const utmCampaign = optionalCampaignValue(record.utm_campaign);
  const utmContent = optionalCampaignValue(record.utm_content);
  const utmTerm = optionalCampaignValue(record.utm_term);
  const total = requiredOrderTotal(record.total);
  const currency = clean(record.currency, 12).toUpperCase();
  if (currency !== "SAR") {
    throw new StorefrontAttributionError(422, "The storefront order currency must be SAR.");
  }
  const attribution: StoreOrderAttribution = {
    clientId,
    ...(sessionId ? { sessionId } : {}),
    ...(gclid ? { gclid } : {}),
    ...(gbraid ? { gbraid } : {}),
    ...(wbraid ? { wbraid } : {}),
    ...(utmSource ? { utmSource } : {}),
    ...(utmMedium ? { utmMedium } : {}),
    ...(utmCampaign ? { utmCampaign } : {}),
    ...(utmContent ? { utmContent } : {}),
    ...(utmTerm ? { utmTerm } : {}),
  };
  return {
    orderId,
    checkoutId: clean(record.checkout_id, 100) || undefined,
    total,
    currency,
    attribution,
  };
}

export function resolveStorefrontAttributionOwnerUid(env: NodeJS.ProcessEnv = process.env) {
  return clean(env.STORE_WEBHOOK_OWNER_UID || env.SALLA_APP_OWNER_UID, 256) || null;
}

export async function attachStorefrontOrderAttribution(
  ownerUid: string,
  input: StorefrontOrderAttributionInput,
) {
  const orderDocId = getStoreOrderDocId(ownerUid, "salla", input.orderId);
  const orderRef = adminDb.collection("store_orders").doc(orderDocId);
  const snapshot = await orderRef.get();
  if (!snapshot.exists) {
    throw new StorefrontAttributionError(404, "The order is not ready for attribution yet.");
  }
  const order = snapshot.data() || {};
  if (String(order.createdBy || order.owner_uid || "") !== ownerUid) {
    throw new StorefrontAttributionError(403, "Order ownership mismatch.");
  }
  const storedTotal = Number(order.total);
  const storedCurrency = String(order.currency || "SAR").trim().toUpperCase();
  if (!Number.isFinite(storedTotal) || storedTotal <= 0) {
    throw new StorefrontAttributionError(409, "The authoritative order total is not ready yet.");
  }
  if (Math.abs(storedTotal - input.total) > 0.01 || storedCurrency !== input.currency) {
    throw new StorefrontAttributionError(409, "Storefront order value does not match the authoritative order.");
  }
  const existing = order.attribution && typeof order.attribution === "object"
    ? order.attribution as StoreOrderAttribution
    : {};
  const attribution = { ...existing, ...input.attribution };
  const now = new Date().toISOString();
  await orderRef.set({
    attribution,
    updatedAt: now,
  }, { merge: true });

  const analytics = await deliverOrderAnalytics(ownerUid, orderDocId, {
    eventType: "order.created",
    eventId: `storefront:order-completed:${input.orderId}`,
    orderId: input.orderId,
    orderNumber: String(order.order_number || input.orderId),
    status: String(order.status || "completed"),
    paymentStatus: String(order.payment_status || ""),
    paymentTypeGroup: String(order.payment_type_group || ""),
    currency: String(order.currency || "SAR"),
    attribution,
    items: [],
  });

  return {
    success: true,
    order_id: input.orderId,
    analytics_status: analytics.status,
    transaction_id: "transaction_id" in analytics ? analytics.transaction_id || null : null,
  };
}
