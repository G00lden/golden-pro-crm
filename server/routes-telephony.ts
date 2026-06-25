/**
 * Telephony / IVR routes.
 *
 * Public webhooks (registered BEFORE the /api Firebase guard) are how the
 * provider drives the live call:
 *   - POST/GET /webhooks/telephony/ivr     → menu + DTMF handling
 *   - POST     /webhooks/telephony/status  → call outcome → missed-call flow
 *
 * Admin endpoints (after auth) manage departments/agents, config, and the call
 * log, plus a /test-missed simulator for verifying the WhatsApp flow without a
 * real call.
 */
import crypto from "crypto";
import type { Express, NextFunction, Request, Response } from "express";
import type { AuthedRequest } from "./auth";
import { unifonicAdapter } from "./telephony/unifonicAdapter";
import type { TelephonyAdapter } from "./telephony/types";
import {
  buildGreeting,
  createDepartment,
  deleteDepartment,
  getTelephonyConfig,
  handleCallStatus,
  handleDigit,
  listCalls,
  listDepartments,
  recordCall,
  runMissedCallFlow,
  updateCallBySid,
  updateDepartment,
  upsertTelephonyConfig,
} from "./ivrEngine";
import {
  validate,
  validateQuery,
  telephonyWebhookSchema,
  telephonyWebhookQuerySchema,
  telephonyConfigSchema,
  telephonyDepartmentSchema,
  telephonyDepartmentUpdateSchema,
  telephonyTestMissedSchema,
  telephonyCallsQuerySchema,
} from "./validation";
import { logError } from "./logger";

function asyncRoute(handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function httpError(status: number, message: string) {
  const err = new Error(message) as Error & { status?: number };
  err.status = status;
  return err;
}

function adapterFor(_provider?: string): TelephonyAdapter {
  // Only Unifonic is wired today; the engine is provider-agnostic so adding
  // another adapter is a one-line switch here.
  return unifonicAdapter;
}

/** Absolute base URL the provider should call back on (for responseUrl/status). */
function resolveBaseUrl(req: Request): string {
  const fromEnv = process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || "";
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "https";
  const host = req.get("host") || "localhost:3000";
  return `${proto}://${host}`;
}

/** Constant-time compare that won't throw on length mismatch. */
function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * Authenticate an inbound telephony webhook via a shared secret header.
 * Fail-closed in production when the secret is unset; allow unsigned in
 * dev/local so the simulator and local tunnels keep working.
 */
function verifyTelephonyWebhook(req: Request): { status: number; error: string } | null {
  const secret = process.env.TELEPHONY_WEBHOOK_SECRET || "";
  const isProd = process.env.NODE_ENV === "production";
  if (!secret) {
    return isProd ? { status: 503, error: "TELEPHONY_WEBHOOK_SECRET is not configured." } : null;
  }
  const provided =
    req.get("x-telephony-webhook-secret") ||
    (typeof req.query.secret === "string" ? req.query.secret : "") ||
    "";
  if (provided && safeEquals(provided, secret)) return null;
  return { status: 401, error: "Invalid or missing telephony webhook secret." };
}

function requireWebhookSecret(req: Request, res: Response, next: NextFunction) {
  const rejection = verifyTelephonyWebhook(req);
  if (rejection) {
    res.status(rejection.status).json({ error: rejection.error });
    return;
  }
  next();
}

export interface TelephonyRouteOptions {
  webhookRateLimit: (req: Request, res: Response, next: NextFunction) => void;
  telephonyOwnerUid: () => string;
}

// ── Public webhook routes ─────────────────────────────────────────────────────
export function registerTelephonyWebhookRoutes(app: Express, options: TelephonyRouteOptions) {
  const { webhookRateLimit, telephonyOwnerUid } = options;

  const ivrHandler = asyncRoute(async (req, res) => {
    const ownerUid = telephonyOwnerUid();
    const adapter = adapterFor(getTelephonyConfig(ownerUid).provider);
    const call = adapter.parseInbound(
      (req.body || {}) as Record<string, unknown>,
      (req.query || {}) as Record<string, unknown>,
    );
    const baseUrl = resolveBaseUrl(req);
    const instructions = call.digit
      ? handleDigit(ownerUid, call, baseUrl)
      : buildGreeting(ownerUid, call, baseUrl);
    res.status(200).json(adapter.renderInstructions(instructions));
  });

  app.get(
    "/webhooks/telephony/ivr",
    webhookRateLimit,
    requireWebhookSecret,
    validateQuery(telephonyWebhookQuerySchema),
    ivrHandler,
  );
  app.post(
    "/webhooks/telephony/ivr",
    webhookRateLimit,
    requireWebhookSecret,
    validate(telephonyWebhookSchema),
    ivrHandler,
  );

  app.post(
    "/webhooks/telephony/status",
    webhookRateLimit,
    requireWebhookSecret,
    validate(telephonyWebhookSchema),
    asyncRoute(async (req, res) => {
      const ownerUid = telephonyOwnerUid();
      const adapter = adapterFor(getTelephonyConfig(ownerUid).provider);
      const status = adapter.parseStatus(
        (req.body || {}) as Record<string, unknown>,
        (req.query || {}) as Record<string, unknown>,
      );
      try {
        const result = await handleCallStatus(status);
        res.status(200).json({ received: true, ...result });
      } catch (error) {
        // Best-effort: always 200 so the provider doesn't retry-storm.
        logError("telephony.status.handler_failed", error);
        res.status(200).json({ received: false });
      }
    }),
  );
}

// ── Admin routes ──────────────────────────────────────────────────────────────
export function registerTelephonyRoutes(app: Express, options: TelephonyRouteOptions) {
  const { telephonyOwnerUid } = options;

  function requireAdmin(req: Request, res: Response, next: NextFunction) {
    const user = (req as AuthedRequest).user;
    if (!user?.uid) {
      res.status(401).json({ error: "Authentication required." });
      return;
    }
    if (user.role === "admin" || user.role === "manager") return next();
    res.status(403).json({ error: "صلاحيات المسؤول مطلوبة لإدارة نظام المكالمات." });
  }

  // Single-tenant: admin UI and the public webhook operate on the same owner
  // partition so configured departments are visible to live calls.
  const owner = () => telephonyOwnerUid();

  app.get("/api/telephony/config", requireAdmin, (_req, res) => {
    res.json({ config: getTelephonyConfig(owner()) });
  });

  app.put(
    "/api/telephony/config",
    requireAdmin,
    validate(telephonyConfigSchema),
    (req, res) => {
      res.json({ config: upsertTelephonyConfig(owner(), req.body || {}) });
    },
  );

  app.get("/api/telephony/departments", requireAdmin, (_req, res) => {
    res.json({ departments: listDepartments(owner()) });
  });

  app.post(
    "/api/telephony/departments",
    requireAdmin,
    validate(telephonyDepartmentSchema),
    (req, res) => {
      const existing = listDepartments(owner()).find((d) => d.digit === req.body.digit);
      if (existing) throw httpError(409, `الرقم ${req.body.digit} مستخدم بالفعل لقسم آخر.`);
      res.status(201).json({ department: createDepartment(owner(), req.body) });
    },
  );

  app.put(
    "/api/telephony/departments/:id",
    requireAdmin,
    validate(telephonyDepartmentUpdateSchema),
    (req, res) => {
      const updated = updateDepartment(owner(), req.params.id, req.body || {});
      if (!updated) throw httpError(404, "القسم غير موجود.");
      res.json({ department: updated });
    },
  );

  app.delete("/api/telephony/departments/:id", requireAdmin, (req, res) => {
    const ok = deleteDepartment(owner(), req.params.id);
    if (!ok) throw httpError(404, "القسم غير موجود.");
    res.json({ success: true });
  });

  app.get(
    "/api/telephony/calls",
    requireAdmin,
    validateQuery(telephonyCallsQuerySchema),
    (req, res) => {
      const limit = Number(req.query.limit ?? 100);
      const missedOnly = req.query.missed === "true";
      res.json({ calls: listCalls({ ownerUid: owner(), limit, missedOnly }) });
    },
  );

  // Simulate a missed call end-to-end (records a call, marks it missed, fires
  // the WhatsApp flow) so the operator can verify routing without a real call.
  app.post(
    "/api/telephony/test-missed",
    requireAdmin,
    validate(telephonyTestMissedSchema),
    asyncRoute(async (req, res) => {
      const ownerUid = owner();
      const body = req.body as { from_phone: string; digit?: string; department_id?: string };
      const departments = listDepartments(ownerUid);
      const department = body.department_id
        ? departments.find((d) => d.id === body.department_id)
        : body.digit
          ? departments.find((d) => d.digit === body.digit)
          : departments[0];
      if (!department) throw httpError(400, "لا يوجد قسم مطابق. أنشئ قسماً أولاً.");
      const agent = department.agents.find((a) => a.active && a.phone) || department.agents[0];

      const callSid = `test_${crypto.randomUUID().slice(0, 12)}`;
      recordCall({
        ownerUid,
        provider: getTelephonyConfig(ownerUid).provider,
        callSid,
        from: body.from_phone,
        to: getTelephonyConfig(ownerUid).main_number || "",
        status: "no_answer",
      });
      updateCallBySid(callSid, {
        department_id: department.id,
        department_name: department.name,
        selected_digit: department.digit,
        agent_user_id: agent?.user_id || null,
        agent_phone: agent?.phone || null,
        agent_name: agent?.name || null,
        status: "no_answer",
        missed: 1,
      });
      const result = await runMissedCallFlow(callSid);
      res.json({ success: true, callSid, department: department.name, result });
    }),
  );
}
