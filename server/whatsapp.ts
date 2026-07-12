import crypto from "crypto";
import { rm } from "fs/promises";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import path from "path";
import type { Boom } from "@hapi/boom";
import QRCode from "qrcode";
import db from "./db";
import { decideOutbound, dryRunSendResult, outboundSafetyStatus, type OutboundSendOptions } from "./outboundSafety";
import { cloudTemplateEnvKey, renderTemplate, templateToCloudParams, type RenderVars, type TemplateName } from "./whatsappTemplates";
import { normalizePhoneDigits, requirePhoneDigits } from "../shared/phone";
import { advanceMessageStatus } from "./communicationStatus";

export type WhatsAppConnectionStatus =
  | "disconnected"
  | "connecting"
  | "qr_pending"
  | "connected"
  | "error";

export type WhatsAppStatus = {
  status: WhatsAppConnectionStatus;
  provider: "web" | "cloud_api";
  configured?: boolean;
  verifiedAt?: string;
  qr?: string;
  lastError?: string;
  template?: string;
  user?: string;
  connectedAt?: string;
  outbound?: ReturnType<typeof outboundSafetyStatus>;
  updatedAt: string;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** True if a process with this PID is currently running. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process (dead). EPERM = exists but not ours (alive).
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

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
  private cloudVerifiedAt = "";

  // Auto-reply hooks (registered by server/whatsappAutoReply.ts). Kept as
  // callbacks so whatsapp.ts has no dependency on the routing engine.
  private incomingCallHandler?: (fromPhone: string) => void | Promise<void>;
  private inboundMessageHandler?: (fromPhone: string, text: string) => void | Promise<void>;
  private handledCalls = new Set<string>();
  private answeredCalls = new Set<string>();

  // Add to a call-dedup set, evicting only the OLDEST entry when over the cap.
  // (A full clear() would drop every id, so a late terminal event for an
  // already-handled call could re-fire the missed-call apology.)
  private boundedAdd(set: Set<string>, id: string, limit = 500) {
    set.add(id);
    if (set.size > limit) {
      const oldest = set.values().next().value;
      if (oldest !== undefined) set.delete(oldest);
    }
  }

  // Cache of recently-sent message content, keyed by message id. When a
  // recipient's device can't decrypt a message it shows "Waiting for this
  // message" and auto-sends a retry receipt; Baileys then calls getMessage() to
  // re-encrypt and resend the original. Without this cache those messages can
  // never be recovered and stay stuck as "Waiting for this message".
  private sentMessages = new Map<string, unknown>();
  private static readonly SENT_CACHE_LIMIT = 1000;

  // Ids of inbound messages already routed, so a reconnect/redelivery doesn't
  // re-process the same "نعم" and re-confirm reminders or re-fire auto-replies.
  private processedInboundIds = new Set<string>();
  private static readonly INBOUND_DEDUP_LIMIT = 2000;

  private isDuplicateInbound(id: string | null | undefined): boolean {
    if (!id) return false;
    if (this.processedInboundIds.has(id)) return true;
    this.processedInboundIds.add(id);
    if (this.processedInboundIds.size > WhatsAppService.INBOUND_DEDUP_LIMIT) {
      const oldest = this.processedInboundIds.values().next().value;
      if (oldest !== undefined) this.processedInboundIds.delete(oldest);
    }
    return false;
  }

  private rememberSentMessage(id: string | null | undefined, content: unknown) {
    if (!id || !content) return;
    this.sentMessages.set(id, content);
    if (this.sentMessages.size > WhatsAppService.SENT_CACHE_LIMIT) {
      const oldest = this.sentMessages.keys().next().value;
      if (oldest !== undefined) this.sentMessages.delete(oldest);
    }
  }

  /**
   * Content Baileys should resend when a recipient's retry receipt arrives.
   * Falls back to the persisted message text so retries still work after a
   * server restart (when the in-memory cache is empty).
   */
  private resolveOutgoingMessage(id?: string | null): unknown {
    if (!id) return undefined;
    const cached = this.sentMessages.get(id);
    if (cached) return cached;
    try {
      const row = db
        .prepare(
          "SELECT message FROM whatsapp_messages WHERE message_id = ? AND direction = 'outbound' ORDER BY created_at DESC LIMIT 1",
        )
        .get(id) as { message?: string } | undefined;
      if (row?.message) return { conversation: String(row.message) };
    } catch {
      /* DB unavailable — fall through */
    }
    return undefined;
  }

  private lockPath() {
    return path.join(this.sessionDir, ".instance.lock");
  }

  /**
   * Refuse to start if another *live* process already owns this WhatsApp
   * session. Two sockets on one session desync the Signal encryption ratchet,
   * which is the top cause of recipients seeing "Waiting for this message".
   * Stale locks (dead PID) are taken over automatically; set
   * WA_IGNORE_SESSION_LOCK=true to bypass.
   */
  private acquireSessionLock() {
    if (process.env.WA_IGNORE_SESSION_LOCK === "true") return;
    try {
      mkdirSync(this.sessionDir, { recursive: true });
    } catch {
      /* ignore */
    }
    try {
      const { pid } = JSON.parse(readFileSync(this.lockPath(), "utf8")) as { pid?: number };
      if (typeof pid === "number" && pid !== process.pid && isProcessAlive(pid)) {
        throw new Error(
          `WhatsApp session "${this.sessionDir}" is already in use by another running process (PID ${pid}). ` +
            `Running two instances on one session corrupts encryption and makes recipients see "Waiting for this message". ` +
            `Stop the other instance, or set WA_IGNORE_SESSION_LOCK=true to override.`,
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("already in use")) throw err;
      /* no/invalid lock file — safe to take over */
    }
    try {
      writeFileSync(this.lockPath(), JSON.stringify({ pid: process.pid, ts: Date.now() }));
    } catch {
      /* ignore */
    }
  }

  private releaseSessionLock() {
    try {
      const { pid } = JSON.parse(readFileSync(this.lockPath(), "utf8")) as { pid?: number };
      if (pid === process.pid) unlinkSync(this.lockPath());
    } catch {
      /* ignore */
    }
  }

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
      return {
        provider: this.provider,
        configured,
        status: !configured ? "error" : this.status === "connected" ? "connected" : this.lastError ? "error" : "connecting",
        lastError: configured ? this.lastError || undefined : "WhatsApp Cloud API credentials are missing.",
        template: this.cloudTemplateName() || undefined,
        user: this.cloudPhoneNumberId() || undefined,
        connectedAt: this.connectedAt || undefined,
        verifiedAt: this.cloudVerifiedAt || undefined,
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
    if (this.provider === "cloud_api") return this.verifyConnection(true);

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
    // Remember the content so Baileys can resend it if the recipient's device
    // fails to decrypt (retry receipt) — otherwise it stays "Waiting for this
    // message" on their side.
    this.rememberSentMessage(result?.key?.id, result?.message);
    return { jid, messageId: result?.key?.id || null };
  }

  /**
   * Verify provider readiness without sending a customer message. Cloud API
   * credentials are only considered connected after Meta accepts a read probe;
   * merely having environment variables is not proof that a token is valid.
   */
  async verifyConnection(force = false): Promise<WhatsAppStatus> {
    if (this.provider !== "cloud_api") return this.getStatus();

    const token = this.cloudToken();
    const phoneNumberId = this.cloudPhoneNumberId();
    if (!token || !phoneNumberId) {
      this.status = "error";
      this.lastError = "WhatsApp Cloud API credentials are missing.";
      return this.getStatus();
    }

    const verifiedMs = this.cloudVerifiedAt ? Date.parse(this.cloudVerifiedAt) : 0;
    if (!force && this.status === "connected" && Date.now() - verifiedMs < 60_000) {
      return this.getStatus();
    }

    this.status = "connecting";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(process.env.WHATSAPP_HTTP_TIMEOUT_MS || 10_000));
    try {
      const version = process.env.WHATSAPP_CLOUD_API_VERSION || "v23.0";
      const fields = "id,display_phone_number,verified_name,quality_rating";
      const response = await fetch(
        `https://graph.facebook.com/${version}/${phoneNumberId}?fields=${encodeURIComponent(fields)}`,
        { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal },
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body?.error?.message || `HTTP ${response.status}`);
      }
      this.status = "connected";
      this.lastError = "";
      this.cloudVerifiedAt = new Date().toISOString();
      if (!this.connectedAt) this.connectedAt = this.cloudVerifiedAt;
    } catch (error) {
      this.status = "error";
      this.connectedAt = "";
      this.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timeout);
    }
    return this.getStatus();
  }

  async sendTemplate(phone: string, template: TemplateName, vars: RenderVars = {}, options: OutboundSendOptions = {}) {
    const decision = decideOutbound(phone, options);
    if (!decision.allowed) {
      return dryRunSendResult(phone, this.provider, decision.reason);
    }
    if (this.provider === "cloud_api") return this.sendCloudTemplate(phone, template, vars);
    return this.sendText(phone, renderTemplate(template, vars, { strict: false }), options);
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
    // Guard against two processes sharing one session (ratchet desync).
    this.acquireSessionLock();

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
      // Lets Baileys resend a message when the recipient's device failed to
      // decrypt it (retry receipt). Fixes recipients seeing "Waiting for this
      // message. This may take a while." indefinitely.
      getMessage: async (key: any) => this.resolveOutgoingMessage(key?.id) as any,
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

        // Reconnecting keeps ownership; a terminal close (logout/manual) frees
        // the session lock so a fresh instance can take over cleanly.
        if (!shouldReconnect) this.releaseSessionLock();

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
          this.boundedAdd(this.answeredCalls, id);
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
          this.boundedAdd(this.handledCalls, id);
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
      // Only live messages. "append" carries history/offline sync that Baileys
      // replays on reconnect — processing it would re-route old confirmations.
      if (payload?.type && payload.type !== "notify") return;
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
          if (this.isDuplicateInbound(m.key?.id)) continue; // WhatsApp redelivery
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
    const digits = requirePhoneDigits(phone);
    return `${digits}@s.whatsapp.net`;
  }

  private toInternationalPhone(phone: string) {
    return requirePhoneDigits(phone);
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

  private buildCloudTextPayload(to: string, message: string) {
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

  private async postCloudPayload(to: string, payload: Record<string, unknown>) {
    const token = this.cloudToken();
    const phoneNumberId = this.cloudPhoneNumberId();
    if (!token || !phoneNumberId) throw new Error("WhatsApp Cloud API credentials are missing.");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(process.env.WHATSAPP_HTTP_TIMEOUT_MS || 10_000));
    try {
      const version = process.env.WHATSAPP_CLOUD_API_VERSION || "v23.0";
      const response = await fetch(`https://graph.facebook.com/${version}/${phoneNumberId}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const details = body?.error?.message || `HTTP ${response.status}`;
        this.status = "error";
        this.connectedAt = "";
        this.lastError = details;
        throw new Error(`WhatsApp Cloud API error: ${details}`);
      }
      this.status = "connected";
      this.lastError = "";
      this.cloudVerifiedAt = new Date().toISOString();
      if (!this.connectedAt) this.connectedAt = this.cloudVerifiedAt;
      return {
        jid: `${to}@s.whatsapp.net`,
        messageId: body?.messages?.[0]?.id || null,
        provider: this.provider,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async sendCloudTemplate(phone: string, template: TemplateName, vars: RenderVars) {
    const to = this.toInternationalPhone(phone);
    const envKey = cloudTemplateEnvKey(template);
    const templateName = process.env[envKey] || (template === "general_reminder" ? this.cloudTemplateName() : "");
    if (!templateName) throw new Error(`WhatsApp Cloud template mapping is missing: ${envKey}`);
    const rendered = templateToCloudParams(template, vars);
    const components = rendered.parameters?.length
      ? [{ type: "body", parameters: rendered.parameters }]
      : undefined;
    return this.postCloudPayload(to, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "template",
      template: {
        name: templateName,
        language: { code: this.cloudTemplateLanguage() },
        ...(components ? { components } : {}),
      },
    });
  }

  private async sendCloudText(phone: string, message: string) {
    const to = this.toInternationalPhone(phone);
    return this.postCloudPayload(to, this.buildCloudTextPayload(to, message));
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
    normalizePhoneDigits(opts.from_phone) || null,
    normalizePhoneDigits(opts.to_phone) || null,
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
    .prepare("SELECT id, status, metadata FROM whatsapp_messages WHERE message_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(messageId) as { id: string; status?: string; metadata?: string } | undefined;
  if (!row) return false;
  const mergedMeta = (() => {
    try {
      const existing = row.metadata ? JSON.parse(row.metadata) : {};
      return { ...existing, ...extras };
    } catch {
      return extras;
    }
  })();
  const nextStatus = advanceMessageStatus(row.status, status);
  db.prepare("UPDATE whatsapp_messages SET status = ?, metadata = ?, updated_at = ? WHERE id = ?").run(
    nextStatus,
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
  const normalized = normalizePhoneDigits(phone);
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
  // strict:false → a missing/empty variable becomes "" instead of leaking the
  // literal "{placeholder}" to the customer (e.g. "عزيزي {customer_name}،").
  const body = renderTemplate(opts.template, opts.vars || {}, { strict: false });
  const result = await whatsappService.sendTemplate(opts.phone, opts.template, opts.vars || {}, { confirmationCode: opts.outboundCode });

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
