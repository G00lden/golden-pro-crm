import type { Express, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import { validate, validateQuery } from "./validation";
import {
  enqueueAttributionEvent,
  normalizeSaudiPhone,
  upsertAttributionSession,
  type AttributionDatabase,
} from "./tiktokAttributionStorage";
import { logError } from "./logger";

const trackingEventNameSchema = z.enum([
  "page_view",
  "wa_click",
  "call_click",
  "lead_submit",
  "purchase",
]);

/**
 * Only fields needed to acknowledge a known event survive parsing. Zod strips
 * unknown fields (UTM click ids, email, phone, tokens, arbitrary metadata), so
 * route code can never accidentally persist or log them.
 */
export const trackingEventSchema = z.object({
  event: trackingEventNameSchema,
  event_id: z.string().trim().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/),
  value: z.number().finite().min(0).max(1_000_000_000).optional(),
  currency: z.string().trim().regex(/^[A-Z]{3}$/).optional(),
  page: z.string().trim().min(1).max(256).refine(
    (value) => value.startsWith("/") && !/[?#\u0000-\u001f]/u.test(value),
    "Page must be a path without a query string or fragment",
  ),
  ts: z.string().datetime({ offset: true }),
}).strip();

export type AcceptedTrackingEvent = z.infer<typeof trackingEventSchema>;

type TrackingRouteOptions = {
  rateLimit: RequestHandler;
  /** Test seam for the minimised event intake. */
  onAccepted?: (event: AcceptedTrackingEvent) => void;
  database?: AttributionDatabase;
  ownerUid?: () => string;
  clientIp?: (req: Request) => string | null | undefined;
  publicContactPhone?: () => string | null | undefined;
};

const trackedWhatsAppQuerySchema = z.object({
  reference: z.string().trim().regex(/^[A-Fa-f0-9]{16}$/),
  consent: z.literal("granted"),
  message: z.string().trim().max(600).optional().default(""),
  page: z.string().trim().min(1).max(256).refine(
    (value) => value.startsWith("/") && !/[?#\u0000-\u001f]/u.test(value),
    "Page must be a path without a query string or fragment",
  ),
  ttclid: z.string().trim().min(6).max(512).optional(),
  ttp: z.string().trim().min(6).max(256).optional(),
  utm_source: z.string().trim().max(120).optional(),
  utm_medium: z.string().trim().max(120).optional(),
  utm_campaign: z.string().trim().max(180).optional(),
  utm_content: z.string().trim().max(180).optional(),
  utm_term: z.string().trim().max(180).optional(),
  ts: z.string().datetime({ offset: true }).optional(),
}).strip();

function publicWhatsAppUrl(phone: string, message: string) {
  return `https://wa.me/${phone.slice(1)}${message ? `?text=${encodeURIComponent(message)}` : ""}`;
}

function trackedMessage(message: string, reference: string) {
  const base = message.trim().slice(0, 600);
  const marker = `مرجع الطلب:\n${reference}`;
  return base ? `${base}\n\n${marker}` : marker;
}

function boundedPositiveInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

export function trackingEventRateLimitOptions(env: NodeJS.ProcessEnv = process.env) {
  return {
    windowMs: boundedPositiveInteger(
      env.TRACK_EVENT_RATE_LIMIT_WINDOW_MS,
      60_000,
      1_000,
      60 * 60_000,
    ),
    max: boundedPositiveInteger(env.TRACK_EVENT_RATE_LIMIT_MAX, 120, 1, 10_000),
    name: "tracking-events",
  };
}

export function registerTrackingRoutes(app: Express, options: TrackingRouteOptions) {
  app.get(
    "/api/track/whatsapp",
    options.rateLimit,
    validateQuery(trackedWhatsAppQuerySchema),
    (req: Request, res: Response) => {
      const query = req.query as unknown as z.infer<typeof trackedWhatsAppQuerySchema>;
      const phone = normalizeSaudiPhone(options.publicContactPhone?.() || process.env.VITE_PUBLIC_CONTACT_PHONE);
      if (!phone) {
        res.status(503).type("text/plain").send("Public WhatsApp contact is not configured.");
        return;
      }

      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Robots-Tag", "noindex, nofollow");
      if (
        process.env.TIKTOK_ATTRIBUTION_ENABLED !== "true"
        || !options.database
        || !options.ownerUid
      ) {
        res.redirect(302, publicWhatsAppUrl(phone, query.message));
        return;
      }

      try {
        const ownerUid = options.ownerUid();
        const now = query.ts || new Date().toISOString();
        const appOrigin = String(process.env.PUBLIC_APP_URL || `${req.protocol}://${req.get("host") || "crm.breexe-pro.com"}`)
          .replace(/\/+$/, "");
        const session = upsertAttributionSession(options.database, {
          reference: query.reference,
          ownerUid,
          ttclid: query.ttclid,
          ttp: query.ttp,
          utmSource: query.utm_source,
          utmMedium: query.utm_medium,
          utmCampaign: query.utm_campaign,
          utmContent: query.utm_content,
          utmTerm: query.utm_term,
          landingPath: query.page,
          landingUrl: `${appOrigin}${query.page}`,
          clientIp: options.clientIp?.(req),
          userAgent: req.get("user-agent"),
          now,
          ttlDays: Number(process.env.TIKTOK_ATTRIBUTION_TTL_DAYS || 90),
        });
        enqueueAttributionEvent(options.database, {
          eventId: `wa-click:${session.reference}`,
          ownerUid,
          reference: session.reference,
          eventName: "ClickButton",
          source: "landing",
          contentName: "مكيفات",
          occurredAt: now,
        });
        res.redirect(302, publicWhatsAppUrl(phone, trackedMessage(query.message, session.reference)));
      } catch (error) {
        // Fail open for the customer's conversation but fail closed for
        // attribution: never put an unpersisted reference into the message.
        logError("tiktok.attribution.redirect_failed", error);
        res.redirect(302, publicWhatsAppUrl(phone, query.message));
      }
    },
  );

  app.post(
    "/api/track/event",
    options.rateLimit,
    validate(trackingEventSchema),
    (req: Request, res: Response) => {
      const event = req.body as AcceptedTrackingEvent;

      // Privacy-minimised acknowledgement. Attribution ids are accepted only
      // by the explicit-consent WhatsApp redirect above.
      options.onAccepted?.(event);
      res.setHeader("Cache-Control", "no-store");
      res.status(202).json({ accepted: true });
    },
  );
}
