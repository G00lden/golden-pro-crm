import dotenv from "dotenv";
import express, { type NextFunction, type Request, type Response } from "express";
import { appendFileSync } from "fs";
import cron from "node-cron";
import path from "path";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";
import { type AuthedRequest, requireFirebaseUser } from "./server/auth";
import { completeBooking } from "./server/bookingLifecycle";
import { registerCrmApiRoutes } from "./server/crmApi";
import { registerUserAdminRoutes, repairLocalDevAdminRoles } from "./server/userManagement";
import { adminDb } from "./server/firebaseAdmin";
import { outboundSafetyStatus, runWithOutboundCode } from "./server/outboundSafety";
import {
  getReminderDiagnostics,
  getReminderSchedulerState,
  runDueReminders,
  sendReminderForInstallation,
  todayInTimeZone,
} from "./server/reminderEngine";
import {
  assignStoreOrderTechnician,
  classifyStoreOrderItem,
  getStoreOrderForUser,
  getStoreOrdersForUser,
  getStoreWebhookDiagnostics,
  getStoreWebhookPublicState,
  linkStoreOrderInstallation,
  processStoreWebhook,
} from "./server/storeWebhook";
import {
  getSallaConnectUrl,
  getSallaStatus,
  handleSallaAppWebhook,
  handleSallaCallback,
  syncAllLinkedSallaIntegrations,
  syncSallaStoreForUser,
} from "./server/salla";
import {
  getConversation as getWhatsAppConversation,
  listRecentMessages as listRecentWhatsAppMessages,
  parseConfirmation,
  recordWhatsAppMessage,
  sendWhatsAppTemplate,
  updateWhatsAppStatus,
  whatsAppStats,
  whatsappService,
} from "./server/whatsapp";
import { listTemplateNames, renderTemplate, type TemplateName } from "./server/whatsappTemplates";
import {
  cancelMaintenance,
  completeMaintenance,
  createMaintenance,
  getCustomerScore,
  getMaintenanceTimeline,
  getOverdueList,
  getUpcomingList,
  recordCustomerConfirmation,
  rescheduleMaintenance,
} from "./server/maintenanceLifecycle";
import {
  assignEscalation,
  escalationStats,
  getEscalation,
  listEscalations,
  resolveEscalation,
} from "./server/escalationEngine";
import { handleWebhook as handleWhatsAppWebhook, verifyWebhook as verifyWhatsAppWebhook } from "./server/whatsappWebhook";
import { notifyTechnicianForBooking, sendTechnicianPreAlerts } from "./server/bookingNotifications";

dotenv.config({ path: process.env.ENV_FILE || ".env" });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const timeZone = process.env.APP_TIMEZONE || "Asia/Riyadh";

function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function httpError(status: number, message: string) {
  const err = new Error(message) as Error & { status?: number };
  err.status = status;
  return err;
}

// Security (C2): the WhatsApp session is a single shared business channel.
// Only explicitly-allowlisted operator/admin UIDs may connect, read the
// pairing QR, disconnect, or send. Other authenticated tenants are denied.
function adminUids(): string[] {
  return String(process.env.ADMIN_UIDS || process.env.STORE_WEBHOOK_OWNER_UID || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const allow = adminUids();
  const user = (req as AuthedRequest).user;
  if (!user?.uid) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  // Pass if the user holds the admin role in the local users table OR is on
  // the explicit ADMIN_UIDS allowlist (legacy single-operator deployments).
  if (user.role === "admin") {
    next();
    return;
  }
  if (allow.length === 0 || allow.includes(user.uid)) {
    next();
    return;
  }
  res.status(403).json({ error: "Administrator privileges are required for this action." });
}

function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  if (process.env.ENABLE_SECURITY_HEADERS === "false") {
    next();
    return;
  }

  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

  if (process.env.NODE_ENV === "production") {
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "img-src 'self' data: https:",
        "style-src 'self' 'unsafe-inline'",
        // Security (H4): no 'unsafe-inline' for scripts — Vite emits hashed
        // bundle files, so 'self' is sufficient and inline-script XSS is blocked.
        "script-src 'self' https://www.gstatic.com https://apis.google.com",
        "connect-src 'self' https://*.supabase.co https://*.googleapis.com https://www.googleapis.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://firestore.googleapis.com",
        "frame-src 'self' https://accounts.google.com https://*.firebaseapp.com",
        "form-action 'self'",
      ].join("; "),
    );
  }

  next();
}

function clientIp(req: Request) {
  return String(
    req.get("cf-connecting-ip") ||
      req.get("x-real-ip") ||
      req.get("x-forwarded-for")?.split(",")[0] ||
      req.socket.remoteAddress ||
      "unknown",
  ).trim();
}

function createRateLimiter(options: { windowMs: number; max: number; name: string }) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  // Security (H6): evict expired buckets so the Map cannot grow unbounded
  // (memory-exhaustion DoS) when keyed by spoofable client IPs.
  function prune(now: number) {
    if (hits.size < 5000) return;
    for (const [key, bucket] of hits) {
      if (bucket.resetAt <= now) hits.delete(key);
    }
  }

  return (req: Request, res: Response, next: NextFunction) => {
    if (process.env.DISABLE_RATE_LIMIT === "true") {
      next();
      return;
    }

    const now = Date.now();
    prune(now);
    const key = `${options.name}:${clientIp(req)}`;
    const current = hits.get(key);
    const bucket = current && current.resetAt > now
      ? current
      : { count: 0, resetAt: now + options.windowMs };

    bucket.count += 1;
    hits.set(key, bucket);

    res.setHeader("RateLimit-Limit", String(options.max));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, options.max - bucket.count)));
    res.setHeader("RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > options.max) {
      res.status(429).json({ error: "Too many requests. Please try again shortly." });
      return;
    }

    next();
  };
}

async function ownedCount(collection: string, uid: string, configure?: (ref: any) => any) {
  try {
    const baseRef = adminDb.collection(collection).where("createdBy", "==", uid);
    const ref = configure ? configure(baseRef) : baseRef;
    const snap = await ref.limit(500).get();
    return { count: snap.docs.length, error: null as string | null };
  } catch (error) {
    return {
      count: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
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

async function startServer() {
  // Security (C3): the local-dev auth bypass forges identities with zero
  // verification. It must NEVER be active in production — fail closed.
  // Exception: SQLite mode requires local auth since Firebase is unavailable.
  const dbProvider = process.env.DATA_PROVIDER || process.env.DB_PROVIDER || "firebase";
  if (process.env.NODE_ENV === "production" && dbProvider !== "sqlite" && process.env.ALLOW_LOCAL_AUTH === "true") {
    throw new Error(
      "ALLOW_LOCAL_AUTH=true is forbidden in production. Unset it before deploying.",
    );
  }
  repairLocalDevAdminRoles();

  const app = express();
  const port = Number(process.env.PORT || 3000);
  const apiRateLimit = createRateLimiter({
    windowMs: Number(process.env.API_RATE_LIMIT_WINDOW_MS || 60_000),
    max: Number(process.env.API_RATE_LIMIT_MAX || 240),
    name: "api",
  });
  const webhookRateLimit = createRateLimiter({
    windowMs: Number(process.env.WEBHOOK_RATE_LIMIT_WINDOW_MS || 60_000),
    max: Number(process.env.WEBHOOK_RATE_LIMIT_MAX || 120),
    name: "webhook",
  });

  app.disable("x-powered-by");
  app.use(securityHeaders);

  app.use(express.json({
    limit: "2mb",
    verify: (req, _res, buf) => {
      (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
    },
  }));

  app.use((req, _res, next) => {
    const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
    const code = String(
      req.get("x-outbound-code") ||
        body.outboundCode ||
        body.confirmationCode ||
        body.sendCode ||
        "",
    ).trim() || undefined;
    runWithOutboundCode(code, next);
  });

  app.use(
    [
      "/api/store/webhook",
      "/api/integrations/salla/webhook",
      // Security (H7): throttle the unauthenticated OAuth callback paths too —
      // each triggers an outbound token exchange and must not be abusable for
      // amplification/DoS.
      "/api/integrations/salla/callback",
      "/salla/callback",
      "/salla/webhook",
      "/api/whatsapp/webhook",
      "/api/health",
    ],
    webhookRateLimit,
  );

  app.get("/api/health", (_req, res) => {
    res.json({
      status: "ok",
      timeZone,
      today: todayInTimeZone(),
      reminders: getReminderSchedulerState(),
      storeWebhook: getStoreWebhookPublicState(),
      outbound: outboundSafetyStatus(),
    });
  });

  app.post(
    "/api/store/webhook",
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
    "/api/integrations/salla/callback",
    asyncRoute(async (req, res) => {
      const result = await handleSallaCallback(req);
      res.status(result.status).type("html").send(result.html);
    }),
  );

  app.post(
    "/api/integrations/salla/webhook",
    asyncRoute(async (req, res) => {
      res.json(await handleSallaAppWebhook(req as Request & { rawBody?: Buffer }));
    }),
  );

  app.get(
    "/salla/callback",
    asyncRoute(async (req, res) => {
      const result = await handleSallaCallback(req);
      res.status(result.status).type("html").send(result.html);
    }),
  );

  app.post(
    ["/salla/callback", "/salla/webhook"],
    asyncRoute(async (req, res) => {
      res.json(await handleSallaAppWebhook(req as Request & { rawBody?: Buffer }));
    }),
  );

  // WhatsApp Cloud API webhook (works for direct Meta callbacks AND Kapso.ai
  // forwarded webhooks). GET handles Meta's hub.challenge verification handshake;
  // POST receives message status callbacks and incoming user messages.
  app.get("/api/whatsapp/webhook", (req, res) => verifyWhatsAppWebhook(req, res));

  const __whatsappOwnerUid = () =>
    adminUids()[0] || process.env.STORE_WEBHOOK_OWNER_UID || process.env.LOCAL_AUTH_SHARED_UID || "local-dev-owner";

  app.post(
    "/api/whatsapp/webhook",
    asyncRoute(async (req, res) => {
      await handleWhatsAppWebhook(req, res, { ownerUid: __whatsappOwnerUid() });
    }),
  );

  // Legacy inline body retained below for the qa-suite scenario that posts to
  // /api/whatsapp/webhook with the old shape. The new module above already
  // ACKs the request, so the catch-all below never executes on a real call.
  app.post(
    "/api/whatsapp/webhook-legacy",
    webhookRateLimit,
    asyncRoute(async (req, res) => {
      const body = (req.body || {}) as Record<string, unknown>;
      try {
        const entries = Array.isArray(body.entry) ? (body.entry as any[]) : [];
        const summary: Array<Record<string, unknown>> = [];
        const adminUid = adminUids()[0] || process.env.STORE_WEBHOOK_OWNER_UID || "local-dev-owner";

        for (const entry of entries) {
          const changes = Array.isArray(entry?.changes) ? entry.changes : [];
          for (const change of changes) {
            const value = change?.value || {};
            const messages = Array.isArray(value.messages) ? value.messages : [];
            const statuses = Array.isArray(value.statuses) ? value.statuses : [];

            for (const message of messages) {
              const text = message?.text?.body || "";
              // Persist inbound message for the conversation viewer.
              recordWhatsAppMessage({
                type: "received",
                provider: "cloud_api",
                direction: "inbound",
                from_phone: message?.from,
                to_phone: value?.metadata?.phone_number_id || null,
                message: text,
                message_id: message?.id,
                status: "delivered",
                owner_uid: adminUid,
                metadata: { wa_type: message?.type, timestamp: message?.timestamp },
              });
              // Confirmation parsing: if customer replied with نعم/تمام etc.,
              // stop further reminders for that installation.
              const matched = parseConfirmation(text);
              if (matched) {
                try {
                  const result = recordCustomerConfirmation(adminUid, String(message?.from || ""), text);
                  summary.push({ kind: "confirmation", phone: message?.from, matched_keyword: matched, ...result });
                } catch (confErr) {
                  console.error("[wa-webhook] confirmation save failed:", confErr);
                }
              }
              summary.push({
                kind: "message",
                from: message?.from,
                type: message?.type,
                text,
                wa_id: message?.id,
                timestamp: message?.timestamp,
              });
            }

            for (const status of statuses) {
              const messageId = String(status?.id || "");
              const updated = messageId
                ? updateWhatsAppStatus(messageId, String(status?.status || "unknown"), {
                    recipient_id: status?.recipient_id,
                    timestamp: status?.timestamp,
                  })
                : false;
              if (!updated && messageId) {
                // Status arrived for an unknown wam_id (e.g. message sent outside
                // this CRM). Log the receipt so /conversations still surfaces it.
                recordWhatsAppMessage({
                  type: "status",
                  provider: "cloud_api",
                  direction: "outbound",
                  to_phone: status?.recipient_id,
                  message_id: messageId,
                  status: String(status?.status || "unknown"),
                  owner_uid: adminUid,
                  metadata: { timestamp: status?.timestamp },
                });
              }
              summary.push({
                kind: "status",
                wa_id: messageId,
                recipient_id: status?.recipient_id,
                status: status?.status,
                timestamp: status?.timestamp,
                updated,
              });
            }
          }
        }

        if (summary.length > 0) {
          const line = `${new Date().toISOString()} ${JSON.stringify(summary)}\n`;
          appendFileSync(path.join(process.cwd(), ".whatsapp-webhook.log"), line, "utf8");
          console.log("[wa-webhook]", JSON.stringify(summary));
        }
        // Meta requires a quick 200; we always ACK even for unexpected shapes
        // so the platform does not back off and pause delivery.
        res.status(200).json({ received: true, events: summary.length });
      } catch (error) {
        console.error("[wa-webhook] handler failed:", error);
        res.status(200).json({ received: false });
      }
    }),
  );

  app.use("/api", apiRateLimit, requireFirebaseUser);

  registerUserAdminRoutes(app);
  registerCrmApiRoutes(app);

  // ============================================================
  // Admin escalation queue
  // ============================================================
  app.get(
    "/api/escalations",
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      const status = typeof req.query.status === "string" ? (req.query.status as any) : "active";
      const ownerUid = userReq.user.role === "admin" ? undefined : userReq.user.uid;
      const limit = Math.min(500, Number(req.query.limit ?? 100) || 100);
      const items = listEscalations({ ownerUid, status, limit });
      res.json({ count: items.length, status, items });
    }),
  );

  app.get(
    "/api/escalations/stats",
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      const ownerUid = userReq.user.role === "admin" ? undefined : userReq.user.uid;
      res.json(escalationStats(ownerUid));
    }),
  );

  app.get(
    "/api/escalations/:id",
    asyncRoute(async (req, res) => {
      const item = getEscalation(req.params.id);
      if (!item) throw httpError(404, "Escalation not found.");
      res.json(item);
    }),
  );

  app.post(
    "/api/escalations/:id/resolve",
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      const updated = resolveEscalation(req.params.id, userReq.user.uid, req.body?.notes);
      if (!updated) throw httpError(404, "Escalation not found.");
      res.json(updated);
    }),
  );

  app.post(
    "/api/escalations/:id/assign",
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      if (!req.body?.assigned_to) throw httpError(400, "assigned_to is required.");
      const updated = assignEscalation(req.params.id, String(req.body.assigned_to), userReq.user.uid, req.body?.notes);
      if (!updated) throw httpError(404, "Escalation not found.");
      res.json(updated);
    }),
  );

  app.post(
    "/api/bookings/pre-alerts/run",
    asyncRoute(async (_req, res) => {
      res.json(await sendTechnicianPreAlerts());
    }),
  );

  app.get("/api/whatsapp/status", requireAdmin, (_req, res) => {
    res.json(whatsappService.getStatus());
  });

  app.post(
    "/api/whatsapp/connect",
    requireAdmin,
    asyncRoute(async (_req, res) => {
      res.json(await whatsappService.connect());
    }),
  );

  app.get("/api/whatsapp/qr", requireAdmin, (_req, res) => {
    const status = whatsappService.getStatus();
    if (!status.qr) return res.status(404).json({ error: "لا يوجد QR جاهز حاليا." });
    return res.json({ qr: status.qr });
  });

  app.post(
    "/api/whatsapp/disconnect",
    requireAdmin,
    asyncRoute(async (_req, res) => {
      res.json(await whatsappService.disconnect());
    }),
  );

  app.post(
    "/api/whatsapp/send-test",
    requireAdmin,
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      const { phone, message, metadata } = req.body || {};
      if (!phone) throw httpError(400, "رقم الجوال مطلوب.");

      try {
        const body = message || "رسالة اختبار من نظام Breexe Pro CRM";
        const result = await whatsappService.sendText(
          phone,
          body,
        );
        recordWhatsAppMessage({
          type: "sent",
          provider: whatsappService.getStatus().provider,
          direction: "outbound",
          to_phone: phone,
          message: body,
          message_id: (result as { messageId?: string | null })?.messageId || null,
          status: (result as { dryRun?: boolean })?.dryRun ? "dry_run" : "sent",
          owner_uid: userReq.user.uid,
          metadata: metadata && typeof metadata === "object" ? metadata : { kind: "manual" },
        });
        res.json({ success: true, result });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        // Surface predictable config / connectivity errors as 503 (Service
        // Unavailable) instead of 500 so dashboards can show "not configured"
        // without alarming. Genuine server errors still bubble up as 500.
        if (msg.includes("credentials are missing") || msg.includes("is not connected")) {
          throw httpError(503, msg);
        }
        throw error;
      }
    }),
  );

  app.get(
    "/api/integrations/salla/status",
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      res.json(await getSallaStatus(userReq.user.uid, req));
    }),
  );

  app.get(
    "/api/integrations/salla/orders",
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      const uid = userReq.user.uid;
      const [status, orders] = await Promise.all([
        getSallaStatus(uid, req),
        getStoreOrdersForUser(uid, String(req.query.type || "all")),
      ]);
      const list = Array.isArray(orders) ? orders : (orders as { orders?: unknown[] }).orders ?? orders;
      const arr = Array.isArray(list) ? list : [];
      res.json({
        provider: "salla",
        linked: (status as { linked?: boolean }).linked || false,
        last_sync_at: (status as { last_sync_at?: string | null }).last_sync_at || null,
        last_sync_status: (status as { last_sync_status?: string | null }).last_sync_status || null,
        last_sync_count: (status as { last_sync_count?: number }).last_sync_count ?? null,
        last_sync_error: (status as { last_sync_error?: string | null }).last_sync_error || null,
        sync_enabled: (status as { sync_enabled?: boolean }).sync_enabled ?? false,
        sync_schedule: (status as { sync_schedule?: string }).sync_schedule ?? null,
        total: arr.length,
        orders: arr,
      });
    }),
  );

  app.get(
    "/api/integrations/salla/products",
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      const uid = userReq.user.uid;
      // Surface Salla-sourced product mappings: rows in CRM products whose
      // store_product_id is set, plus a count of orders referencing each.
      const products = await adminDb
        .collection("products")
        .where("createdBy", "==", uid)
        .limit(500)
        .get();
      const orders = await adminDb
        .collection("store_orders")
        .where("createdBy", "==", uid)
        .limit(500)
        .get();

      const usageBySku = new Map<string, number>();
      for (const doc of orders.docs) {
        const data = doc.data() as { items?: Array<{ sku?: string }> };
        const items = Array.isArray(data.items) ? data.items : [];
        for (const item of items) {
          if (item?.sku) usageBySku.set(item.sku, (usageBySku.get(item.sku) || 0) + 1);
        }
      }

      const mapped = products.docs.map((doc) => {
        const data = doc.data() as Record<string, unknown>;
        const sku = (data.sku as string) || "";
        return {
          id: doc.id,
          name: (data.name as string) || "",
          sku,
          category: (data.category as string) || "",
          source: (data.source as string) || "manual",
          store_provider: (data.store_provider as string) || null,
          store_product_id: (data.store_product_id as string) || null,
          mapped_to_salla: ((data.source as string) === "salla") || Boolean(data.store_product_id),
          order_usage_count: sku ? usageBySku.get(sku) ?? 0 : 0,
        };
      });

      res.json({
        provider: "salla",
        total: mapped.length,
        mapped_count: mapped.filter((p) => p.mapped_to_salla).length,
        products: mapped,
      });
    }),
  );

  app.get(
    "/api/integrations/salla/connect",
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      try {
        res.json(await getSallaConnectUrl(userReq.user.uid, req));
      } catch (error) {
        // Easy-Mode apps refuse a direct connect call and tell the merchant to
        // approve the install from Salla Partners. Convert to 409 (Conflict)
        // so the UI can show actionable guidance instead of a generic 500.
        const message = error instanceof Error ? error.message : String(error);
        throw httpError(409, message);
      }
    }),
  );

  app.post(
    "/api/integrations/salla/sync",
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      try {
        res.json(await syncSallaStoreForUser(userReq.user.uid));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("not linked") || message.includes("token")) {
          throw httpError(412, message);
        }
        throw error;
      }
    }),
  );

  app.post(
    "/api/operations/prepare-daily",
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      const uid = userReq.user.uid;
      const syncRequested = Boolean(req.body?.syncSalla);
      const [salla, technicians, storeOrders, needsReview, awaitingSchedule, todayBookings] = await Promise.all([
        getSallaStatus(uid, req),
        ownedCount("technicians", uid),
        ownedCount("store_orders", uid),
        ownedCount("store_orders", uid, (ref) => ref.where("journey_status", "==", "needs_review")),
        ownedCount("store_orders", uid, (ref) => ref.where("journey_status", "==", "awaiting_schedule")),
        ownedCount("bookings", uid, (ref) => ref.where("date", "==", todayInTimeZone())),
      ]);

      let sync: unknown = null;
      if (syncRequested && (salla as any).linked) {
        try {
          sync = await syncSallaStoreForUser(uid);
        } catch (error) {
          sync = {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }

      const whatsapp = whatsappService.getStatus();
      const storageErrors = [
        technicians.error,
        storeOrders.error,
        needsReview.error,
        awaitingSchedule.error,
        todayBookings.error,
      ].filter(Boolean);

      res.json({
        success: true,
        prepared_at: new Date().toISOString(),
        sync,
        summary: {
          technicians: technicians.count,
          storeOrders: storeOrders.count,
          needsReview: needsReview.count,
          awaitingSchedule: awaitingSchedule.count,
          todayBookings: todayBookings.count,
        },
        checks: [
          {
            id: "salla",
            ok: Boolean((salla as any).linked),
            label: "ربط سلة",
            detail: (salla as any).linked ? `مرتبط: ${(salla as any).store_name || "متجر سلة"}` : "اربط تطبيق سلة أو راجع حالة التكامل.",
          },
          {
            id: "technicians",
            ok: technicians.count > 0,
            label: "ملف الفنيين",
            detail: technicians.count > 0 ? `${technicians.count} فني جاهز للتحويل.` : "أضف فني واحد على الأقل مع رقم الجوال.",
          },
          {
            id: "messaging",
            ok: whatsapp.status === "connected" || process.env.WHATSAPP_PROVIDER === "cloud_api",
            label: "قناة الرسائل",
            detail:
              whatsapp.status === "connected"
                ? "واتساب ويب متصل."
                : process.env.WHATSAPP_PROVIDER === "cloud_api"
                  ? "WhatsApp Cloud API محدد كقناة الإنتاج."
                  : "اربط واتساب ويب أو فعّل WhatsApp Cloud API قبل التشغيل التجاري.",
          },
          {
            id: "review_queue",
            ok: needsReview.count === 0,
            label: "طلبات تحتاج مراجعة",
            detail: needsReview.count ? `${needsReview.count} طلب يحتاج تصنيف أو ربط يدوي.` : "لا توجد طلبات عالقة للمراجعة.",
          },
          {
            id: "schedule_queue",
            ok: awaitingSchedule.count === 0,
            label: "طلبات بانتظار الجدولة",
            detail: awaitingSchedule.count ? `${awaitingSchedule.count} طلب يحتاج موعد وفني.` : "لا توجد طلبات بانتظار الجدولة.",
          },
          {
            id: "storage",
            ok: storageErrors.length === 0,
            label: "قاعدة البيانات",
            detail: storageErrors.length ? storageErrors[0] : "قراءة الجداول الأساسية نجحت.",
          },
        ],
      });
    }),
  );

  app.get(
    "/api/reminders/diagnostics",
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      res.json(await getReminderDiagnostics(userReq.user.uid));
    }),
  );

  app.get("/api/reminders/scheduler", (_req, res) => {
    res.json(getReminderSchedulerState());
  });

  app.get(
    "/api/store/webhook/diagnostics",
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      res.json(await getStoreWebhookDiagnostics(userReq.user.uid));
    }),
  );

  app.get(
    "/api/store/orders",
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      res.json(await getStoreOrdersForUser(userReq.user.uid, String(req.query.type || "all")));
    }),
  );

  app.get(
    "/api/store/orders/:id",
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      res.json(await getStoreOrderForUser(userReq.user.uid, req.params.id));
    }),
  );

  app.post(
    "/api/store/orders/:id/classify",
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
        notification = await notifyTechnicianForBooking(result.booking_id, userReq.user.uid, "created");
      }

      res.json({ ...result, notification });
    }),
  );

  app.post(
    "/api/store/orders/:id/link-installation",
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

  app.post(
    "/api/installations/:id/remind",
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      const result = await sendReminderForInstallation(
        req.params.id,
        userReq.user.uid,
        req.body?.type,
        "manual",
      );
      res.json(result);
    }),
  );

  app.post(
    "/api/reminders/run-due",
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      res.json(await runDueReminders({ uid: userReq.user.uid, mode: req.body?.mode || "manual" }));
    }),
  );

  app.post(
    "/api/bookings/:id/notify-technician",
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      res.json(await notifyTechnicianForBooking(req.params.id, userReq.user.uid, req.body?.trigger || "manual"));
    }),
  );

  app.post(
    "/api/bookings/:id/complete",
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      res.json(await completeBooking(req.params.id, userReq.user.uid));
    }),
  );

  // ============================================================
  // Maintenance lifecycle engine
  // ============================================================
  app.post(
    "/api/maintenance",
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      const body = (req.body || {}) as {
        customer_id?: string;
        customer_name?: string;
        customer_phone?: string;
        customer_address?: string;
        product_id?: string;
        product_name?: string;
        product_sku?: string;
        install_date?: string;
        next_maintenance?: string;
        technician_id?: string;
        technician_name?: string;
        scheduled_time?: string;
        notes?: string;
      };
      if (!body.customer_id || !body.product_id || !body.next_maintenance) {
        throw httpError(400, "customer_id, product_id, and next_maintenance are required.");
      }
      res.status(201).json(
        createMaintenance({
          uid: userReq.user.uid,
          customer_id: body.customer_id,
          customer_name: body.customer_name || "",
          customer_phone: body.customer_phone || "",
          customer_address: body.customer_address || "",
          product_id: body.product_id,
          product_name: body.product_name || "",
          product_sku: body.product_sku || "",
          install_date: body.install_date,
          next_maintenance: body.next_maintenance,
          technician_id: body.technician_id,
          technician_name: body.technician_name,
          scheduled_time: body.scheduled_time,
          notes: body.notes,
        }),
      );
    }),
  );

  app.post(
    "/api/maintenance/:id/complete",
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      res.json(
        completeMaintenance({
          installationId: req.params.id,
          uid: userReq.user.uid,
          completedDate: req.body?.completedDate,
          notes: req.body?.notes,
        }),
      );
    }),
  );

  app.post(
    "/api/maintenance/:id/reschedule",
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      if (!req.body?.newDate) throw httpError(400, "newDate is required.");
      res.json(
        rescheduleMaintenance({
          installationId: req.params.id,
          uid: userReq.user.uid,
          newDate: req.body.newDate,
          reason: req.body?.reason,
        }),
      );
    }),
  );

  app.post(
    "/api/maintenance/:id/cancel",
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      res.json(
        cancelMaintenance({
          installationId: req.params.id,
          uid: userReq.user.uid,
          reason: req.body?.reason,
        }),
      );
    }),
  );

  app.get(
    "/api/maintenance/:id/timeline",
    asyncRoute(async (req, res) => {
      res.json({ installation_id: req.params.id, events: getMaintenanceTimeline(req.params.id) });
    }),
  );

  app.get(
    "/api/maintenance/overdue",
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      const days = Number(req.query.days ?? 0) || 0;
      const list = getOverdueList(userReq.user.uid, days);
      res.json({ count: list.length, days_past: days, items: list });
    }),
  );

  app.get(
    "/api/maintenance/upcoming",
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      const days = Number(req.query.days ?? 7) || 7;
      const list = getUpcomingList(userReq.user.uid, days);
      res.json({ count: list.length, days_ahead: days, items: list });
    }),
  );

  app.get(
    "/api/maintenance/customers/:id/score",
    asyncRoute(async (req, res) => {
      res.json(getCustomerScore(req.params.id));
    }),
  );

  // ============================================================
  // WhatsApp templates + conversations
  // ============================================================
  app.get("/api/whatsapp/templates", (_req, res) => {
    res.json({
      templates: listTemplateNames().map((name) => ({
        name,
        sample: renderTemplate(name, {
          customer_name: "{customer_name}",
          product_name: "{product_name}",
          maintenance_date: "{maintenance_date}",
          scheduled_time: "{scheduled_time}",
          technician_name: "{technician_name}",
          customer_address: "{customer_address}",
          message: "{message}",
          next_maintenance_date: "{next_maintenance_date}",
        }, { strict: false }),
      })),
    });
  });

  app.post(
    "/api/whatsapp/send-template",
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      const body = (req.body || {}) as {
        phone?: string;
        template?: TemplateName;
        vars?: Record<string, string>;
        installation_id?: string;
        booking_id?: string;
        outboundCode?: string;
      };
      if (!body.phone || !body.template) throw httpError(400, "phone and template are required.");
      try {
        const result = await sendWhatsAppTemplate({
          phone: body.phone,
          template: body.template,
          vars: body.vars,
          installation_id: body.installation_id,
          booking_id: body.booking_id,
          owner_uid: userReq.user.uid,
          outboundCode: body.outboundCode,
        });
        res.json({ success: true, result });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("credentials are missing") || msg.includes("is not connected")) {
          throw httpError(503, msg);
        }
        throw error;
      }
    }),
  );

  app.get(
    "/api/whatsapp/conversations/:phone",
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      const limit = Math.min(500, Number(req.query.limit ?? 200) || 200);
      const restrictByOwner = userReq.user.role !== "admin";
      const ownerUid = restrictByOwner ? userReq.user.uid : undefined;
      const messages = getWhatsAppConversation(req.params.phone, ownerUid, limit);
      res.json({ phone: req.params.phone, count: messages.length, messages });
    }),
  );

  app.get(
    "/api/whatsapp/messages",
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      const limit = Math.min(500, Number(req.query.limit ?? 50) || 50);
      const ownerUid = userReq.user.role === "admin" ? undefined : userReq.user.uid;
      const items = listRecentWhatsAppMessages({ ownerUid, limit });
      res.json({ count: items.length, items });
    }),
  );

  app.get(
    "/api/whatsapp/stats",
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      const ownerUid = userReq.user.role === "admin" ? undefined : userReq.user.uid;
      const counts = whatsAppStats(ownerUid);
      const status = whatsappService.getStatus();
      res.json({
        ...counts,
        provider: status.provider,
        status: status.status,
        user: status.user,
        outbound: status.outbound,
      });
    }),
  );

  app.get(
    "/api/whatsapp/devices",
    asyncRoute(async (_req, res) => {
      const status = whatsappService.getStatus();
      const linked = status.user
        ? [{
            id: status.user,
            provider: status.provider,
            status: status.status,
            connected_since: status.connectedAt || status.updatedAt,
            label: status.provider === "web" ? "WhatsApp Web (Baileys)" : "WhatsApp Business Cloud API",
          }]
        : [];
      res.json({ count: linked.length, devices: linked });
    }),
  );

  app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || 500;
    // Security (M3): only surface messages for intentional client errors
    // (those carrying an explicit status). Unexpected 500s may contain
    // database/provider internals, so log server-side and return a generic
    // message to the client.
    if (!err.status || status >= 500) {
      console.error("Unhandled server error:", err);
      res.status(status).json({ error: "حدث خطأ غير متوقع في السيرفر." });
      return;
    }
    res.status(status).json({ error: err.message || "تعذر تنفيذ الطلب." });
  });

  if (process.env.ENABLE_DAILY_CRON === "true") {
    const reminderSchedule = process.env.REMINDER_CRON_SCHEDULE || "0 10 * * *";
    cron.schedule(
      reminderSchedule,
      async () => {
        try {
          await runDueReminders({ mode: "scheduled" });
        } catch (error) {
          console.error("Reminder scheduler failed:", error);
        }
      },
      { timezone: timeZone },
    );
    console.log(`Reminder cron enabled: ${reminderSchedule} (${timeZone})`);
  }

  if (process.env.SALLA_SYNC_CRON_ENABLED === "true") {
    const sallaSchedule = process.env.SALLA_SYNC_CRON_SCHEDULE || "*/15 * * * *";
    cron.schedule(
      sallaSchedule,
      async () => {
        try {
          await syncAllLinkedSallaIntegrations();
        } catch (error) {
          console.error("Salla sync scheduler failed:", error);
        }
      },
      { timezone: timeZone },
    );
    console.log(`Salla sync cron enabled: ${sallaSchedule} (${timeZone})`);
  }

  // Technician pre-alert cron: scan every 10 minutes for confirmed bookings
  // whose scheduled time falls within TECH_PREALERT_MINUTES.
  if (process.env.ENABLE_DAILY_CRON === "true") {
    const techSchedule = process.env.TECH_PREALERT_CRON_SCHEDULE || "*/10 * * * *";
    cron.schedule(
      techSchedule,
      async () => {
        try {
          await sendTechnicianPreAlerts();
        } catch (error) {
          console.error("Technician pre-alert scheduler failed:", error);
        }
      },
      { timezone: timeZone },
    );
    console.log(`Technician pre-alert cron enabled: ${techSchedule} (${timeZone})`);
  }

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true, allowedHosts: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(port, "0.0.0.0", () => {
    console.log(`Golden Pro CRM running on http://localhost:${port}`);
  });
}

startServer().catch((error) => {
  console.error("Failed to start Golden Pro CRM:", error);
  process.exit(1);
});
