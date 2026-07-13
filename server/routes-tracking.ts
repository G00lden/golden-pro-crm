import type { Express, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import { validate } from "./validation";

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
  /** Test/adapter seam. Production intentionally supplies no storage adapter. */
  onAccepted?: (event: AcceptedTrackingEvent) => void;
};

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
  app.post(
    "/api/track/event",
    options.rateLimit,
    validate(trackingEventSchema),
    (req: Request, res: Response) => {
      const event = req.body as AcceptedTrackingEvent;

      // Privacy-safe no-op by design: the endpoint removes the old 404 and
      // validates traffic, but does not persist, forward, or log event payloads
      // until a consent-aware analytics adapter is configured explicitly.
      options.onAccepted?.(event);
      res.setHeader("Cache-Control", "no-store");
      res.status(202).json({ accepted: true });
    },
  );
}
