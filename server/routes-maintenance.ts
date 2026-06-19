import type { Express, Request, Response, NextFunction } from "express";
import type { AuthedRequest } from "./auth";
import {
  createMaintenance,
  completeMaintenance,
  rescheduleMaintenance,
  cancelMaintenance,
  getMaintenanceTimeline,
  getOverdueList,
  getUpcomingList,
  getCustomerScore,
} from "./maintenanceLifecycle";
import {
  listEscalations,
  escalationStats,
  getEscalation,
  resolveEscalation,
  assignEscalation,
} from "./escalationEngine";
import { completeBooking } from "./bookingLifecycle";
import { notifyTechnicianForBooking, sendTechnicianPreAlerts } from "./bookingNotifications";
import { validate, resolveEscalationSchema, assignEscalationSchema } from "./validation";

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

export function registerMaintenanceRoutes(app: Express) {
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
    validate(resolveEscalationSchema),
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      const updated = resolveEscalation(req.params.id, userReq.user.uid, req.body?.notes);
      if (!updated) throw httpError(404, "Escalation not found.");
      res.json(updated);
    }),
  );

  app.post(
    "/api/escalations/:id/assign",
    validate(assignEscalationSchema),
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      if (!req.body?.assigned_to) throw httpError(400, "assigned_to is required.");
      const updated = assignEscalation(req.params.id, String(req.body.assigned_to), userReq.user.uid, req.body?.notes);
      if (!updated) throw httpError(404, "Escalation not found.");
      res.json(updated);
    }),
  );

  // ============================================================
  // Bookings
  // ============================================================
  app.post(
    "/api/bookings/pre-alerts/run",
    asyncRoute(async (_req, res) => {
      res.json(await sendTechnicianPreAlerts());
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
}
