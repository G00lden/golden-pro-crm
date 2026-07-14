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
  gatewayDeviceParamsSchema,
  gatewayPairSchema,
} from "./validation";
import { logError } from "./logger";
import {
  activeGatewayDeviceCount,
  createGatewayPairingCode,
  gatewayDeviceAuthConfigured,
  listGatewayDevices,
  redeemGatewayPairingCode,
  revokeGatewayDevice,
  verifyGatewayDeviceToken,
} from "./gatewayPairing";

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

function verifyGatewayToken(req: Request, ownerUid: string): { status: number; error: string } | null {
  const legacyToken = process.env.GATEWAY_TOKEN || "";
  if (!legacyToken && !gatewayDeviceAuthConfigured()) {
    return { status: 503, error: "Gateway credential signing is not configured." };
  }
  const provided =
    req.get("x-gateway-token") ||
    (typeof req.query.token === "string" ? req.query.token : "") ||
    "";
  if (provided && legacyToken && safeEquals(provided, legacyToken)) return null;
  if (provided && verifyGatewayDeviceToken(ownerUid, provided)) return null;
  return { status: 401, error: "Invalid or missing gateway token." };
}

function requireGatewayToken(gatewayOwnerUid: () => string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const rejection = verifyGatewayToken(req, gatewayOwnerUid());
    if (rejection) {
      res.status(rejection.status).json({ error: rejection.error });
      return;
    }
    next();
  };
}

export interface GatewayRouteOptions {
  webhookRateLimit: (req: Request, res: Response, next: NextFunction) => void;
  pairingRateLimit: (req: Request, res: Response, next: NextFunction) => void;
  gatewayOwnerUid: () => string;
}

export function registerGatewayWebhookRoutes(app: Express, options: GatewayRouteOptions) {
  const { webhookRateLimit, pairingRateLimit, gatewayOwnerUid } = options;
  const requireDevice = requireGatewayToken(gatewayOwnerUid);

  app.post(
    "/api/gateway/pair",
    pairingRateLimit,
    validate(gatewayPairSchema),
    (req, res) => {
      const body = (req.body || {}) as { code: string; deviceName: string; companyNumber?: string; clientNonce: string };
      const paired = redeemGatewayPairingCode({
        code: body.code,
        deviceName: body.deviceName,
        companyNumber: body.companyNumber,
        clientNonce: body.clientNonce,
      });
      if (!paired) {
        res.status(400).json({ error: "رمز الربط غير صحيح أو منتهي الصلاحية. أنشئ رمزًا جديدًا من CRM." });
        return;
      }
      res.status(201).json({
        paired: true,
        token: paired.token,
        deviceId: paired.deviceId,
      });
    },
  );

  app.post(
    "/api/gateway/event",
    webhookRateLimit,
    requireDevice,
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
    requireDevice,
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
    requireDevice,
    (_req, res) => {
      res.json(getNextPendingSms(gatewayOwnerUid(), _req.get("x-gateway-device-id") || "next"));
    },
  );

  app.post(
    "/api/gateway/outbox/ack",
    webhookRateLimit,
    requireDevice,
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
      configured: Boolean(process.env.GATEWAY_TOKEN) || gatewayDeviceAuthConfigured(),
      registered_devices: activeGatewayDeviceCount(owner),
      routing_mode: routingMode(),
      pending: listPendingSms(owner, 100).length,
      recent: listRecentOutbox(owner, 50),
    });
  });

  app.post("/api/gateway/pairing-code", requireAdmin, (req, res) => {
    try {
      const user = (req as AuthedRequest).user;
      const result = createGatewayPairingCode(gatewayOwnerUid(), user.uid);
      res.status(201).json(result);
    } catch (error) {
      logError("gateway.pairing_code.failed", error);
      res.status(503).json({ error: "تعذر إنشاء رمز الربط. تأكد من إعداد سر البوابة على الخادم." });
    }
  });

  app.get("/api/gateway/devices", requireAdmin, (_req, res) => {
    res.json({ devices: listGatewayDevices(gatewayOwnerUid()) });
  });

  app.post("/api/gateway/devices/:id/revoke", requireAdmin, (req, res) => {
    const parsed = gatewayDeviceParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: "معرف جهاز البوابة غير صالح." });
      return;
    }
    const revoked = revokeGatewayDevice(gatewayOwnerUid(), parsed.data.id);
    if (!revoked) {
      res.status(404).json({ error: "الجهاز غير موجود أو تم إلغاؤه مسبقًا." });
      return;
    }
    res.json({ success: true });
  });
}
