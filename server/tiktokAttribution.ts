import { createHash } from "node:crypto";
import db from "./db";
import { logError, logEvent } from "./logger";
import {
  claimNextAttributionEvent,
  enqueueAttributionEvent,
  markAttributionEventFailed,
  markAttributionEventSent,
  normalizeAttributionReference,
  parseAttributionReference,
  pruneAttributionData,
  sha256Phone,
  type ClaimedAttributionEvent,
} from "./tiktokAttributionStorage";

const DEFAULT_ENDPOINT = "https://business-api.tiktok.com/open_api/v1.3/event/track/";
let timer: ReturnType<typeof setInterval> | undefined;
let running = false;

function enabled() {
  return process.env.TIKTOK_EVENTS_ENABLED === "true";
}

function configured() {
  return Boolean(
    String(process.env.TIKTOK_EVENTS_ACCESS_TOKEN || "").trim()
      && String(process.env.TIKTOK_PIXEL_ID || "").trim(),
  );
}

function eventId(prefix: string, value: string) {
  return `${prefix}:${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

function errorMessage(body: unknown, status: number) {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const message = String(record.message || record.msg || record.error || "").trim();
    const code = String(record.code || record.status_code || status).trim();
    if (message) return `TikTok ${code}: ${message}`;
  }
  return `TikTok Events API returned HTTP ${status}.`;
}

export function buildTikTokWebEventPayload(event: ClaimedAttributionEvent, pixelId: string) {
  const context: Record<string, unknown> = {
    page: {
      url: event.landing_url || `${process.env.PUBLIC_APP_URL || "https://crm.breexe-pro.com"}${event.landing_path || "/landing"}`,
      ...(event.referrer ? { referrer: event.referrer } : {}),
    },
    ...(event.client_ip ? { ip: event.client_ip } : {}),
    ...(event.user_agent ? { user_agent: event.user_agent } : {}),
  };
  const ad: Record<string, unknown> = {};
  if (event.ttclid) ad.callback = event.ttclid;
  if (Object.keys(ad).length) context.ad = ad;
  const user: Record<string, unknown> = {};
  if (event.phone_sha256) user.phone_number = event.phone_sha256;
  if (event.ttp) user.ttp = event.ttp;
  if (Object.keys(user).length) context.user = user;

  const properties: Record<string, unknown> = {};
  if (event.value != null) properties.value = event.value;
  if (event.currency) properties.currency = event.currency;
  if (event.content_name) {
    properties.content_name = event.content_name;
    properties.content_type = "product";
  }

  return {
    pixel_code: pixelId,
    event: event.event_name,
    event_id: event.event_id,
    timestamp: new Date(event.occurred_at).getTime(),
    context,
    ...(Object.keys(properties).length ? { properties } : {}),
  };
}

export async function sendTikTokAttributionEvent(
  event: ClaimedAttributionEvent,
  fetchImpl: typeof fetch = fetch,
) {
  const token = String(process.env.TIKTOK_EVENTS_ACCESS_TOKEN || "").trim();
  const pixelId = String(process.env.TIKTOK_PIXEL_ID || "").trim();
  if (!enabled()) throw new Error("TikTok event delivery is disabled.");
  if (!token || !pixelId) throw new Error("TikTok event credentials are incomplete.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1_000, Number(process.env.TIKTOK_EVENTS_TIMEOUT_MS || 10_000)));
  try {
    const response = await fetchImpl(process.env.TIKTOK_EVENTS_ENDPOINT || DEFAULT_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Access-Token": token,
      },
      body: JSON.stringify(buildTikTokWebEventPayload(event, pixelId)),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    const apiCode = Number(body?.code ?? 0);
    if (!response.ok || apiCode !== 0) throw new Error(errorMessage(body, response.status));
    return String(body?.request_id || body?.code || response.status);
  } finally {
    clearTimeout(timeout);
  }
}

export function captureInboundWhatsAppAttribution(input: {
  ownerUid: string;
  message: string;
  phone: string;
  providerMessageId?: string | null;
  occurredAt?: string;
}) {
  if (process.env.TIKTOK_ATTRIBUTION_ENABLED !== "true") return { matched: false, reason: "disabled" as const };
  const reference = parseAttributionReference(input.message);
  if (!reference) return { matched: false, reason: "reference_missing" as const };
  const session = db.prepare(`
    SELECT reference FROM marketing_attribution_sessions
    WHERE reference = ? AND owner_uid = ? AND expires_at > ?
  `).get(reference, input.ownerUid, input.occurredAt || new Date().toISOString()) as { reference: string } | undefined;
  if (!session) return { matched: false, reason: "reference_unknown" as const };
  const providerId = String(input.providerMessageId || `${reference}:${input.occurredAt || ""}`);
  const result = enqueueAttributionEvent(db, {
    eventId: eventId("wa-contact", providerId),
    ownerUid: input.ownerUid,
    reference,
    eventName: "Contact",
    source: "whatsapp",
    phone: input.phone,
    contentName: "مكيفات",
    occurredAt: input.occurredAt,
  });
  return { matched: true, created: result.created, reference };
}

function referenceForPhone(ownerUid: string, phone: string) {
  const phoneHash = sha256Phone(phone);
  if (!phoneHash) return null;
  const row = db.prepare(`
    SELECT reference FROM marketing_attribution_events
    WHERE owner_uid = ? AND phone_sha256 = ? AND reference IS NOT NULL
      AND event_name IN ('Contact','SubmitForm')
      AND occurred_at >= datetime('now', '-180 days')
    ORDER BY occurred_at DESC LIMIT 1
  `).get(ownerUid, phoneHash) as { reference?: string } | undefined;
  return normalizeAttributionReference(row?.reference);
}

export function captureCrmStageAttribution(input: {
  ownerUid: string;
  entityId: string;
  phone: string;
  stage: string;
  amount?: number | null;
  currency?: string | null;
  contentName?: string | null;
  occurredAt?: string;
}) {
  if (process.env.TIKTOK_ATTRIBUTION_ENABLED !== "true") return { matched: false, reason: "disabled" as const };
  const stage = String(input.stage || "").toLowerCase();
  const mapped = ["opportunity", "quote", "invoice", "qualified"].includes(stage)
    ? "SubmitForm"
    : ["paid", "won", "closed_won"].includes(stage)
      ? "CompletePayment"
      : null;
  if (!mapped) return { matched: false, reason: "stage_ignored" as const };
  const reference = referenceForPhone(input.ownerUid, input.phone);
  if (!reference) return { matched: false, reason: "attribution_missing" as const };
  const result = enqueueAttributionEvent(db, {
    eventId: eventId(`crm-${mapped.toLowerCase()}`, input.entityId),
    ownerUid: input.ownerUid,
    reference,
    eventName: mapped,
    source: mapped === "CompletePayment" ? "order" : "crm",
    phone: input.phone,
    value: mapped === "CompletePayment" ? input.amount : null,
    currency: input.currency || "SAR",
    contentName: input.contentName || "مكيفات",
    occurredAt: input.occurredAt,
  });
  return { matched: true, created: result.created, reference, eventName: mapped };
}

export async function processNextTikTokAttributionEvent() {
  if (!enabled() || !configured()) return null;
  const event = claimNextAttributionEvent(db);
  if (!event) return null;
  try {
    const responseCode = await sendTikTokAttributionEvent(event);
    markAttributionEventSent(db, event.event_id, responseCode);
    logEvent("info", "tiktok.attribution.sent", {
      eventId: event.event_id,
      eventName: event.event_name,
      attempts: event.attempts,
    });
  } catch (error) {
    markAttributionEventFailed(db, event, error);
    logError("tiktok.attribution.failed", error, {
      eventId: event.event_id,
      eventName: event.event_name,
      attempts: event.attempts,
    });
  }
  return event;
}

export function startTikTokAttributionWorker() {
  if (timer || !enabled()) return;
  if (!configured()) {
    logEvent("warn", "tiktok.attribution.not_configured");
    return;
  }
  const intervalMs = Math.max(1_000, Number(process.env.TIKTOK_EVENTS_WORKER_INTERVAL_MS || 5_000));
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (let index = 0; index < 20; index += 1) {
        if (!await processNextTikTokAttributionEvent()) break;
      }
      pruneAttributionData(db);
    } catch (error) {
      logError("tiktok.attribution.worker_failed", error);
    } finally {
      running = false;
    }
  };
  timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();
  logEvent("info", "tiktok.attribution.worker_enabled", { intervalMs });
}
