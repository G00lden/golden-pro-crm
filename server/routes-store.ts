import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { appendFileSync } from "fs";
import path from "path";
import {
  processStoreWebhook,
  getStoreWebhookDiagnostics,
  getStoreOrderForUser,
  getStoreReconciliationForUser,
  classifyStoreOrderItem,
  assignStoreOrderTechnician,
  linkStoreOrderInstallation,
} from "./storeWebhook";
import { notifyTechnicianForBooking } from "./bookingNotifications";
import { requireFirebaseUser, type AuthedRequest } from "./auth";
import { validate, storeWebhookSchema } from "./validation";
import { storeOrderRealtimeListenerCount, subscribeStoreOrderChanges } from "./storeOrderRealtime";
import { getStoreOrderPageForUser, normalizeStoreOrderRemoteFields } from "./storeOrderQuery";
import {
  attachStorefrontOrderAttribution,
  issueStorefrontAttributionClaim,
  normalizeStorefrontAttributionClaim,
  normalizeStorefrontOrderAttribution,
  resolveStorefrontAttributionOwnerUid,
  storefrontAttributionOriginAllowed,
} from "./storefrontAttribution";

function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function logStoreWebhookAttempt(
  req: Request,
  outcome: { statusCode: number; accepted: boolean; error?: string; resultStatus?: string },
) {
  if (process.env.STORE_WEBHOOK_ATTEMPT_LOG === "false") return;

  const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
  const data = body.data && typeof body.data === "object" ? (body.data as Record<string, unknown>) : {};
  const order = (body.order || data.order || data) as Record<string, unknown>;
  const entry = {
    at: new Date().toISOString(),
    method: req.method,
    path: req.originalUrl,
    statusCode: outcome.statusCode,
    accepted: outcome.accepted,
    resultStatus: outcome.resultStatus || null,
    error: outcome.error || null,
    userAgent: req.get("user-agent") || "",
    contentLength: req.get("content-length") || "",
    hasSharedSecret: Boolean(req.get("x-golden-webhook-secret") || req.get("authorization")),
    hasGoldenSignature: Boolean(req.get("x-golden-signature")),
    hasSallaSignature: Boolean(req.get("x-salla-signature")),
    event: body.event || body.type || body.event_type || null,
    orderId: order?.id || order?.order_id || order?.reference || order?.number || null,
    bodyKeys: Object.keys(body).slice(0, 20),
  };

  try {
    appendFileSync(path.join(process.cwd(), ".store-webhook-attempts.log"), `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // Best-effort diagnostics only.
  }
}

export interface StoreRouteOptions {
  webhookRateLimit: (req: Request, res: Response, next: NextFunction) => void;
}

export function registerStoreRoutes(app: Express, options: StoreRouteOptions) {
  const { webhookRateLimit } = options;

  const allowStorefrontOrigin = (req: Request, res: Response, next: NextFunction) => {
    const origin = req.get("origin") || "";
    if (!storefrontAttributionOriginAllowed(origin)) {
      res.status(403).json({ error: "Storefront origin is not allowed." });
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    next();
  };

  app.options("/api/storefront/order-attribution", allowStorefrontOrigin, (_req, res) => {
    res.status(204).end();
  });

  app.options("/api/storefront/attribution-claim", allowStorefrontOrigin, (_req, res) => {
    res.status(204).end();
  });

  app.post(
    "/api/storefront/attribution-claim",
    webhookRateLimit,
    allowStorefrontOrigin,
    express.text({ type: "text/plain", limit: "16kb" }),
    asyncRoute(async (req, res) => {
      const ownerUid = resolveStorefrontAttributionOwnerUid();
      if (!ownerUid) {
        res.status(503).json({ error: "Storefront attribution is not configured." });
        return;
      }
      const input = normalizeStorefrontAttributionClaim(req.body);
      const result = await issueStorefrontAttributionClaim(ownerUid, input);
      res.setHeader("Cache-Control", "no-store");
      res.status(201).json(result);
    }),
  );

  app.post(
    "/api/storefront/order-attribution",
    webhookRateLimit,
    allowStorefrontOrigin,
    express.text({ type: "text/plain", limit: "16kb" }),
    asyncRoute(async (req, res) => {
      const ownerUid = resolveStorefrontAttributionOwnerUid();
      if (!ownerUid) {
        res.status(503).json({ error: "Storefront attribution is not configured." });
        return;
      }
      const input = normalizeStorefrontOrderAttribution(req.body);
      const result = await attachStorefrontOrderAttribution(ownerUid, input);
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json(result);
    }),
  );

  app.post(
    "/api/store/webhook",
    webhookRateLimit,
    validate(storeWebhookSchema),
    asyncRoute(async (req, res) => {
      try {
        const result = await processStoreWebhook(req as Request & { rawBody?: Buffer });
        const statusCode = result.duplicate ? 200 : 202;
        logStoreWebhookAttempt(req, {
          statusCode,
          accepted: true,
          resultStatus: result.duplicate ? "duplicate" : "accepted",
        });
        res.status(statusCode).json(result);
      } catch (error) {
        const err = error as Error & { status?: number };
        logStoreWebhookAttempt(req, {
          statusCode: err.status || 500,
          accepted: false,
          error: err.message || String(error),
        });
        throw error;
      }
    }),
  );

  app.get(
    "/api/store/webhook/diagnostics",
    requireFirebaseUser,
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      res.json(await getStoreWebhookDiagnostics(userReq.user.uid));
    }),
  );

  app.get(
    "/api/store/orders",
    requireFirebaseUser,
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      res.json(await getStoreOrderPageForUser(userReq.user.uid, req.query as Record<string, unknown>));
    }),
  );

  app.get(
    "/api/store/reconciliation",
    requireFirebaseUser,
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      res.json(await getStoreReconciliationForUser(userReq.user.uid, {
        from: String(req.query.from || "") || undefined,
        to: String(req.query.to || "") || undefined,
      }));
    }),
  );

  app.get(
    "/api/store/orders/events",
    requireFirebaseUser,
    (req, res) => {
      const userReq = req as AuthedRequest;
      if (storeOrderRealtimeListenerCount(userReq.user.uid) >= 20) {
        res.status(429).json({ error: "Too many live order streams are open for this account." });
        return;
      }
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();
      res.write(": connected\n\n");

      const unsubscribe = subscribeStoreOrderChanges(userReq.user.uid, (event) => {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      });
      const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 20_000);
      const close = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
      req.once("close", close);
      req.once("aborted", close);
    },
  );

  app.get(
    "/api/store/orders/:id",
    requireFirebaseUser,
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      res.json(normalizeStoreOrderRemoteFields(
        await getStoreOrderForUser(userReq.user.uid, req.params.id),
      ));
    }),
  );

  app.post(
    "/api/store/orders/:id/classify",
    requireFirebaseUser,
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      res.json(await classifyStoreOrderItem(userReq.user.uid, req.params.id, {
        itemSku: req.body?.itemSku,
        manualType: req.body?.manualType,
      }));
    }),
  );

  app.post(
    "/api/store/orders/:id/assign-technician",
    requireFirebaseUser,
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      const result = await assignStoreOrderTechnician(userReq.user.uid, req.params.id, {
        itemSku: req.body?.itemSku,
        technicianId: req.body?.technicianId,
        scheduledDate: req.body?.scheduledDate,
        scheduledTime: req.body?.scheduledTime,
      });

      let notification: unknown = null;
      if (req.body?.sendNow && result.booking_id) {
        notification = await notifyTechnicianForBooking(
          result.booking_id,
          userReq.user.uid,
          "created",
          req.body?.outboundCode,
        );
      }

      res.json({ ...result, notification });
    }),
  );

  app.post(
    "/api/store/orders/:id/link-installation",
    requireFirebaseUser,
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      res.json(await linkStoreOrderInstallation(
        userReq.user.uid,
        req.params.id,
        req.body?.installationId,
        req.body?.itemSku,
      ));
    }),
  );
}
