import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import type { AuthedRequest } from "./auth";
import { completeBooking } from "./bookingLifecycle";
import { requireCapability } from "./capabilityGuard";
import { hasAppCapability } from "../shared/accessControl";
import { maintenanceCalendarDate } from "./maintenanceRequestValidation";
import {
  assignMaintenanceRequest,
  cancelMaintenanceRequest,
  closeMaintenanceRequest,
  createPublicMaintenanceRequest,
  getMaintenanceRequestByPortalToken,
  getOwnedMaintenanceRequest,
  listMaintenanceRequests,
  maintenancePortalTokenForRequest,
  maintenanceRequestEvents,
  publicMaintenanceRequest,
  requestCustomerReschedule,
  transitionMaintenanceRequest,
  updateMaintenancePortalAccess,
} from "./maintenanceRequestService";

type PublicRouteOptions = {
  rateLimit: RequestHandler;
  ownerUid: () => string | null;
  queueFieldTechSync: (reason: string) => void;
};

type AdminRouteOptions = {
  queueFieldTechSync: (reason: string) => void;
};

function asyncRoute(handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function validationError(res: Response, parsed: { error: z.ZodError }) {
  res.status(400).json({
    error: parsed.error.issues[0]?.message || "تحقق من البيانات المدخلة.",
    issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  });
}

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "أدخل الوقت بصيغة صحيحة.");

const publicCreateSchema = z.object({
  client_request_id: z.string().trim().regex(/^[A-Za-z0-9_-]{8,128}$/, "تعذر تثبيت رقم المحاولة. أعد تحميل الصفحة."),
  customer_name: z.string().trim().min(2, "أدخل اسم العميل.").max(200),
  customer_phone: z.string().trim().min(7, "أدخل رقم الجوال.").max(30),
  city: z.string().trim().max(160).optional(),
  address: z.string().trim().min(5, "أدخل عنوان موقع الصيانة.").max(1_000),
  service_type: z.enum(["air_conditioning", "electrical", "plumbing", "appliances", "general"]),
  product_name: z.string().trim().min(2, "أدخل نوع الجهاز أو الخدمة.").max(240),
  issue_description: z.string().trim().min(10, "صف العطل بمزيد من التفاصيل.").max(4_000),
  warranty_status: z.enum(["yes", "no", "unknown"]).optional(),
  invoice_number: z.string().trim().max(120).optional(),
  preferred_date: maintenanceCalendarDate.optional(),
  preferred_time: time.optional(),
  accept_terms: z.literal(true, "يجب الموافقة على سياسة الخدمة والخصوصية."),
  website: z.string().trim().max(2_048).optional(),
}).strict();

const portalTokenSchema = z.string().trim().min(40).max(300);

const customerActionSchema = z.discriminatedUnion("action", [
  z.object({ token: portalTokenSchema, action: z.literal("cancel"), reason: z.string().trim().min(3).max(1_000) }),
  z.object({
    token: portalTokenSchema,
    action: z.literal("request_reschedule"),
    preferred_date: maintenanceCalendarDate,
    preferred_time: time.optional(),
    note: z.string().trim().max(1_000).optional(),
  }),
]);

const adminActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), note: z.string().trim().max(2_000).optional() }),
  z.object({ action: z.literal("reject"), reason: z.string().trim().min(3).max(2_000) }),
  z.object({
    action: z.literal("assign"),
    technician_id: z.string().trim().min(1).max(128),
    date: maintenanceCalendarDate,
    scheduled_time: time,
    note: z.string().trim().max(2_000).optional(),
  }),
  z.object({ action: z.literal("start"), note: z.string().trim().max(2_000).optional() }),
  z.object({ action: z.literal("close"), note: z.string().trim().min(3).max(2_000) }),
  z.object({ action: z.literal("close_override"), reason: z.string().trim().min(10).max(2_000) }),
  z.object({ action: z.literal("rotate_portal_link") }),
  z.object({ action: z.literal("revoke_portal_link") }),
  z.object({ action: z.literal("cancel"), reason: z.string().trim().min(3).max(2_000) }),
]);

export function resolveMaintenanceRequestOwnerUid(env: NodeJS.ProcessEnv = process.env) {
  return String(
    env.MAINTENANCE_REQUEST_OWNER_UID
      || env.PUBLIC_LEADS_OWNER_UID
      || env.STORE_WEBHOOK_OWNER_UID
      || (env.NODE_ENV === "production" ? "" : env.LOCAL_AUTH_SHARED_UID || "local-dev-owner"),
  ).trim() || null;
}

function boundedPositiveInteger(value: unknown, fallback: number, maximum: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(maximum, Math.trunc(parsed)) : fallback;
}

function adminRequestResponse(request: Awaited<ReturnType<typeof getOwnedMaintenanceRequest>>, ownerUid: string) {
  return {
    ...request,
    customer_change_requested: Boolean(request.customer_change_requested),
    portal_token: maintenancePortalTokenForRequest(request, ownerUid),
  };
}

function adminWorkspaceOwnerUid(req: Request, env: NodeJS.ProcessEnv = process.env) {
  const configured = String(
    env.MAINTENANCE_REQUEST_OWNER_UID
      || env.PUBLIC_LEADS_OWNER_UID
      || env.STORE_WEBHOOK_OWNER_UID
      || "",
  ).trim();
  return configured || (req as AuthedRequest).user.uid;
}

export function maintenanceRequestRateLimitOptions(env: NodeJS.ProcessEnv = process.env) {
  return {
    windowMs: boundedPositiveInteger(env.MAINTENANCE_REQUEST_RATE_LIMIT_WINDOW_MS, 15 * 60_000, 24 * 60 * 60_000),
    max: boundedPositiveInteger(env.MAINTENANCE_REQUEST_RATE_LIMIT_MAX, 20, 1_000),
    name: "maintenance-requests",
  };
}

export function registerMaintenanceRequestPublicRoutes(app: Express, options: PublicRouteOptions) {
  app.post("/public/maintenance-requests", options.rateLimit, asyncRoute(async (req, res) => {
    const parsed = publicCreateSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, { error: parsed.error! });
    if (parsed.data.website) return res.status(202).json({ success: true });
    const ownerUid = options.ownerUid();
    if (!ownerUid) return res.status(503).json({ error: "استقبال طلبات الصيانة غير مهيأ بحساب مالك." });
    const result = await createPublicMaintenanceRequest(ownerUid, parsed.data);
    const events = await maintenanceRequestEvents(result.request.id, ownerUid);
    res.setHeader("Cache-Control", "no-store");
    res.status(result.duplicate ? 200 : 201).json({
      success: true,
      duplicate: result.duplicate,
      portal_token: result.portal_token,
      request: publicMaintenanceRequest(result.request, events),
    });
  }));

  app.get("/public/maintenance-request", options.rateLimit, asyncRoute(async (req, res) => {
    const parsed = portalTokenSchema.safeParse(req.query.token);
    if (!parsed.success) return res.status(404).json({ error: "رابط الطلب غير صالح أو منتهي." });
    const request = await getMaintenanceRequestByPortalToken(parsed.data);
    const events = await maintenanceRequestEvents(request.id, String(request.createdBy || request.owner_uid));
    res.setHeader("Cache-Control", "no-store");
    res.json({ request: publicMaintenanceRequest(request, events) });
  }));

  app.post("/public/maintenance-request/action", options.rateLimit, asyncRoute(async (req, res) => {
    const parsed = customerActionSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, { error: parsed.error! });
    const request = await getMaintenanceRequestByPortalToken(parsed.data.token);
    const ownerUid = String(request.createdBy || request.owner_uid);
    if (parsed.data.action === "cancel") {
      if (!["new", "approved", "scheduled"].includes(request.status)) {
        return res.status(409).json({ error: "لا يمكن إلغاء الطلب بعد بدء التنفيذ أو إغلاقه." });
      }
      const cancelled = await cancelMaintenanceRequest(request.id, ownerUid, {
        actorType: "customer",
        action: "customer_cancelled",
        message: `ألغى العميل الطلب: ${parsed.data.reason}`,
        reason: parsed.data.reason,
      });
      if (cancelled.bookingCancelled) {
        options.queueFieldTechSync("maintenance_request_customer_cancelled");
      }
    } else {
      await requestCustomerReschedule(request, parsed.data);
    }
    const updated = await getOwnedMaintenanceRequest(request.id, ownerUid);
    const events = await maintenanceRequestEvents(request.id, ownerUid);
    res.setHeader("Cache-Control", "no-store");
    res.json({ success: true, request: publicMaintenanceRequest(updated, events) });
  }));
}

export function registerMaintenanceRequestAdminRoutes(app: Express, options: AdminRouteOptions) {
  app.get("/api/maintenance-requests", requireCapability("maintenance.requests.view"), asyncRoute(async (req, res) => {
    const ownerUid = adminWorkspaceOwnerUid(req);
    res.json(await listMaintenanceRequests(ownerUid, {
      status: String(req.query.status || ""),
      search: String(req.query.search || ""),
    }));
  }));

  app.get("/api/maintenance-requests/:id", requireCapability("maintenance.requests.view"), asyncRoute(async (req, res) => {
    const ownerUid = adminWorkspaceOwnerUid(req);
    const request = await getOwnedMaintenanceRequest(String(req.params.id), ownerUid);
    res.json({
      request: adminRequestResponse(request, ownerUid),
      events: await maintenanceRequestEvents(request.id, ownerUid),
    });
  }));

  app.post("/api/maintenance-requests/:id/action", requireCapability("maintenance.requests.manage"), asyncRoute(async (req, res) => {
    const parsed = adminActionSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, { error: parsed.error! });
    const user = (req as AuthedRequest).user;
    const uid = user.uid;
    const ownerUid = adminWorkspaceOwnerUid(req);
    const id = String(req.params.id);
    let request = await getOwnedMaintenanceRequest(id, ownerUid);

    if (parsed.data.action === "approve") {
      request = await transitionMaintenanceRequest(id, ownerUid, "approved", {
        actorUid: uid,
        action: "approved",
        message: parsed.data.note || "اعتمد فريق الصيانة الطلب ويجري تحديد الموعد.",
      });
    } else if (parsed.data.action === "reject") {
      request = await transitionMaintenanceRequest(id, ownerUid, "rejected", {
        actorUid: uid,
        action: "rejected",
        message: parsed.data.reason,
        patch: { rejection_reason: parsed.data.reason },
      });
    } else if (parsed.data.action === "assign") {
      request = await assignMaintenanceRequest(id, ownerUid, { ...parsed.data, actor_uid: uid });
      options.queueFieldTechSync("maintenance_request_assigned");
    } else if (parsed.data.action === "start") {
      request = await transitionMaintenanceRequest(id, ownerUid, "in_progress", {
        actorUid: uid,
        action: "started",
        message: parsed.data.note || "بدأ تنفيذ طلب الصيانة.",
      });
    } else if (parsed.data.action === "close" || parsed.data.action === "close_override") {
      if (!request.booking_id) return res.status(409).json({ error: "يجب إسناد الطلب وإنشاء حجز قبل إغلاقه." });
      const override = parsed.data.action === "close_override";
      if (override && !hasAppCapability(user.role, "maintenance.requests.close_override", user.permissions || {})) {
        return res.status(403).json({ error: "صلاحية تجاوز أدلة FieldTech مخصصة لمدير النظام فقط." });
      }
      const overrideReason = parsed.data.action === "close_override" ? parsed.data.reason : "";
      const closeNote = parsed.data.action === "close" ? parsed.data.note : "";
      const resolutionNote = override ? overrideReason : closeNote;
      request = await closeMaintenanceRequest(id, ownerUid, {
        actorUid: uid,
        action: override ? "closed_with_evidence_override" : "closed",
        message: override
          ? `أغلق مدير النظام الطلب بتجاوز موثق لأدلة FieldTech: ${overrideReason}`
          : closeNote,
        resolutionNote,
        evidenceOverride: override,
        overrideReason,
        metadata: override ? { reason: overrideReason } : {},
      });
      await completeBooking(String(request.booking_id), ownerUid, {
        evidenceOverride: true,
        syncMaintenance: false,
        skipBookingWrite: true,
      });
      options.queueFieldTechSync("maintenance_request_closed");
    } else if (parsed.data.action === "rotate_portal_link" || parsed.data.action === "revoke_portal_link") {
      request = await updateMaintenancePortalAccess(
        id,
        ownerUid,
        parsed.data.action === "revoke_portal_link" ? "revoke" : "rotate",
        uid,
      );
    } else if (parsed.data.action === "cancel") {
      const cancelled = await cancelMaintenanceRequest(id, ownerUid, {
        actorUid: uid,
        action: "cancelled",
        message: parsed.data.reason,
        reason: parsed.data.reason,
      });
      request = cancelled.request;
      if (cancelled.bookingCancelled) {
        options.queueFieldTechSync("maintenance_request_cancelled");
      }
    }

    request = await getOwnedMaintenanceRequest(id, ownerUid);
    res.json({
      success: true,
      request: adminRequestResponse(request, ownerUid),
      events: await maintenanceRequestEvents(id, ownerUid),
    });
  }));
}
