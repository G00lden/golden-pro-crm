/**
 * Google Analytics 4 (GA4) — client-side measurement.
 *
 *   - Provides `initGA4()` to load gtag.js and configure the GA4 stream.
 *   - Provides `ga4Event()` to fire arbitrary GA4 events.
 *   - Wired through `trackEvent()` in track.ts as a direct path independent of
 *     GTM (belt-and-suspenders approach: GTM fires GA4 tags, and so do we).
 *
 * Checklist 5.10 — https://github.com/G00lden/golden-pro-crm
 */

let initialized = false;

/**
 * Initialise GA4 by loading gtag.js and firing the initial `config` call.
 * Safe to call multiple times — only fires once.
 */
export function initGA4(measurementId: string): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;

  // Load gtag.js if not already present (GTM may have loaded it)
  if (!document.querySelector(`script[src*="googletagmanager.com/gtag/js"]`)) {
    const script = document.createElement("script");
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${measurementId}`;
    document.head.appendChild(script);
  }

  // Ensure the gtag function queue exists on window
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  w.dataLayer = w.dataLayer || [];
  w.gtag = function gtag() {
    // gtag.js consumes the raw `arguments` object from dataLayer, not an array —
    // pushing a plain array is not recognised as a gtag command.
    // eslint-disable-next-line prefer-rest-params
    w.dataLayer.push(arguments);
  };

  // Config call — tells GA4 to start collecting
  // send_page_view=false because we fire page_view ourselves in trackEvent
  w.gtag("config", measurementId, { send_page_view: false });
}

/**
 * Fire a GA4 event via gtag().
 * No-op if GA4 was never initialised.
 */
export function ga4Event(
  eventName: string,
  params?: Record<string, unknown>,
): void {
  if (!initialized || typeof window === "undefined") return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  w.gtag("event", eventName, params || {});
}
