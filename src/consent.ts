/**
 * Cookie / tracking consent — PDPL + Meta ad-policy compliant gate.
 *
 * No third-party tracker (GTM, GA4, Meta Pixel, …) may load until the visitor
 * explicitly grants consent. State persists in localStorage so a returning
 * visitor isn't asked again. See docs/commercial-release-checklist.md §5.7.
 */

export type ConsentState = "granted" | "denied" | "unknown";

const KEY = "breexe_consent_v1";
const listeners = new Set<(s: ConsentState) => void>();

export function getConsent(): ConsentState {
  if (typeof localStorage === "undefined") return "unknown";
  try {
    const v = localStorage.getItem(KEY);
    return v === "granted" ? "granted" : v === "denied" ? "denied" : "unknown";
  } catch {
    return "unknown";
  }
}

export function hasConsent(): boolean {
  return getConsent() === "granted";
}

export function setConsent(state: "granted" | "denied"): void {
  try {
    localStorage.setItem(KEY, state);
  } catch {
    /* private mode — keep in-memory only for this page load */
  }
  listeners.forEach((cb) => cb(state));
}

/** Subscribe to consent changes. Returns an unsubscribe function. */
export function onConsentChange(cb: (s: ConsentState) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
