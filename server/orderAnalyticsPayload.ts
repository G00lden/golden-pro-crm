export type AnalyticsAttribution = {
  clientId?: string;
  sessionId?: string;
  gclid?: string;
  gbraid?: string;
  wbraid?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
};

export type AnalyticsOrderItem = {
  name: string;
  sku: string;
  quantity: number;
  unitPrice?: number | null;
  totalPrice?: number | null;
  currency?: string | null;
  variant?: string | null;
  sallaProductId?: string | null;
  coupon?: string | null;
};

export type AnalyticsOrder = {
  eventType: string;
  eventId: string;
  orderId: string;
  orderNumber: string;
  status: string;
  paymentStatus?: string;
  paymentTypeGroup?: string;
  currency?: string;
  total?: number;
  subtotal?: number;
  shipping?: number;
  tax?: number;
  discount?: number;
  coupon?: string;
  attribution?: AnalyticsAttribution;
  items: AnalyticsOrderItem[];
};

export type Ga4CommerceEventName = "purchase" | "refund";

export type Ga4CommerceEvent = {
  name: Ga4CommerceEventName;
  params: Record<string, unknown>;
};

function finiteNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function positiveMoney(value: unknown): number | undefined {
  const parsed = finiteNumber(value);
  return parsed === undefined ? undefined : Math.max(0, parsed);
}

function clean(value: unknown, max = 100): string {
  return String(value ?? "").trim().slice(0, max);
}

function isRejectedPaymentStatus(value: string): boolean {
  const normalized = value.trim().toLocaleLowerCase("en-US");
  return [
    "failed",
    "failure",
    "declined",
    "void",
    "voided",
    "cancelled",
    "canceled",
    "refunded",
    "unpaid",
    "payment failed",
    "فشل",
    "ملغي",
    "ملغى",
    "مسترجع",
    "غير مدفوع",
  ].some((token) => normalized.includes(token));
}

function isConfirmedPaymentStatus(value: string): boolean {
  const normalized = value.trim().toLocaleLowerCase("en-US");
  return [
    "paid",
    "completed",
    "captured",
    "authorized",
    "تم الدفع",
    "مدفوع",
    "مكتمل",
  ].some((token) => normalized.includes(token));
}

export function classifyGa4CommerceEvent(order: AnalyticsOrder): Ga4CommerceEventName | null {
  const eventType = order.eventType.trim().toLocaleLowerCase("en-US");
  if (eventType === "order.refunded" || eventType === "order.cancelled" || eventType === "order.canceled") {
    return "refund";
  }

  if (eventType === "order.created") {
    return isRejectedPaymentStatus(order.paymentStatus || order.status) ? null : "purchase";
  }

  if (eventType === "order.payment.updated" || eventType === "order.updated") {
    return isConfirmedPaymentStatus(order.paymentStatus || order.status) ? "purchase" : null;
  }

  return null;
}

export function commerceValue(order: AnalyticsOrder): number {
  const explicitSubtotal = positiveMoney(order.subtotal);
  if (explicitSubtotal !== undefined) return explicitSubtotal;

  const itemTotal = order.items.reduce((sum, item) => {
    const total = positiveMoney(item.totalPrice);
    if (total !== undefined) return sum + total;
    const price = positiveMoney(item.unitPrice) ?? 0;
    return sum + price * Math.max(1, Number(item.quantity || 1));
  }, 0);
  if (itemTotal > 0) return itemTotal;

  const total = positiveMoney(order.total) ?? 0;
  const shipping = positiveMoney(order.shipping) ?? 0;
  const tax = positiveMoney(order.tax) ?? 0;
  return Math.max(0, total - shipping - tax);
}

export function buildGa4CommerceEvent(order: AnalyticsOrder): Ga4CommerceEvent | null {
  const name = classifyGa4CommerceEvent(order);
  if (!name) return null;

  const currency = clean(order.currency || order.items[0]?.currency || "SAR", 12).toUpperCase() || "SAR";
  const params: Record<string, unknown> = {
    transaction_id: clean(order.orderNumber || order.orderId, 100),
    value: commerceValue(order),
    currency,
    items: order.items.map((item) => {
      const mapped: Record<string, unknown> = {
        item_id: clean(item.sku, 100),
        item_name: clean(item.name, 100),
        price: positiveMoney(item.unitPrice) ?? 0,
        quantity: Math.max(1, Math.round(Number(item.quantity || 1))),
      };
      const variant = clean(item.variant, 100);
      const productId = clean(item.sallaProductId, 100);
      const coupon = clean(item.coupon, 100);
      if (variant) mapped.item_variant = variant;
      if (productId) mapped.salla_product_id = productId;
      if (coupon) mapped.coupon = coupon;
      return mapped;
    }),
  };

  const shipping = positiveMoney(order.shipping);
  const tax = positiveMoney(order.tax);
  const coupon = clean(order.coupon, 100);
  const paymentTypeGroup = clean(order.paymentTypeGroup, 40);
  if (shipping !== undefined) params.shipping = shipping;
  if (tax !== undefined) params.tax = tax;
  if (coupon) params.coupon = coupon;
  if (paymentTypeGroup) params.payment_type_group = paymentTypeGroup;

  const sessionId = clean(order.attribution?.sessionId, 40);
  if (/^\d+$/.test(sessionId)) params.session_id = Number(sessionId);
  params.engagement_time_msec = 1;

  return { name, params };
}

export function buildGa4MeasurementBody(order: AnalyticsOrder) {
  const event = buildGa4CommerceEvent(order);
  const clientId = clean(order.attribution?.clientId, 160);
  if (!event || !clientId) return null;
  return {
    client_id: clientId,
    events: [event],
  };
}

export function buildGoogleAdsMatchRecord(order: AnalyticsOrder) {
  const eventName = classifyGa4CommerceEvent(order);
  if (!eventName) return null;
  const attribution = order.attribution || {};
  const clickId = clean(attribution.gclid || attribution.gbraid || attribution.wbraid, 200);
  if (!clickId) return null;
  const clickIdType = attribution.gclid ? "gclid" : attribution.gbraid ? "gbraid" : "wbraid";
  return {
    status: eventName === "purchase" ? "pending_configuration" : "pending_adjustment",
    event_name: eventName,
    transaction_id: clean(order.orderNumber || order.orderId, 100),
    conversion_value: commerceValue(order),
    currency: clean(order.currency || order.items[0]?.currency || "SAR", 12).toUpperCase() || "SAR",
    click_id_type: clickIdType,
    click_id: clickId,
  };
}
