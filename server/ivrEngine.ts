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
import { sendWhatsAppTemplate } from "./whatsapp";
import { logError, logEvent } from "./logger";

const COMPANY_NAME = process.env.COMPANY_NAME || "Breexe Pro";
const DEFAULT_RING_TIMEOUT = Number(process.env.TELEPHONY_RING_TIMEOUT_SEC || 20);

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

// ── Call logs ─────────────────────────────────────────────────────────────────
function safeJson(raw: unknown) {
  if (typeof raw !== "string") return raw ?? null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function recordCall(input: {
  ownerUid: string;
  provider: string;
  callSid: string;
  from: string;
  to: string;
  status?: string;
}): CallLog {
  const id = newId("call");
  db.prepare(
    `INSERT INTO call_logs (id, owner_uid, provider, call_sid, from_phone, to_phone, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.ownerUid,
    input.provider,
    input.callSid || null,
    input.from || null,
    input.to || null,
    input.status || "menu",
    nowIso(),
    nowIso(),
  );
  return { id };
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

  const agent = department.agents.find((a) => a.active && a.phone);
  if (!agent) {
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
    { action: "say", text: `يتم تحويلكم إلى ${department.name}. يرجى الانتظار.`, language: "ar" },
    {
      action: "dial",
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
export async function handleCallStatus(status: NormalizedCallStatus): Promise<Record<string, unknown>> {
  const call = getCallBySid(status.callSid);
  if (!call) {
    return { handled: false, reason: "unknown_call_sid", callSid: status.callSid };
  }

  const missedStatuses: NormalizedCallStatus["status"][] = ["no_answer", "busy", "failed", "voicemail"];
  const isMissed = missedStatuses.includes(status.status);

  updateCallBySid(status.callSid, {
    status: status.status,
    duration_sec: status.durationSec ?? Number(call.duration_sec || 0),
    ended_at: nowIso(),
    missed: isMissed ? 1 : 0,
  });

  if (isMissed) {
    const result = await runMissedCallFlow(status.callSid);
    return { handled: true, missed: true, ...result };
  }
  return { handled: true, missed: false, status: status.status };
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

  const out: Record<string, unknown> = { sent: true, customer: false, agent: false };

  // 1) Apology to the customer.
  if (customerPhone && Number(call.wa_customer_notified || 0) === 0) {
    try {
      await sendWhatsAppTemplate({
        phone: customerPhone,
        template: "missed_call_customer",
        vars: { department_name: departmentName || "خدمة العملاء", agent_name: agentName || "أحد موظفينا" },
        owner_uid: ownerUid,
      });
      updateCallBySid(callSid, { wa_customer_notified: 1 });
      out.customer = true;
    } catch (err) {
      logError("ivr.missed_call.customer_wa_failed", err);
    }
  }

  // 2) Call-back alert to the agent.
  if (agentPhone && Number(call.wa_agent_notified || 0) === 0) {
    try {
      await sendWhatsAppTemplate({
        phone: agentPhone,
        template: "missed_call_agent",
        vars: { department_name: departmentName || "-", customer_phone: customerPhone || "-", call_time: callTime },
        owner_uid: ownerUid,
      });
      updateCallBySid(callSid, { wa_agent_notified: 1 });
      out.agent = true;
    } catch (err) {
      logError("ivr.missed_call.agent_wa_failed", err);
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
