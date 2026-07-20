/**
 * Tracking shim — placeholder for the full Meta Pixel / CAPI / GA4 stack
 * that lands in Step 3 of the roadmap. Today this:
 *
 *   1. Pushes events to window.dataLayer (GTM-ready).
 *   2. POSTs a privacy-minimised event to the server's validated no-storage intake.
 *   3. Logs in dev for visibility.
 *
 * Once GTM is wired (checklist 5.9), the dataLayer push becomes a real
 * trigger for every downstream tag (Meta Pixel, TikTok, Snap, GA4, etc.).
 */

import { ga4Event } from "./ga4";
import { trackMetaEvent } from "./metaPixel";
import { hasConsent } from "./consent";
import { trackTikTokEvent } from "./tiktokPixel";

declare global {
  interface Window {
    dataLayer?: Array<Record<string, unknown>>;
  }
}

const isDev = typeof import.meta !== "undefined" && (import.meta as { env?: { DEV?: boolean } }).env?.DEV;

const UTM_KEY = "breexe_utm";
const ATTRIBUTION_REFERENCE_KEY = "breexe_attribution_ref_v1";

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
      // First-touch attribution: keep the earliest capture; don't overwrite it
      // on later visits that arrive with fresh UTM params. Click identifiers are
      // persisted only after explicit consent.
      if (hasConsent() && !localStorage.getItem(UTM_KEY)) {
        localStorage.setItem(UTM_KEY, JSON.stringify(captured));
      }
    } catch { /* private mode */ }
    return captured;
  }
  try {
    const raw = localStorage.getItem(UTM_KEY);
    if (raw) return JSON.parse(raw) as UtmContext;
  } catch { /* private mode */ }
  return {};
}

/** Stable for one browser tab; contains no identity and is useless by itself. */
export function attributionReference(): string | null {
  if (typeof window === "undefined" || !hasConsent()) return null;
  try {
    const existing = sessionStorage.getItem(ATTRIBUTION_REFERENCE_KEY);
    if (/^[A-F0-9]{16}$/.test(existing || "")) return existing;
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    const reference = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("").toUpperCase();
    sessionStorage.setItem(ATTRIBUTION_REFERENCE_KEY, reference);
    return reference;
  } catch {
    return null;
  }
}

export function tiktokFirstPartyCookie(): string | undefined {
  if (typeof document === "undefined" || !hasConsent()) return undefined;
  const match = document.cookie.match(/(?:^|;\s*)_ttp=([^;]+)/);
  return match?.[1] ? decodeURIComponent(match[1]).slice(0, 256) : undefined;
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
    console.log("[track] event dispatched");
  }

  // 2. GTM dataLayer (becomes the trigger for every downstream tag once GTM is wired)
  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push(payload);

  // 2b. Direct GA4 + Meta Pixel fire — a belt-and-suspenders path alongside any
  // GTM-managed tags. Both no-op until their respective init has run.
  const eventParams = { value: event.value, currency: event.currency, ...(event.meta || {}) };
  ga4Event(event.name, eventParams);
  trackMetaEvent(event.name, eventParams);
  trackTikTokEvent(event.name, eventParams, payload.event_id);

  // 3. Privacy-minimised server intake. Attribution ids and arbitrary metadata
  // stay out of this request; the server also strips unknown fields defensively.
  const serverPayload = {
    event: event.name,
    event_id: payload.event_id,
    value: event.value,
    currency: event.currency,
    page: window.location.pathname,
    ts: payload.ts,
  };
  try {
    void fetch("/api/track/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(serverPayload),
      keepalive: true,
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    }).then((response) => {
      if (!response.ok && isDev) {
        // eslint-disable-next-line no-console
        console.warn(`[track] intake rejected event (${response.status})`);
      }
    }).catch(() => {
      if (isDev) {
        // eslint-disable-next-line no-console
        console.warn("[track] intake unavailable");
      }
    });
  } catch { /* ignore */ }
}

function cryptoId(): string {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  } catch { /* ignore */ }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
