import dotenv from "dotenv";
import express, { type NextFunction, type Request, type Response } from "express";
import { randomUUID } from "crypto";
import cron from "node-cron";
import path from "path";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";
import { requireFirebaseUser } from "./server/auth";
import { registerCrmApiRoutes } from "./server/crmApi";
import { registerUserAdminRoutes } from "./server/userManagement";
import { adminDb } from "./server/firebaseAdmin";
import { runWithOutboundCode } from "./server/outboundSafety";
import { todayInTimeZone } from "./server/reminderEngine";
import { runDueReminders } from "./server/reminderEngine";
import { syncAllLinkedSallaIntegrations } from "./server/salla";
import { sendTechnicianPreAlerts } from "./server/bookingNotifications";
import { ownedCount } from "./server/sharedRouteHelpers";
import { validate, validateQuery, sallaCallbackQuerySchema, sallaWebhookSchema } from "./server/validation";
import { registerHealthRoutes } from "./server/routes-health";
import {
  registerWhatsAppRoutes,
  registerWhatsAppWebhookRoutes,
} from "./server/routes-whatsapp";
import { registerSallaRoutes } from "./server/routes-salla";
import { registerMaintenanceRoutes } from "./server/routes-maintenance";
import { registerReminderRoutes } from "./server/routes-reminders";
import { registerStoreRoutes } from "./server/routes-store";
import { registerOdooCrmRoutes } from "./server/odooCrm";
import { getStoreWebhookPublicState } from "./server/storeWebhook";
import { getReminderSchedulerState } from "./server/reminderEngine";
import { outboundSafetyStatus } from "./server/outboundSafety";
import { logError } from "./server/logger";

dotenv.config({ path: process.env.ENV_FILE || ".env" });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const timeZone = process.env.APP_TIMEZONE || "Asia/Riyadh";

function httpError(status: number, message: string) {
  const err = new Error(message) as Error & { status?: number };
  err.status = status;
  return err;
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
        "script-src 'self' https://www.gstatic.com https://apis.google.com",
        "connect-src 'self' https://*.supabase.co https://*.googleapis.com https://www.googleapis.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://firestore.googleapis.com",
        "frame-src 'self' https://accounts.google.com https://*.firebaseapp.com",
        "form-action 'self'",
      ].join("; "),
    );
  }

  next();
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
  app.use((req, res, next) => {
    const requestId = req.get("x-request-id") || randomUUID();
    (req as Request & { requestId?: string }).requestId = requestId;
    res.setHeader("X-Request-Id", requestId);
    next();
  });

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
      "/api/health",
      "/public/invoices",
      "/webhooks/whatsapp",
    ],
    webhookRateLimit,
  );

  // ── Route modules ──
  registerHealthRoutes(app);

  registerStoreRoutes(app, { webhookRateLimit });

  // WhatsApp webhook callbacks + admin endpoints
  const __whatsappOwnerUid = () =>
    adminUids()[0] || process.env.STORE_WEBHOOK_OWNER_UID || process.env.LOCAL_AUTH_SHARED_UID || "local-dev-owner";
  registerWhatsAppWebhookRoutes(app, { webhookRateLimit, whatsappOwnerUid: __whatsappOwnerUid });

  // Salla OAuth callback + webhook (unauthenticated — these trigger token
  // exchanges or receive store-push events before any user is logged in).
  function asyncRoute(
    handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
  ) {
    return (req: Request, res: Response, next: NextFunction) => {
      Promise.resolve(handler(req, res, next)).catch(next);
    };
  }
  const { handleSallaCallback, handleSallaAppWebhook } = await import("./server/salla");
  app.get(
    "/api/integrations/salla/callback",
    validateQuery(sallaCallbackQuerySchema),
    asyncRoute(async (req, res) => {
      const result = await handleSallaCallback(req);
      res.status(result.status).type("html").send(result.html);
    }),
  );
  app.post(
    "/api/integrations/salla/webhook",
    validate(sallaWebhookSchema),
    asyncRoute(async (req, res) => {
      res.json(await handleSallaAppWebhook(req as Request & { rawBody?: Buffer }));
    }),
  );
  app.get(
    "/salla/callback",
    validateQuery(sallaCallbackQuerySchema),
    asyncRoute(async (req, res) => {
      const result = await handleSallaCallback(req);
      res.status(result.status).type("html").send(result.html);
    }),
  );
  app.post(
    ["/salla/callback", "/salla/webhook"],
    validate(sallaWebhookSchema),
    asyncRoute(async (req, res) => {
      res.json(await handleSallaAppWebhook(req as Request & { rawBody?: Buffer }));
    }),
  );

  // Authenticated routes (require Firebase user)
  app.use("/api", apiRateLimit, requireFirebaseUser);

  registerUserAdminRoutes(app);
  registerCrmApiRoutes(app);
  registerWhatsAppRoutes(app, { webhookRateLimit, whatsappOwnerUid: __whatsappOwnerUid });
  registerOdooCrmRoutes(app);

  registerSallaRoutes(app);

  registerMaintenanceRoutes(app);

  registerReminderRoutes(app);

  // ── Daily-prep route (uses getSallaStatus, ownedCount, whatsappService) ──
  function asyncRoute2(
    handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
  ) {
    return (req: Request, res: Response, next: NextFunction) => {
      Promise.resolve(handler(req, res, next)).catch(next);
    };
  }
  app.post(
    "/api/operations/prepare-daily",
    asyncRoute2(async (req, res) => {
      // Dynamic import to avoid circular dependency — routes-salla exports no register for this pattern.
      const { getSallaStatus, syncSallaStoreForUser } = await import("./server/salla");
      const { whatsappService } = await import("./server/whatsapp");
      const userReq = req as any;
      const uid = userReq.user.uid;
      const syncRequested = Boolean(req.body?.syncSalla);
      const [salla, technicians, storeOrders, needsReview, awaitingSchedule, todayBookings] = await Promise.all([
        getSallaStatus(uid, req),
        ownedCount("technicians", uid),
        ownedCount("store_orders", uid),
        ownedCount("store_orders", uid, (ref: any) => ref.where("journey_status", "==", "needs_review")),
        ownedCount("store_orders", uid, (ref: any) => ref.where("journey_status", "==", "awaiting_schedule")),
        ownedCount("bookings", uid, (ref: any) => ref.where("date", "==", todayInTimeZone())),
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

  // Error handler
  app.use((err: Error & { status?: number }, req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || 500;
    if (!err.status || status >= 500) {
      const requestId = (req as Request & { requestId?: string }).requestId;
      logError("server.unhandled_error", err, {
        requestId,
        method: req.method,
        path: req.originalUrl,
        status,
      });
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
          logError("scheduler.reminder_failed", error);
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
          logError("scheduler.salla_sync_failed", error);
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
          logError("scheduler.technician_prealert_failed", error);
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
  logError("server.start_failed", error);
  process.exit(1);
});
