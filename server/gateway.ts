/**
 * Self-hosted phone gateway — no external telephony/SMS provider.
 *
 * The company SIM lives in an Android phone running a free automation app
 * (MacroDroid/Tasker). That app:
 *   1. POSTs call/SMS events here  → POST /api/gateway/event
 *   2. polls queued replies        → GET  /api/gateway/outbox
 *   3. sends each SMS from the SIM and acks → POST /api/gateway/outbox/ack
 *
 * Routing reuses the IVR departments/agents/call_logs. Replies go out over
 * WhatsApp when it's connected, otherwise they are queued as SMS for the phone
 * to send — so the system works with neither a provider nor a WhatsApp QR.
 */
import crypto from "crypto";
import db from "./db";
import {
  getDepartmentByDigit,
  listDepartments,
  recordCall,
  updateCallBySid,
  type IvrDepartment,
} from "./ivrEngine";
import { recordWhatsAppMessage, whatsappService } from "./whatsapp";
import {
  smsAgentAlert,
  smsMissedDirect,
  smsMissedMenu,
  smsRoutedCustomer,
} from "./smsTemplates";
import { logError, logEvent } from "./logger";

function newId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`;
}
function nowIso() {
  return new Date().toISOString();
}

function normPhone(p: string | undefined | null): string {
  let d = String(p || "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("0")) d = `966${d.slice(1)}`;
  if (d.length === 9 && d.startsWith("5")) d = `966${d}`;
  return d;
}

export function routingMode(): "menu" | "direct" {
  return (process.env.GATEWAY_ROUTING_MODE || "menu").toLowerCase() === "direct" ? "direct" : "menu";
}

// ── Outbox ────────────────────────────────────────────────────────────────────
export function enqueueSms(ownerUid: string, toPhone: string, body: string, role: string, callId?: string): string {
  const id = newId("sms");
  db.prepare(
    `INSERT INTO gateway_outbox (id, owner_uid, to_phone, body, role, channel, status, call_id, created_at)
     VALUES (?, ?, ?, ?, ?, 'sms', 'pending', ?, ?)`,
  ).run(id, ownerUid, normPhone(toPhone), body, role, callId || null, nowIso());
  return id;
}

/**
 * Returns the single oldest pending SMS in a flat, MacroDroid-friendly shape
 * (no array to iterate). `to` is E.164 (+9665…) so any SMS app dials it.
 */
export function getNextPendingSms(ownerUid: string): {
  has: boolean;
  id?: string;
  to?: string;
  body?: string;
  role?: string;
} {
  const row = db
    .prepare("SELECT id, to_phone, body, role FROM gateway_outbox WHERE owner_uid = ? AND status = 'pending' ORDER BY created_at ASC LIMIT 1")
    .get(ownerUid) as { id: string; to_phone: string; body: string; role: string } | undefined;
  if (!row) return { has: false };
  return { has: true, id: row.id, to: `+${normPhone(row.to_phone)}`, body: row.body, role: row.role };
}

export function listPendingSms(ownerUid: string, limit = 20) {
  const rows = db
    .prepare("SELECT id, to_phone, body, role FROM gateway_outbox WHERE owner_uid = ? AND status = 'pending' ORDER BY created_at ASC LIMIT ?")
    .all(ownerUid, Math.min(100, limit)) as Array<Record<string, unknown>>;
  return rows;
}

export function ackSms(ownerUid: string, ids: string[], failedIds: string[] = []): number {
  let changed = 0;
  const markSent = db.prepare("UPDATE gateway_outbox SET status = 'sent', sent_at = ? WHERE id = ? AND owner_uid = ? AND status = 'pending'");
  for (const id of ids) changed += markSent.run(nowIso(), id, ownerUid).changes;
  const markFailed = db.prepare("UPDATE gateway_outbox SET status = 'failed', error = 'reported by gateway', sent_at = ? WHERE id = ? AND owner_uid = ?");
  for (const id of failedIds) markFailed.run(nowIso(), id, ownerUid);
  return changed;
}

export function listRecentOutbox(ownerUid: string, limit = 50) {
  return db
    .prepare("SELECT * FROM gateway_outbox WHERE owner_uid = ? ORDER BY created_at DESC LIMIT ?")
    .all(ownerUid, Math.min(200, limit)) as Array<Record<string, unknown>>;
}

// ── Channel-aware dispatch ────────────────────────────────────────────────────
/**
 * Send `body` to `phone`. Uses WhatsApp when it is connected; otherwise queues
 * an SMS for the phone gateway. Returns which channel was used.
 */
export async function dispatchMessage(
  ownerUid: string,
  phone: string,
  body: string,
  opts: { role: string; callId?: string } = { role: "customer" },
): Promise<{ channel: "whatsapp" | "sms"; to: string; body: string }> {
  const to = normPhone(phone);
  const wa = whatsappService.getStatus();
  const waUsable = wa.status === "connected" || wa.provider === "cloud_api";

  if (waUsable) {
    try {
      const res = await whatsappService.sendText(to, body);
      recordWhatsAppMessage({
        type: "sent",
        provider: wa.provider,
        direction: "outbound",
        to_phone: to,
        message: body,
        message_id: (res as { messageId?: string | null })?.messageId || null,
        status: (res as { dryRun?: boolean })?.dryRun ? "dry_run" : "sent",
        owner_uid: ownerUid,
        metadata: { channel: "whatsapp", role: opts.role, call_id: opts.callId },
      });
      return { channel: "whatsapp", to, body };
    } catch (err) {
      logError("gateway.whatsapp_send_failed_fallback_sms", err);
    }
  }

  enqueueSms(ownerUid, to, body, opts.role, opts.callId);
  return { channel: "sms", to, body };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function activeDepartments(ownerUid: string): IvrDepartment[] {
  return listDepartments(ownerUid)
    .filter((d) => d.active)
    .sort((a, b) => a.sort_order - b.sort_order);
}

function smsMenuText(ownerUid: string): string {
  return activeDepartments(ownerUid).map((d) => `${d.digit} - ${d.name}`).join("\n");
}

function firstAgent(dept: IvrDepartment) {
  return dept.agents.find((a) => a.active && a.phone) || dept.agents[0] || null;
}

/** Latest missed/menu call from this number that hasn't been routed yet. */
function recentUnroutedMissed(ownerUid: string, fromNorm: string): Record<string, unknown> | null {
  const tail = fromNorm.slice(-9);
  const row = db
    .prepare(
      `SELECT * FROM call_logs
       WHERE owner_uid = ? AND from_phone LIKE ?
         AND status IN ('no_answer','menu') AND (department_id IS NULL OR department_id = '')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(ownerUid, `%${tail}`) as Record<string, unknown> | undefined;
  return row || null;
}

function leadingDigit(text: string | undefined): string | null {
  const m = String(text || "").trim().match(/^([0-9])/);
  return m ? m[1] : null;
}

// ── Event handling ────────────────────────────────────────────────────────────
export type GatewayEvent = {
  type: string;
  from?: string;
  to?: string;
  text?: string;
  ts?: string;
};

export async function handleGatewayEvent(ownerUid: string, event: GatewayEvent): Promise<Record<string, unknown>> {
  const type = String(event.type || "").toLowerCase().replace(/[\s-]/g, "_");
  const from = normPhone(event.from);

  if (!from) return { handled: false, reason: "missing_from" };

  // ── Missed / unanswered call ──
  if (["missed_call", "call_missed", "no_answer", "unanswered", "call_ended_unanswered"].includes(type)) {
    const callSid = `gw_${crypto.randomUUID().slice(0, 12)}`;
    recordCall({ ownerUid, provider: "gateway", callSid, from, to: normPhone(event.to), status: "no_answer" });
    updateCallBySid(callSid, { missed: 1 });

    const dispatched: Array<{ channel: string; to: string }> = [];

    if (routingMode() === "direct") {
      const dept = activeDepartments(ownerUid)[0];
      const agent = dept ? firstAgent(dept) : null;
      if (dept) {
        updateCallBySid(callSid, {
          department_id: dept.id,
          department_name: dept.name,
          agent_user_id: agent?.user_id || null,
          agent_phone: agent?.phone || null,
          agent_name: agent?.name || null,
        });
        const c = await dispatchMessage(ownerUid, from, smsMissedDirect(dept.name, agent?.name || ""), { role: "customer", callId: callSid });
        dispatched.push({ channel: c.channel, to: c.to });
        if (agent?.phone) {
          updateCallBySid(callSid, { wa_agent_notified: 1 });
          const a = await dispatchMessage(ownerUid, agent.phone, smsAgentAlert(dept.name, from), { role: "agent", callId: callSid });
          dispatched.push({ channel: a.channel, to: a.to });
        }
      }
      updateCallBySid(callSid, { wa_customer_notified: 1 });
    } else {
      // menu mode: ask the caller to pick a department by SMS reply.
      const menu = smsMenuText(ownerUid);
      const body = menu ? smsMissedMenu(menu) : smsMissedDirect("خدمة العملاء", "");
      const c = await dispatchMessage(ownerUid, from, body, { role: "customer", callId: callSid });
      updateCallBySid(callSid, { wa_customer_notified: 1 });
      dispatched.push({ channel: c.channel, to: c.to });
    }

    logEvent("info", "gateway.missed_call", { from, mode: routingMode(), dispatched });
    return { handled: true, kind: "missed_call", callSid, mode: routingMode(), dispatched };
  }

  // ── Inbound SMS (department selection) ──
  if (["sms_in", "inbound_sms", "sms", "message_in"].includes(type)) {
    const digit = leadingDigit(event.text);
    if (!digit) return { handled: false, reason: "no_digit", from };

    const dept = getDepartmentByDigit(ownerUid, digit);
    if (!dept) {
      await dispatchMessage(ownerUid, from, `عذراً، الرقم ${digit} غير مخصص لأي قسم. حاول مرة أخرى.`, { role: "customer" });
      return { handled: true, kind: "sms_invalid_digit", digit };
    }

    const agent = firstAgent(dept);
    const existing = recentUnroutedMissed(ownerUid, from);
    const callSid = existing?.call_sid ? String(existing.call_sid) : `gw_${crypto.randomUUID().slice(0, 12)}`;
    if (!existing) {
      recordCall({ ownerUid, provider: "gateway", callSid, from, to: "", status: "menu" });
    }
    updateCallBySid(callSid, {
      department_id: dept.id,
      department_name: dept.name,
      selected_digit: digit,
      agent_user_id: agent?.user_id || null,
      agent_phone: agent?.phone || null,
      agent_name: agent?.name || null,
      status: "routed",
      wa_customer_notified: 1,
    });

    const dispatched: Array<{ channel: string; to: string }> = [];
    const c = await dispatchMessage(ownerUid, from, smsRoutedCustomer(dept.name, agent?.name || ""), { role: "customer", callId: callSid });
    dispatched.push({ channel: c.channel, to: c.to });
    if (agent?.phone) {
      updateCallBySid(callSid, { wa_agent_notified: 1 });
      const a = await dispatchMessage(ownerUid, agent.phone, smsAgentAlert(dept.name, from), { role: "agent", callId: callSid });
      dispatched.push({ channel: a.channel, to: a.to });
    }

    logEvent("info", "gateway.sms_routed", { from, digit, department: dept.name, dispatched });
    return { handled: true, kind: "sms_routed", department: dept.name, callSid, dispatched };
  }

  // ── Other events (incoming/answered) — log only ──
  if (["incoming_call", "call_incoming", "call_answered", "answered"].includes(type)) {
    return { handled: true, kind: "logged", type };
  }

  return { handled: false, reason: "unknown_type", type };
}
