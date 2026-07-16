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
import { normalizePhoneDigits, phoneTail } from "../shared/phone";
import { communicationJobStore } from "./communicationJobs";
import { evaluateCallReplyRecipient, evaluateCallReplySource, renderCallReplyMessage, type CallReplyDisposition } from "./callReplyPolicy";

const COMPANY_NAME = process.env.COMPANY_NAME || "Breexe Pro";
const DEFAULT_RING_TIMEOUT = Number(process.env.TELEPHONY_RING_TIMEOUT_SEC || 20);

// ── ids / time ──────────────────────────────────────────────────────────────
function newId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}
function nowIso() {
  return new Date().toISOString();
}

// ── Types ────────────────────────────────────────────────────────────────────
export type TelephonyConfig = {
  owner_uid: string;
  provider: string;
  main_number: string;
  greeting: string;
  menu_prompt: string;
  ring_timeout_sec: number;
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
  return {
    owner_uid: ownerUid,
    provider: (row?.provider as string) || process.env.TELEPHONY_PROVIDER || "unifonic",
    main_number: (row?.main_number as string) || process.env.TELEPHONY_MAIN_NUMBER || "",
    greeting: (row?.greeting as string) || "",
    menu_prompt: (row?.menu_prompt as string) || "",
    ring_timeout_sec: Number(row?.ring_timeout_sec || DEFAULT_RING_TIMEOUT),
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
    `INSERT INTO telephony_config (owner_uid, provider, main_number, greeting, menu_prompt, ring_timeout_sec, enabled, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(owner_uid) DO UPDATE SET
       main_number = excluded.main_number,
       greeting = excluded.greeting,
       menu_prompt = excluded.menu_prompt,
       ring_timeout_sec = excluded.ring_timeout_sec,
       enabled = excluded.enabled,
       updated_at = excluded.updated_at`,
  ).run(
    ownerUid,
    next.provider,
    next.main_number,
    next.greeting,
    next.menu_prompt,
    next.ring_timeout_sec,
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
  const tail = phoneTail(fromPhone);
  if (!tail) return false;
  const since = new Date(Date.now() - minutes * 60_000).toISOString();
  const row = db
    .prepare(
      `SELECT 1 FROM call_logs
       WHERE owner_uid = ? AND from_phone LIKE ? AND wa_customer_notified = 1 AND created_at >= ?
       LIMIT 1`,
    )
    .get(ownerUid, `%${tail}`, since);
  if (row) return true;
  const queued = db.prepare(
    `SELECT 1 FROM communication_jobs
     WHERE owner_uid = ? AND recipient_phone LIKE ? AND role = 'customer'
       AND status IN ('pending','processing','retry','sent') AND created_at >= ?
     LIMIT 1`,
  ).get(ownerUid, `%${tail}`, since);
  return Boolean(queued);
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
  const tail = phoneTail(phone);
  if (!tail) return null;
  const row = db
    .prepare("SELECT id, name FROM customers WHERE owner_uid = ? AND phone LIKE ? ORDER BY created_at DESC LIMIT 1")
    .get(ownerUid, `%${tail}`) as { id: string; name: string } | undefined;
  return row ? { id: row.id, name: row.name || "" } : null;
}

/**
 * Return the CRM customer for an inbound caller, creating it when necessary,
 * and queue the contact for synchronisation to the paired Android phone.
 */
export function ensureCustomerContact(ownerUid: string, phone: string): { id: string; name: string } | null {
  const normalized = normalizePhoneDigits(phone);
  if (!/^\d{8,15}$/.test(normalized)) return null;

  let customer = findCustomerByPhone(ownerUid, normalized);
  if (!customer) {
    const customerId = newId("customer");
    const customerName = `متصل CRM ${normalized.slice(-4)}`;
    const createdAt = nowIso();
    db.prepare(
      `INSERT INTO customers
        (id, owner_uid, name, phone, source, notes, contact_needs_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'phone_call', ?, 1, ?, ?)`,
    ).run(
      customerId,
      ownerUid,
      customerName,
      `+${normalized}`,
      "أُنشئت جهة الاتصال تلقائياً من مكالمة واردة.",
      createdAt,
      createdAt,
    );
    customer = { id: customerId, name: customerName };
  }

  db.prepare(
    `INSERT OR IGNORE INTO gateway_contact_outbox
      (id, owner_uid, customer_id, phone, name, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(newId("gct"), ownerUid, customer.id, `+${normalized}`, customer.name, nowIso());
  return customer;
}

export function recordCall(input: {
  ownerUid: string;
  provider: string;
  callSid: string;
  from: string;
  to: string;
  status?: string;
  correlationKey?: string;
  saveContact?: boolean;
}): CallLog {
  if (input.callSid) {
    const existing = getCallBySid(input.callSid, input.ownerUid);
    if (existing?.id) return { id: String(existing.id) };
  }
  const id = newId("call");
  const customer = input.saveContact === false
    ? findCustomerByPhone(input.ownerUid, input.from)
    : ensureCustomerContact(input.ownerUid, input.from);
  db.prepare(
    `INSERT INTO call_logs (id, owner_uid, provider, call_sid, correlation_key, from_phone, to_phone, status, customer_id, customer_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.ownerUid,
    input.provider,
    input.callSid || null,
    input.correlationKey || null,
    input.from || null,
    input.to || null,
    input.status || "menu",
    customer?.id || null,
    customer?.name || null,
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
  const tail = phoneTail(agentPhone);
  if (!tail) return null;
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
  const res = db
    .prepare(
      "UPDATE call_logs SET handled = 1, handled_at = ?, handled_by = ?, updated_at = ? WHERE owner_uid = ? AND id = ?",
    )
    .run(nowIso(), by, nowIso(), ownerUid, callId);
  return res.changes > 0;
}

export function getCallBySid(callSid: string, ownerUid?: string): Record<string, unknown> | null {
  if (!callSid) return null;
  const found = ownerUid
    ? db.prepare("SELECT * FROM call_logs WHERE owner_uid = ? AND call_sid = ? ORDER BY created_at DESC LIMIT 1").get(ownerUid, callSid)
    : db.prepare("SELECT * FROM call_logs WHERE call_sid = ? ORDER BY created_at DESC LIMIT 1").get(callSid);
  const row = found as Record<string, unknown> | undefined;
  return row ? { ...row, metadata: safeJson(row.metadata) } : null;
}

export function updateCallBySid(callSid: string, fields: Record<string, unknown>, ownerUid?: string) {
  if (!callSid) return;
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const set = keys.map((k) => `${k} = ?`).join(", ");
  const sql = ownerUid
    ? `UPDATE call_logs SET ${set}, updated_at = ? WHERE owner_uid = ? AND call_sid = ?`
    : `UPDATE call_logs SET ${set}, updated_at = ? WHERE call_sid = ?`;
  const args = [...keys.map((k) => fields[k]), nowIso(), ...(ownerUid ? [ownerUid] : []), callSid];
  db.prepare(sql).run(...args);
}

function fallbackCorrelation(raw: string) {
  return raw.startsWith("caller:");
}

function resolveCallSid(ownerUid: string, rawSid: string, create: boolean): string {
  if (!rawSid || !fallbackCorrelation(rawSid)) return rawSid;
  const since = new Date(Date.now() - Number(process.env.TELEPHONY_CORRELATION_WINDOW_MIN || 10) * 60_000).toISOString();
  const active = db.prepare(
    `SELECT call_sid FROM call_logs
     WHERE owner_uid = ? AND correlation_key = ? AND created_at >= ?
       AND status IN ('menu','ringing','forwarding','in_progress')
     ORDER BY created_at DESC LIMIT 1`,
  ).get(ownerUid, rawSid, since) as { call_sid?: string } | undefined;
  if (active?.call_sid) return active.call_sid;
  return create ? `${rawSid}:${crypto.randomUUID().slice(0, 12)}` : rawSid;
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
  const { greeting, prompt } = buildMenuText(ownerUid);

  // Record the call so the status webhook can correlate it later.
  const callSid = resolveCallSid(ownerUid, call.callSid, true);
  if (callSid) {
    const existing = getCallBySid(callSid, ownerUid);
    if (!existing) {
      recordCall({
        ownerUid,
        provider: config.provider,
        callSid,
        correlationKey: fallbackCorrelation(call.callSid) ? call.callSid : undefined,
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
  const callSid = resolveCallSid(ownerUid, call.callSid, true);

  // Ensure a call row exists even if the provider didn't hit the greeting first
  // (so the later status webhook can correlate this call by sid).
  if (callSid && !getCallBySid(callSid, ownerUid)) {
    const config = getTelephonyConfig(ownerUid);
    recordCall({
      ownerUid,
      provider: config.provider,
      callSid,
      correlationKey: fallbackCorrelation(call.callSid) ? call.callSid : undefined,
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
  const existing = getCallBySid(callSid, ownerUid);
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
    updateCallBySid(callSid, {
      department_id: department.id,
      department_name: department.name,
      selected_digit: digit,
      status: "no_answer",
    });
    runMissedCallFlow(callSid).catch((err) => logError("ivr.no_agent_missed_flow_failed", err));
    return [
      { action: "say", text: `سيتواصل معكم فريق ${department.name} قريباً. شكراً لاتصالكم.`, language: "ar" },
      { action: "hangup" },
    ];
  }

  updateCallBySid(callSid, {
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
      number: normalizePhoneDigits(agent.phone),
      callerId: config.main_number ? normalizePhoneDigits(config.main_number) : undefined,
      ringTimeoutSec: department.ring_timeout_sec || config.ring_timeout_sec,
      statusCallbackUrl: statusCallbackUrl(baseUrl),
    },
  ];
}

/**
 * Status webhook entry point. Returns a short summary for logging. On a
 * not-connected outcome it triggers the missed-call WhatsApp flow.
 */
export async function handleCallStatus(ownerUid: string, status: NormalizedCallStatus): Promise<Record<string, unknown>> {
  const callSid = resolveCallSid(ownerUid, status.callSid, false);
  const call = getCallBySid(callSid, ownerUid);
  if (!call) {
    return { handled: false, reason: "unknown_call_sid", callSid: status.callSid };
  }

  const missedStatuses: NormalizedCallStatus["status"][] = ["no_answer", "busy", "failed", "voicemail"];
  const isMissed = missedStatuses.includes(status.status);

  updateCallBySid(callSid, {
    status: status.status,
    duration_sec: status.durationSec ?? Number(call.duration_sec || 0),
    ended_at: nowIso(),
    missed: isMissed ? 1 : 0,
  });

  if ((isMissed || status.status === "completed") && recentlyNotifiedCustomer(
    ownerUid,
    String(call.from_phone || status.from || ""),
    Number(process.env.GATEWAY_REPLY_COOLDOWN_MIN ?? 10),
  )) {
    return { handled: true, missed: isMissed, cooled: true, status: status.status };
  }

  if (isMissed) {
    const result = await runMissedCallFlow(callSid);
    return { handled: true, missed: true, ...result };
  }
  if (status.status === "completed") {
    const result = await runAnsweredCallFlow(callSid);
    return { handled: true, missed: false, ...result };
  }
  return { handled: true, missed: false, status: status.status };
}

/** Queue one durable WhatsApp follow-up after an answered/completed call. */
export async function runAnsweredCallFlow(callSid: string): Promise<Record<string, unknown>> {
  const call = getCallBySid(callSid);
  if (!call) return { queued: false, reason: "unknown_call" };
  if (Number(call.wa_customer_notified || 0) === 1) return { queued: false, reason: "already_notified" };

  const ownerUid = String(call.owner_uid || "");
  const customerPhone = String(call.from_phone || "");
  const callId = String(call.id || "");
  if (!ownerUid || !customerPhone || !callId) return { queued: false, reason: "missing_call_data" };

  const replyDecision = evaluateCallReplyRecipient(ownerUid, customerPhone);
  const source = String(call.source || call.provider || "");
  const sourceDecision = evaluateCallReplySource(replyDecision.policy, {
    source,
    deviceId: call.device_id,
    simKey: call.sim_key,
  });
  if (!replyDecision.allowed || !sourceDecision.allowed) {
    return {
      queued: false,
      reason: replyDecision.allowed ? sourceDecision.reason : replyDecision.reason,
    };
  }

  try {
    const job = communicationJobStore.enqueue({
      ownerUid,
      eventKey: `answered-call:${callId}:customer`,
      recipientPhone: customerPhone,
      templateName: "call_answered_customer",
      payload: {
        purpose: "call_auto",
        policyVersion: replyDecision.policy.version,
        source,
        deviceId: String(call.device_id || ""),
        simKey: String(call.sim_key || ""),
        vars: {},
      },
      role: "customer",
      callId,
      expiresInMinutes: 30,
    });
    db.prepare(
      "UPDATE call_logs SET wa_customer_job_id = ?, wa_customer_status = ?, updated_at = ? WHERE owner_uid = ? AND id = ?",
    ).run(job.id, job.status, nowIso(), ownerUid, callId);
    return { queued: true, customer: job.status, customer_job_id: job.id };
  } catch (err) {
    logError("ivr.answered_call.customer_queue_failed", err);
    return { queued: false, reason: "queue_failed" };
  }
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
  const customerPhone = String(call.from_phone || "");
  const agentPhone = String(call.agent_phone || "");
  const departmentName = String(call.department_name || "");
  const agentName = String(call.agent_name || "");
  const callTime = new Date(String(call.created_at || nowIso())).toLocaleString("ar-SA", {
    timeZone: process.env.APP_TIMEZONE || "Asia/Riyadh",
  });

  const callId = String(call.id || "");
  const out: Record<string, unknown> = { queued: true, customer: false, agent: false };
  const replyDecision = evaluateCallReplyRecipient(ownerUid, customerPhone);
  const source = String(call.source || call.provider || "");
  const sourceDecision = evaluateCallReplySource(replyDecision.policy, {
    source,
    deviceId: call.device_id,
    simKey: call.sim_key,
  });
  out.customer_policy = replyDecision.allowed ? sourceDecision.reason : replyDecision.reason;
  const disposition = ["no_answer", "busy", "unreachable", "rejected", "after_hours"].includes(String(call.disposition || call.status))
    ? String(call.disposition || call.status) as CallReplyDisposition
    : "no_answer";
  const customerMessage = renderCallReplyMessage(
    disposition,
    new Date(String(call.ended_at || call.created_at || nowIso())),
    replyDecision.policy,
  );

  // 1) Queue the apology to the customer. The durable worker owns provider I/O,
  // retry and final delivery flags; webhook retries only return the same job.
  if (sourceDecision.allowed && replyDecision.allowed && customerPhone && Number(call.wa_customer_notified || 0) === 0) {
    try {
      const job = communicationJobStore.enqueue({
        ownerUid,
        eventKey: `missed-call:${callId}:customer`,
        recipientPhone: customerPhone,
        templateName: "general_reminder",
        payload: {
          purpose: "call_auto",
          policyVersion: replyDecision.policy.version,
          source,
          deviceId: String(call.device_id || ""),
          simKey: String(call.sim_key || ""),
          vars: { message: customerMessage },
        },
        role: "customer",
        callId,
        expiresInMinutes: 30,
      });
      db.prepare(
        "UPDATE call_logs SET wa_customer_job_id = ?, wa_customer_status = ?, updated_at = ? WHERE owner_uid = ? AND id = ?",
      ).run(job.id, job.status, nowIso(), ownerUid, callId);
      out.customer = job.status;
      out.customer_job_id = job.id;
    } catch (err) {
      logError("ivr.missed_call.customer_queue_failed", err);
      out.customer_error = true;
    }
  }

  // 2) Queue the call-back alert to the assigned agent.
  if (agentPhone && Number(call.wa_agent_notified || 0) === 0) {
    try {
      const job = communicationJobStore.enqueue({
        ownerUid,
        eventKey: `missed-call:${callId}:agent`,
        recipientPhone: agentPhone,
        templateName: "missed_call_agent",
        payload: { vars: { department_name: departmentName || "-", customer_phone: (customerPhone && normalizePhoneDigits(customerPhone)) || "-", call_time: callTime } },
        role: "agent",
        callId,
        expiresInMinutes: 30,
      });
      db.prepare(
        "UPDATE call_logs SET wa_agent_job_id = ?, wa_agent_status = ?, updated_at = ? WHERE owner_uid = ? AND id = ?",
      ).run(job.id, job.status, nowIso(), ownerUid, callId);
      out.agent = job.status;
      out.agent_job_id = job.id;
    } catch (err) {
      logError("ivr.missed_call.agent_queue_failed", err);
      out.agent_error = true;
    }
  }

  logEvent("info", "ivr.missed_call.handled", {
    callSid,
    customer: out.customer,
    agent: out.agent,
    department: departmentName,
  });
  return out;
}
