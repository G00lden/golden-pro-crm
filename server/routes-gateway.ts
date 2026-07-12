/**
 * Self-hosted phone gateway routes.
 *
 * Called by the user's Android automation app (no Firebase auth — it uses a
 * static GATEWAY_TOKEN). Registered BEFORE the /api Firebase guard.
 *
 *   POST /api/gateway/event        — report a call/SMS event → routing
 *   GET  /api/gateway/outbox       — fetch queued SMS to send from the SIM
 *   POST /api/gateway/outbox/ack   — mark SMS as sent (or failed)
 *
 * Admin (after auth):
 *   GET  /api/gateway/status       — token configured? routing mode? recent log
 */
import crypto from "crypto";
import type { Express, NextFunction, Request, Response } from "express";
import type { AuthedRequest } from "./auth";
import {
  ackSms,
  claimPendingSms,
  getNextPendingSms,
  handleGatewayEvent,
  listPendingSms,
  listRecentOutbox,
  routingMode,
} from "./gateway";
import {
  validate,
  validateQuery,
  gatewayEventSchema,
  gatewayOutboxQuerySchema,
  gatewayAckSchema,
} from "./validation";
import { logError } from "./logger";

function asyncRoute(handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function verifyGatewayToken(req: Request): { status: number; error: string } | null {
  const token = process.env.GATEWAY_TOKEN || "";
  if (!token) {
    return { status: 503, error: "GATEWAY_TOKEN is not configured." };
  }
  const provided =
    req.get("x-gateway-token") ||
    (typeof req.query.token === "string" ? req.query.token : "") ||
    "";
  if (provided && safeEquals(provided, token)) return null;
  return { status: 401, error: "Invalid or missing gateway token." };
}

function requireGatewayToken(req: Request, res: Response, next: NextFunction) {
  const rejection = verifyGatewayToken(req);
  if (rejection) {
    res.status(rejection.status).json({ error: rejection.error });
    return;
  }
  next();
}

export interface GatewayRouteOptions {
  webhookRateLimit: (req: Request, res: Response, next: NextFunction) => void;
  gatewayOwnerUid: () => string;
}

export function registerGatewayWebhookRoutes(app: Express, options: GatewayRouteOptions) {
  const { webhookRateLimit, gatewayOwnerUid } = options;

  app.post(
    "/api/gateway/event",
    webhookRateLimit,
    requireGatewayToken,
    validate(gatewayEventSchema),
    asyncRoute(async (req, res) => {
      try {
        const result = await handleGatewayEvent(gatewayOwnerUid(), req.body || {});
        // Include any freshly-queued SMS so a response-driven automation can
        // also send immediately; polling /outbox remains the canonical path.
        const pending = claimPendingSms(gatewayOwnerUid(), 20, req.get("x-gateway-device-id") || "event-response");
        res.status(200).json({ received: true, ...result, outbox: pending });
      } catch (error) {
        logError("gateway.event.handler_failed", error);
        res.status(200).json({ received: false });
      }
    }),
  );

  app.get(
    "/api/gateway/outbox",
    webhookRateLimit,
    requireGatewayToken,
    validateQuery(gatewayOutboxQuerySchema),
    (req, res) => {
      const limit = Number(req.query.limit ?? 20);
      res.json({ messages: claimPendingSms(gatewayOwnerUid(), limit, req.get("x-gateway-device-id") || "poll") });
    },
  );

  // MacroDroid-friendly: one flat pending SMS (no array to iterate).
  // Returns { has:false } when the queue is empty.
  app.get(
    "/api/gateway/next",
    webhookRateLimit,
    requireGatewayToken,
    (_req, res) => {
      res.json(getNextPendingSms(gatewayOwnerUid(), _req.get("x-gateway-device-id") || "next"));
    },
  );

  app.post(
    "/api/gateway/outbox/ack",
    webhookRateLimit,
    requireGatewayToken,
    validate(gatewayAckSchema),
    (req, res) => {
      const body = (req.body || {}) as { ids?: string[]; failed?: string[] };
      const acked = ackSms(gatewayOwnerUid(), body.ids || [], body.failed || []);
      res.json({ success: true, acked });
    },
  );
}

export function registerGatewayRoutes(app: Express, options: GatewayRouteOptions) {
  const { gatewayOwnerUid } = options;

  function requireAdmin(req: Request, res: Response, next: NextFunction) {
    const user = (req as AuthedRequest).user;
    if (!user?.uid) {
      res.status(401).json({ error: "Authentication required." });
      return;
    }
    if (user.role === "admin" || user.role === "manager") return next();
    res.status(403).json({ error: "صلاحيات المسؤول مطلوبة." });
  }

  app.get("/api/gateway/status", requireAdmin, (_req, res) => {
    const owner = gatewayOwnerUid();
    res.json({
      configured: Boolean(process.env.GATEWAY_TOKEN),
      routing_mode: routingMode(),
      pending: listPendingSms(owner, 100).length,
      recent: listRecentOutbox(owner, 50),
    });
  });
}
