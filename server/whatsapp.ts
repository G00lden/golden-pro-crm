import crypto from "crypto";
import { rm } from "fs/promises";
import path from "path";
import type { Boom } from "@hapi/boom";
import QRCode from "qrcode";
import db from "./db";
import { decideOutbound, dryRunSendResult, outboundSafetyStatus, type OutboundSendOptions } from "./outboundSafety";
import { renderTemplate, type RenderVars, type TemplateName } from "./whatsappTemplates";

export type WhatsAppConnectionStatus =
  | "disconnected"
  | "connecting"
  | "qr_pending"
  | "connected"
  | "error";

export type WhatsAppStatus = {
  status: WhatsAppConnectionStatus;
  provider: "web" | "cloud_api";
  qr?: string;
  lastError?: string;
  template?: string;
  user?: string;
  connectedAt?: string;
  outbound?: ReturnType<typeof outboundSafetyStatus>;
  updatedAt: string;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class WhatsAppService {
  private sock: any;
  private status: WhatsAppConnectionStatus = "disconnected";
  private qrDataUrl = "";
  private lastError = "";
  private user = "";
  private connectedAt = "";
  private starting?: Promise<void>;
  private manualDisconnect = false;
  private waiters = new Set<() => void>();
  private readonly sessionDir: string;
  private readonly provider: "web" | "cloud_api";

  // Auto-reply hooks (registered by server/whatsappAutoReply.ts). Kept as
  // callbacks so whatsapp.ts has no dependency on the routing engine.
  private incomingCallHandler?: (fromPhone: string) => void | Promise<void>;
  private inboundMessageHandler?: (fromPhone: string, text: string) => void | Promise<void>;
  private handledCalls = new Set<string>();
  private answeredCalls = new Set<string>();

  constructor(sessionDir = process.env.WA_SESSION_DIR || ".wa-session") {
    this.sessionDir = path.resolve(process.cwd(), sessionDir);
    this.provider = process.env.WHATSAPP_PROVIDER === "cloud_api" ? "cloud_api" : "web";
  }

  /** Register a handler fired when an incoming WhatsApp call is NOT answered. */
  onIncomingCall(handler: (fromPhone: string) => void | Promise<void>) {
    this.incomingCallHandler = handler;
  }

  /** Register a handler fired for each inbound WhatsApp text message. */
  onInboundMessage(handler: (fromPhone: string, text: string) => void | Promise<void>) {
    this.inboundMessageHandler = handler;
  }

  private jidToPhone(jid: string | undefined): string {
    return String(jid || "").split("@")[0].split(":")[0];
  }

  getStatus(): WhatsAppStatus {
    if (this.provider === "cloud_api") {
      const configured = Boolean(this.cloudToken() && this.cloudPhoneNumberId());
      if (configured && !this.connectedAt) this.connectedAt = new Date().toISOString();
      return {
        provider: this.provider,
        status: configured ? "connected" : "error",
        lastError: configured ? this.lastError || undefined : "WhatsApp Cloud API credentials are missing.",
        template: this.cloudTemplateName() || undefined,
        user: this.cloudPhoneNumberId() || undefined,
        connectedAt: configured ? this.connectedAt || new Date().toISOString() : undefined,
        outbound: outboundSafetyStatus(),
        updatedAt: new Date().toISOString(),
      };
    }

    return {
      provider: this.provider,
      status: this.status,
      qr: this.qrDataUrl || undefined,
      lastError: this.lastError || undefined,
      user: this.user || undefined,
      connectedAt: this.connectedAt || undefined,
      outbound: outboundSafetyStatus(),
      updatedAt: new Date().toISOString(),
    };
  }

  async connect(): Promise<WhatsAppStatus> {
    if (this.provider === "cloud_api") return this.getStatus();

    if (this.status === "connected" || this.status === "qr_pending") {
      return this.getStatus();
    }

    if (this.status !== "connecting" || !this.sock) {
      await this.startSocket();
    }
    await this.waitForReadySignal(10_000);
    return this.getStatus();
  }

  async disconnect(): Promise<WhatsAppStatus> {
    if (this.provider === "cloud_api") {
      this.lastError = "";
      return this.getStatus();
    }

    this.manualDisconnect = true;
    this.qrDataUrl = "";
    this.user = "";
    this.connectedAt = "";
    this.lastError = "";
    this.status = "disconnected";
    this.notifyWaiters();

    try {
      await this.sock?.logout?.();
    } catch {
      // Logging out can fail when the socket is already closed.
    }

    try {
      this.sock?.end?.(new Error("Manual WhatsApp disconnect"));
    } catch {
      // Older Baileys sockets may not expose end().
    }

    this.sock = undefined;
    this.starting = undefined;
    await rm(this.sessionDir, { recursive: true, force: true });
    return this.getStatus();
  }

  async sendText(phone: string, message: string, options: OutboundSendOptions = {}) {
    const decision = decideOutbound(phone, options);
    if (!decision.allowed) {
      return dryRunSendResult(phone, this.provider, decision.reason);
    }

    if (this.provider === "cloud_api") return this.sendCloudText(phone, message);

    if (this.status !== "connected" || !this.sock) {
      throw new Error("WhatsApp is not connected.");
    }

    const jid = this.toJid(phone);
    const result = await this.sock.sendMessage(jid, { text: message });
    return { jid, messageId: result?.key?.id || null };
  }

  private async startSocket() {
    if (this.starting) return this.starting;

    this.manualDisconnect = false;
    this.status = "connecting";
    this.lastError = "";
    this.notifyWaiters();

    this.starting = this.createSocket()
      .catch((error) => {
        this.status = "error";
        this.lastError = error instanceof Error ? error.message : String(error);
        this.sock = undefined;
        this.notifyWaiters();
        throw error;
      })
      .finally(() => {
        this.starting = undefined;
      });

    return this.starting;
  }

  private async createSocket() {
    const [
      {
        default: makeWASocket,
        DisconnectReason,
        fetchLatestBaileysVersion,
        useMultiFileAuthState,
      },
      { default: pino },
    ] = await Promise.all([
      import("@whiskeysockets/baileys"),
      import("pino"),
    ]);

    const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      auth: state,
      browser: ["Breexe Pro CRM", "Chrome", "1.0.0"],
      logger: pino({ level: process.env.WA_LOG_LEVEL || "silent" }) as any,
      printQRInTerminal: false,
      version,
    });

    this.sock = sock;
    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update: any) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.qrDataUrl = await QRCode.toDataURL(qr);
        this.status = "qr_pending";
        this.notifyWaiters();
      }

      if (connection === "open") {
        this.status = "connected";
        this.qrDataUrl = "";
        this.lastError = "";
        this.user = sock.user?.id || "";
        this.connectedAt = this.connectedAt || new Date().toISOString();
        this.notifyWaiters();
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        const shouldReconnect =
          !this.manualDisconnect && statusCode !== DisconnectReason.loggedOut;
        // (call/message handlers are bound once below; nothing to clean here)

        this.sock = undefined;
        this.qrDataUrl = "";
        this.user = "";
        this.connectedAt = "";
        this.status = shouldReconnect ? "connecting" : "disconnected";
        this.lastError = lastDisconnect?.error?.message || "";
        this.notifyWaiters();

        if (shouldReconnect) {
          await sleep(2_000);
          await this.startSocket();
        }
      }
    });

    // Incoming WhatsApp calls → fire the missed-call auto-reply when the call
    // is not answered (timeout/reject). Optionally auto-reject the call first.
    sock.ev.on("call", async (calls: any[]) => {
      for (const call of calls || []) {
        const id = String(call?.id || "");
        const fromPhone = this.jidToPhone(call?.from || call?.chatId);
        if (!id || !fromPhone) continue;
        const status = String(call?.status || "");

        if (status === "accept") {
          this.answeredCalls.add(id);
          continue;
        }

        const autoReject = process.env.WHATSAPP_AUTO_REJECT_CALLS === "true";
        if (status === "offer" && autoReject) {
          try {
            await this.sock?.rejectCall?.(call.id, call.from);
          } catch {
            // older Baileys may lack rejectCall; the timeout path still fires.
          }
        }

        // Treat a non-answered terminal status (or a rejected offer) as missed.
        const isMissed = status === "timeout" || status === "reject" || (status === "offer" && autoReject);
        if (isMissed && !this.answeredCalls.has(id) && !this.handledCalls.has(id)) {
          this.handledCalls.add(id);
          // bound memory: keep the set from growing unbounded
          if (this.handledCalls.size > 500) this.handledCalls.clear();
          try {
            await this.incomingCallHandler?.(fromPhone);
          } catch (err) {
            // best-effort; never break the socket
            void err;
          }
        }
      }
    });

    // Inbound text messages → routing (e.g. caller replies with a department
    // digit). Skips our own messages, groups, and status broadcasts.
    sock.ev.on("messages.upsert", async (payload: any) => {
      if (!this.inboundMessageHandler) return;
      const messages = Array.isArray(payload?.messages) ? payload.messages : [];
      for (const m of messages) {
        try {
          if (!m?.message || m.key?.fromMe) continue;
          const jid = String(m.key?.remoteJid || "");
          if (!jid.endsWith("@s.whatsapp.net")) continue; // ignore groups/status
          const text =
            m.message?.conversation ||
            m.message?.extendedTextMessage?.text ||
            m.message?.buttonsResponseMessage?.selectedButtonId ||
            m.message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
            "";
          const fromPhone = this.jidToPhone(jid);
          if (!fromPhone || !text) continue;
          await this.inboundMessageHandler(fromPhone, String(text));
        } catch (err) {
          void err;
        }
      }
    });
  }

  private async waitForReadySignal(timeoutMs: number) {
    if (this.status === "connected" || this.status === "qr_pending" || this.status === "error") {
      return;
    }

    await Promise.race([
      new Promise<void>((resolve) => {
        const waiter = () => {
          if (this.status === "connected" || this.status === "qr_pending" || this.status === "error") {
            this.waiters.delete(waiter);
            resolve();
          }
        };
        this.waiters.add(waiter);
      }),
      sleep(timeoutMs),
    ]);
  }

  private notifyWaiters() {
    for (const waiter of [...this.waiters]) waiter();
  }

  private toJid(phone: string) {
    let digits = String(phone || "").replace(/\D/g, "");
    if (digits.startsWith("00")) digits = digits.slice(2);
    if (digits.startsWith("0")) digits = `966${digits.slice(1)}`;
    if (digits.length === 9 && digits.startsWith("5")) digits = `966${digits}`;

    if (!/^\d{10,15}$/.test(digits)) {
      throw new Error("Invalid WhatsApp phone number.");
    }

    return `${digits}@s.whatsapp.net`;
  }

  private toInternationalPhone(phone: string) {
    let digits = String(phone || "").replace(/\D/g, "");
    if (digits.startsWith("00")) digits = digits.slice(2);
    if (digits.startsWith("0")) digits = `966${digits.slice(1)}`;
    if (digits.length === 9 && digits.startsWith("5")) digits = `966${digits}`;

    if (!/^\d{10,15}$/.test(digits)) {
      throw new Error("Invalid WhatsApp phone number.");
    }

    return digits;
  }

  private cloudToken() {
    return process.env.WHATSAPP_CLOUD_API_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN || "";
  }

  private cloudPhoneNumberId() {
    return process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID || "";
  }

  private cloudTemplateName() {
    return process.env.WHATSAPP_CLOUD_TEMPLATE_NAME || process.env.WHATSAPP_TEMPLATE_NAME || "";
  }

  private cloudTemplateLanguage() {
    return process.env.WHATSAPP_CLOUD_TEMPLATE_LANGUAGE || process.env.WHATSAPP_TEMPLATE_LANGUAGE || "ar";
  }

  private buildCloudPayload(to: string, message: string) {
    const templateName = this.cloudTemplateName();
    if (!templateName) {
      return {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: {
          preview_url: false,
          body: message,
        },
      };
    }

    return {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "template",
      template: {
        name: templateName,
        language: {
          code: this.cloudTemplateLanguage(),
        },
        components: [
          {
            type: "body",
            parameters: [
              {
                type: "text",
                text: message,
              },
            ],
          },
        ],
      },
    };
  }

  private async sendCloudText(phone: string, message: string) {
    const token = this.cloudToken();
    const phoneNumberId = this.cloudPhoneNumberId();
    if (!token || !phoneNumberId) {
      throw new Error("WhatsApp Cloud API credentials are missing.");
    }

    const to = this.toInternationalPhone(phone);
    const version = process.env.WHATSAPP_CLOUD_API_VERSION || "v23.0";
    const response = await fetch(`https://graph.facebook.com/${version}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(this.buildCloudPayload(to, message)),
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const details = body?.error?.message || `HTTP ${response.status}`;
      this.lastError = details;
      throw new Error(`WhatsApp Cloud API error: ${details}`);
    }

    this.lastError = "";
    return {
      jid: `${to}@s.whatsapp.net`,
      messageId: body?.messages?.[0]?.id || null,
      provider: this.provider,
    };
  }
}

export const whatsappService = new WhatsAppService();

// ===========================================================================
// Message log + template send + conversation reader
// ===========================================================================

export type MessageDirection = "inbound" | "outbound";
export type MessageType = "sent" | "received" | "template" | "status";

type RecordOptions = {
  type: MessageType;
  provider: "web" | "cloud_api";
  direction: MessageDirection;
  from_phone?: string | null;
  to_phone?: string | null;
  message?: string | null;
  template_name?: string | null;
  message_id?: string | null;
  status?: string | null;
  installation_id?: string | null;
  booking_id?: string | null;
  owner_uid?: string | null;
  metadata?: Record<string, unknown> | null;
};

function newMsgId() {
  return `wam_${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`;
}

function nowIsoMsg() {
  return new Date().toISOString();
}

function normalizePhone(phone: string | null | undefined) {
  if (!phone) return "";
  let digits = String(phone).replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = `966${digits.slice(1)}`;
  if (digits.length === 9 && digits.startsWith("5")) digits = `966${digits}`;
  return digits;
}

export function recordWhatsAppMessage(opts: RecordOptions): string {
  const id = newMsgId();
  db.prepare(
    `INSERT INTO whatsapp_messages (
      id, type, provider, from_phone, to_phone, message, template_name, message_id,
      status, direction, installation_id, booking_id, owner_uid, metadata, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.type,
    opts.provider,
    normalizePhone(opts.from_phone) || null,
    normalizePhone(opts.to_phone) || null,
    opts.message || null,
    opts.template_name || null,
    opts.message_id || null,
    opts.status || null,
    opts.direction,
    opts.installation_id || null,
    opts.booking_id || null,
    opts.owner_uid || null,
    opts.metadata ? JSON.stringify(opts.metadata) : null,
    nowIsoMsg(),
    nowIsoMsg(),
  );
  return id;
}

export function updateWhatsAppStatus(messageId: string, status: string, extras: Record<string, unknown> = {}) {
  const row = db
    .prepare("SELECT id, metadata FROM whatsapp_messages WHERE message_id = ?")
    .get(messageId) as { id: string; metadata?: string } | undefined;
  if (!row) return false;
  const mergedMeta = (() => {
    try {
      const existing = row.metadata ? JSON.parse(row.metadata) : {};
      return { ...existing, ...extras };
    } catch {
      return extras;
    }
  })();
  db.prepare("UPDATE whatsapp_messages SET status = ?, metadata = ?, updated_at = ? WHERE id = ?").run(
    status,
    JSON.stringify(mergedMeta),
    nowIsoMsg(),
    row.id,
  );
  return true;
}

/**
 * Returns the conversation history for a single customer phone, ordered
 * oldest-first. Always normalizes phone to international format so callers
 * don't have to pre-format.
 */
export function getConversation(phone: string, ownerUid?: string, limit = 200) {
  const normalized = normalizePhone(phone);
  const tail = normalized.slice(-9); // tolerate 9- or 12-digit storage
  const sql = ownerUid
    ? `SELECT * FROM whatsapp_messages
       WHERE owner_uid = ? AND (from_phone LIKE ? OR to_phone LIKE ?)
       ORDER BY created_at ASC LIMIT ?`
    : `SELECT * FROM whatsapp_messages
       WHERE (from_phone LIKE ? OR to_phone LIKE ?)
       ORDER BY created_at ASC LIMIT ?`;
  const args = ownerUid
    ? [ownerUid, `%${tail}`, `%${tail}`, limit]
    : [`%${tail}`, `%${tail}`, limit];
  const rows = db.prepare(sql).all(...args) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    ...row,
    metadata: row.metadata ? safeJsonWa(row.metadata as string) : null,
  }));
}

function safeJsonWa(raw: string) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Sends a template message via the configured provider, records the outbound
 * message, and returns the provider result. Cloud API uses Meta-approved
 * templates when WHATSAPP_CLOUD_TEMPLATE_NAME is set; otherwise the rendered
 * text is sent as a plain message.
 */
export async function sendWhatsAppTemplate(opts: {
  phone: string;
  template: TemplateName;
  vars?: RenderVars;
  installation_id?: string;
  booking_id?: string;
  owner_uid?: string;
  outboundCode?: string;
}) {
  const body = renderTemplate(opts.template, opts.vars || {});
  const result = await whatsappService.sendText(opts.phone, body, { confirmationCode: opts.outboundCode });

  recordWhatsAppMessage({
    type: "template",
    provider: whatsappService.getStatus().provider,
    direction: "outbound",
    from_phone: null,
    to_phone: opts.phone,
    message: body,
    template_name: opts.template,
    message_id: result?.messageId || null,
    status: (result as { dryRun?: boolean })?.dryRun ? "dry_run" : "sent",
    installation_id: opts.installation_id,
    booking_id: opts.booking_id,
    owner_uid: opts.owner_uid,
    metadata: { template: opts.template, vars: opts.vars || {} },
  });

  return { ...result, template: opts.template, body };
}

const CONFIRMATION_KEYWORDS = ["نعم", "تمام", "موافق", "اوكي", "أوكي", "ok", "yes", "confirm"];

/**
 * Checks an inbound text for confirmation keywords. Returns the matched
 * keyword or null. Caller is responsible for triggering downstream side
 * effects (e.g. recordCustomerConfirmation in maintenanceLifecycle).
 */
/**
 * Returns the latest N WhatsApp messages across all phones for the activity
 * feed shown on the operator console. When `ownerUid` is given, scopes to
 * that user's records.
 */
export function listRecentMessages(opts: { ownerUid?: string; limit?: number } = {}) {
  const limit = Math.min(500, opts.limit || 50);
  const sql = opts.ownerUid
    ? `SELECT * FROM whatsapp_messages WHERE owner_uid = ? ORDER BY created_at DESC LIMIT ?`
    : `SELECT * FROM whatsapp_messages ORDER BY created_at DESC LIMIT ?`;
  const args = opts.ownerUid ? [opts.ownerUid, limit] : [limit];
  const rows = db.prepare(sql).all(...args) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    ...row,
    metadata: row.metadata ? safeJsonWa(row.metadata as string) : null,
  }));
}

/**
 * Per-day WhatsApp counters powering the operator console mini-stats.
 */
export function whatsAppStats(ownerUid?: string) {
  const today = new Date().toISOString().slice(0, 10);
  const where = ownerUid ? "owner_uid = ? AND" : "";
  const args = ownerUid ? [ownerUid, `${today}%`] : [`${today}%`];
  const count = (sql: string, extra: unknown[] = []) =>
    (db.prepare(sql).get(...args, ...extra) as { c: number }).c;

  const todaySent = count(
    `SELECT COUNT(*) AS c FROM whatsapp_messages WHERE ${where} created_at LIKE ? AND direction = 'outbound'`,
  );
  const todayDelivered = count(
    `SELECT COUNT(*) AS c FROM whatsapp_messages WHERE ${where} created_at LIKE ? AND status = 'delivered'`,
  );
  const todayRead = count(
    `SELECT COUNT(*) AS c FROM whatsapp_messages WHERE ${where} created_at LIKE ? AND status = 'read'`,
  );
  const todayFailed = count(
    `SELECT COUNT(*) AS c FROM whatsapp_messages WHERE ${where} created_at LIKE ? AND status = 'failed'`,
  );
  const todayInbound = count(
    `SELECT COUNT(*) AS c FROM whatsapp_messages WHERE ${where} created_at LIKE ? AND direction = 'inbound'`,
  );

  return {
    today: { sent: todaySent, delivered: todayDelivered, read: todayRead, failed: todayFailed, inbound: todayInbound },
  };
}

export function parseConfirmation(message: string | undefined | null): string | null {
  if (!message) return null;
  const lower = String(message).toLowerCase().trim();
  for (const keyword of CONFIRMATION_KEYWORDS) {
    if (lower === keyword || lower.startsWith(keyword + " ") || lower.endsWith(" " + keyword)) {
      return keyword;
    }
  }
  return null;
}
