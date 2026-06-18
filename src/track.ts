/**
 * Tracking shim — placeholder for the full Meta Pixel / CAPI / GA4 stack
 * that lands in Step 3 of the roadmap. Today this:
 *
 *   1. Pushes events to window.dataLayer (GTM-ready).
 *   2. POSTs to /api/track/event when that endpoint exists (no-op until then).
 *   3. Logs in dev for visibility.
 *
 * Once GTM is wired (checklist 5.9), the dataLayer push becomes a real
 * trigger for every downstream tag (Meta Pixel, TikTok, Snap, GA4, etc.).
 */

declare global {
  interface Window {
    dataLayer?: Array<Record<string, unknown>>;
  }
}

const isDev = typeof import.meta !== "undefined" && (import.meta as { env?: { DEV?: boolean } }).env?.DEV;

const UTM_KEY = "breexe_utm";

export interface UtmContext {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  gclid?: string;
  fbclid?: string;
  ttclid?: string;
  landing_url?: string;
  referrer?: string;
  ts?: string;
}

/** Read query params on page load, persist first-touch + update last-touch. */
export function captureUtm(): UtmContext {
  if (typeof window === "undefined") return {};
  const params = new URLSearchParams(window.location.search);
  const fields: Array<keyof UtmContext> = [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_content",
    "utm_term",
    "gclid",
    "fbclid",
    "ttclid",
  ];
  const captured: UtmContext = {};
  for (const f of fields) {
    const v = params.get(f);
    if (v) (captured as Record<string, string>)[f] = v;
  }
  if (Object.keys(captured).length) {
    captured.landing_url = window.location.href;
    captured.referrer = document.referrer || undefined;
    captured.ts = new Date().toISOString();
    try {
      localStorage.setItem(UTM_KEY, JSON.stringify(captured));
    } catch { /* private mode */ }
    return captured;
  }
  try {
    const raw = localStorage.getItem(UTM_KEY);
    if (raw) return JSON.parse(raw) as UtmContext;
  } catch { /* private mode */ }
  return {};
}

export interface TrackEvent {
  name: string; // e.g. "wa_click", "call_click", "lead_submit", "purchase"
  value?: number;
  currency?: string;
  meta?: Record<string, unknown>;
}

/** Fire a tracking event. Idempotent if eventId is supplied. */
export function trackEvent(event: TrackEvent): void {
  if (typeof window === "undefined") return;
  const utm = captureUtm();
  const payload = {
    event: event.name,
    event_id: cryptoId(),
    value: event.value,
    currency: event.currency,
    ...(event.meta || {}),
    utm,
    page: window.location.pathname,
    ts: new Date().toISOString(),
  };

  // 1. Dev visibility
  if (isDev) {
    // eslint-disable-next-line no-console
    console.log("[track]", event.name, payload);
  }

  // 2. GTM dataLayer (becomes the trigger for every downstream tag once GTM is wired)
  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push(payload);

  // 3. Best-effort server-side fire for CAPI dedup. Endpoint may not exist yet
  // and that's OK — we just swallow the error.
  try {
    fetch("/api/track/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => undefined);
  } catch { /* ignore */ }
}

function cryptoId(): string {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  } catch { /* ignore */ }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
