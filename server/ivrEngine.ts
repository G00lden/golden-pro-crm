/**
 * IVR engine — provider-agnostic call routing logic.
 *
 * Flow:
 *   1. Inbound call hits the IVR webhook → `buildGreeting()` returns a menu
 *      built from `ivr_departments` and records a `call_logs` row.
 *   2. Caller presses a digit → `handleDigit()` resolves the department + its
 *      first active agent and returns a `dial` (forward) instruction.
 *   3. The dial ends → the status webhook calls `handleCallStatus()`. On a
 *      no-answer/busy/failed/voicemail outcome we run the missed-call flow:
 *      WhatsApp to the customer (apology) and to the agent (call-back alert).
 *
 * All WhatsApp side effects are best-effort and never throw to the caller, so a
 * disconnected WhatsApp session can't break the webhook response.
 */
import crypto from "crypto";
import db from "./db";
import type {
  IvrInstruction,
  NormalizedCallStatus,
  NormalizedInboundCall,
} from "./telephony/types";
import { logError, logEvent } from "./logger";
import { drainCallActionQueue, prepareCallAutomation, type CallAutomationConfig } from "./callAutomation";
import { AUTOMATION_DISPOSITIONS, companyMessage, isBusinessOpen, type CallDisposition } from "./callPolicy";

const COMPANY_NAME = process.env.COMPANY_NAME || "Breexe Pro";
const DEFAULT_RING_TIMEOUT = Number(process.env.TELEPHONY_RING_TIMEOUT_SEC || 15);
const DEFAULT_VOICE_IN_HOURS = "شكرًا لاتصالك. يتعذر علينا الرد الآن. ستصلك رسالة على واتساب، وسنتواصل معك في أقرب فرصة.";
const DEFAULT_VOICE_AFTER_HOURS = "شكرًا لاتصالك بـ{اسم الشركة}. نحن خارج أوقات الدوام حاليًا. ستصلك رسالة على واتساب الآن، وسنتواصل معك في أقرب فرصة.";
const DEFAULT_WHATSAPP_IN_HOURS = "شكرًا لاتصالك بـ{اسم الشركة}. تعذر علينا الرد الآن. اكتب لنا هنا ماذا تحتاج، وسنتواصل معك في أقرب فرصة.";
const DEFAULT_WHATSAPP_AFTER_HOURS = "شكرًا لاتصالك بـ{اسم الشركة}. نحن خارج أوقات الدوام حاليًا. اكتب لنا هنا ماذا تحتاج، وسنتواصل معك في أقرب فرصة.";

// ── ids / time ──────────────────────────────────────────────────────────────
function newId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}
function nowIso() {
  return new Date().toISOString();
}

/** Normalize a Saudi phone to international digits for provider dialing. */
function normalizeDialNumber(phone: string): string {
  let digits = String(phone || "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = `966${digits.slice(1)}`;
  if (digits.length === 9 && digits.startsWith("5")) digits = `966${digits}`;
  return digits;
}

// ── Types ────────────────────────────────────────────────────────────────────
export type TelephonyConfig = CallAutomationConfig & {
  owner_uid: string;
  provider: string;
  main_number: string;
  call_flow_mode: "unavailable_reply" | "menu";
  greeting: string;
  menu_prompt: string;
  ring_timeout_sec: number;
  voice_in_hours: string;
  voice_after_hours: string;
  enabled: boolean;
};

export type IvrAgent = {
  id: string;
  department_id: string;
  owner_uid: string;
  user_id: string | null;
  name: string;
  phone: string;
  sort_order: number;
  active: boolean;
};

export type IvrDepartment = {
  id: string;
  owner_uid: string;
  digit: string;
  name: string;
  ring_timeout_sec: number;
  active: boolean;
  sort_order: number;
  agents: IvrAgent[];
};

export type CallLog = Record<string, unknown> & { id: string };

// ── Config ────────────────────────────────────────────────────────────────────
export function getTelephonyConfig(ownerUid: string): TelephonyConfig {
  const row = db
    .prepare("SELECT * FROM telephony_config WHERE owner_uid = ?")
    .get(ownerUid) as Record<string, unknown> | undefined;
  let businessDays = [6, 0, 1, 2, 3, 4];
  try {
    const parsed = JSON.parse(String(row?.business_days || "[6,0,1,2,3,4]"));
    if (Array.isArray(parsed)) {
      const validDays = parsed.map(Number).filter((day) => day >= 0 && day <= 6);
      if (validDays.length) businessDays = validDays;
    }
  } catch {
    // Keep the commercial default schedule.
  }
  return {
    owner_uid: ownerUid,
    provider: (row?.provider as string) || process.env.TELEPHONY_PROVIDER || "unifonic",
    main_number: (row?.main_number as string) || process.env.TELEPHONY_MAIN_NUMBER || "",
    company_name: (row?.company_name as string) || process.env.COMPANY_NAME || COMPANY_NAME,
    call_flow_mode: row?.call_flow_mode === "menu" ? "menu" : "unavailable_reply",
    greeting: (row?.greeting as string) || "",
    menu_prompt: (row?.menu_prompt as string) || "",
    ring_timeout_sec: Number(row?.ring_timeout_sec || DEFAULT_RING_TIMEOUT),
    timezone: (row?.timezone as string) || process.env.APP_TIMEZONE || "Asia/Riyadh",
    business_days: businessDays,
    business_open: (row?.business_open as string) || "08:00",
    business_close: (row?.business_close as string) || "21:00",
    auto_reply_enabled: row ? row.auto_reply_enabled !== 0 : true,
    reply_cooldown_min: Number(row?.reply_cooldown_min ?? 10),
    follow_up_sla_min: Number(row?.follow_up_sla_min ?? 5),
    voice_in_hours: (row?.voice_in_hours as string) || DEFAULT_VOICE_IN_HOURS,
    voice_after_hours: (row?.voice_after_hours as string) || DEFAULT_VOICE_AFTER_HOURS,
    whatsapp_in_hours: (row?.whatsapp_in_hours as string) || DEFAULT_WHATSAPP_IN_HOURS,
    whatsapp_after_hours: (row?.whatsapp_after_hours as string) || DEFAULT_WHATSAPP_AFTER_HOURS,
    enabled: row ? row.enabled === 1 : true,
  };
}

export function upsertTelephonyConfig(
  ownerUid: string,
  patch: Partial<Omit<TelephonyConfig, "owner_uid" | "provider">>,
): TelephonyConfig {
  const current = getTelephonyConfig(ownerUid);
  const next = { ...current, ...patch };
  db.prepare(
    `INSERT INTO telephony_config
      (owner_uid, provider, main_number, company_name, call_flow_mode, greeting, menu_prompt,
       ring_timeout_sec, timezone, business_days, business_open, business_close,
       auto_reply_enabled, reply_cooldown_min, follow_up_sla_min, voice_in_hours,
       voice_after_hours, whatsapp_in_hours, whatsapp_after_hours, enabled, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(owner_uid) DO UPDATE SET
       main_number = excluded.main_number,
       company_name = excluded.company_name,
       call_flow_mode = excluded.call_flow_mode,
       greeting = excluded.greeting,
       menu_prompt = excluded.menu_prompt,
       ring_timeout_sec = excluded.ring_timeout_sec,
       timezone = excluded.timezone,
       business_days = excluded.business_days,
       business_open = excluded.business_open,
       business_close = excluded.business_close,
       auto_reply_enabled = excluded.auto_reply_enabled,
       reply_cooldown_min = excluded.reply_cooldown_min,
       follow_up_sla_min = excluded.follow_up_sla_min,
       voice_in_hours = excluded.voice_in_hours,
       voice_after_hours = excluded.voice_after_hours,
       whatsapp_in_hours = excluded.whatsapp_in_hours,
       whatsapp_after_hours = excluded.whatsapp_after_hours,
       enabled = excluded.enabled,
       updated_at = excluded.updated_at`,
  ).run(
    ownerUid,
    next.provider,
    next.main_number,
    next.company_name,
    next.call_flow_mode,
    next.greeting,
    next.menu_prompt,
    next.ring_timeout_sec,
    next.timezone,
    JSON.stringify(next.business_days),
    next.business_open,
    next.business_close,
    next.auto_reply_enabled ? 1 : 0,
    next.reply_cooldown_min,
    next.follow_up_sla_min,
    next.voice_in_hours,
    next.voice_after_hours,
    next.whatsapp_in_hours,
    next.whatsapp_after_hours,
    next.enabled ? 1 : 0,
    nowIso(),
  );
  return getTelephonyConfig(ownerUid);
}

// ── Departments + agents ──────────────────────────────────────────────────────
function rowToAgent(row: Record<string, unknown>): IvrAgent {
  return {
    id: String(row.id),
    department_id: String(row.department_id),
    owner_uid: String(row.owner_uid),
    user_id: (row.user_id as string) || null,
    name: (row.name as string) || "",
    phone: (row.phone as string) || "",
    sort_order: Number(row.sort_order || 0),
    active: row.active === null ? true : row.active === 1,
  };
}

function agentsForDepartment(departmentId: string): IvrAgent[] {
  const rows = db
    .prepare("SELECT * FROM ivr_department_agents WHERE department_id = ? ORDER BY sort_order ASC, created_at ASC")
    .all(departmentId) as Array<Record<string, unknown>>;
  return rows.map(rowToAgent);
}

function rowToDepartment(row: Record<string, unknown>): IvrDepartment {
  return {
    id: String(row.id),
    owner_uid: String(row.owner_uid),
    digit: String(row.digit),
    name: (row.name as string) || "",
    ring_timeout_sec: Number(row.ring_timeout_sec || DEFAULT_RING_TIMEOUT),
    active: row.active === null ? true : row.active === 1,
    sort_order: Number(row.sort_order || 0),
    agents: agentsForDepartment(String(row.id)),
  };
}

export function listDepartments(ownerUid: string): IvrDepartment[] {
  const rows = db
    .prepare("SELECT * FROM ivr_departments WHERE owner_uid = ? ORDER BY sort_order ASC, digit ASC")
    .all(ownerUid) as Array<Record<string, unknown>>;
  return rows.map(rowToDepartment);
}

export function getDepartment(ownerUid: string, id: string): IvrDepartment | null {
  const row = db
    .prepare("SELECT * FROM ivr_departments WHERE owner_uid = ? AND id = ?")
    .get(ownerUid, id) as Record<string, unknown> | undefined;
  return row ? rowToDepartment(row) : null;
}

export function getDepartmentByDigit(ownerUid: string, digit: string): IvrDepartment | null {
  const row = db
    .prepare("SELECT * FROM ivr_departments WHERE owner_uid = ? AND digit = ? AND active = 1")
    .get(ownerUid, digit) as Record<string, unknown> | undefined;
  return row ? rowToDepartment(row) : null;
}

type AgentInput = {
  user_id?: string | null;
  name?: string;
  phone: string;
  sort_order?: number;
  active?: boolean;
};

type DepartmentInput = {
  digit: string;
  name: string;
  ring_timeout_sec?: number;
  active?: boolean;
  sort_order?: number;
  agents?: AgentInput[];
};

function replaceAgents(ownerUid: string, departmentId: string, agents: AgentInput[]) {
  db.prepare("DELETE FROM ivr_department_agents WHERE department_id = ?").run(departmentId);
  agents.forEach((agent, index) => {
    db.prepare(
      `INSERT INTO ivr_department_agents
        (id, department_id, owner_uid, user_id, name, phone, sort_order, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId("agent"),
      departmentId,
      ownerUid,
      agent.user_id || null,
      agent.name || "",
      agent.phone,
      agent.sort_order ?? index,
      agent.active === false ? 0 : 1,
      nowIso(),
      nowIso(),
    );
  });
}

export function createDepartment(ownerUid: string, input: DepartmentInput): IvrDepartment {
  const id = newId("dept");
  db.prepare(
    `INSERT INTO ivr_departments
      (id, owner_uid, digit, name, ring_timeout_sec, active, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    ownerUid,
    input.digit,
    input.name,
    input.ring_timeout_sec ?? DEFAULT_RING_TIMEOUT,
    input.active === false ? 0 : 1,
    input.sort_order ?? 0,
    nowIso(),
    nowIso(),
  );
  replaceAgents(ownerUid, id, input.agents || []);
  return getDepartment(ownerUid, id)!;
}

export function updateDepartment(
  ownerUid: string,
  id: string,
  input: Partial<DepartmentInput>,
): IvrDepartment | null {
  const existing = getDepartment(ownerUid, id);
  if (!existing) return null;
  db.prepare(
    `UPDATE ivr_departments SET
       digit = ?, name = ?, ring_timeout_sec = ?, active = ?, sort_order = ?, updated_at = ?
     WHERE owner_uid = ? AND id = ?`,
  ).run(
    input.digit ?? existing.digit,
    input.name ?? existing.name,
    input.ring_timeout_sec ?? existing.ring_timeout_sec,
    input.active === undefined ? (existing.active ? 1 : 0) : input.active ? 1 : 0,
    input.sort_order ?? existing.sort_order,
    nowIso(),
    ownerUid,
    id,
  );
  if (input.agents) replaceAgents(ownerUid, id, input.agents);
  return getDepartment(ownerUid, id);
}

export function deleteDepartment(ownerUid: string, id: string): boolean {
  const existing = getDepartment(ownerUid, id);
  if (!existing) return false;
  db.prepare("DELETE FROM ivr_department_agents WHERE department_id = ?").run(id);
  db.prepare("DELETE FROM ivr_departments WHERE owner_uid = ? AND id = ?").run(ownerUid, id);
  return true;
}

/**
 * Picks the next agent for a department, rotating fairly across all active
 * agents (round-robin) so calls are distributed instead of always hitting the
 * first employee. Advances and persists the department's pointer.
 */
export function pickAgentRoundRobin(dept: IvrDepartment): IvrAgent | null {
  const agents = dept.agents.filter((a) => a.active && a.phone);
  if (agents.length === 0) return dept.agents[0] || null;
  const row = db.prepare("SELECT rr_counter FROM ivr_departments WHERE id = ?").get(dept.id) as
    | { rr_counter?: number }
    | undefined;
  const counter = Number(row?.rr_counter || 0);
  const agent = agents[counter % agents.length];
  db.prepare("UPDATE ivr_departments SET rr_counter = ?, updated_at = ? WHERE id = ?").run(
    (counter + 1) % 1_000_000,
    nowIso(),
    dept.id,
  );
  return agent;
}

/**
 * True when this caller already received a customer auto-reply within the last
 * `minutes` (anti-spam for repeated/retried missed calls). minutes<=0 disables.
 */
export function recentlyNotifiedCustomer(ownerUid: string, fromPhone: string, minutes: number): boolean {
  if (!minutes || minutes <= 0) return false;
  const digits = String(fromPhone || "").replace(/\D/g, "");
  if (!digits) return false;
  const tail = digits.slice(-9);
  const since = new Date(Date.now() - minutes * 60_000).toISOString();
  const row = db
    .prepare(
      `SELECT 1 FROM call_logs
       WHERE owner_uid = ? AND from_phone LIKE ? AND wa_customer_notified = 1 AND created_at >= ?
       LIMIT 1`,
    )
    .get(ownerUid, `%${tail}`, since);
  return Boolean(row);
}

// ── Call logs ─────────────────────────────────────────────────────────────────
function safeJson(raw: unknown) {
  if (typeof raw !== "string") return raw ?? null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Look up a registered customer by phone (last-9-digit match). */
export function findCustomerByPhone(ownerUid: string, phone: string): { id: string; name: string } | null {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return null;
  const tail = digits.slice(-9);
  const row = db
    .prepare("SELECT id, name FROM customers WHERE owner_uid = ? AND phone LIKE ? ORDER BY created_at DESC LIMIT 1")
    .get(ownerUid, `%${tail}`) as { id: string; name: string } | undefined;
  return row ? { id: row.id, name: row.name || "" } : null;
}

export function recordCall(input: {
  ownerUid: string;
  provider: string;
  callSid: string;
  from: string;
  to: string;
  status?: string;
  eventId?: string;
  source?: string;
  direction?: "incoming" | "outgoing";
  disposition?: CallDisposition;
  durationSeconds?: number;
  occurredAt?: string;
  phoneAccountId?: string;
  metadata?: Record<string, unknown>;
}): CallLog {
  if (input.eventId) {
    const duplicate = db.prepare("SELECT id FROM call_logs WHERE owner_uid = ? AND event_id = ? LIMIT 1")
      .get(input.ownerUid, input.eventId) as { id: string } | undefined;
    if (duplicate) return { id: duplicate.id };
  }
  if (input.callSid) {
    const duplicate = db.prepare("SELECT id FROM call_logs WHERE owner_uid = ? AND call_sid = ? ORDER BY created_at DESC LIMIT 1")
      .get(input.ownerUid, input.callSid) as { id: string } | undefined;
    if (duplicate) return { id: duplicate.id };
  }

  const occurredAt = input.occurredAt || nowIso();
  const source = input.source || input.provider || "unknown";
  const tail = normalizeDialNumber(input.from).slice(-9);
  if (tail) {
    const nearby = db.prepare(
      `SELECT id FROM call_logs
       WHERE owner_uid = ? AND from_phone LIKE ? AND IFNULL(source, '') <> ?
         AND ABS(strftime('%s', COALESCE(occurred_at, created_at)) - strftime('%s', ?)) <= 90
       ORDER BY created_at DESC LIMIT 1`,
    ).get(input.ownerUid, `%${tail}`, source, occurredAt) as { id: string } | undefined;
    if (nearby) {
      db.prepare(
        `UPDATE call_logs SET call_sid = COALESCE(NULLIF(call_sid, ''), ?),
         event_id = COALESCE(event_id, ?), source = ?, provider = ?,
         metadata = COALESCE(metadata, ?), updated_at = ? WHERE id = ?`,
      ).run(
        input.callSid || null,
        input.eventId || null,
        `${source}+merged`,
        input.provider,
        input.metadata ? JSON.stringify(input.metadata) : null,
        nowIso(),
        nearby.id,
      );
      return { id: nearby.id };
    }
  }

  const id = newId("call");
  const customer = findCustomerByPhone(input.ownerUid, input.from);
  db.prepare(
    `INSERT INTO call_logs
      (id, owner_uid, provider, event_id, call_sid, source, direction, disposition,
       from_phone, to_phone, status, duration_sec, occurred_at, phone_account_id,
       customer_id, customer_name, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.ownerUid,
    input.provider,
    input.eventId || null,
    input.callSid || null,
    source,
    input.direction || "incoming",
    input.disposition || "unknown",
    input.from || null,
    input.to || null,
    input.status || "menu",
    input.durationSeconds || 0,
    occurredAt,
    input.phoneAccountId || null,
    customer?.id || null,
    customer?.name || null,
    input.metadata ? JSON.stringify(input.metadata) : null,
    nowIso(),
    nowIso(),
  );
  return { id };
}

const AGENT_ACK_KEYWORDS = ["تم", "تمت", "استلمت", "تواصلت", "تم التواصل", "تمت المعالجة", "done", "ok"];

/** Returns true if the text is an agent acknowledgement ("تم", "استلمت"…). */
export function isAgentAck(text: string | undefined | null): boolean {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return false;
  return AGENT_ACK_KEYWORDS.some((k) => t === k.toLowerCase() || t.startsWith(k.toLowerCase() + " "));
}

/** Most recent unhandled call assigned to this agent phone (last 9 digits). */
export function findUnhandledCallForAgent(ownerUid: string, agentPhone: string): Record<string, unknown> | null {
  const digits = String(agentPhone || "").replace(/\D/g, "");
  if (!digits) return null;
  const tail = digits.slice(-9);
  const row = db
    .prepare(
      `SELECT * FROM call_logs
       WHERE owner_uid = ? AND agent_phone LIKE ? AND IFNULL(handled,0) = 0
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(ownerUid, `%${tail}`) as Record<string, unknown> | undefined;
  return row || null;
}

/** Mark a call as handled (resolved follow-up). `by` is 'agent' or a user id. */
export function markCallHandled(ownerUid: string, callId: string, by: string): boolean {
  const call = db.prepare("SELECT follow_up_task_id FROM call_logs WHERE owner_uid = ? AND id = ?")
    .get(ownerUid, callId) as { follow_up_task_id?: string } | undefined;
  const res = db
    .prepare(
      "UPDATE call_logs SET handled = 1, handled_at = ?, handled_by = ?, status = 'handled', updated_at = ? WHERE owner_uid = ? AND id = ?",
    )
    .run(nowIso(), by, nowIso(), ownerUid, callId);
  if (res.changes > 0 && call?.follow_up_task_id) {
    db.prepare(
      "UPDATE crm_tasks SET status = 'done', completed_at = ?, updated_at = ? WHERE owner_uid = ? AND id = ?",
    ).run(nowIso(), nowIso(), ownerUid, call.follow_up_task_id);
  }
  return res.changes > 0;
}

export function getCallBySid(callSid: string): Record<string, unknown> | null {
  if (!callSid) return null;
  const row = db
    .prepare("SELECT * FROM call_logs WHERE call_sid = ? ORDER BY created_at DESC LIMIT 1")
    .get(callSid) as Record<string, unknown> | undefined;
  return row ? { ...row, metadata: safeJson(row.metadata) } : null;
}

export function updateCallBySid(callSid: string, fields: Record<string, unknown>) {
  if (!callSid) return;
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const set = keys.map((k) => `${k} = ?`).join(", ");
  db.prepare(`UPDATE call_logs SET ${set}, updated_at = ? WHERE call_sid = ?`).run(
    ...keys.map((k) => fields[k]),
    nowIso(),
    callSid,
  );
}

export function updateCallById(callId: string, fields: Record<string, unknown>) {
  if (!callId) return;
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const set = keys.map((key) => `${key} = ?`).join(", ");
  db.prepare(`UPDATE call_logs SET ${set}, updated_at = ? WHERE id = ?`).run(
    ...keys.map((key) => fields[key]),
    nowIso(),
    callId,
  );
}

/** Dashboard counters: unhandled missed calls + today's totals. */
export function callStats(ownerUid: string): { missed_unhandled: number; missed_today: number; total_today: number } {
  const today = new Date().toISOString().slice(0, 10);
  const one = (sql: string, ...args: unknown[]) =>
    (db.prepare(sql).get(ownerUid, ...args) as { c: number }).c;
  return {
    missed_unhandled: one("SELECT COUNT(*) AS c FROM call_logs WHERE owner_uid = ? AND missed = 1 AND IFNULL(handled,0) = 0"),
    missed_today: one("SELECT COUNT(*) AS c FROM call_logs WHERE owner_uid = ? AND missed = 1 AND created_at LIKE ?", `${today}%`),
    total_today: one("SELECT COUNT(*) AS c FROM call_logs WHERE owner_uid = ? AND created_at LIKE ?", `${today}%`),
  };
}

export function listCalls(opts: { ownerUid: string; limit?: number; missedOnly?: boolean }): Record<string, unknown>[] {
  const limit = Math.min(500, opts.limit || 100);
  const sql = opts.missedOnly
    ? "SELECT * FROM call_logs WHERE owner_uid = ? AND missed = 1 ORDER BY created_at DESC LIMIT ?"
    : "SELECT * FROM call_logs WHERE owner_uid = ? ORDER BY created_at DESC LIMIT ?";
  const rows = db.prepare(sql).all(opts.ownerUid, limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({ ...r, metadata: safeJson(r.metadata) }));
}

// ── IVR instruction builders ──────────────────────────────────────────────────
function ivrResponseUrl(baseUrl: string) {
  return `${baseUrl.replace(/\/$/, "")}/webhooks/telephony/ivr`;
}
function statusCallbackUrl(baseUrl: string) {
  return `${baseUrl.replace(/\/$/, "")}/webhooks/telephony/status`;
}

/** Build the greeting + menu prompt text from configured departments. */
export function buildMenuText(ownerUid: string): { greeting: string; prompt: string; departments: IvrDepartment[] } {
  const config = getTelephonyConfig(ownerUid);
  const departments = listDepartments(ownerUid).filter((d) => d.active);
  const greeting = config.greeting || `مرحباً بكم في ${COMPANY_NAME}.`;
  const options = departments
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((d) => `للتواصل مع ${d.name} اضغط ${d.digit}`)
    .join("، ");
  const prompt = config.menu_prompt || options || "عذراً، لا توجد أقسام متاحة حالياً.";
  return { greeting, prompt, departments };
}

/** Instructions for a fresh inbound call: greet, then gather one digit. */
export function buildGreeting(ownerUid: string, call: NormalizedInboundCall, baseUrl: string): IvrInstruction[] {
  const config = getTelephonyConfig(ownerUid);

  if (!config.enabled) {
    const callSid = call.callSid || `unifonic_${crypto.randomUUID().slice(0, 18)}`;
    recordCall({
      ownerUid,
      provider: config.provider,
      callSid,
      from: call.from,
      to: call.to || config.main_number,
      status: "unknown",
      source: "unifonic",
      disposition: "unknown",
      occurredAt: nowIso(),
      metadata: call.raw,
    });
    return [
      { action: "say", text: "شكرًا لاتصالك. يتعذر علينا الرد حاليًا. يرجى المحاولة لاحقًا.", language: "ar" },
      { action: "hangup" },
    ];
  }

  // The advertised Zain line forwards only unavailable calls here. In this
  // mode Unifonic plays one short message, queues the CRM/WhatsApp follow-up,
  // and ends the call without a keypad menu.
  if (config.call_flow_mode === "unavailable_reply") {
    const occurredAt = nowIso();
    const inHours = isBusinessOpen(config, new Date(occurredAt));
    const disposition: CallDisposition = inHours ? "no_answer" : "after_hours";
    const callSid = call.callSid || `unifonic_${crypto.randomUUID().slice(0, 18)}`;
    const recorded = recordCall({
      ownerUid,
      provider: config.provider,
      callSid,
      from: call.from,
      to: call.to || config.main_number,
      status: disposition,
      source: "unifonic",
      direction: "incoming",
      disposition,
      occurredAt,
      metadata: call.raw,
    });
    updateCallById(recorded.id, { status: disposition, disposition, missed: 1, ended_at: occurredAt });
    prepareCallAutomation(recorded.id, config);
    void drainCallActionQueue(ownerUid).catch((error) => logError("call.automation.initial_drain_failed", error));

    const voice = companyMessage(
      inHours ? config.voice_in_hours : config.voice_after_hours,
      config.company_name,
    );
    return [
      { action: "say", text: voice, language: "ar" },
      { action: "hangup" },
    ];
  }

  const { greeting, prompt } = buildMenuText(ownerUid);

  // Record the call so the status webhook can correlate it later.
  if (call.callSid) {
    const existing = getCallBySid(call.callSid);
    if (!existing) {
      recordCall({
        ownerUid,
        provider: config.provider,
        callSid: call.callSid,
        from: call.from,
        to: call.to || config.main_number,
        status: "menu",
      });
    }
  }

  return [
    {
      action: "gather",
      text: `${greeting} ${prompt}`,
      numDigits: 1,
      timeoutSec: 8,
      responseUrl: ivrResponseUrl(baseUrl),
      language: "ar",
    },
  ];
}

/** Instructions after a digit press: forward to the department's agent. */
export function handleDigit(ownerUid: string, call: NormalizedInboundCall, baseUrl: string): IvrInstruction[] {
  const digit = String(call.digit || "");

  // Ensure a call row exists even if the provider didn't hit the greeting first
  // (so the later status webhook can correlate this call by sid).
  if (call.callSid && !getCallBySid(call.callSid)) {
    const config = getTelephonyConfig(ownerUid);
    recordCall({
      ownerUid,
      provider: config.provider,
      callSid: call.callSid,
      from: call.from,
      to: call.to || config.main_number,
      status: "menu",
    });
  }

  const department = getDepartmentByDigit(ownerUid, digit);

  if (!department) {
    return [
      { action: "say", text: "عذراً، اختيار غير صحيح. سيتم إنهاء المكالمة. يمكنكم مراسلتنا عبر واتساب.", language: "ar" },
      { action: "hangup" },
    ];
  }

  // Idempotent per call: if this call already picked an agent (e.g. the provider
  // re-posted the DTMF webhook), reuse it instead of advancing the round-robin
  // pointer again — which would skew distribution and reassign the call.
  const existing = getCallBySid(call.callSid);
  const agent: IvrAgent | null = existing?.agent_phone
    ? {
        id: String(existing.agent_user_id || existing.agent_phone || ""),
        department_id: department.id,
        owner_uid: ownerUid,
        user_id: existing.agent_user_id != null ? String(existing.agent_user_id) : null,
        name: String(existing.agent_name || ""),
        phone: String(existing.agent_phone),
        sort_order: 0,
        active: true,
      }
    : pickAgentRoundRobin(department);
  if (!agent || !agent.phone) {
    // No reachable agent → treat as a missed call immediately so the customer
    // still gets a WhatsApp follow-up.
    updateCallBySid(call.callSid, {
      department_id: department.id,
      department_name: department.name,
      selected_digit: digit,
      status: "no_answer",
    });
    runMissedCallFlow(call.callSid).catch((err) => logError("ivr.no_agent_missed_flow_failed", err));
    return [
      { action: "say", text: `سيتواصل معكم فريق ${department.name} قريباً. شكراً لاتصالكم.`, language: "ar" },
      { action: "hangup" },
    ];
  }

  updateCallBySid(call.callSid, {
    department_id: department.id,
    department_name: department.name,
    selected_digit: digit,
    agent_user_id: agent.user_id,
    agent_phone: agent.phone,
    agent_name: agent.name,
    status: "forwarding",
    forwarded_at: nowIso(),
  });

  const config = getTelephonyConfig(ownerUid);
  return [
    {
      action: "dial",
      text: `يتم تحويلكم إلى ${department.name}. يرجى الانتظار.`,
      number: normalizeDialNumber(agent.phone),
      callerId: config.main_number ? normalizeDialNumber(config.main_number) : undefined,
      ringTimeoutSec: department.ring_timeout_sec || config.ring_timeout_sec,
      statusCallbackUrl: statusCallbackUrl(baseUrl),
    },
  ];
}

/**
 * Status webhook entry point. Returns a short summary for logging. On a
 * not-connected outcome it triggers the missed-call WhatsApp flow.
 */
export async function handleCallStatus(
  ownerUid: string,
  status: NormalizedCallStatus,
): Promise<Record<string, unknown>> {
  if (status.eventId) {
    const duplicate = db.prepare("SELECT call_id FROM call_status_events WHERE owner_uid = ? AND event_id = ?")
      .get(ownerUid, status.eventId) as { call_id?: string } | undefined;
    if (duplicate) return { handled: true, duplicate: true, callId: duplicate.call_id || null };
  }

  let call = status.callSid ? getCallBySid(status.callSid) : null;
  if (!call && status.from) {
    const tail = normalizeDialNumber(status.from).slice(-9);
    call = db.prepare(
      `SELECT * FROM call_logs WHERE owner_uid = ? AND from_phone LIKE ?
       AND created_at >= ? ORDER BY created_at DESC LIMIT 1`,
    ).get(ownerUid, `%${tail}`, new Date(Date.now() - 15 * 60_000).toISOString()) as Record<string, unknown> | undefined || null;
  }
  if (!call) {
    const config = getTelephonyConfig(ownerUid);
    const generatedSid = status.callSid || `unifonic_${crypto.randomUUID().slice(0, 18)}`;
    const recorded = recordCall({
      ownerUid,
      provider: config.provider,
      callSid: generatedSid,
      from: status.from || "",
      to: status.to || config.main_number,
      status: status.status,
      source: "unifonic",
      disposition: status.status === "ringing" || status.status === "in_progress" ? "unknown" : status.status,
      durationSeconds: status.durationSec,
      occurredAt: status.occurredAt,
      metadata: status.raw,
    });
    call = db.prepare("SELECT * FROM call_logs WHERE id = ?").get(recorded.id) as Record<string, unknown>;
  }

  const callId = String(call.id);
  if (status.eventId) {
    db.prepare(
      `INSERT OR IGNORE INTO call_status_events (id, owner_uid, event_id, call_id, status, occurred_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(newId("cse"), ownerUid, status.eventId, callId, status.status, status.occurredAt || nowIso(), nowIso());
  }

  if (status.status === "ringing" || status.status === "in_progress") {
    updateCallById(callId, { status: status.status, duration_sec: status.durationSec ?? Number(call.duration_sec || 0) });
    return { handled: true, missed: false, status: status.status, callId };
  }

  const previousDisposition = String(call.disposition || "unknown") as CallDisposition;
  const unavailableReplyAlreadyStarted =
    AUTOMATION_DISPOSITIONS.has(previousDisposition) && String(call.action_state || "none") !== "none";
  const disposition = unavailableReplyAlreadyStarted && status.status === "answered"
    ? previousDisposition
    : status.status;
  const isMissed = AUTOMATION_DISPOSITIONS.has(disposition as CallDisposition);
  updateCallById(callId, {
    status: disposition,
    disposition,
    duration_sec: status.durationSec ?? Number(call.duration_sec || 0),
    occurred_at: status.occurredAt || call.occurred_at || call.created_at,
    ended_at: nowIso(),
    missed: isMissed ? 1 : 0,
  });

  if (isMissed) {
    const config = getTelephonyConfig(ownerUid);
    const prepared = prepareCallAutomation(callId, config);
    const drained = await drainCallActionQueue(ownerUid);
    return { handled: true, missed: true, disposition, callId, prepared, drained };
  }
  return { handled: true, missed: false, disposition, callId };
}

// ── Missed-call WhatsApp flow ─────────────────────────────────────────────────
/**
 * Sends the apology to the customer and the call-back alert to the agent.
 * Idempotent per flag — re-running won't double-send. Never throws.
 */
export async function runMissedCallFlow(callSid: string): Promise<Record<string, unknown>> {
  const call = getCallBySid(callSid);
  if (!call) return { sent: false, reason: "unknown_call" };
  const ownerUid = String(call.owner_uid || "");
  const config = getTelephonyConfig(ownerUid);
  const current = String(call.disposition || "unknown") as CallDisposition;
  const disposition = AUTOMATION_DISPOSITIONS.has(current) ? current : "no_answer";
  updateCallById(String(call.id), { status: disposition, disposition, missed: 1, ended_at: nowIso() });
  const prepared = prepareCallAutomation(String(call.id), config);
  const drained = await drainCallActionQueue(ownerUid);
  logEvent("info", "ivr.missed_call.handled", { callSid, disposition, prepared, drained });
  return { sent: true, disposition, prepared, drained };
}
