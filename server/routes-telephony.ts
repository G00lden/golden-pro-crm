import crypto from "crypto";
import type { Express, NextFunction, Request, Response } from "express";
import { requestOwnerUid, type AuthedRequest } from "./auth";
import {
  beginTelephonyEvent,
  buildGreetingForProvider,
  callStats,
  completeTelephonyEvent,
  createDepartment,
  deleteDepartment,
  failTelephonyEvent,
  getCallById,
  getCallBySessionToken,
  getCallBySid,
  getTelephonyConfig,
  getTelephonyReadiness,
  handleCallStatus,
  handleDigit,
  isDialablePhone,
  legacyHandleDigit,
  listCalls,
  listDepartments,
  markCallHandled,
  recordCall,
  resolveTelephonyOwnerUid,
  runMissedCallFlow,
  updateCallBySid,
  updateDepartment,
  upsertTelephonyConfig,
} from "./ivrEngine";
import { logError, logEvent } from "./logger";
import { unifonicAdapter } from "./telephony/unifonicAdapter";
import type { TelephonyAdapter } from "./telephony/types";
import {
  telephonyCallsQuerySchema,
  telephonyConfigSchema,
  telephonyDepartmentSchema,
  telephonyDepartmentUpdateSchema,
  telephonyFollowUpSchema,
  telephonyTestMissedSchema,
  telephonyWebhookQuerySchema,
  telephonyWebhookSchema,
  validate,
  validateQuery,
} from "./validation";

function asyncRoute(handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function httpError(status: number, message: string) {
  const error = new Error(message) as Error & { status?: number };
  error.status = status;
  return error;
}

function adapterFor(_provider?: string): TelephonyAdapter {
  return unifonicAdapter;
}

function resolveBaseUrl(req: Request): string {
  const configured = process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || "";
  if (configured) return configured.replace(/\/$/, "");
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "https";
  return `${proto}://${req.get("host") || "localhost:3000"}`;
}

function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function bearerValue(req: Request): string {
  const authorization = req.get("authorization") || "";
  return authorization.replace(/^Bearer\s+/i, "").trim();
}

function verifyInitialAuthorization(req: Request): { status: number; error: string } | null {
  const secret = process.env.TELEPHONY_WEBHOOK_SECRET || "";
  if (!secret) {
    return process.env.NODE_ENV === "production"
      ? { status: 503, error: "TELEPHONY_WEBHOOK_SECRET is not configured." }
      : null;
  }
  const provided = bearerValue(req) || req.get("x-telephony-webhook-secret") || "";
  return provided && safeEquals(provided, secret)
    ? null
    : { status: 401, error: "Invalid or missing IVR Authorization." };
}

function verifyStatusAuthorization(req: Request): { status: number; error: string } | null {
  const expectedUser = process.env.TELEPHONY_STATUS_WEBHOOK_USER || "";
  const expectedPassword = process.env.TELEPHONY_STATUS_WEBHOOK_PASSWORD || "";
  if (expectedUser && expectedPassword) {
    const authorization = req.get("authorization") || "";
    if (!authorization.startsWith("Basic ")) return { status: 401, error: "Basic Authentication is required." };
    let decoded = "";
    try {
      decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    } catch {
      return { status: 401, error: "Invalid Basic Authentication." };
    }
    const separator = decoded.indexOf(":");
    const user = separator >= 0 ? decoded.slice(0, separator) : "";
    const password = separator >= 0 ? decoded.slice(separator + 1) : "";
    return safeEquals(user, expectedUser) && safeEquals(password, expectedPassword)
      ? null
      : { status: 401, error: "Invalid Basic Authentication." };
  }

  // One-release compatibility for non-production setups that have only the old secret.
  const rejection = verifyInitialAuthorization(req);
  if (!rejection) return null;
  return process.env.NODE_ENV === "production"
    ? { status: 503, error: "Independent status webhook credentials are not configured." }
    : rejection;
}

function guard(
  verify: (req: Request) => { status: number; error: string } | null,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    const rejection = verify(req);
    if (rejection) {
      res.status(rejection.status).json({ error: rejection.error });
      return;
    }
    next();
  };
}

export interface TelephonyRouteOptions {
  webhookRateLimit: (req: Request, res: Response, next: NextFunction) => void;
  telephonyOwnerUid: () => string;
}

export function registerTelephonyWebhookRoutes(app: Express, options: TelephonyRouteOptions) {
  const { webhookRateLimit, telephonyOwnerUid } = options;

  app.get(
    "/webhooks/telephony/ivr",
    webhookRateLimit,
    guard(verifyInitialAuthorization),
    validateQuery(telephonyWebhookQuerySchema),
    asyncRoute(async (req, res) => {
      const parsed = unifonicAdapter.parseInbound(
        (req.body || {}) as Record<string, unknown>,
        (req.query || {}) as Record<string, unknown>,
      );
      const ownerUid = resolveTelephonyOwnerUid(parsed.to, telephonyOwnerUid());
      const adapter = adapterFor(getTelephonyConfig(ownerUid).provider);
      res.status(200).json(adapter.renderInstructions(await buildGreetingForProvider(ownerUid, parsed, resolveBaseUrl(req))));
    }),
  );

  app.post(
    "/webhooks/telephony/ivr/session/:token",
    webhookRateLimit,
    validate(telephonyWebhookSchema),
    asyncRoute(async (req, res) => {
      const session = getCallBySessionToken(req.params.token);
      if (!session) throw httpError(401, "Invalid or expired call session.");
      const ownerUid = String(session.owner_uid);
      const adapter = adapterFor(String(session.provider));
      const parsed = adapter.parseInbound(
        (req.body || {}) as Record<string, unknown>,
        (req.query || {}) as Record<string, unknown>,
      );
      const boundCall = {
        ...parsed,
        callSid: String(session.call_sid),
        from: String(session.from_phone || parsed.from),
        to: String(session.to_phone || parsed.to),
        sessionToken: req.params.token,
      };
      res.status(200).json(adapter.renderInstructions(handleDigit(ownerUid, boundCall, resolveBaseUrl(req))));
    }),
  );

  // Deprecated compatibility endpoint for one release. New responseUrl values
  // always point to /session/:token and do not depend on an Authorization header.
  app.post(
    "/webhooks/telephony/ivr",
    webhookRateLimit,
    guard(verifyInitialAuthorization),
    validate(telephonyWebhookSchema),
    asyncRoute(async (req, res) => {
      logEvent("warn", "telephony.ivr.legacy_endpoint_used", { ip: req.ip });
      const parsed = unifonicAdapter.parseInbound(
        (req.body || {}) as Record<string, unknown>,
        (req.query || {}) as Record<string, unknown>,
      );
      const ownerUid = resolveTelephonyOwnerUid(parsed.to, telephonyOwnerUid());
      const adapter = adapterFor(getTelephonyConfig(ownerUid).provider);
      const instructions = parsed.digit
        ? legacyHandleDigit(ownerUid, parsed, resolveBaseUrl(req))
        : await buildGreetingForProvider(ownerUid, parsed, resolveBaseUrl(req));
      res.status(200).json(adapter.renderInstructions(instructions));
    }),
  );

  app.post(
    "/webhooks/telephony/status",
    webhookRateLimit,
    guard(verifyStatusAuthorization),
    validate(telephonyWebhookSchema),
    asyncRoute(async (req, res) => {
      const status = unifonicAdapter.parseStatus(
        (req.body || {}) as Record<string, unknown>,
        (req.query || {}) as Record<string, unknown>,
      );
      const known = status.callSid ? getCallBySid(status.callSid) : null;
      const ownerUid = known?.owner_uid
        ? String(known.owner_uid)
        : resolveTelephonyOwnerUid(status.to, telephonyOwnerUid());
      const provider = getTelephonyConfig(ownerUid).provider;
      const event = beginTelephonyEvent(ownerUid, provider, status);
      if (event.duplicate) {
        res.status(200).json({ received: true, duplicate: true });
        return;
      }
      try {
        const result = await handleCallStatus(status);
        completeTelephonyEvent(event.eventId, typeof result.callId === "string" ? result.callId : undefined);
        res.status(200).json({ received: true, duplicate: false, ...result });
      } catch (error) {
        failTelephonyEvent(event.eventId, error);
        logError("telephony.status.handler_failed", error);
        res.status(503).json({ received: false, retryable: true });
      }
    }),
  );
}

export function registerTelephonyRoutes(app: Express, _options: TelephonyRouteOptions) {
  const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
    const role = (req as AuthedRequest).user?.role;
    if (role === "admin" || role === "manager") return next();
    res.status(403).json({ error: "صلاحيات المسؤول مطلوبة لإدارة إعدادات الهاتف." });
  };
  const requireCallAccess = (req: Request, res: Response, next: NextFunction) => {
    const role = (req as AuthedRequest).user?.role;
    if (["admin", "manager", "sales", "technician"].includes(role)) return next();
    res.status(403).json({ error: "لا تملك صلاحية عرض المكالمات." });
  };
  const owner = (req: Request) => requestOwnerUid(req);
  const assignedScope = (req: Request) => {
    const user = (req as AuthedRequest).user;
    return user.role === "admin" || user.role === "manager" ? undefined : user.uid;
  };

  app.get("/api/telephony/config", requireAdmin, (req, res) => {
    res.json({ config: getTelephonyConfig(owner(req)) });
  });
  app.get("/api/telephony/readiness", requireAdmin, (req, res) => {
    res.json({ readiness: getTelephonyReadiness(owner(req)) });
  });
  app.put("/api/telephony/config", requireAdmin, validate(telephonyConfigSchema), (req, res) => {
    res.json({ config: upsertTelephonyConfig(owner(req), req.body || {}) });
  });

  app.get("/api/telephony/departments", requireAdmin, (req, res) => {
    res.json({ departments: listDepartments(owner(req)) });
  });
  app.post("/api/telephony/departments", requireAdmin, validate(telephonyDepartmentSchema), (req, res) => {
    const ownerUid = owner(req);
    if (listDepartments(ownerUid).some((department) => department.digit === req.body.digit)) {
      throw httpError(409, `الرقم ${req.body.digit} مستخدم لقسم آخر.`);
    }
    res.status(201).json({ department: createDepartment(ownerUid, req.body) });
  });
  app.put("/api/telephony/departments/:id", requireAdmin, validate(telephonyDepartmentUpdateSchema), (req, res) => {
    const department = updateDepartment(owner(req), req.params.id, req.body || {});
    if (!department) throw httpError(404, "القسم غير موجود.");
    res.json({ department });
  });
  app.delete("/api/telephony/departments/:id", requireAdmin, (req, res) => {
    if (!deleteDepartment(owner(req), req.params.id)) throw httpError(404, "القسم غير موجود.");
    res.json({ success: true });
  });

  app.get("/api/telephony/calls", requireCallAccess, validateQuery(telephonyCallsQuerySchema), (req, res) => {
    res.json({ calls: listCalls({
      ownerUid: owner(req),
      assignedUserId: assignedScope(req),
      limit: Number(req.query.limit || 100),
      missedOnly: req.query.missed === "true",
      status: typeof req.query.status === "string" ? req.query.status : undefined,
      followUpStatus: typeof req.query.follow_up_status === "string" ? req.query.follow_up_status : undefined,
      departmentId: typeof req.query.department_id === "string" ? req.query.department_id : undefined,
      search: typeof req.query.search === "string" ? req.query.search : undefined,
      fromDate: typeof req.query.from_date === "string" ? req.query.from_date : undefined,
      toDate: typeof req.query.to_date === "string" ? req.query.to_date : undefined,
    }) });
  });
  app.get("/api/telephony/calls/summary", requireCallAccess, (req, res) => {
    res.json(callStats(owner(req), assignedScope(req)));
  });

  const followUpHandler = (req: Request, res: Response) => {
    const ownerUid = owner(req);
    const user = (req as AuthedRequest).user;
    const call = getCallById(ownerUid, req.params.id);
    if (!call) throw httpError(404, "المكالمة غير موجودة.");
    if (!["admin", "manager"].includes(user.role) &&
        String(call.assigned_user_id || call.agent_user_id || "") !== user.uid) {
      throw httpError(403, "هذه المكالمة ليست مسندة إليك.");
    }
    const body = (req.body || {}) as { outcome?: string; notes?: string };
    markCallHandled(ownerUid, req.params.id, user.uid, body.outcome || "completed", body.notes || "");
    res.json({ success: true });
  };
  app.post("/api/telephony/calls/:id/follow-up", requireCallAccess, validate(telephonyFollowUpSchema), followUpHandler);
  app.post("/api/telephony/calls/:id/handle", requireCallAccess, followUpHandler);

  app.post(
    "/api/telephony/test-missed",
    requireAdmin,
    validate(telephonyTestMissedSchema),
    asyncRoute(async (req, res) => {
      const ownerUid = owner(req);
      const body = req.body as { from_phone: string; digit?: string; department_id?: string };
      const departments = listDepartments(ownerUid).filter((department) => department.active);
      const department = body.department_id
        ? departments.find((candidate) => candidate.id === body.department_id)
        : body.digit
          ? departments.find((candidate) => candidate.digit === body.digit)
          : departments[0];
      if (!department) throw httpError(400, "أنشئ قسمًا نشطًا قبل المحاكاة.");
      const agent = department.agents.find((candidate) => candidate.active && isDialablePhone(candidate.phone)) || null;
      const callSid = `test_${crypto.randomUUID().slice(0, 12)}`;
      recordCall({
        ownerUid,
        provider: getTelephonyConfig(ownerUid).provider,
        callSid,
        from: body.from_phone,
        to: getTelephonyConfig(ownerUid).main_number,
        status: "no_answer",
      });
      updateCallBySid(callSid, {
        department_id: department.id,
        department_name: department.name,
        selected_digit: department.digit,
        agent_user_id: agent?.user_id || null,
        assigned_user_id: agent?.user_id || null,
        agent_phone: agent?.phone || null,
        agent_name: agent?.name || null,
        status: "no_answer",
        call_status: "no_answer",
        follow_up_status: agent?.user_id ? "assigned" : "new",
        missed: 1,
      });
      const result = await runMissedCallFlow(callSid);
      res.json({ success: true, callSid, department: department.name, result });
    }),
  );
}
