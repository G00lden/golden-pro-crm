import crypto from "crypto";
import db from "./db";
import { isDryRunSendResult } from "./outboundSafety";
import { logError, logEvent } from "./logger";
import { recordWhatsAppMessage, whatsappService } from "./whatsapp";
import {
  AUTOMATION_DISPOSITIONS,
  companyMessage,
  isBusinessOpen,
  nextBusinessOpen,
  type BusinessSchedule,
  type CallDisposition,
} from "./callPolicy";

export type CallAutomationConfig = BusinessSchedule & {
  company_name: string;
  auto_reply_enabled: boolean;
  reply_cooldown_min: number;
  follow_up_sla_min: number;
  whatsapp_in_hours: string;
  whatsapp_after_hours: string;
};

type CallRow = Record<string, unknown> & {
  id: string;
  owner_uid: string;
  from_phone?: string;
  disposition?: CallDisposition;
};

type ActionRow = {
  id: string;
  owner_uid: string;
  call_id: string;
  action_key: string;
  action_type: string;
  recipient: string;
  body: string;
  attempts: number;
};

function newId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function nowIso(date = new Date()) {
  return date.toISOString();
}

function safeDate(value: unknown, fallback = new Date()): Date {
  const date = new Date(String(value || ""));
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function normalizePhone(phone: unknown): string {
  let digits = String(phone || "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = `966${digits.slice(1)}`;
  if (digits.length === 9 && digits.startsWith("5")) digits = `966${digits}`;
  return digits;
}

function callById(callId: string): CallRow | null {
  return (db.prepare("SELECT * FROM call_logs WHERE id = ?").get(callId) as CallRow | undefined) || null;
}

function ensureAgent(call: CallRow): CallRow {
  if (call.agent_phone) return call;
  const agent = db.prepare(
    `SELECT d.id AS department_id, d.name AS department_name,
            a.user_id AS agent_user_id, a.phone AS agent_phone, a.name AS agent_name
     FROM ivr_departments d
     LEFT JOIN ivr_department_agents a
       ON a.department_id = d.id AND a.active = 1 AND a.phone <> ''
     WHERE d.owner_uid = ? AND d.active = 1
     ORDER BY d.sort_order ASC, a.sort_order ASC, a.created_at ASC
     LIMIT 1`,
  ).get(call.owner_uid) as Record<string, unknown> | undefined;
  if (!agent) return call;
  db.prepare(
    `UPDATE call_logs SET department_id = COALESCE(department_id, ?),
       department_name = COALESCE(NULLIF(department_name, ''), ?),
       agent_user_id = COALESCE(agent_user_id, ?), agent_phone = COALESCE(agent_phone, ?),
       agent_name = COALESCE(agent_name, ?), updated_at = ? WHERE id = ?`,
  ).run(
    agent.department_id || null,
    agent.department_name || null,
    agent.agent_user_id || null,
    agent.agent_phone || null,
    agent.agent_name || null,
    nowIso(),
    call.id,
  );
  return callById(call.id) || call;
}

function ensureFollowUpTask(call: CallRow, config: CallAutomationConfig, inHours: boolean): string {
  if (call.follow_up_task_id) return String(call.follow_up_task_id);
  const existing = db.prepare(
    "SELECT id FROM crm_tasks WHERE owner_uid = ? AND related_type = 'call' AND related_id = ? LIMIT 1",
  ).get(call.owner_uid, call.id) as { id: string } | undefined;
  const taskId = existing?.id || newId("task");
  const occurredAt = safeDate(call.occurred_at || call.created_at);
  const due = inHours
    ? new Date(occurredAt.getTime() + Math.max(1, config.follow_up_sla_min) * 60_000)
    : nextBusinessOpen(config, occurredAt);
  if (!existing) {
    const customerPhone = normalizePhone(call.from_phone);
    db.prepare(
      `INSERT INTO crm_tasks
        (id, owner_uid, title, status, priority, due_date, assigned_to, related_type,
         related_id, customer_id, notes, created_at, updated_at)
       VALUES (?, ?, ?, 'open', 'high', ?, ?, 'call', ?, ?, ?, ?, ?)`,
    ).run(
      taskId,
      call.owner_uid,
      `متابعة مكالمة ${customerPhone || "غير معروفة"}`,
      nowIso(due),
      call.agent_user_id || call.agent_name || null,
      call.id,
      call.customer_id || null,
      `الحالة: ${call.disposition || "unknown"}. المصدر: ${call.source || "unknown"}. اتصل بالعميل خلال المهلة المحددة.`,
      nowIso(),
      nowIso(),
    );
  }
  db.prepare("UPDATE call_logs SET follow_up_task_id = ?, updated_at = ? WHERE id = ?")
    .run(taskId, nowIso(), call.id);
  return taskId;
}

function queueAction(call: CallRow, actionKey: string, actionType: string, recipient: string, body: string) {
  if (!recipient || !body) return false;
  const result = db.prepare(
    `INSERT OR IGNORE INTO call_action_runs
      (id, owner_uid, call_id, action_key, action_type, recipient, body, status, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
  ).run(
    newId("cact"),
    call.owner_uid,
    call.id,
    actionKey,
    actionType,
    normalizePhone(recipient),
    body,
    nowIso(),
    nowIso(),
    nowIso(),
  );
  return result.changes > 0;
}

function customerActionInCooldown(call: CallRow, minutes: number): boolean {
  if (minutes <= 0) return false;
  const phone = normalizePhone(call.from_phone);
  if (!phone) return false;
  const since = nowIso(new Date(Date.now() - minutes * 60_000));
  const found = db.prepare(
    `SELECT 1 FROM call_action_runs a
     JOIN call_logs c ON c.id = a.call_id
     WHERE a.owner_uid = ? AND a.action_key = 'customer_whatsapp'
       AND a.status IN ('pending','retry','sending','sent')
       AND c.id <> ? AND c.from_phone LIKE ? AND a.created_at >= ? LIMIT 1`,
  ).get(call.owner_uid, call.id, `%${phone.slice(-9)}`, since);
  return Boolean(found);
}

function ensureWhatsAppReconnectTask(ownerUid: string, reason: string) {
  const exists = db.prepare(
    `SELECT id FROM crm_tasks WHERE owner_uid = ? AND related_type = 'whatsapp_connection'
     AND status = 'open' LIMIT 1`,
  ).get(ownerUid);
  if (exists) return;
  const now = nowIso();
  db.prepare(
    `INSERT INTO crm_tasks
      (id, owner_uid, title, status, priority, due_date, assigned_to, related_type, related_id, notes, created_at, updated_at)
     VALUES (?, ?, ?, 'open', 'urgent', ?, 'manager', 'whatsapp_connection', 'web-session', ?, ?, ?)`,
  ).run(
    newId("task"),
    ownerUid,
    "إعادة ربط واتساب ويب",
    now,
    `جلسة واتساب غير متصلة. الرسائل محفوظة في الطابور. افتح شاشة واتساب وامسح رمز QR. الخطأ: ${reason}`,
    now,
    now,
  );
}

export function prepareCallAutomation(callId: string, config: CallAutomationConfig): Record<string, unknown> {
  let call = callById(callId);
  if (!call) return { prepared: false, reason: "unknown_call" };
  const disposition = String(call.disposition || "unknown") as CallDisposition;
  if (!config.auto_reply_enabled || !AUTOMATION_DISPOSITIONS.has(disposition)) {
    db.prepare("UPDATE call_logs SET action_state = 'not_applicable', updated_at = ? WHERE id = ?")
      .run(nowIso(), call.id);
    return { prepared: false, reason: "disposition_not_automated", disposition };
  }

  call = ensureAgent(call);
  const occurredAt = safeDate(call.occurred_at || call.created_at);
  const inHours = disposition !== "after_hours" && isBusinessOpen(config, occurredAt);
  ensureFollowUpTask(call, config, inHours);

  const customerPhone = normalizePhone(call.from_phone);
  const customerBody = companyMessage(
    inHours ? config.whatsapp_in_hours : config.whatsapp_after_hours,
    config.company_name,
  );
  const cooled = customerActionInCooldown(call, config.reply_cooldown_min);
  const customerQueued = cooled ? false : queueAction(call, "customer_whatsapp", "customer", customerPhone, customerBody);

  const alertPhone = normalizePhone(call.agent_phone || process.env.MANAGER_WHATSAPP_PHONE);
  const localTime = occurredAt.toLocaleString("ar-SA", { timeZone: config.timezone || "Asia/Riyadh" });
  const agentBody = `تنبيه: مكالمة ${disposition} من ${customerPhone || "رقم غير معروف"} بتاريخ ${localTime}. توجد مهمة متابعة في CRM.`;
  const agentQueued = queueAction(call, "agent_whatsapp", "agent", alertPhone, agentBody);

  db.prepare("UPDATE call_logs SET action_state = ?, updated_at = ? WHERE id = ?")
    .run(customerQueued || agentQueued ? "queued" : cooled ? "cooldown" : "task_created", nowIso(), call.id);
  logEvent("info", "call.automation.prepared", {
    callId,
    disposition,
    inHours,
    cooled,
    customerQueued,
    agentQueued,
  });
  return { prepared: true, inHours, cooled, customerQueued, agentQueued };
}

export async function drainCallActionQueue(
  ownerUid?: string,
  limit = 50,
  includeDeferred = false,
): Promise<Record<string, unknown>> {
  const ownerFilter = ownerUid ? "AND owner_uid = ?" : "";
  const dueFilter = includeDeferred ? "" : "AND (next_attempt_at IS NULL OR next_attempt_at <= ?)";
  const args: unknown[] = ownerUid ? [ownerUid] : [];
  if (!includeDeferred) args.push(nowIso());
  args.push(limit);
  const rows = db.prepare(
    `SELECT * FROM call_action_runs
     WHERE status IN ('pending','retry') ${ownerFilter}
       ${dueFilter}
     ORDER BY created_at ASC LIMIT ?`,
  ).all(...args) as ActionRow[];

  let sent = 0;
  let pending = 0;
  let dryRun = 0;
  let failed = 0;
  for (const action of rows) {
    db.prepare("UPDATE call_action_runs SET status = 'sending', attempts = attempts + 1, updated_at = ? WHERE id = ?")
      .run(nowIso(), action.id);
    try {
      if (whatsappService.getStatus().provider !== "web") {
        throw new Error("Cellular call automation requires WHATSAPP_PROVIDER=web.");
      }
      const result = await whatsappService.sendText(action.recipient, action.body);
      if (isDryRunSendResult(result)) {
        db.prepare(
          "UPDATE call_action_runs SET status = 'dry_run', last_error = ?, updated_at = ? WHERE id = ?",
        ).run(result.reason, nowIso(), action.id);
        db.prepare("UPDATE call_logs SET action_state = 'dry_run', updated_at = ? WHERE id = ?")
          .run(nowIso(), action.call_id);
        dryRun += 1;
        continue;
      }
      const messageId = String(result?.messageId || "");
      db.prepare(
        `UPDATE call_action_runs SET status = 'sent', provider_message_id = ?, last_error = NULL,
         sent_at = ?, updated_at = ? WHERE id = ?`,
      ).run(messageId || null, nowIso(), nowIso(), action.id);
      recordWhatsAppMessage({
        type: "sent",
        provider: whatsappService.getStatus().provider,
        direction: "outbound",
        to_phone: action.recipient,
        message: action.body,
        message_id: messageId || null,
        status: "sent",
        owner_uid: action.owner_uid,
        metadata: { call_id: action.call_id, action_key: action.action_key },
      });
      const flag = action.action_key === "customer_whatsapp" ? "wa_customer_notified" : "wa_agent_notified";
      db.prepare(`UPDATE call_logs SET ${flag} = 1, action_state = 'sent', updated_at = ? WHERE id = ?`)
        .run(nowIso(), action.call_id);
      sent += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const permanentFailure = /not registered on WhatsApp|invalid outbound phone/i.test(message);
      if (permanentFailure) {
        db.prepare(
          "UPDATE call_action_runs SET status = 'failed', last_error = ?, next_attempt_at = NULL, updated_at = ? WHERE id = ?",
        ).run(message, nowIso(), action.id);
        db.prepare("UPDATE call_logs SET action_state = 'failed_whatsapp', updated_at = ? WHERE id = ?")
          .run(nowIso(), action.call_id);
        logError("call.automation.whatsapp_recipient_invalid", error, { actionId: action.id, callId: action.call_id });
        failed += 1;
        continue;
      }
      const attempts = Number(action.attempts || 0) + 1;
      const delayMs = Math.min(15 * 60_000, 30_000 * 2 ** Math.min(5, attempts - 1));
      db.prepare(
        `UPDATE call_action_runs SET status = 'retry', last_error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?`,
      ).run(message, nowIso(new Date(Date.now() + delayMs)), nowIso(), action.id);
      db.prepare("UPDATE call_logs SET action_state = 'waiting_whatsapp', updated_at = ? WHERE id = ?")
        .run(nowIso(), action.call_id);
      ensureWhatsAppReconnectTask(action.owner_uid, message);
      logError("call.automation.whatsapp_send_failed", error, { actionId: action.id, callId: action.call_id });
      const timer = setTimeout(() => {
        void drainCallActionQueue(action.owner_uid).catch((retryError) =>
          logError("call.automation.scheduled_retry_failed", retryError, { actionId: action.id }),
        );
      }, delayMs);
      timer.unref?.();
      pending += 1;
    }
  }
  if (ownerUid && whatsappService.getStatus().status === "connected") {
    const remaining = db.prepare(
      "SELECT 1 FROM call_action_runs WHERE owner_uid = ? AND status IN ('pending','retry','sending') LIMIT 1",
    ).get(ownerUid);
    if (!remaining) {
      db.prepare(
        `UPDATE crm_tasks SET status = 'done', completed_at = ?, updated_at = ?
         WHERE owner_uid = ? AND related_type = 'whatsapp_connection' AND status = 'open'`,
      ).run(nowIso(), nowIso(), ownerUid);
    }
  }
  return { processed: rows.length, sent, pending, failed, dryRun };
}

export function handleCustomerWhatsAppReply(ownerUid: string, fromPhone: string, text: string) {
  const phone = normalizePhone(fromPhone);
  if (!phone) return { updated: false };
  const call = db.prepare(
    `SELECT c.* FROM call_logs c
     JOIN call_action_runs a ON a.call_id = c.id
     WHERE c.owner_uid = ? AND c.from_phone LIKE ? AND c.missed = 1
       AND a.action_key = 'customer_whatsapp' AND a.status = 'sent'
       AND a.sent_at >= ?
     ORDER BY COALESCE(c.occurred_at, c.created_at) DESC LIMIT 1`,
  ).get(ownerUid, `%${phone.slice(-9)}`, nowIso(new Date(Date.now() - 30 * 24 * 60 * 60_000))) as CallRow | undefined;
  if (!call) return { updated: false };
  const now = nowIso();
  db.prepare("UPDATE call_logs SET last_customer_reply_at = ?, action_state = 'customer_replied', updated_at = ? WHERE id = ?")
    .run(now, now, call.id);
  if (call.follow_up_task_id) {
    const row = db.prepare("SELECT notes FROM crm_tasks WHERE id = ? AND owner_uid = ?")
      .get(call.follow_up_task_id, ownerUid) as { notes?: string } | undefined;
    const notes = `${row?.notes || ""}\nرد العميل عبر واتساب: ${String(text || "").slice(0, 500)}`.trim();
    db.prepare(
      `UPDATE crm_tasks SET status = 'open', priority = 'urgent', due_date = ?, notes = ?, updated_at = ?
       WHERE id = ? AND owner_uid = ?`,
    ).run(now, notes, now, call.follow_up_task_id, ownerUid);
  }
  return { updated: true, callId: call.id, taskId: call.follow_up_task_id || null };
}

export function listCallActions(ownerUid: string, limit = 100) {
  return db.prepare(
    `SELECT * FROM call_action_runs WHERE owner_uid = ? ORDER BY created_at DESC LIMIT ?`,
  ).all(ownerUid, Math.min(500, limit));
}
