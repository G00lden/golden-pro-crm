import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import { logEvent } from "./logger";
import {
  capturePublicLeadRecord,
  projectPublicLeadToCrm,
  type PublicLeadDatabase,
} from "./publicLeadStorage";
import { publicLeadSchema, type PublicLeadInput, validate } from "./validation";

export type PublicLeadRouteOptions = {
  database: PublicLeadDatabase;
  rateLimit: RequestHandler;
  ownerUid?: () => string | null;
  idFactory?: () => string;
  now?: () => string;
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

export function publicLeadRateLimitOptions(env: NodeJS.ProcessEnv = process.env) {
  return {
    windowMs: boundedPositiveInteger(
      env.PUBLIC_LEAD_RATE_LIMIT_WINDOW_MS,
      15 * 60_000,
      1_000,
      24 * 60 * 60_000,
    ),
    max: boundedPositiveInteger(env.PUBLIC_LEAD_RATE_LIMIT_MAX, 10, 1, 1_000),
    name: "public-leads",
  };
}

export function resolvePublicLeadOwnerUid(env: NodeJS.ProcessEnv = process.env) {
  for (const name of [
    "PUBLIC_LEADS_OWNER_UID",
    "STORE_WEBHOOK_OWNER_UID",
    "SALLA_APP_OWNER_UID",
    "LOCAL_AUTH_SHARED_UID",
  ]) {
    const value = String(env[name] || "").trim();
    if (value) return value;
  }
  return null;
}

export function registerPublicLeadRoutes(app: Express, options: PublicLeadRouteOptions) {
  app.post(
    "/api/leads/public",
    options.rateLimit,
    validate(publicLeadSchema),
    (req: Request, res: Response, next: NextFunction) => {
      try {
        const input = req.body as PublicLeadInput;

        // A filled honeypot is acknowledged without storing anything. Returning a
        // normal 2xx keeps simple bots from learning how the trap works.
        if (input.website) {
          res.setHeader("Cache-Control", "no-store");
          res.status(202).json({ success: true });
          return;
        }

        const ownerUid = options.ownerUid?.() ?? resolvePublicLeadOwnerUid();
        if (!ownerUid) {
          res.setHeader("Cache-Control", "no-store");
          res.status(503).json({ error: "Public lead intake is not configured." });
          return;
        }
        const requestId = String((req as Request & { requestId?: string }).requestId || "").trim() || null;
        const captured = capturePublicLeadRecord(options.database, input, {
          ownerUid,
          requestId,
          idFactory: options.idFactory,
          now: options.now,
        });
        const projection = projectPublicLeadToCrm(options.database, captured.lead.id, {
          ownerUid,
          now: options.now,
        });

        logEvent(projection.error ? "error" : "info", projection.error ? "public_lead.projection_failed" : "public_lead.accepted", {
          leadId: captured.lead.id,
          source: captured.lead.source,
          duplicate: captured.duplicate,
          projectionStatus: projection.projection.status,
          projectionError: projection.error,
          requestId,
        });
        res.setHeader("Cache-Control", "no-store");
        res.status(captured.duplicate ? 200 : 201).json({
          success: true,
          lead_id: captured.lead.id,
          received_at: captured.lead.created_at,
        });
      } catch (error) {
        next(error);
      }
    },
  );
}
