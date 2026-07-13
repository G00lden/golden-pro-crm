import type { Express, NextFunction, Request, Response } from "express";
import { requireCapability } from "./capabilityGuard";
import { logEvent } from "./logger";
import {
  getPublicLeadInboxRecord,
  listPublicLeadInbox,
  projectPublicLeadToCrm,
  reconcilePublicLeadProjections,
  updatePublicLeadStatus,
  type PublicLeadDatabase,
  type PublicLeadStatus,
} from "./publicLeadStorage";

export type PublicLeadInboxRouteOptions = {
  database: PublicLeadDatabase;
  ownerUid: () => string | null;
  now?: () => string;
  reconcileOnRegister?: boolean;
};

const LEAD_STATUSES = new Set<PublicLeadStatus>([
  "new",
  "contacted",
  "qualified",
  "closed",
  "spam",
]);

function ownerOrUnavailable(options: PublicLeadInboxRouteOptions, res: Response) {
  const ownerUid = String(options.ownerUid() || "").trim();
  if (ownerUid) return ownerUid;
  res.status(503).json({ error: "Public lead intake is not configured." });
  return null;
}

function route(handler: (req: Request, res: Response) => void) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      handler(req, res);
    } catch (error) {
      next(error);
    }
  };
}

export function registerPublicLeadInboxRoutes(
  app: Express,
  options: PublicLeadInboxRouteOptions,
) {
  if (options.reconcileOnRegister !== false) {
    const ownerUid = String(options.ownerUid() || "").trim();
    if (ownerUid) {
      try {
        const result = reconcilePublicLeadProjections(options.database, ownerUid, {
          now: options.now,
        });
        if (result.attempted || result.backfilled) {
          logEvent(result.failed ? "warn" : "info", "public_lead.reconciled", result);
        }
      } catch (error) {
        // Startup reconciliation is best effort. The durable inbox remains
        // available for manual retry and startup must not be held hostage by it.
        logEvent("error", "public_lead.reconciliation_failed", { error });
      }
    }
  }

  const requirePublicLeadManager = requireCapability("public_leads.manage");

  app.get(
    "/api/odoo/public-leads",
    requirePublicLeadManager,
    route((_req, res) => {
      const ownerUid = ownerOrUnavailable(options, res);
      if (!ownerUid) return;
      const data = listPublicLeadInbox(options.database, ownerUid);
      res.setHeader("Cache-Control", "no-store");
      res.json({ data, total: data.length });
    }),
  );

  app.put(
    "/api/odoo/public-leads/:id/status",
    requirePublicLeadManager,
    route((req, res) => {
      const ownerUid = ownerOrUnavailable(options, res);
      if (!ownerUid) return;
      const status = String(req.body?.status || "") as PublicLeadStatus;
      if (!LEAD_STATUSES.has(status)) {
        res.status(400).json({ error: "Invalid public lead status." });
        return;
      }
      const lead = updatePublicLeadStatus(
        options.database,
        req.params.id,
        ownerUid,
        status,
        options.now,
      );
      if (!lead) {
        res.status(404).json({ error: "Public lead was not found." });
        return;
      }
      logEvent("info", "public_lead.status_updated", {
        leadId: lead.id,
        status: lead.status,
      });
      res.json({ lead: getPublicLeadInboxRecord(options.database, lead.id, ownerUid) });
    }),
  );

  app.post(
    "/api/odoo/public-leads/:id/retry",
    requirePublicLeadManager,
    route((req, res) => {
      const ownerUid = ownerOrUnavailable(options, res);
      if (!ownerUid) return;
      if (!getPublicLeadInboxRecord(options.database, req.params.id, ownerUid)) {
        res.status(404).json({ error: "Public lead was not found." });
        return;
      }
      const result = projectPublicLeadToCrm(options.database, req.params.id, {
        ownerUid,
        now: options.now,
        force: true,
      });
      logEvent(result.error ? "error" : "info", result.error ? "public_lead.retry_failed" : "public_lead.retry_completed", {
        leadId: req.params.id,
        projectionStatus: result.projection.status,
        projectionError: result.error,
      });
      res.json({
        lead: getPublicLeadInboxRecord(options.database, req.params.id, ownerUid),
      });
    }),
  );
}
