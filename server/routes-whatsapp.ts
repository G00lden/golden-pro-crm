import type { Express, Request, Response, NextFunction } from "express";
import {
  sendWhatsAppTemplate,
  whatsAppStats,
  whatsappService,
  getConversation as getWhatsAppConversation,
  listRecentMessages as listRecentWhatsAppMessages,
  recordWhatsAppMessage,
  updateWhatsAppStatus,
} from "./whatsapp";
import { cloudTemplateEnvKey, listTemplateNames, renderTemplate, type TemplateName } from "./whatsappTemplates";
import {
  handleWebhook as handleWhatsAppWebhook,
  verifyWebhook as verifyWhatsAppWebhook,
  verifyWhatsAppWebhookAuth,
} from "./whatsappWebhook";
import { recordCustomerConfirmation } from "./maintenanceLifecycle";
import { parseConfirmation } from "./whatsapp";
import {
  validate,
  validateQuery,
  sendTestSchema,
  whatsappConversationQuerySchema,
  whatsappTemplateSendSchema,
  whatsappWebhookBodySchema,
  whatsappWebhookVerifyQuerySchema,
  communicationPreferenceSchema,
  communicationCampaignSchema,
  communicationCampaignLaunchSchema,
} from "./validation";
import { appendFileSync } from "fs";
import path from "path";
import type { AuthedRequest } from "./auth";
import { logError, logEvent, redactValue } from "./logger";
import { communicationJobStore } from "./communicationJobs";
import { communicationPreferenceStore } from "./communicationPreferences";
import { communicationCampaignStore } from "./communicationCampaigns";
import { hasAppCapability } from "../shared/accessControl";
import { visibleWhatsAppStatus } from "./whatsappStatusVisibility";

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
  if (hasAppCapability(user.role, "whatsapp.manage")) {
    next();
    return;
  }
  // Fail closed: a non-role-admin passes only when explicitly allow-listed.
  // (Previously an empty allow-list let ANY authenticated user through.)
  if (allow.includes(user.uid)) {
    next();
    return;
  }
  res.status(403).json({ error: "Administrator privileges are required for this action." });
}

function requireCampaignManager(req: Request, res: Response, next: NextFunction) {
  const allow = adminUids();
  const user = (req as AuthedRequest).user;
  if (!user?.uid) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  if (hasAppCapability(user.role, "campaigns.manage") || allow.includes(user.uid)) {
    next();
    return;
  }
  res.status(403).json({ error: "Manager privileges are required for campaign operations." });
}

/**
 * Authenticate inbound WhatsApp webhook POSTs (HMAC / shared secret).
 * Runs before body validation so forged callers are rejected first.
 */
function requireWebhookSignature(
  req: Request & { rawBody?: Buffer },
  res: Response,
  next: NextFunction,
) {
  const rejection = verifyWhatsAppWebhookAuth(req);
  if (rejection) {
    res.status(rejection.status).json({ error: rejection.error });
    return;
  }
  next();
}

export interface WhatsAppRouteOptions {
  webhookRateLimit: (req: Request, res: Response, next: NextFunction) => void;
  whatsappOwnerUid: () => string;
}

export function registerWhatsAppWebhookRoutes(app: Express, options: WhatsAppRouteOptions) {
  const { webhookRateLimit, whatsappOwnerUid } = options;

  // WhatsApp Cloud API webhook (works for direct Meta callbacks AND Kapso.ai
  // forwarded webhooks). GET handles Meta's hub.challenge verification handshake;
  // POST receives message status callbacks and incoming user messages.
  app.get(
    "/webhooks/whatsapp",
    webhookRateLimit,
    validateQuery(whatsappWebhookVerifyQuerySchema),
    (req, res) => verifyWhatsAppWebhook(req, res),
  );

  app.post(
    "/webhooks/whatsapp",
    webhookRateLimit,
    requireWebhookSignature,
    validate(whatsappWebhookBodySchema),
    asyncRoute(async (req, res) => {
      await handleWhatsAppWebhook(req, res, { ownerUid: whatsappOwnerUid() });
    }),
  );

  // Legacy inline body retained below for the qa-suite scenario that posts to
  // the old shape. The new module above already
  // ACKs the request, so the catch-all below never executes on a real call.
  app.post(
    "/webhooks/whatsapp/legacy",
    webhookRateLimit,
    requireWebhookSignature,
    validate(whatsappWebhookBodySchema),
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
              const matched = parseConfirmation(text);
              if (matched) {
                try {
                  const result = recordCustomerConfirmation(adminUid, String(message?.from || ""), text);
                  summary.push({ kind: "confirmation", phone: message?.from, matched_keyword: matched, ...result });
                } catch (confErr) {
                  logError("whatsapp.webhook.confirmation_save_failed", confErr);
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
          const safeSummary = redactValue(summary);
          const line = `${new Date().toISOString()} ${JSON.stringify(safeSummary)}\n`;
          appendFileSync(path.join(process.cwd(), ".whatsapp-webhook.log"), line, "utf8");
          logEvent("info", "whatsapp.webhook.legacy_events", { events: summary.length, summary });
        }
        res.status(200).json({ received: true, events: summary.length });
      } catch (error) {
        logError("whatsapp.webhook.legacy_handler_failed", error);
        res.status(200).json({ received: false });
      }
    }),
  );
}

export function registerWhatsAppRoutes(app: Express, options: WhatsAppRouteOptions) {

  app.get(
    "/api/whatsapp/status",
    requireCampaignManager,
    asyncRoute(async (req, res) => {
      const refresh = String(req.query.refresh || "").toLowerCase() === "true";
      const status = refresh ? await whatsappService.verifyConnection(true) : whatsappService.getStatus();
      const user = (req as AuthedRequest).user;
      const canManageWhatsApp = hasAppCapability(user?.role, "whatsapp.manage")
        || Boolean(user?.uid && adminUids().includes(user.uid));
      res.json(visibleWhatsAppStatus(status, canManageWhatsApp));
    }),
  );

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
    validate(sendTestSchema),
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      const { phone, message, metadata } = req.body || {};
      if (!phone) throw httpError(400, "رقم الجوال مطلوب.");

      try {
        const body = message || "رسالة اختبار من نظام Breexe Pro CRM";
        const result = await whatsappService.sendText(phone, body, {
          confirmationCode: req.body?.outboundCode,
        });
        const dryRun = (result as { dryRun?: boolean })?.dryRun === true;
        recordWhatsAppMessage({
          type: "sent",
          provider: whatsappService.getStatus().provider,
          direction: "outbound",
          to_phone: phone,
          message: body,
          message_id: (result as { messageId?: string | null })?.messageId || null,
          status: dryRun ? "dry_run" : "sent",
          owner_uid: userReq.user.uid,
          metadata: metadata && typeof metadata === "object" ? metadata : { kind: "manual" },
        });
        res.json({ success: true, dry_run: dryRun, result });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("credentials are missing") || msg.includes("is not connected")) {
          throw httpError(503, msg);
        }
        throw error;
      }
    }),
  );

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
    requireAdmin,
    validate(whatsappTemplateSendSchema),
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
        const dryRun = (result as { dryRun?: boolean })?.dryRun === true;
        res.json({ success: true, dry_run: dryRun, result });
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
    validateQuery(whatsappConversationQuerySchema),
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      const limit = Number(req.query.limit ?? 200);
      const restrictByOwner = userReq.user.role !== "admin";
      const ownerUid = restrictByOwner ? userReq.user.uid : undefined;
      const messages = getWhatsAppConversation(req.params.phone, ownerUid, limit);
      res.json({ phone: req.params.phone, count: messages.length, messages });
    }),
  );

  app.get(
    "/api/whatsapp/messages",
    validateQuery(whatsappConversationQuerySchema),
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      const limit = Number(req.query.limit ?? 50);
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

  app.get(
    "/api/whatsapp/jobs",
    requireAdmin,
    asyncRoute(async (req, res) => {
      const ownerUid = options.whatsappOwnerUid();
      const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
      res.json({
        summary: communicationJobStore.summary(ownerUid),
        jobs: communicationJobStore.listRecent(ownerUid, limit),
      });
    }),
  );

  app.get("/api/whatsapp/suppressions", requireCampaignManager, (req, res) => {
    const ownerUid = options.whatsappOwnerUid();
    const limit = Math.max(1, Math.min(500, Number(req.query.limit || 100)));
    res.json({ suppressions: communicationPreferenceStore.listSuppressions(ownerUid, limit) });
  });

  app.put(
    "/api/whatsapp/preferences",
    requireCampaignManager,
    validate(communicationPreferenceSchema),
    (req, res) => {
      const ownerUid = options.whatsappOwnerUid();
      const actorSource = `manual_admin:${(req as AuthedRequest).user.uid}`;
      const body = req.body as {
        phone: string;
        channel: "whatsapp" | "sms";
        status: "granted" | "withdrawn";
        source: string;
        evidence: string;
        lift_suppression: boolean;
      };
      if (body.status === "withdrawn") {
        communicationPreferenceStore.suppress({
          ownerUid,
          phone: body.phone,
          channel: body.channel,
          reason: "manual_withdrawal",
          source: actorSource,
          evidence: body.evidence,
        });
      } else {
        if (body.lift_suppression) {
          communicationPreferenceStore.liftSuppression(ownerUid, body.phone, body.channel);
        }
        communicationPreferenceStore.setPreference({
          ownerUid,
          phone: body.phone,
          channel: body.channel,
          status: "granted",
          source: actorSource,
          evidence: body.evidence,
        });
      }
      res.json({
        preference: communicationPreferenceStore.getPreference(ownerUid, body.phone, body.channel),
        eligibility: communicationPreferenceStore.marketingEligibility(ownerUid, body.phone, body.channel),
      });
    },
  );

  app.get("/api/whatsapp/campaigns", requireCampaignManager, (req, res) => {
    const ownerUid = options.whatsappOwnerUid();
    const limit = Math.max(1, Math.min(500, Number(req.query.limit || 100)));
    res.json({ campaigns: communicationCampaignStore.list(ownerUid, limit) });
  });

  app.post(
    "/api/whatsapp/campaigns",
    requireCampaignManager,
    validate(communicationCampaignSchema),
    (req, res) => {
      const user = (req as AuthedRequest).user;
      const body = req.body as {
        name: string;
        template_name: TemplateName;
        audience_filter: { allCustomers?: boolean; city?: string; source?: string; customerIds?: string[] };
        template_vars?: Record<string, string | number>;
        rate_limit_per_minute?: number;
        frequency_cap_days?: number;
      };
      const campaign = communicationCampaignStore.create({
        ownerUid: options.whatsappOwnerUid(),
        name: body.name,
        templateName: body.template_name,
        audienceFilter: body.audience_filter,
        templateVars: body.template_vars,
        rateLimitPerMinute: body.rate_limit_per_minute,
        frequencyCapDays: body.frequency_cap_days,
        createdBy: user.uid,
      });
      res.status(201).json({ campaign });
    },
  );

  app.get("/api/whatsapp/campaigns/:id/preview", requireCampaignManager, (req, res) => {
    const preview = communicationCampaignStore.preview(options.whatsappOwnerUid(), req.params.id);
    if (!preview) throw httpError(404, "Campaign not found.");
    res.json(preview);
  });

  app.post(
    "/api/whatsapp/campaigns/:id/launch",
    requireCampaignManager,
    validate(communicationCampaignLaunchSchema),
    (req, res) => {
      const ownerUid = options.whatsappOwnerUid();
      const campaign = communicationCampaignStore.get(ownerUid, req.params.id);
      if (!campaign) throw httpError(404, "Campaign not found.");
      const preview = communicationCampaignStore.preview(ownerUid, campaign.id);
      if (!preview?.eligible) throw httpError(409, "Campaign has no eligible recipients with explicit consent.");
      const providerStatus = whatsappService.getStatus();
      if (providerStatus.provider !== "cloud_api" || providerStatus.status !== "connected") {
        throw httpError(409, "Campaign launch requires a verified WhatsApp Cloud API connection.");
      }
      if (providerStatus.outbound?.mode !== "production" || !providerStatus.outbound.launchApproved) {
        throw httpError(409, "Campaign launch requires approved production outbound mode.");
      }
      if (providerStatus.provider === "cloud_api") {
        const envKey = cloudTemplateEnvKey(campaign.template_name);
        const mapped = process.env[envKey] || (
          campaign.template_name === "general_reminder"
            ? process.env.WHATSAPP_CLOUD_TEMPLATE_NAME || process.env.WHATSAPP_TEMPLATE_NAME
            : ""
        );
        if (!mapped) throw httpError(409, `Approved Meta template mapping is missing: ${envKey}`);
      }
      const launched = communicationCampaignStore.launch(ownerUid, campaign.id, req.body.scheduled_at);
      res.json({ campaign: launched });
    },
  );

  for (const action of ["pause", "resume", "cancel"] as const) {
    app.post(`/api/whatsapp/campaigns/:id/${action}`, requireCampaignManager, (req, res) => {
      const next = action === "pause" ? "paused" : action === "resume" ? "running" : "cancelled";
      const campaign = communicationCampaignStore.setStatus(options.whatsappOwnerUid(), req.params.id, next);
      if (!campaign) throw httpError(404, "Campaign not found.");
      res.json({ campaign });
    });
  }
}
