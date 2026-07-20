let initialized = false;

type TikTokQueue = Array<unknown[]> & {
  _i?: Record<string, unknown>;
  _t?: Record<string, number>;
  _o?: Record<string, unknown>;
  methods?: string[];
  setAndDefer?: (target: Record<string, unknown>, method: string) => void;
  load?: (pixelId: string, options?: Record<string, unknown>) => void;
  instance?: (pixelId: string) => Record<string, unknown>;
  page?: () => void;
  track?: (event: string, properties?: Record<string, unknown>, options?: Record<string, unknown>) => void;
  [key: string]: unknown;
};

declare global {
  interface Window {
    TiktokAnalyticsObject?: string;
    ttq?: TikTokQueue;
  }
}

/** Official queue shape, loaded only after the visitor grants consent. */
export function initTikTokPixel(pixelId: string): void {
  if (initialized || typeof window === "undefined" || !/^[A-Z0-9]{10,40}$/i.test(pixelId)) return;
  initialized = true;
  window.TiktokAnalyticsObject = "ttq";
  const queue = (window.ttq = window.ttq || ([] as unknown as TikTokQueue));
  queue.methods = [
    "page", "track", "identify", "instances", "debug", "on", "off", "once",
    "ready", "alias", "group", "enableCookie", "disableCookie", "holdConsent", "revokeConsent", "grantConsent",
  ];
  queue.setAndDefer = (target, method) => {
    target[method] = (...args: unknown[]) => queue.push([method, ...args]);
  };
  for (const method of queue.methods) queue.setAndDefer(queue as unknown as Record<string, unknown>, method);
  queue.instance = (id) => {
    const instance = (queue._i?.[id] || []) as unknown as Record<string, unknown>;
    for (const method of queue.methods || []) queue.setAndDefer?.(instance, method);
    return instance;
  };
  queue._i = queue._i || {};
  queue._t = queue._t || {};
  queue._o = queue._o || {};
  queue.load = (id, options = {}) => {
    const baseUrl = "https://analytics.tiktok.com/i18n/pixel/events.js";
    const instance = [] as unknown as Record<string, unknown>;
    instance._u = baseUrl;
    queue._i![id] = instance;
    queue._o![id] = options;
    queue._t![id] = Date.now();
    const script = document.createElement("script");
    script.async = true;
    script.src = `${baseUrl}?sdkid=${encodeURIComponent(id)}&lib=ttq`;
    const firstScript = document.getElementsByTagName("script")[0];
    if (firstScript?.parentNode) firstScript.parentNode.insertBefore(script, firstScript);
    else document.head.appendChild(script);
  };
  queue.load(pixelId);
  queue.page?.();
}

export function trackTikTokEvent(
  eventName: string,
  properties: Record<string, unknown> = {},
  eventId?: string,
) {
  if (!initialized || typeof window === "undefined") return;
  const mapped = eventName === "page_view"
    ? "ViewContent"
    : eventName === "call_click"
      ? "Contact"
      : eventName === "lead_submit"
        ? "SubmitForm"
        : eventName === "purchase"
          ? "CompletePayment"
          : null;
  // WhatsApp clicks are sent by the same-origin redirect, using the same
  // reference later matched to the inbound message. Avoid a second pixel copy.
  if (!mapped) return;
  window.ttq?.track?.(mapped, properties, eventId ? { event_id: eventId } : undefined);
}
