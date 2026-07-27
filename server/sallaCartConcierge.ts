import db from "./db";
import { communicationJobStore } from "./communicationJobs";
import { normalizePhoneDigits } from "../shared/phone";
import {
  createSallaCartConciergeStore,
  type SallaCartProductContext,
} from "./sallaCartConciergeStorage";

type UnknownRecord = Record<string, unknown>;

type LocalProduct = {
  store_product_id: string | null;
  name: string;
  price: number | null;
  sale_price: number | null;
  currency: string | null;
  description: string | null;
  product_type: string | null;
  store_url: string | null;
  is_available: number | null;
  stock_quantity: number | null;
  unlimited_quantity: number | null;
};

export const SALLA_CART_EVENTS = new Set([
  "abandoned.cart",
  "abandoned.cart.updated",
  "abandoned.cart.status.changed",
  "abandoned.cart.purchased",
]);

export const sallaCartConciergeStore = createSallaCartConciergeStore(db);

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function records(value: unknown): UnknownRecord[] {
  return Array.isArray(value)
    ? value.filter((item): item is UnknownRecord => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    : [];
}

function text(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function numberValue(...values: unknown[]): number | null {
  for (const value of values) {
    const nested = record(value);
    const candidate = Object.keys(nested).length ? nested.amount : value;
    if (candidate === "" || candidate === null || candidate === undefined) continue;
    const parsed = Number(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function cleanHttpsUrl(value: unknown) {
  const raw = text(value);
  if (!raw || raw.length > 1200) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function cartObject(payload: UnknownRecord) {
  const nested = record(payload.cart);
  return Object.keys(nested).length ? nested : payload;
}

export function sallaCartId(payload: UnknownRecord) {
  const cart = cartObject(payload);
  return text(cart.id, cart.cart_id, cart.uuid, payload.cart_id) || null;
}

function localProduct(ownerUid: string, productId: string): LocalProduct | null {
  if (!productId) return null;
  return db.prepare(
    `SELECT store_product_id, name, price, sale_price, currency, description,
            product_type, store_url, is_available, stock_quantity, unlimited_quantity
       FROM products
      WHERE owner_uid = ? AND store_product_id = ? AND merged_into IS NULL
      ORDER BY updated_at DESC LIMIT 1`,
  ).get(ownerUid, productId) as LocalProduct | undefined || null;
}

function cartItems(ownerUid: string, cart: UnknownRecord): SallaCartProductContext[] {
  return records(cart.items || cart.products).slice(0, 20).map((item, index) => {
    const product = record(item.product);
    const amounts = record(item.amounts);
    const lineTotal = record(amounts.total);
    const priceWithoutTax = record(amounts.price_without_tax);
    const productId = text(item.product_id, product.id, product.product_id) || "";
    const local = localProduct(ownerUid, productId);
    const quantity = Math.max(1, Math.floor(numberValue(item.quantity) || 1));
    const lineAmount = numberValue(lineTotal.amount);
    const remoteUnitPrice = numberValue(
      item.price,
      record(item.price).amount,
      priceWithoutTax.amount,
      lineAmount === null ? null : lineAmount / quantity,
    );
    const localPrice = numberValue(local?.sale_price, local?.price);
    const stockQuantity = numberValue(local?.stock_quantity);
    const available = local
      ? local.is_available !== 0 && (local.unlimited_quantity === 1 || stockQuantity === null || stockQuantity > 0)
      : null;
    return {
      productId: productId || null,
      name: text(item.name, item.title, product.name, product.title, local?.name) || `منتج ${index + 1}`,
      quantity,
      price: localPrice ?? remoteUnitPrice,
      currency: text(local?.currency, lineTotal.currency, priceWithoutTax.currency, "SAR"),
      description: text(local?.description, product.description).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 1200),
      productType: text(local?.product_type, product.product_type),
      storeUrl: cleanHttpsUrl(local?.store_url || product.url),
      isAvailable: available,
      stockQuantity,
    };
  });
}

function terminalStatus(event: string, payload: UnknownRecord): "purchased" | "cancelled" | null {
  if (event === "abandoned.cart.purchased") return "purchased";
  if (event !== "abandoned.cart.status.changed") return null;
  const cart = cartObject(payload);
  const status = text(record(cart.status).slug, record(cart.status).name, cart.status, payload.status)
    .toLowerCase()
    .replace(/\s+/g, "_");
  if (/(purchased|converted|completed|ordered|recovered)/.test(status)) return "purchased";
  if (/(cancelled|canceled|expired|deleted|inactive)/.test(status)) return "cancelled";
  return null;
}

function cancelPendingOutreach(ownerUid: string, cartId: string, status: "purchased" | "cancelled", eventAt: string) {
  db.prepare(
    `UPDATE communication_jobs
        SET status = 'blocked', last_error = ?, lease_until = NULL, updated_at = ?
      WHERE owner_uid = ? AND event_key = ?
        AND status IN ('pending', 'retry', 'processing')`,
  ).run(`salla_cart_${status}`, eventAt, ownerUid, `salla-cart:${cartId}:whatsapp:1`);
  return sallaCartConciergeStore.markTerminal(ownerUid, cartId, status, eventAt);
}

function productSummary(items: SallaCartProductContext[]) {
  if (!items.length) return "المنتجات الموجودة في سلتك";
  const visible = items.slice(0, 3).map((item) => item.name);
  return items.length > visible.length
    ? `${visible.join("، ")} و${items.length - visible.length} أخرى`
    : visible.join("، ");
}

function delayMinutes() {
  return Math.max(0, Math.min(24 * 60, Number(process.env.SALLA_CART_WHATSAPP_DELAY_MINUTES || 30)));
}

function expiryMinutes() {
  return Math.max(60, Math.min(7 * 24 * 60, Number(process.env.SALLA_CART_WHATSAPP_EXPIRY_MINUTES || 1440)));
}

export function ingestSallaCartEvent(input: {
  ownerUid: string;
  merchantId?: string | null;
  event: string;
  payload: UnknownRecord;
  eventAt?: string | null;
}) {
  const eventAt = input.eventAt || new Date().toISOString();
  const cartId = sallaCartId(input.payload);
  if (!cartId) {
    const error = new Error("Salla abandoned-cart event is missing the cart id.") as Error & { status?: number };
    error.status = 422;
    throw error;
  }

  const terminal = terminalStatus(input.event, input.payload);
  if (terminal) {
    return {
      cartId,
      terminal,
      cart: cancelPendingOutreach(input.ownerUid, cartId, terminal, eventAt),
      queued: false,
    };
  }

  const cart = cartObject(input.payload);
  const customer = record(cart.customer);
  const total = record(cart.total);
  const items = cartItems(input.ownerUid, cart);
  const customerPhone = normalizePhoneDigits(text(customer.mobile, customer.phone, cart.mobile, cart.phone));
  const checkoutUrl = cleanHttpsUrl(cart.checkout_url || record(cart.urls).checkout);
  const saved = sallaCartConciergeStore.upsertActive({
    ownerUid: input.ownerUid,
    cartId,
    merchantId: input.merchantId || null,
    customerName: text(customer.name, cart.customer_name),
    customerPhone,
    checkoutUrl,
    items,
    totalAmount: numberValue(total.amount, cart.total_amount),
    currency: text(total.currency, cart.currency, "SAR"),
    ageInMinutes: numberValue(cart.age_in_minutes),
    eventAt,
  });

  if (saved?.status !== "active") {
    return { cartId, cart: saved, queued: false, reason: `cart_${saved?.status || "not_active"}` };
  }
  if (process.env.SALLA_CART_WHATSAPP_ENABLED === "false") {
    return { cartId, cart: saved, queued: false, reason: "feature_disabled" };
  }
  if (!/^\d{10,15}$/.test(customerPhone)) {
    sallaCartConciergeStore.setOutreach(input.ownerUid, cartId, { status: "invalid_phone" });
    return { cartId, cart: saved, queued: false, reason: "invalid_phone" };
  }
  if (!checkoutUrl) {
    sallaCartConciergeStore.setOutreach(input.ownerUid, cartId, { status: "checkout_url_missing" });
    return { cartId, cart: saved, queued: false, reason: "checkout_url_missing" };
  }

  const availableAt = new Date(Date.now() + delayMinutes() * 60_000).toISOString();
  const job = communicationJobStore.enqueue({
    ownerUid: input.ownerUid,
    eventKey: `salla-cart:${cartId}:whatsapp:1`,
    recipientPhone: customerPhone,
    templateName: "abandoned_cart_support",
    kind: "whatsapp_template",
    role: "customer",
    maxAttempts: 5,
    availableAt,
    expiresInMinutes: expiryMinutes(),
    payload: {
      purpose: "salla_abandoned_cart",
      cartId,
      customerName: saved?.customer_name || "عميلنا",
      checkoutUrl,
      products: items,
      vars: {
        customer_name: saved?.customer_name || "عميلنا",
        product_names: productSummary(items),
        checkout_url: checkoutUrl,
      },
    },
  });
  const updated = sallaCartConciergeStore.setOutreach(input.ownerUid, cartId, {
    status: job.status === "sent" ? "sent" : job.status === "blocked" ? "blocked" : "queued",
    jobId: job.id,
    providerMessageId: job.provider_message_id,
    sentAt: job.sent_at,
  });
  return { cartId, cart: updated, queued: ["pending", "retry", "processing"].includes(job.status), job };
}
