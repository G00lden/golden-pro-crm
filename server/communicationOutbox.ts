import crypto from "crypto";
import db from "./db";
import { logError } from "./logger";
import { sendWhatsAppTemplate } from "./whatsapp";
import { renderTemplate, type RenderVars, type TemplateName } from "./whatsappTemplates";

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function normalizePhone(phone: string) {
  let digits = String(phone || "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = `966${digits.slice(1)}`;
  if (digits.length === 9 && digits.startsWith("5")) digits = `966${digits}`;
  return digits;
}

export type CommunicationJobInput = {
  ownerUid: string;
  idempotencyKey: string;
  callId?: string;
  role: "customer" | "agent" | "manager";
  phone: string;
  template: TemplateName;
  vars?: RenderVars;
};

/**
 * Durable, idempotent notification dispatch. WhatsApp is attempted first;
 * when it cannot send, one SMS is queued for the Android gateway.
 */
export async function dispatchCommunicationJob(input: CommunicationJobInput): Promise<{
  duplicate: boolean;
  channel: "whatsapp" | "sms" | "pending";
  jobId: string;
}> {
  const phone = normalizePhone(input.phone);
  if (!phone) throw new Error("A destination phone is required.");
  const body = renderTemplate(input.template, input.vars || {}, { strict: false });
  const jobId = newId("msgjob");
  const inserted = db.prepare(
    `INSERT OR IGNORE INTO communication_outbox
      (id, owner_uid, idempotency_key, call_id, role, to_phone, body, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).run(
    jobId,
    input.ownerUid,
    input.idempotencyKey,
    input.callId || null,
    input.role,
    phone,
    body,
    nowIso(),
    nowIso(),
  );

  const row = db.prepare(
    "SELECT * FROM communication_outbox WHERE owner_uid = ? AND idempotency_key = ?",
  ).get(input.ownerUid, input.idempotencyKey) as Record<string, unknown>;
  const actualId = String(row.id);
  if (inserted.changes === 0 && String(row.status) === "dispatched") {
    return {
      duplicate: true,
      channel: String(row.dispatched_channel) === "whatsapp" ? "whatsapp" : "sms",
      jobId: actualId,
    };
  }

  db.prepare(
    "UPDATE communication_outbox SET status = 'pending' WHERE id = ? AND status = 'processing' AND updated_at < ?",
  ).run(actualId, new Date(Date.now() - 5 * 60_000).toISOString());

  const claimed = db.prepare(
    "UPDATE communication_outbox SET status = 'processing', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'pending'",
  ).run(nowIso(), actualId);
  if (claimed.changes === 0) {
    return { duplicate: true, channel: "pending", jobId: actualId };
  }

  try {
    await sendWhatsAppTemplate({
      phone,
      template: input.template,
      vars: input.vars,
      owner_uid: input.ownerUid,
    });
    db.prepare(
      `UPDATE communication_outbox
       SET status = 'dispatched', dispatched_channel = 'whatsapp', dispatched_at = ?, error = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(nowIso(), nowIso(), actualId);
    return { duplicate: inserted.changes === 0, channel: "whatsapp", jobId: actualId };
  } catch (error) {
    logError("communication.whatsapp_failed_fallback_sms", error);
  }

  // The durable communication row is the idempotency guard: only enqueue the
  // SMS once even if the provider repeats its webhook after our response.
  if (String(row.status) !== "dispatched") {
    db.prepare(
      `INSERT OR IGNORE INTO gateway_outbox
        (id, owner_uid, to_phone, body, role, channel, status, call_id, communication_job_id, created_at)
       VALUES (?, ?, ?, ?, ?, 'sms', 'pending', ?, ?, ?)`,
    ).run(newId("sms"), input.ownerUid, phone, body, input.role, input.callId || null, actualId, nowIso());
  }
  db.prepare(
    `UPDATE communication_outbox
     SET status = 'dispatched', dispatched_channel = 'sms', dispatched_at = ?, error = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(nowIso(), nowIso(), actualId);
  return { duplicate: inserted.changes === 0, channel: "sms", jobId: actualId };
}
