import { randomUUID } from "node:crypto";
import { adminDb } from "./firebaseAdmin";
import { compareAndSetDocument } from "./atomicDocumentUpdate";
import {
  buildGa4CommerceEvent,
  buildGa4MeasurementBody,
  buildGoogleAdsMatchRecord,
  type AnalyticsOrder,
} from "./orderAnalyticsPayload";

export type Ga4MeasurementMode = "disabled" | "validate" | "collect";

export type Ga4MeasurementConfig = {
  mode: Ga4MeasurementMode;
  measurementId: string;
  apiSecret: string;
  endpoint?: string;
};

export type AnalyticsDeliveryResult = {
  status:
    | "ignored"
    | "disabled"
    | "blocked_missing_client_id"
    | "blocked_missing_config"
    | "validated"
    | "validation_failed"
    | "sent"
    | "delivery_unknown"
    | "retry_pending"
    | "failed";
  mode?: Ga4MeasurementMode;
  event_name?: "purchase" | "refund";
  transaction_id?: string;
  validation_messages?: unknown[];
  http_status?: number;
  error?: string;
  retry_after_ms?: number;
  manual_reconciliation_required?: boolean;
};

const DEFAULT_ANALYTICS_RESERVATION_TTL_MS = 5 * 60 * 1_000;

function configuredMode(value: unknown): Ga4MeasurementMode {
  const normalized = String(value || "disabled").trim().toLocaleLowerCase("en-US");
  if (normalized === "validate" || normalized === "collect") return normalized;
  return "disabled";
}

export function ga4MeasurementConfigFromEnv(): Ga4MeasurementConfig {
  return {
    mode: configuredMode(process.env.GA4_MEASUREMENT_MODE),
    measurementId: String(process.env.GA4_MEASUREMENT_ID || "").trim(),
    apiSecret: String(process.env.GA4_API_SECRET || "").trim(),
    endpoint: String(process.env.GA4_MEASUREMENT_ENDPOINT || "").trim() || undefined,
  };
}

function ga4Endpoint(config: Ga4MeasurementConfig) {
  if (config.endpoint) return config.endpoint;
  return config.mode === "validate"
    ? "https://www.google-analytics.com/debug/mp/collect"
    : "https://www.google-analytics.com/mp/collect";
}

function safeError(error: unknown) {
  return (error instanceof Error ? error.message : String(error || "Unknown analytics delivery error")).slice(0, 500);
}

export async function sendGa4OrderEvent(
  order: AnalyticsOrder,
  config: Ga4MeasurementConfig = ga4MeasurementConfigFromEnv(),
  fetchImpl: typeof fetch = fetch,
): Promise<AnalyticsDeliveryResult> {
  const event = buildGa4CommerceEvent(order);
  if (!event) return { status: "ignored" };
  const transactionId = String(event.params.transaction_id || "");
  const base = { event_name: event.name, transaction_id: transactionId, mode: config.mode } as const;

  if (config.mode === "disabled") return { status: "disabled", ...base };
  if (!config.measurementId || !config.apiSecret) return { status: "blocked_missing_config", ...base };

  const body = buildGa4MeasurementBody(order);
  if (!body) return { status: "blocked_missing_client_id", ...base };

  const query = new URLSearchParams({
    measurement_id: config.measurementId,
    api_secret: config.apiSecret,
  });

  try {
    const response = await fetchImpl(`${ga4Endpoint(config)}?${query.toString()}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(config.mode === "validate"
        ? { ...body, validation_behavior: "ENFORCE_RECOMMENDATIONS" }
        : body),
    });

    if (!response.ok) {
      return { status: "failed", ...base, http_status: response.status, error: `GA4 HTTP ${response.status}` };
    }

    if (config.mode === "validate") {
      const result = await response.json().catch(() => ({ validationMessages: [{ description: "Invalid validation response." }] })) as {
        validationMessages?: unknown[];
      };
      const messages = Array.isArray(result.validationMessages) ? result.validationMessages : [];
      return {
        status: messages.length ? "validation_failed" : "validated",
        ...base,
        http_status: response.status,
        validation_messages: messages,
      };
    }

    return { status: "sent", ...base, http_status: response.status };
  } catch (error) {
    // A network failure can happen after Google accepted the request. The
    // attempted mode is persisted so a debug/validate failure cannot suppress
    // a later production collect attempt.
    return { status: "delivery_unknown", ...base, error: safeError(error) };
  }
}

function deliveryKey(result: AnalyticsDeliveryResult, order: AnalyticsOrder) {
  if (result.event_name === "refund") {
    return "refund_full";
  }
  return "purchase";
}

function isTerminalDelivery(value: unknown, mode: Ga4MeasurementMode) {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const status = String(record.status || "");
  const attemptedMode = configuredMode(record.mode);
  return status === "sent"
    || (status === "delivery_unknown" && attemptedMode === "collect")
    || (status === "validated" && mode === "validate");
}

function analyticsReservationTtlMs() {
  const configured = Number(process.env.ANALYTICS_RESERVATION_TTL_MS);
  return Number.isFinite(configured) && configured >= 10_000
    ? configured
    : DEFAULT_ANALYTICS_RESERVATION_TTL_MS;
}

function reservationIsStale(value: unknown, nowMs = Date.now()) {
  const reservedAtMs = Date.parse(String(value || ""));
  return !Number.isFinite(reservedAtMs) || nowMs - reservedAtMs >= analyticsReservationTtlMs();
}

function numberOrUndefined(value: unknown) {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function effectiveOrderFromSaved(order: AnalyticsOrder, saved: Record<string, any>): AnalyticsOrder {
  const savedItems = Array.isArray(saved.items) ? saved.items.map((item: Record<string, any>) => ({
    name: String(item.name || "Store item"),
    sku: String(item.sku || ""),
    quantity: Math.max(1, Number(item.quantity || 1)),
    unitPrice: numberOrUndefined(item.unit_price) ?? null,
    totalPrice: numberOrUndefined(item.total_price) ?? null,
    currency: String(item.currency || saved.currency || "SAR"),
    variant: item.variant || null,
    sallaProductId: item.salla_product_id || null,
    coupon: item.coupon || null,
  })) : [];
  const incomingItemsAreFallback = order.items.length === 1 && /^salla-[a-f0-9]{12}$/i.test(String(order.items[0]?.sku || ""));
  return {
    ...order,
    status: order.status || String(saved.status || ""),
    paymentStatus: order.paymentStatus || saved.payment_status || undefined,
    paymentTypeGroup: order.paymentTypeGroup || saved.payment_type_group || undefined,
    currency: order.currency || saved.currency || "SAR",
    total: order.total ?? numberOrUndefined(saved.total),
    subtotal: order.subtotal ?? numberOrUndefined(saved.subtotal),
    shipping: order.shipping ?? numberOrUndefined(saved.shipping),
    tax: order.tax ?? numberOrUndefined(saved.tax),
    discount: order.discount ?? numberOrUndefined(saved.discount),
    coupon: order.coupon || saved.coupon || undefined,
    attribution: {
      ...(saved.attribution && typeof saved.attribution === "object" ? saved.attribution : {}),
      ...(order.attribution || {}),
    },
    items: order.items.length && !incomingItemsAreFallback ? order.items : savedItems,
  };
}

export async function deliverOrderAnalytics(
  uid: string,
  orderDocId: string,
  order: AnalyticsOrder,
  config: Ga4MeasurementConfig = ga4MeasurementConfigFromEnv(),
  fetchImpl: typeof fetch = fetch,
  orderRefOverride?: unknown,
) {
  const orderRef = orderRefOverride || adminDb.collection("store_orders").doc(orderDocId);
  const typedOrderRef = orderRef as {
    get: () => Promise<{ exists: boolean; data: () => Record<string, any> }>;
  };
  const orderDoc = await typedOrderRef.get();
  const saved = orderDoc.exists ? orderDoc.data() || {} : {};
  if (!orderDoc.exists || String(saved.createdBy || saved.owner_uid || "") !== uid) {
    return { status: "ignored" as const };
  }
  const analytics = saved.analytics && typeof saved.analytics === "object"
    ? { ...(saved.analytics as Record<string, unknown>) }
    : {};

  const effectiveOrder = effectiveOrderFromSaved(order, saved);
  const preview = buildGa4CommerceEvent(effectiveOrder);
  if (!preview) return { status: "ignored" as const };
  const key = preview.name === "purchase"
    ? "purchase"
    : deliveryKey({ status: "ignored", event_name: preview.name }, effectiveOrder);
  if (isTerminalDelivery(analytics[key], config.mode)) {
    return {
      status: "ignored" as const,
      duplicate: true,
      event_name: preview.name,
      transaction_id: String(preview.params.transaction_id || ""),
    };
  }

  const currentReservation = String(saved.analytics_reservation_token || "");
  if (currentReservation) {
    if (!reservationIsStale(saved.analytics_reservation_at)) {
      return {
        status: "retry_pending" as const,
        in_flight: true,
        event_name: preview.name,
        transaction_id: String(preview.params.transaction_id || ""),
        retry_after_ms: analyticsReservationTtlMs(),
      };
    }

    const reservationMode = configuredMode(saved.analytics_reservation_mode || config.mode);
    if (reservationMode === "collect") {
      // A collect request may have reached Google before the worker stopped.
      // Never reclaim and resend that lease automatically: record an explicit
      // ambiguous state for private reconciliation, then let a different event
      // (for example a later refund) acquire its own reservation.
      const staleKey = String(saved.analytics_reservation_key || key);
      const detectedAt = new Date().toISOString();
      const ambiguousResult: AnalyticsDeliveryResult = {
        status: "delivery_unknown",
        mode: "collect",
        event_name: staleKey === "refund_full" ? "refund" : "purchase",
        transaction_id: String(preview.params.transaction_id || ""),
        error: "A stale GA4 collect reservation may already have been accepted. Automatic resend is blocked; reconcile this order manually.",
        manual_reconciliation_required: true,
      };
      const staleAnalytics: Record<string, unknown> = {
        ...analytics,
        [staleKey]: {
          ...ambiguousResult,
          attempted_at: saved.analytics_reservation_at || detectedAt,
          detected_at: detectedAt,
          pii_sent: false,
        },
      };
      const googleAdsMatch = buildGoogleAdsMatchRecord(effectiveOrder);
      if (googleAdsMatch) {
        staleAnalytics.google_ads = {
          ...googleAdsMatch,
          updated_at: detectedAt,
          pii_sent: false,
        };
      }
      const markedAmbiguous = await compareAndSetDocument(
        orderRef,
        {
          analytics_reservation_token: saved.analytics_reservation_token,
          analytics_reservation_key: saved.analytics_reservation_key ?? null,
          analytics_reservation_at: saved.analytics_reservation_at ?? null,
          analytics_reservation_mode: saved.analytics_reservation_mode ?? null,
        },
        {
          analytics: staleAnalytics,
          analytics_delivery_reconciliation_required: true,
          analytics_reservation_token: null,
          analytics_reservation_key: null,
          analytics_reservation_at: null,
          analytics_reservation_mode: null,
          updatedAt: detectedAt,
        },
      );
      if (!markedAmbiguous) {
        return {
          status: "retry_pending" as const,
          in_flight: true,
          event_name: preview.name,
          transaction_id: String(preview.params.transaction_id || ""),
          retry_after_ms: analyticsReservationTtlMs(),
        };
      }
      if (staleKey === key) return ambiguousResult;
      return deliverOrderAnalytics(uid, orderDocId, order, config, fetchImpl, orderRef);
    }
  }

  const reservationToken = randomUUID();
  const reservedAt = new Date().toISOString();
  const reservationExpected = currentReservation
    ? {
        analytics_reservation_token: saved.analytics_reservation_token,
        analytics_reservation_key: saved.analytics_reservation_key ?? null,
        analytics_reservation_at: saved.analytics_reservation_at ?? null,
      }
    : { analytics_reservation_token: saved.analytics_reservation_token ?? null };
  const reserved = await compareAndSetDocument(
    orderRef,
    reservationExpected,
    {
      analytics_reservation_token: reservationToken,
      analytics_reservation_key: key,
      analytics_reservation_at: reservedAt,
      analytics_reservation_mode: config.mode,
      updatedAt: reservedAt,
    },
  );
  if (!reserved) {
    return {
      status: "retry_pending" as const,
      in_flight: true,
      event_name: preview.name,
      transaction_id: String(preview.params.transaction_id || ""),
      retry_after_ms: analyticsReservationTtlMs(),
    };
  }

  const result = await sendGa4OrderEvent(effectiveOrder, config, fetchImpl);
  const now = new Date().toISOString();
  const googleAdsMatch = buildGoogleAdsMatchRecord(effectiveOrder);
  const latestDoc = await typedOrderRef.get();
  const latestSaved = latestDoc.exists ? latestDoc.data() || {} : {};
  const latestAnalytics = latestSaved.analytics && typeof latestSaved.analytics === "object"
    ? { ...(latestSaved.analytics as Record<string, unknown>) }
    : {};
  const nextAnalytics: Record<string, unknown> = {
    ...latestAnalytics,
    [deliveryKey(result, effectiveOrder)]: {
      ...result,
      attempted_at: now,
      pii_sent: false,
    },
  };
  if (googleAdsMatch) {
    nextAnalytics.google_ads = {
      ...googleAdsMatch,
      updated_at: now,
      pii_sent: false,
    };
  }

  const finalized = await compareAndSetDocument(
    orderRef,
    {
      analytics_reservation_token: reservationToken,
      analytics_reservation_key: key,
    },
    {
      analytics: nextAnalytics,
      analytics_reservation_token: null,
      analytics_reservation_key: null,
      analytics_reservation_at: null,
      analytics_reservation_mode: null,
      updatedAt: now,
    },
  );
  if (!finalized) {
    throw new Error("Analytics delivery completed but its reservation could not be finalized.");
  }
  return result;
}
