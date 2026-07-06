/**
 * WhatsApp Cloud API webhook handler.
 *
 * Receives delivery/read receipts AND inbound customer messages from Meta
 * (directly or via Kapso.ai). Returns 200 immediately so Meta does not back
 * off delivery — all side effects (persistence, confirmation parsing,
 * reschedule logging) are best-effort and never bubble exceptions up.
 */
import { appendFileSync } from "fs";
import path from "path";
import crypto from "crypto";
import type { Request, Response } from "express";
import db from "./db";
import { recordCustomerConfirmation } from "./maintenanceLifecycle";
import {
  parseConfirmation,
  recordWhatsAppMessage,
  updateWhatsAppStatus,
} from "./whatsapp";
import { logError, logEvent, redactValue } from "./logger";

export type WhatsAppWebhookMessage = {
  from?: string;
  id?: string;
  timestamp?: string;
  text?: { body?: string };
  type?: string;
};

export type WhatsAppWebhookStatus = {
  id?: string;
  status?: "sent" | "delivered" | "read" | "failed" | string;
  timestamp?: string;
  recipient_id?: string;
};

export type WhatsAppWebhookValue = {
  metadata?: { phone_number_id?: string };
  messages?: WhatsAppWebhookMessage[];
  statuses?: WhatsAppWebhookStatus[];
};

export type WhatsAppWebhookPayload = {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{
      field?: string;
      value?: WhatsAppWebhookValue;
    }>;
  }>;
};

const RESCHEDULE_KEYWORDS = ["لا", "لأ", "no", "غير متاح", "ما اقدر", "ما اقدر اليوم", "غير ممكن"];
const TECH_ACK_KEYWORDS = ["تم", "موافق", "ok", "received", "received."];

function newId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function isReschedule(message: string | null | undefined): string | null {
  if (!message) return null;
  const lower = String(message).toLowerCase().trim();
  for (const keyword of RESCHEDULE_KEYWORDS) {
    if (lower === keyword || lower.startsWith(keyword + " ") || lower.endsWith(" " + keyword)) {
      return keyword;
    }
  }
  return null;
}

function isTechnicianAck(message: string | null | undefined): string | null {
  if (!message) return null;
  const lower = String(message).toLowerCase().trim();
  for (const keyword of TECH_ACK_KEYWORDS) {
    if (lower === keyword || lower.startsWith(keyword + " ")) return keyword;
  }
  return null;
}

function normalizePhone(phone: string | null | undefined): string {
  if (!phone) return "";
  let digits = String(phone).replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = `966${digits.slice(1)}`;
  if (digits.length === 9 && digits.startsWith("5")) digits = `966${digits}`;
  return digits;
}

/**
 * If the sender matches a technician phone associated with an unconfirmed
 * booking, mark that booking as technician-acknowledged.
 */
function recordTechnicianAck(ownerUid: string, phone: string) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  const tail = normalized.slice(-9);
  const tech = db
    .prepare("SELECT * FROM technicians WHERE phone LIKE ? LIMIT 1")
    .get(`%${tail}%`) as { id?: string } | undefined;
  if (!tech?.id) return null;
  const booking = db
    .prepare(
      `SELECT * FROM bookings
       WHERE technician_id = ? AND status = 'confirmed'
         AND (confirmed_by_technician IS NULL OR confirmed_by_technician = 0)
       ORDER BY date ASC, scheduled_time ASC LIMIT 1`,
    )
    .get(tech.id) as { id?: string } | undefined;
  if (!booking?.id) return null;
  db.prepare(
    `UPDATE bookings
     SET confirmed_by_technician = 1, technician_confirmed_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(new Date().toISOString(), new Date().toISOString(), booking.id);
  return { booking_id: booking.id, technician_id: tech.id };
}

/**
 * Logs a customer's reschedule request to maintenance_history so the admin
 * can follow up and pick a new date. Mirrors the existing reminded/cancelled
 * shape from maintenanceLifecycle.
 */
function recordRescheduleRequest(ownerUid: string, phone: string, body: string) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  const tail = normalized.slice(-9);
  const reminder = db
    .prepare(
      `SELECT * FROM reminders
       WHERE owner_uid = ? AND customer_phone LIKE ?
       ORDER BY sent_at DESC LIMIT 1`,
    )
    .get(ownerUid, `%${tail}%`) as Record<string, unknown> | undefined;
  if (!reminder?.installation_id) return null;
  db.prepare(
    `INSERT INTO maintenance_history (
      id, installation_id, customer_id, action, old_value, new_value, performed_by, notes, metadata, created_at
    ) VALUES (?, ?, ?, 'reminded', ?, 'reschedule_needed', ?, ?, ?, datetime('now'))`,
  ).run(
    newId("mh"),
    reminder.installation_id,
    reminder.customer_id || null,
    String(reminder.remind_type || "unknown"),
    ownerUid,
    body.slice(0, 280),
    JSON.stringify({ source: "customer_reply", customer_phone: phone }),
  );
  return { installation_id: reminder.installation_id, reminder_id: reminder.id };
}

export function verifyWebhook(req: Request, res: Response): void {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  const expected = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || "";

  if (mode === "subscribe" && expected && token === expected) {
    res.status(200).type("text/plain").send(String(challenge ?? ""));
    return;
  }
  res.status(403).json({ error: "Invalid verify token" });
}

/** Constant-time hex/string compare that won't throw on length mismatch. */
function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * Authenticate an inbound WhatsApp webhook POST. Returns `null` when the
 * request is genuine, or an `{ status, error }` to reject with.
 *
 * Two proofs are accepted (either suffices):
 *   1. Meta's `x-hub-signature-256: sha256=<hmac>` over the *raw* body, keyed
 *      with `WHATSAPP_APP_SECRET` (the Meta App Secret).
 *   2. A shared-secret header `x-whatsapp-webhook-secret` === `WHATSAPP_WEBHOOK_SECRET`
 *      — for Kapso.ai forwarding or manual setups that cannot replay Meta's sig.
 *
 * Fail-closed: in production, if neither secret is configured the endpoint is
 * refused (503) rather than silently accepting forged inbound. In dev/local the
 * unsigned path is allowed so the qa-suite and local tunnels keep working.
 */
export function verifyWhatsAppWebhookAuth(
  req: Request & { rawBody?: Buffer },
): { status: number; error: string } | null {
  const appSecret = process.env.WHATSAPP_APP_SECRET || "";
  const sharedSecret = process.env.WHATSAPP_WEBHOOK_SECRET || "";
  const isProd = process.env.NODE_ENV === "production";

  if (!appSecret && !sharedSecret) {
    if (isProd) {
      return { status: 503, error: "WhatsApp webhook secret is not configured." };
    }
    return null; // dev/local convenience only
  }

  // Proof 1: shared-secret header.
  if (sharedSecret) {
    const provided = req.get("x-whatsapp-webhook-secret") || "";
    if (provided && safeEquals(provided, sharedSecret)) return null;
  }

  // Proof 2: Meta HMAC-SHA256 over the raw request body.
  if (appSecret) {
    const header = req.get("x-hub-signature-256") || "";
    const sig = header.startsWith("sha256=") ? header.slice("sha256=".length) : header;
    const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
    const expected = crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
    if (sig && safeEquals(sig.toLowerCase(), expected)) return null;
  }

  return { status: 401, error: "Invalid or missing WhatsApp webhook signature." };
}

export async function handleWebhook(
  req: Request & { body?: WhatsAppWebhookPayload },
  res: Response,
  options: { ownerUid: string },
): Promise<void> {
  const body = (req.body || {}) as WhatsAppWebhookPayload;
  const ownerUid = options.ownerUid;

  try {
    const entries = Array.isArray(body.entry) ? body.entry : [];
    const summary: Array<Record<string, unknown>> = [];

    for (const entry of entries) {
      const changes = Array.isArray(entry?.changes) ? entry.changes : [];
      for (const change of changes) {
        const value = (change?.value || {}) as WhatsAppWebhookValue;
        const messages = Array.isArray(value.messages) ? value.messages : [];
        const statuses = Array.isArray(value.statuses) ? value.statuses : [];

        for (const message of messages) {
          // Meta retries webhook deliveries until it gets a 200; skip a message
          // already recorded so we don't double-record or re-run confirmations.
          if (message?.id) {
            const seen = db
              .prepare("SELECT 1 FROM whatsapp_messages WHERE message_id = ? AND direction = 'inbound' LIMIT 1")
              .get(String(message.id));
            if (seen) continue;
          }
          const text = message?.text?.body || "";
          // 1. Persist inbound message for the conversation viewer.
          recordWhatsAppMessage({
            type: "received",
            provider: "cloud_api",
            direction: "inbound",
            from_phone: message?.from,
            to_phone: value?.metadata?.phone_number_id || null,
            message: text,
            message_id: message?.id,
            status: "delivered",
            owner_uid: ownerUid,
            metadata: { wa_type: message?.type, timestamp: message?.timestamp },
          });

          // 2. Confirmation keyword → stop reminders for that installation.
          const confirmed = parseConfirmation(text);
          if (confirmed) {
            try {
              const conf = recordCustomerConfirmation(ownerUid, String(message?.from || ""), text);
              summary.push({ kind: "confirmation", phone: message?.from, matched_keyword: confirmed, ...conf });
            } catch (err) {
              logError("whatsapp.webhook.confirmation_save_failed", err);
            }
          } else {
            // 3. Reschedule keyword → flag for admin follow-up.
            const reschedule = isReschedule(text);
            if (reschedule) {
              try {
                const r = recordRescheduleRequest(ownerUid, String(message?.from || ""), text);
                if (r) summary.push({ kind: "reschedule_request", phone: message?.from, matched_keyword: reschedule, ...r });
              } catch (err) {
                logError("whatsapp.webhook.reschedule_save_failed", err);
              }
            }
          }

          // 4. Technician acknowledgement → mark booking as confirmed.
          const ack = isTechnicianAck(text);
          if (ack) {
            try {
              const a = recordTechnicianAck(ownerUid, String(message?.from || ""));
              if (a) summary.push({ kind: "technician_ack", phone: message?.from, matched_keyword: ack, ...a });
            } catch (err) {
              logError("whatsapp.webhook.tech_ack_save_failed", err);
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
            // Receipt arrived for an unknown wam_id (e.g. message sent outside
            // this CRM). Log it so /conversations surfaces it anyway.
            recordWhatsAppMessage({
              type: "status",
              provider: "cloud_api",
              direction: "outbound",
              to_phone: status?.recipient_id || null,
              message_id: messageId,
              status: String(status?.status || "unknown"),
              owner_uid: ownerUid,
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
      try {
        const line = `${new Date().toISOString()} ${JSON.stringify(redactValue(summary))}\n`;
        appendFileSync(path.join(process.cwd(), ".whatsapp-webhook.log"), line, "utf8");
      } catch {
        // best-effort
      }
      logEvent("info", "whatsapp.webhook.events", { events: summary.length, summary });
    }

    res.status(200).json({ received: true, events: summary.length });
  } catch (error) {
    logError("whatsapp.webhook.handler_failed", error);
    // Meta requires a 200 even on internal errors to avoid retries cascading.
    res.status(200).json({ received: false });
  }
}
