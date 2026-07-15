import crypto from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import type { AuthedRequest } from "./auth";
import { requireCapability } from "./capabilityGuard";
import { hasAppCapability } from "../shared/accessControl";
import {
  CALL_REPLY_MODES,
  evaluateCallReplyRecipient,
  getCallReplyPolicy,
  normalizePolicyPhone,
  renderCallReplyMessage,
  saveCallReplyPolicy,
  type CallReplyDisposition,
} from "./callReplyPolicy";
import db from "./db";
import {
  authenticateGatewayDeviceToken,
  redeemGatewayPairingCode,
  rotateGatewayDeviceToken,
  type AuthenticatedGatewayDevice,
} from "./gatewayPairing";
import {
  acknowledgeMobileCommand,
  createMobileCommand,
  getMobileDevicePolicy,
  listDeviceCommands,
  listMobileDevices,
  mobileCustomerCache,
  mobileDashboard,
  processMobileEventBatch,
  updateDeviceProfile,
  updateMobileDevice,
  type MobileEventEnvelope,
} from "./mobilePlatform";
import { isDryRunSendResult, outboundSafetyStatus } from "./outboundSafety";
import { recordWhatsAppMessage, whatsappService } from "./whatsapp";

type MobileRequest = Request & { mobileDevice: AuthenticatedGatewayDevice };

const pairSchema = z.object({
  code: z.string().regex(/^\d{8}$/),
  deviceName: z.string().trim().min(1).max(80),
  companyNumber: z.string().trim().max(30).optional(),
  clientNonce: z.string().trim().min(16).max(200),
});

const simSchema = z.object({
  simKey: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
  slotIndex: z.number().int().min(0).max(7).optional(),
  carrierName: z.string().max(80).optional(),
  displayName: z.string().max(80).optional(),
  phoneSuffix: z.string().max(8).optional(),
});

const profileSchema = z.object({
  appVersion: z.string().max(40).optional(),
  platformVersion: z.string().max(40).optional(),
  manufacturer: z.string().max(80).optional(),
  model: z.string().max(80).optional(),
  batteryPercent: z.number().min(0).max(100).optional(),
  networkType: z.string().max(40).optional(),
  permissions: z.record(z.string().max(100), z.boolean()).optional(),
  health: z.record(z.string().max(100), z.unknown()).optional(),
  fcmToken: z.string().max(4096).optional(),
  sims: z.array(simSchema).max(4).optional(),
});

const eventSchema = z.object({
  schemaVersion: z.number().int().min(1).max(10).default(1),
  eventId: z.string().trim().min(8).max(160),
  type: z.string().trim().min(1).max(50),
  simKey: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/).optional(),
  occurredAt: z.string().datetime({ offset: true }),
  payload: z.record(z.string().max(100), z.unknown()).optional(),
});

const eventsSchema = z.object({ events: z.array(eventSchema).min(1).max(100) });
const commandAckSchema = z.object({
  status: z.enum(["confirmed", "completed", "failed", "cancelled"]),
  result: z.record(z.string().max(100), z.unknown()).optional(),
  error: z.string().max(1000).optional(),
});

function asyncRoute(handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function parse<T>(schema: z.ZodType<T>, value: unknown, res: Response): T | null {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  res.status(400).json({ error: "بيانات الطلب غير صالحة.", issues: parsed.error.issues.map((issue) => issue.message) });
  return null;
}

function deviceToken(req: Request) {
  return String(req.get("x-gateway-token") || req.get("x-mobile-token") || "").trim();
}

function requireMobileDevice(ownerUid: () => string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = deviceToken(req);
    const device = token ? authenticateGatewayDeviceToken(ownerUid(), token) : null;
    if (!device) {
      res.status(401).json({ error: "Invalid or revoked mobile device credential." });
      return;
    }
    (req as MobileRequest).mobileDevice = device;
    next();
  };
}

function userCanSeeDevice(req: AuthedRequest, device: Record<string, unknown>) {
  return req.user.role === "admin" || req.user.role === "manager" || device.assigned_user_uid === req.user.uid;
}

export function registerMobileDeviceRoutes(app: Express, options: {
  ownerUid: () => string;
  webhookRateLimit: (req: Request, res: Response, next: NextFunction) => void;
  pairingRateLimit: (req: Request, res: Response, next: NextFunction) => void;
}) {
  const requireDevice = requireMobileDevice(options.ownerUid);

  app.post("/api/mobile/v1/pair", options.pairingRateLimit, (req, res) => {
    const body = parse(pairSchema, req.body, res);
    if (!body) return;
    const paired = redeemGatewayPairingCode(body);
    if (!paired) {
      res.status(400).json({ error: "رمز الربط غير صحيح أو منتهي الصلاحية. أنشئ رمزًا جديدًا من CRM." });
      return;
    }
    res.status(201).json({ paired: true, token: paired.token, deviceId: paired.deviceId, apiVersion: 1 });
  });

  app.post("/api/mobile/v1/profile", options.webhookRateLimit, requireDevice, (req, res) => {
    const body = parse(profileSchema, req.body, res);
    if (!body) return;
    res.json({ device: updateDeviceProfile((req as MobileRequest).mobileDevice, body) });
  });

  app.post(
    "/api/mobile/v1/events/batch",
    options.webhookRateLimit,
    requireDevice,
    asyncRoute(async (req, res) => {
      const body = parse(eventsSchema, req.body, res);
      if (!body) return;
      const results = await processMobileEventBatch(
        (req as MobileRequest).mobileDevice,
        body.events as MobileEventEnvelope[],
      );
      res.json({ received: results.length, results });
    }),
  );

  app.get("/api/mobile/v1/commands", options.webhookRateLimit, requireDevice, (req, res) => {
    res.json({ commands: listDeviceCommands((req as MobileRequest).mobileDevice, Number(req.query.limit || 20)) });
  });

  app.post("/api/mobile/v1/commands/:id/ack", options.webhookRateLimit, requireDevice, (req, res) => {
    const body = parse(commandAckSchema, req.body, res);
    if (!body) return;
    res.json({ command: acknowledgeMobileCommand(
      (req as MobileRequest).mobileDevice,
      String(req.params.id || ""),
      body.status,
      body.result,
      body.error,
    ) });
  });

  app.get("/api/mobile/v1/policy", options.webhookRateLimit, requireDevice, (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(getMobileDevicePolicy((req as MobileRequest).mobileDevice));
  });

  app.get("/api/mobile/v1/dashboard", options.webhookRateLimit, requireDevice, (req, res) => {
    res.json(mobileDashboard((req as MobileRequest).mobileDevice));
  });

  app.get("/api/mobile/v1/customer-cache", options.webhookRateLimit, requireDevice, (req, res) => {
    res.json({ customers: mobileCustomerCache((req as MobileRequest).mobileDevice, Number(req.query.limit || 500)) });
  });

  app.post("/api/mobile/v1/token/rotate", options.webhookRateLimit, requireDevice, (req, res) => {
    const device = (req as MobileRequest).mobileDevice;
    const token = rotateGatewayDeviceToken(device.owner_uid, device.id);
    if (!token) {
      res.status(409).json({ error: "تعذر تدوير رمز الجهاز." });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({ token, rotatedAt: new Date().toISOString() });
  });
}

const updateDeviceSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  assignedUserUid: z.string().trim().max(128).nullable().optional(),
  branchId: z.string().trim().max(80).nullable().optional(),
  managementMode: z.enum(["byod", "company"]).optional(),
  workSimKey: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/).nullable().optional(),
  capabilities: z.record(z.string().max(100), z.boolean()).optional(),
});

const createCommandSchema = z.object({
  type: z.enum(["dial_request", "open_customer", "show_task", "sync_contacts", "refresh_policy", "collect_health", "local_wipe"]),
  payload: z.record(z.string().max(100), z.unknown()).optional(),
  expiresInSeconds: z.number().int().min(30).max(86_400).optional(),
  confirmationDeviceName: z.string().trim().max(80).optional(),
});

const policySchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(CALL_REPLY_MODES),
  selectedDeviceId: z.string().max(100).nullable().optional(),
  selectedSimKey: z.string().max(160).nullable().optional(),
  unifonicEnabled: z.boolean().optional(),
  version: z.number().int().min(0).optional(),
  confirmationPhrase: z.string().max(100).optional(),
  numbers: z.array(z.object({ phone: z.string().max(40), label: z.string().max(80).optional() })).max(500).optional(),
});

const previewSchema = z.object({
  phone: z.string().max(40).optional(),
  disposition: z.enum(["no_answer", "busy", "unreachable", "rejected", "after_hours"]).default("no_answer"),
  occurredAt: z.string().datetime({ offset: true }).optional(),
});

const testSchema = previewSchema.extend({ confirm: z.literal(true) });

function testId() {
  return `mtest_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export function registerMobileAdminRoutes(app: Express, options: { ownerUid: () => string }) {
  app.get("/api/mobile/devices", requireCapability("mobile.devices.view"), (req, res) => {
    const userReq = req as AuthedRequest;
    const devices = listMobileDevices(options.ownerUid()).filter((device) => userCanSeeDevice(userReq, device));
    res.json({ devices });
  });

  app.get("/api/mobile/assignable-users", requireCapability("mobile.devices.manage"), (_req, res) => {
    const users = db.prepare(
      "SELECT uid, name, email, phone, role FROM users WHERE active = 1 ORDER BY name ASC LIMIT 500",
    ).all();
    res.json({ users });
  });

  app.patch("/api/mobile/devices/:id", requireCapability("mobile.devices.manage"), (req, res) => {
    const body = parse(updateDeviceSchema, req.body, res);
    if (!body) return;
    const userReq = req as AuthedRequest;
    res.json({ device: updateMobileDevice(options.ownerUid(), userReq.user.uid, String(req.params.id), body) });
  });

  app.post("/api/mobile/devices/:id/commands", (req, res, next) => {
    const body = parse(createCommandSchema, req.body, res);
    if (!body) return;
    const capability = body.type === "dial_request"
      ? "mobile.calls.execute"
      : body.type === "local_wipe"
        ? "mobile.device.wipe"
        : "mobile.devices.manage";
    requireCapability(capability)(req, res, () => {
      const userReq = req as unknown as AuthedRequest;
      const device = listMobileDevices(options.ownerUid()).find((item) => item.id === String(req.params.id));
      if (!device || !userCanSeeDevice(userReq, device)) {
        res.status(404).json({ error: "الجهاز غير موجود ضمن صلاحياتك." });
        return;
      }
      if (body.type === "local_wipe") {
        const recentAuth = !userReq.user.local && Number(userReq.user.authTime || 0) >= Date.now() - 10 * 60_000;
        if (!recentAuth) {
          res.status(403).json({ error: "أعد تسجيل الدخول قبل إرسال أمر مسح بيانات الجهاز." });
          return;
        }
        if (body.confirmationDeviceName !== String(device.name || "")) {
          res.status(400).json({ error: "اكتب اسم الجهاز كاملًا لتأكيد مسح بيانات BreeXe." });
          return;
        }
      }
      try {
        const command = createMobileCommand({
          ownerUid: options.ownerUid(), actorUid: userReq.user.uid,
          deviceId: String(req.params.id), type: body.type,
          payload: body.payload, expiresInSeconds: body.expiresInSeconds,
        });
        res.status(201).json({ command });
      } catch (error) {
        next(error);
      }
    });
  });

  app.get("/api/call-reply-policy", requireCapability("mobile.devices.view"), (req, res) => {
    const ownerUid = options.ownerUid();
    const userReq = req as AuthedRequest;
    const canManagePolicy = hasAppCapability(
      userReq.user.role,
      "mobile.reply_policy.manage",
      userReq.user.permissions || {},
    );
    const policy = getCallReplyPolicy(ownerUid);
    const outbound = outboundSafetyStatus();
    const whatsapp = whatsappService.getStatus();
    res.json({
      policy: canManagePolicy ? policy : { ...policy, numbers: [] },
      devices: listMobileDevices(ownerUid).filter((device) => userCanSeeDevice(userReq, device)),
      outboundSafety: { mode: outbound.mode, enabled: outbound.enabled },
      whatsapp: { provider: whatsapp.provider, status: whatsapp.status, configured: whatsapp.configured },
    });
  });

  app.put("/api/call-reply-policy", requireCapability("mobile.reply_policy.manage"), (req, res) => {
    const body = parse(policySchema, req.body, res);
    if (!body) return;
    const userReq = req as AuthedRequest;
    res.json({ policy: saveCallReplyPolicy(options.ownerUid(), userReq.user.uid, body) });
  });

  app.post("/api/call-reply-policy/preview", requireCapability("mobile.reply_policy.manage"), (req, res) => {
    const body = parse(previewSchema, req.body, res);
    if (!body) return;
    const date = body.occurredAt ? new Date(body.occurredAt) : new Date();
    res.json({
      message: renderCallReplyMessage(body.disposition as CallReplyDisposition, date),
      decision: body.phone ? evaluateCallReplyRecipient(options.ownerUid(), body.phone) : null,
    });
  });

  app.post(
    "/api/call-reply-policy/test",
    requireCapability("mobile.tests.send"),
    asyncRoute(async (req, res) => {
      const body = parse(testSchema, req.body, res);
      if (!body || !body.phone) return;
      const userReq = req as AuthedRequest;
      const ownerUid = options.ownerUid();
      const phone = normalizePolicyPhone(body.phone);
      if (!phone) {
        res.status(400).json({ error: "أدخل رقم واتساب صالحًا." });
        return;
      }
      const recent = db.prepare(
        `SELECT COUNT(*) AS count FROM outbound_test_runs
         WHERE owner_uid = ? AND actor_uid = ? AND created_at >= datetime('now','-1 hour')`,
      ).get(ownerUid, userReq.user.uid) as { count: number };
      if (Number(recent.count || 0) >= 5) {
        res.status(429).json({ error: "وصلت إلى الحد الأقصى: 5 تجارب خلال ساعة." });
        return;
      }
      const wa = whatsappService.getStatus();
      if (wa.provider !== "web" || wa.status !== "connected") {
        res.status(409).json({ error: "اربط واتساب ويب أولًا ثم أعد التجربة. لن تُحفظ التجربة للإرسال لاحقًا." });
        return;
      }
      const date = body.occurredAt ? new Date(body.occurredAt) : new Date();
      const message = renderCallReplyMessage(body.disposition as CallReplyDisposition, date);
      const id = testId();
      db.prepare(
        `INSERT INTO outbound_test_runs
          (id, owner_uid, actor_uid, phone, disposition, message, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'sending', ?)`,
      ).run(id, ownerUid, userReq.user.uid, phone, body.disposition, message, new Date().toISOString());
      try {
        const result = await whatsappService.sendText(phone, message, { oneTimeTestPhone: phone });
        if (isDryRunSendResult(result)) {
          db.prepare("UPDATE outbound_test_runs SET status = 'blocked', error = ? WHERE id = ?")
            .run(result.reason, id);
          res.status(409).json({ error: result.reason, testId: id, status: "blocked" });
          return;
        }
        const sentAt = new Date().toISOString();
        const messageId = String(result.messageId || "");
        db.prepare(
          "UPDATE outbound_test_runs SET status = 'sent', provider_message_id = ?, sent_at = ? WHERE id = ?",
        ).run(messageId || null, sentAt, id);
        recordWhatsAppMessage({
          type: "sent", provider: wa.provider, direction: "outbound", to_phone: phone,
          message, message_id: messageId || null, status: "sent", owner_uid: ownerUid,
          metadata: { kind: "call_reply_test", test_id: id, actor_uid: userReq.user.uid },
        });
        db.prepare(
          `INSERT INTO audit_logs
            (id, owner_uid, actor_uid, action, entity_type, entity_id, summary, after_data, created_at)
           VALUES (?, ?, ?, 'mobile.call_reply_test.sent', 'outbound_test', ?, ?, ?, ?)`,
        ).run(
          `audit_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
          ownerUid, userReq.user.uid, id, "إرسال تجربة رد مكالمة لمرة واحدة",
          JSON.stringify({ phone: "[redacted]", disposition: body.disposition, messageId }), sentAt,
        );
        res.json({ testId: id, status: "sent", sentAt, messageId, phone: `+${phone}`, message });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        db.prepare("UPDATE outbound_test_runs SET status = 'failed', error = ? WHERE id = ?")
          .run(messageText.slice(0, 1000), id);
        res.status(502).json({ error: "تعذر إرسال التجربة. تحقق من جلسة واتساب ثم أعد المحاولة.", detail: messageText, testId: id });
      }
    }),
  );
}
