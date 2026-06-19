/**
 * Google Tag Manager — client-side container loader.
 *
 *   - Injects the GTM <script> and <noscript> once per page load.
 *   - Relies on `VITE_GTM_ID` and `VITE_ENABLE_TRACKING` to decide whether
 *     to load.
 *
 * Checklist 5.9 — https://github.com/G00lden/golden-pro-crm
 */

let loaded = false;

/**
 * Inject the GTM container <script> and <noscript> into the document.
 * Safe to call multiple times — only fires once.
 */
export function loadGTM(containerId: string): void {
  if (loaded || typeof window === "undefined") return;
  loaded = true;

  // GTM dataLayer must be an array when GTM boots
  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push({ "gtm.start": Date.now(), event: "gtm.js" });

  // <script> — first-party gtm.js
  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtm.js?id=${containerId}`;
  document.head.appendChild(script);

  // <noscript> fallback for users without JS
  const noscript = document.createElement("noscript");
  const iframe = document.createElement("iframe");
  iframe.src = `https://www.googletagmanager.com/ns.html?id=${containerId}`;
  iframe.height = "0";
  iframe.width = "0";
  iframe.style.display = "none";
  iframe.style.visibility = "hidden";
  noscript.appendChild(iframe);
  document.body.insertBefore(noscript, document.body.firstChild);
}

/**
 * Conditionally initialise GTM from Vite env vars.
 *
 * Reads `VITE_ENABLE_TRACKING` and `VITE_GTM_ID`. Loads GTM only when
 * both are truthy.
 */
export function initializeTracking(
  env: Record<string, string | undefined>,
): void {
  const enabled = env.VITE_ENABLE_TRACKING === "true";
  if (!enabled) return;

  const gtmId = env.VITE_GTM_ID;
  if (gtmId) {
    loadGTM(gtmId);
  }
}
