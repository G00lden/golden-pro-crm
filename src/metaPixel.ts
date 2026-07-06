/**
 * Meta Pixel (Facebook + Instagram) — client-side conversion tracking.
 *
 *   - Provides `initMetaPixel()` to load the standard fbq base code.
 *   - Provides `trackMetaEvent()` to fire standard Meta events.
 *   - Maps application-level event names to Meta standard events as specified
 *     in the sprint brief.
 *
 * Event mapping:
 *   page_view   → PageView
 *   wa_click    → Contact  (content_name: "WhatsApp Click")
 *   call_click  → Contact  (content_name: "Phone Call")
 *   lead_submit → Lead     (with value / currency when present)
 *
 * Checklist 5.11 — https://github.com/G00lden/golden-pro-crm
 */

let initialized = false;

/**
 * Initialise the Meta Pixel by injecting the fbq base snippet.
 * Safe to call multiple times — only fires once.
 */
export function initMetaPixel(pixelId: string): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;

  // Canonical Meta Pixel base code. When fbevents.js loads it replays
  // `fbq.queue` via `fbq.callMethod`, so the queue/callMethod shape below must
  // match Meta's official snippet — the previous stub pushed to a plain `_fbq`
  // array that fbevents.js never reads, so init/track calls were never sent.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  if (!w.fbq) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const n: any = function (...args: unknown[]) {
      n.callMethod ? n.callMethod.apply(n, args) : n.queue.push(args);
    };
    w.fbq = n;
    if (!w._fbq) w._fbq = n;
    n.push = n;
    n.loaded = true;
    n.version = "2.0";
    n.queue = [];

    const script = document.createElement("script");
    script.async = true;
    script.src = "https://connect.facebook.net/en_US/fbevents.js";
    document.head.appendChild(script);
  }

  w.fbq("init", pixelId);
  w.fbq("track", "PageView");
}

/**
 * Fire a Meta Pixel event.
 * No-op if Meta Pixel was never initialised.
 */
export function trackMetaEvent(
  eventName: string,
  params?: Record<string, unknown>,
): void {
  if (!initialized || typeof window === "undefined") return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const win = window as any;
  const metaEvent = mapToMetaEvent(eventName, params);

  if (metaEvent === "PageView") {
    win.fbq("track", "PageView");
  } else {
    win.fbq("track", metaEvent, params || {});
  }
}

/**
 * Map our generic event names to Meta Pixel standard events.
 */
function mapToMetaEvent(
  eventName: string,
  params?: Record<string, unknown>,
): string {
  switch (eventName) {
    case "page_view":
      return "PageView";
    case "wa_click":
      return "Contact";
    case "call_click":
      return "Contact";
    case "lead_submit":
      return "Lead";
    default:
      return "PageView";
  }
}
