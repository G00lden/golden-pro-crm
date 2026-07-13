/**
 * IVR engine — provider-agnostic call routing logic.
 *
 * Flow:
 *   1. Inbound call hits the IVR webhook → `buildGreeting()` returns a menu
 *      built from `ivr_departments` and records a `call_logs` row.
 *   2. Caller presses a digit → `handleDigit()` resolves the department + its
 *      next eligible agent atomically (round-robin) and returns one `dial`.
 *   3. The dial ends → the status webhook calls `handleCallStatus()`. On a
 *      no-answer/busy/failed outcome we create the CRM follow-up and enqueue
 *      notifications: WhatsApp first, then Android-gateway SMS as fallback.
 *
 * Provider callbacks are idempotent, session tokens are stored as hashes, and
 * communication side effects are dispatched through a durable outbox.
 */
import crypto from "crypto";
import db from "./db";
import type {
  IvrInstruction,
  NormalizedCallStatus,
  NormalizedInboundCall,
} from "./telephony/types";
import { dispatchCommunicationJob } from "./communicationOutbox";
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
export function normalizeDialNumber(phone: string): string {
  let digits = String(phone || "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = `966${digits.slice(1)}`;
  if (digits.length === 9 && digits.startsWith("5")) digits = `966${digits}`;
  return digits;
}

export function isDialablePhone(phone: string): boolean {
  const digits = normalizeDialNumber(phone);
  return digits.length >= 10 && digits.length <= 15;
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

export type TelephonyReadinessCheck = {
  id: "system_enabled" | "main_number" | "public_url" | "webhook_secret" | "status_auth" | "departments" | "agents" | "live_verified";
  label: string;
  ready: boolean;
  blocking: boolean;
  detail: string;
};

export type TelephonyReadiness = {
  ready: boolean;
  provider: string;
  enabled: boolean;
  active_departments: number;
  reachable_agents: number;
  uncovered_departments: string[];
  webhook_base_url: string;
  ivr_webhook_url: string;
  status_webhook_url: string;
  setup_complete: boolean;
  live_verified: boolean;
  checks: TelephonyReadinessCheck[];
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
  workflow_action: "lead" | "service_task" | "none";
  schedule_json: string;
  fallback_user_id: string | null;
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
  const normalizedMainNumber = normalizeDialNumber(next.main_number);
  const timestamp = nowIso();
  const persist = db.transaction(() => {
    if (normalizedMainNumber) {
      const existingNumber = db.prepare(
        "SELECT owner_uid FROM telephony_numbers WHERE provider = ? AND phone_norm = ?",
      ).get(next.provider, normalizedMainNumber) as { owner_uid?: string } | undefined;
      if (existingNumber?.owner_uid && existingNumber.owner_uid !== ownerUid) {
        const error = new Error("رقم الهاتف مرتبط بمساحة شركة أخرى.") as Error & { status?: number };
        error.status = 409;
        throw error;
      }
    }

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
      timestamp,
    );

    // Only the currently configured number should resolve inbound calls for a
    // workspace. Keeping old mappings active makes a replaced number silently
    // continue routing into the company queue.
    db.prepare(
      "UPDATE telephony_numbers SET active = 0, updated_at = ? WHERE owner_uid = ? AND provider = ? AND phone_norm <> ?",
    ).run(timestamp, ownerUid, next.provider, normalizedMainNumber);

    if (normalizedMainNumber) {
      db.prepare(
        `INSERT INTO telephony_numbers (id, owner_uid, provider, phone, phone_norm, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(provider, phone_norm) DO UPDATE SET
           phone = excluded.phone, active = 1, updated_at = excluded.updated_at`,
      ).run(newId("telnum"), ownerUid, next.provider, next.main_number, normalizedMainNumber, timestamp, timestamp);
    }
  });
  persist();
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
    workflow_action: (["lead", "service_task", "none"].includes(String(row.workflow_action))
      ? String(row.workflow_action)
      : "none") as IvrDepartment["workflow_action"],
    schedule_json: String(row.schedule_json || ""),
    fallback_user_id: row.fallback_user_id ? String(row.fallback_user_id) : null,
    agents: agentsForDepartment(String(row.id)),
  };
}

export function listDepartments(ownerUid: string): IvrDepartment[] {
  const rows = db
    .prepare("SELECT * FROM ivr_departments WHERE owner_uid = ? ORDER BY sort_order ASC, digit ASC")
    .all(ownerUid) as Array<Record<string, unknown>>;
  return rows.map(rowToDepartment);
}

export function resolveTelephonyOwnerUid(dialedNumber: string | undefined, fallbackUid: string): string {
  const normalized = normalizeDialNumber(dialedNumber || "");
  if (!normalized) return fallbackUid;
  const row = db.prepare(
    `SELECT owner_uid FROM telephony_numbers
     WHERE phone_norm = ? AND active = 1 ORDER BY updated_at DESC LIMIT 1`,
  ).get(normalized) as { owner_uid?: string } | undefined;
  return row?.owner_uid || fallbackUid;
}

function publicHttpsUrl(raw: string): boolean {
  if (!raw) return false;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const privateIpv4 =
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      /^169\.254\./.test(host);
    const privateIpv6 = host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:");
    return url.protocol === "https:" && host !== "localhost" && !host.endsWith(".local") && !privateIpv4 && !privateIpv6;
  } catch {
    return false;
  }
}

/**
 * Operational readiness for a real inbound IVR call. This deliberately checks
 * only facts the CRM can verify without exposing secrets or claiming that the
 * provider dashboard has already been configured.
 */
export function getTelephonyReadiness(ownerUid: string): TelephonyReadiness {
  const config = getTelephonyConfig(ownerUid);
  const activeDepartments = listDepartments(ownerUid).filter((department) => department.active);
  const uncoveredDepartments = activeDepartments
    .filter((department) => !department.agents.some((agent) => agent.active && isDialablePhone(agent.phone)))
    .map((department) => department.name);
  const reachableAgents = activeDepartments.reduce(
    (count, department) =>
      count + department.agents.filter((agent) => agent.active && isDialablePhone(agent.phone)).length,
    0,
  );
  const baseUrl = String(process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || "").replace(/\/$/, "");
  const mainNumberReady = isDialablePhone(config.main_number);
  const publicUrlReady = publicHttpsUrl(baseUrl);
  const statusAuthReady = Boolean(
    process.env.TELEPHONY_STATUS_WEBHOOK_USER && process.env.TELEPHONY_STATUS_WEBHOOK_PASSWORD,
  );
  const numberRow = db.prepare(
    "SELECT live_verified_at FROM telephony_numbers WHERE owner_uid = ? AND provider = ? AND phone_norm = ? AND active = 1",
  ).get(ownerUid, config.provider, normalizeDialNumber(config.main_number)) as { live_verified_at?: string } | undefined;
  const liveVerified = Boolean(numberRow?.live_verified_at);
  const checks: TelephonyReadinessCheck[] = [
    {
      id: "system_enabled",
      label: "تشغيل الرد الآلي",
      ready: config.enabled,
      blocking: true,
      detail: config.enabled ? "النظام يسمح باستقبال المكالمات وتوجيهها." : "فعّل النظام من الإعدادات العامة.",
    },
    {
      id: "main_number",
      label: "الرقم الأساسي",
      ready: mainNumberReady,
      blocking: true,
      detail: mainNumberReady ? "تم حفظ رقم الاستقبال بصيغة قابلة للتحويل." : "أدخل رقم الشركة الأساسي بصيغة دولية.",
    },
    {
      id: "public_url",
      label: "رابط عام آمن",
      ready: publicUrlReady,
      blocking: true,
      detail: publicUrlReady ? "رابط HTTPS العام جاهز لاستقبال Webhooks." : "PUBLIC_BASE_URL يجب أن يكون رابط HTTPS عاماً وليس عنوان شبكة محلية.",
    },
    {
      id: "webhook_secret",
      label: "حماية Webhook",
      ready: Boolean(process.env.TELEPHONY_WEBHOOK_SECRET),
      blocking: true,
      detail: process.env.TELEPHONY_WEBHOOK_SECRET ? "السر المشترك مضبوط ولا يتم عرضه." : "اضبط TELEPHONY_WEBHOOK_SECRET في بيئة الخادم.",
    },
    {
      id: "status_auth",
      label: "حماية حالات المكالمات",
      ready: statusAuthReady,
      blocking: process.env.NODE_ENV === "production",
      detail: statusAuthReady
        ? "بيانات Basic Authentication المستقلة مضبوطة."
        : "اضبط TELEPHONY_STATUS_WEBHOOK_USER وTELEPHONY_STATUS_WEBHOOK_PASSWORD قبل الإنتاج.",
    },
    {
      id: "departments",
      label: "أقسام الاستقبال",
      ready: activeDepartments.length > 0,
      blocking: true,
      detail: activeDepartments.length > 0 ? `${activeDepartments.length} قسم نشط في القائمة الصوتية.` : "أضف قسماً نشطاً واحداً على الأقل.",
    },
    {
      id: "agents",
      label: "المختصون المتاحون",
      ready: activeDepartments.length > 0 && uncoveredDepartments.length === 0,
      blocking: true,
      detail:
        activeDepartments.length === 0
          ? "أضف الأقسام أولاً ثم عيّن المختصين."
          : uncoveredDepartments.length > 0
            ? `أقسام بلا مختص نشط: ${uncoveredDepartments.join("، ")}.`
            : `${reachableAgents} مختص نشط جاهز للتحويل.`,
    },
    {
      id: "live_verified",
      label: "التحقق بمكالمة حقيقية",
      ready: liveVerified,
      blocking: false,
      detail: liveVerified
        ? "وصلت مكالمة حقيقية وسُجلت حالتها داخل CRM."
        : "الإعداد لم يُثبت بعد بمكالمة حقيقية ناجحة.",
    },
  ];

  const setupComplete = checks.filter((check) => check.blocking).every((check) => check.ready);
  return {
    ready: setupComplete,
    provider: config.provider,
    enabled: config.enabled,
    active_departments: activeDepartments.length,
    reachable_agents: reachableAgents,
    uncovered_departments: uncoveredDepartments,
    webhook_base_url: baseUrl,
    ivr_webhook_url: baseUrl ? `${baseUrl}/webhooks/telephony/ivr` : "",
    status_webhook_url: baseUrl ? `${baseUrl}/webhooks/telephony/status` : "",
    setup_complete: setupComplete,
    live_verified: liveVerified,
    checks,
  };
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
  workflow_action?: "lead" | "service_task" | "none";
  schedule_json?: string;
  fallback_user_id?: string | null;
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
      (id, owner_uid, digit, name, ring_timeout_sec, active, sort_order, workflow_action, schedule_json, fallback_user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    ownerUid,
    input.digit,
    input.name,
    input.ring_timeout_sec ?? DEFAULT_RING_TIMEOUT,
    input.active === false ? 0 : 1,
    input.sort_order ?? 0,
    input.workflow_action || "none",
    input.schedule_json || "",
    input.fallback_user_id || null,
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
       digit = ?, name = ?, ring_timeout_sec = ?, active = ?, sort_order = ?, workflow_action = ?, schedule_json = ?, fallback_user_id = ?, updated_at = ?
     WHERE owner_uid = ? AND id = ?`,
  ).run(
    input.digit ?? existing.digit,
    input.name ?? existing.name,
    input.ring_timeout_sec ?? existing.ring_timeout_sec,
    input.active === undefined ? (existing.active ? 1 : 0) : input.active ? 1 : 0,
    input.sort_order ?? existing.sort_order,
    input.workflow_action ?? existing.workflow_action,
    input.schedule_json ?? existing.schedule_json,
    input.fallback_user_id === undefined ? existing.fallback_user_id : input.fallback_user_id,
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
  const pick = db.transaction((departmentId: string): IvrAgent | null => {
    const row = db.prepare(
      "SELECT rr_counter FROM ivr_departments WHERE id = ? AND owner_uid = ?",
    ).get(departmentId, dept.owner_uid) as { rr_counter?: number } | undefined;
    if (!row) return null;
    const rows = db.prepare(
      `SELECT a.* FROM ivr_department_agents a
       LEFT JOIN users u ON a.user_id IS NOT NULL AND (u.uid = a.user_id OR u.id = a.user_id)
       WHERE a.department_id = ? AND a.owner_uid = ? AND a.active = 1
         AND (a.user_id IS NULL OR (u.active = 1 AND u.workspace_owner_uid = ?))
       ORDER BY a.sort_order ASC, a.created_at ASC`,
    ).all(departmentId, dept.owner_uid, dept.owner_uid) as Array<Record<string, unknown>>;
    const agents = rows.map(rowToAgent).filter((agent) => isDialablePhone(agent.phone));
    if (agents.length === 0) return null;
    const counter = Number(row.rr_counter || 0);
    const agent = agents[counter % agents.length];
    db.prepare(
      "UPDATE ivr_departments SET rr_counter = ?, updated_at = ? WHERE id = ? AND owner_uid = ?",
    ).run((counter + 1) % 1_000_000, nowIso(), departmentId, dept.owner_uid);
    return agent;
  });
  return pick(dept.id);
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
}): CallLog {
  const id = newId("call");
  const customer = findCustomerByPhone(input.ownerUid, input.from);
  const status = input.status || "menu";
  db.prepare(
    `INSERT INTO call_logs
      (id, owner_uid, provider, call_sid, from_phone, to_phone, from_phone_norm, to_phone_norm,
       status, call_status, follow_up_status, customer_id, customer_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?)`,
  ).run(
    id,
    input.ownerUid,
    input.provider,
    input.callSid || null,
    input.from || null,
    input.to || null,
    normalizeDialNumber(input.from) || null,
    normalizeDialNumber(input.to) || null,
    status,
    status,
    customer?.id || null,
    customer?.name || null,
    nowIso(),
    nowIso(),
  );
  return { id };
}

/**
 * Provider-neutral customer lookup through the same Firestore-style adapter
 * used by the rest of the CRM (native Firestore, Supabase, or SQLite).
 */
export async function findCustomerByPhoneRepository(
  ownerUid: string,
  phone: string,
): Promise<{ id: string; name: string } | null> {
  const normalized = normalizeDialNumber(phone);
  if (!normalized) return null;
  const tail = normalized.slice(-9);
  const { adminDb } = await import("./firebaseAdmin");
  const snapshot = await adminDb.collection("customers")
    .where("createdBy", "==", ownerUid)
    .limit(1000)
    .get();
  for (const document of snapshot.docs as Array<{ id: string; data: () => Record<string, unknown> }>) {
    const data = document.data();
    const candidate = normalizeDialNumber(String(data.phone || data.customer_phone || ""));
    if (candidate && candidate.endsWith(tail)) {
      return { id: document.id, name: String(data.name || data.customer_name || "") };
    }
  }
  return null;
}

function sessionTokenHash(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function createCallSession(
  ownerUid: string,
  provider: string,
  call: NormalizedInboundCall,
): { call: Record<string, unknown>; token: string } {
  const token = crypto.randomBytes(32).toString("base64url");
  const internalSid = newId("session");
  const created = recordCall({
    ownerUid,
    provider,
    callSid: internalSid,
    from: call.from,
    to: call.to,
    status: "menu",
  });
  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  db.prepare(
    `UPDATE call_logs SET session_token_hash = ?, session_expires_at = ?, provider_call_sid = ?, updated_at = ?
     WHERE id = ? AND owner_uid = ?`,
  ).run(sessionTokenHash(token), expiresAt, call.callSid || null, nowIso(), created.id, ownerUid);
  return { call: getCallById(ownerUid, created.id)!, token };
}

export function getCallBySessionToken(token: string): Record<string, unknown> | null {
  if (!token) return null;
  const row = db.prepare(
    `SELECT * FROM call_logs
     WHERE session_token_hash = ? AND session_expires_at > ?
     ORDER BY created_at DESC LIMIT 1`,
  ).get(sessionTokenHash(token), nowIso()) as Record<string, unknown> | undefined;
  return row ? { ...row, metadata: safeJson(row.metadata) } : null;
}

export function getCallById(ownerUid: string, callId: string): Record<string, unknown> | null {
  const row = db.prepare("SELECT * FROM call_logs WHERE owner_uid = ? AND id = ?")
    .get(ownerUid, callId) as Record<string, unknown> | undefined;
  return row ? { ...row, metadata: safeJson(row.metadata) } : null;
}

export function updateCallById(ownerUid: string, callId: string, fields: Record<string, unknown>) {
  const allowed = new Set([
    "provider_call_sid", "department_id", "department_name", "selected_digit",
    "agent_user_id", "assigned_user_id", "agent_phone", "agent_name", "status",
    "call_status", "follow_up_status", "follow_up_outcome", "follow_up_notes",
    "forwarded_at", "ended_at", "duration_sec", "missed", "handled", "handled_at",
    "handled_by", "wa_customer_notified", "wa_agent_notified", "lead_id", "task_id",
    "invalid_attempts", "live_verified", "metadata", "customer_id", "customer_name",
  ]);
  const keys = Object.keys(fields).filter((key) => allowed.has(key));
  if (!keys.length) return false;
  const set = keys.map((key) => `${key} = ?`).join(", ");
  const result = db.prepare(
    `UPDATE call_logs SET ${set}, updated_at = ? WHERE owner_uid = ? AND id = ?`,
  ).run(...keys.map((key) => fields[key]), nowIso(), ownerUid, callId);
  return result.changes > 0;
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
export function markCallHandled(
  ownerUid: string,
  callId: string,
  by: string,
  outcome = "completed",
  notes = "",
): boolean {
  const res = db
    .prepare(
      `UPDATE call_logs SET handled = 1, handled_at = ?, handled_by = ?,
       follow_up_status = 'done', follow_up_outcome = ?, follow_up_notes = ?, updated_at = ?
       WHERE owner_uid = ? AND id = ?`,
    )
    .run(nowIso(), by, outcome, notes, nowIso(), ownerUid, callId);
  return res.changes > 0;
}

export function getCallBySid(callSid: string): Record<string, unknown> | null {
  if (!callSid) return null;
  const row = db
    .prepare("SELECT * FROM call_logs WHERE call_sid = ? OR provider_call_sid = ? ORDER BY created_at DESC LIMIT 1")
    .get(callSid, callSid) as Record<string, unknown> | undefined;
  return row ? { ...row, metadata: safeJson(row.metadata) } : null;
}

export function updateCallBySid(callSid: string, fields: Record<string, unknown>) {
  if (!callSid) return;
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const set = keys.map((k) => `${k} = ?`).join(", ");
  db.prepare(`UPDATE call_logs SET ${set}, updated_at = ? WHERE call_sid = ? OR provider_call_sid = ?`).run(
    ...keys.map((k) => fields[k]),
    nowIso(),
    callSid,
    callSid,
  );
}

/** Dashboard counters: unhandled missed calls + today's totals. */
export function callStats(ownerUid: string, assignedUserId?: string): { missed_unhandled: number; missed_today: number; total_today: number } {
  const today = new Date().toISOString().slice(0, 10);
  const assignedClause = assignedUserId ? " AND (assigned_user_id = ? OR agent_user_id = ?)" : "";
  const one = (extraWhere: string, ...args: unknown[]) => {
    const assignedArgs = assignedUserId ? [assignedUserId, assignedUserId] : [];
    return (db.prepare(
      `SELECT COUNT(*) AS c FROM call_logs WHERE owner_uid = ?${extraWhere}${assignedClause}`,
    ).get(ownerUid, ...args, ...assignedArgs) as { c: number }).c;
  };
  return {
    missed_unhandled: one(" AND missed = 1 AND IFNULL(handled,0) = 0"),
    missed_today: one(" AND missed = 1 AND created_at LIKE ?", `${today}%`),
    total_today: one(" AND created_at LIKE ?", `${today}%`),
  };
}

export function listCalls(opts: {
  ownerUid: string;
  limit?: number;
  missedOnly?: boolean;
  assignedUserId?: string;
  status?: string;
  followUpStatus?: string;
  departmentId?: string;
  search?: string;
  fromDate?: string;
  toDate?: string;
}): Record<string, unknown>[] {
  const limit = Math.min(500, opts.limit || 100);
  const where = ["owner_uid = ?"];
  const args: unknown[] = [opts.ownerUid];
  if (opts.missedOnly) where.push("missed = 1");
  if (opts.assignedUserId) {
    where.push("(assigned_user_id = ? OR agent_user_id = ?)");
    args.push(opts.assignedUserId, opts.assignedUserId);
  }
  if (opts.status) {
    where.push("call_status = ?");
    args.push(opts.status);
  }
  if (opts.followUpStatus) {
    where.push("follow_up_status = ?");
    args.push(opts.followUpStatus);
  }
  if (opts.departmentId) {
    where.push("department_id = ?");
    args.push(opts.departmentId);
  }
  if (opts.search) {
    where.push("(from_phone LIKE ? OR customer_name LIKE ? OR agent_name LIKE ?)");
    const needle = `%${opts.search}%`;
    args.push(needle, needle, needle);
  }
  if (opts.fromDate) {
    where.push("created_at >= ?");
    args.push(`${opts.fromDate}T00:00:00.000Z`);
  }
  if (opts.toDate) {
    where.push("created_at <= ?");
    args.push(`${opts.toDate}T23:59:59.999Z`);
  }
  const rows = db.prepare(
    `SELECT * FROM call_logs WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
  ).all(...args, limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({ ...r, metadata: safeJson(r.metadata) }));
}

// ── IVR instruction builders ──────────────────────────────────────────────────
function ivrResponseUrl(baseUrl: string, token?: string) {
  const root = `${baseUrl.replace(/\/$/, "")}/webhooks/telephony/ivr`;
  return token ? `${root}/session/${encodeURIComponent(token)}` : root;
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
export function legacyBuildGreeting(ownerUid: string, call: NormalizedInboundCall, baseUrl: string): IvrInstruction[] {
  const config = getTelephonyConfig(ownerUid);
  if (!config.enabled) {
    return [
      { action: "say", text: "عذراً، خدمة الرد الآلي غير متاحة حالياً. سيتم التواصل معكم في أقرب وقت.", language: "ar" },
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
export function legacyHandleDigit(ownerUid: string, call: NormalizedInboundCall, baseUrl: string): IvrInstruction[] {
  const config = getTelephonyConfig(ownerUid);
  if (!config.enabled) {
    return [
      { action: "say", text: "عذراً، خدمة الرد الآلي غير متاحة حالياً. سيتم التواصل معكم في أقرب وقت.", language: "ar" },
      { action: "hangup" },
    ];
  }
  const digit = String(call.digit || "");

  // Ensure a call row exists even if the provider didn't hit the greeting first
  // (so the later status webhook can correlate this call by sid).
  if (call.callSid && !getCallBySid(call.callSid)) {
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

type DepartmentSchedule = {
  days?: number[];
  start?: string;
  end?: string;
};

export function departmentOpenNow(department: IvrDepartment, at = new Date()): boolean {
  if (!department.schedule_json) return true;
  try {
    const schedule = JSON.parse(department.schedule_json) as DepartmentSchedule;
    if (!schedule.days?.length || !schedule.start || !schedule.end) return true;
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: process.env.APP_TIMEZONE || "Asia/Riyadh",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(at);
    const weekday = parts.find((part) => part.type === "weekday")?.value || "Sun";
    const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
    const hour = parts.find((part) => part.type === "hour")?.value || "00";
    const minute = parts.find((part) => part.type === "minute")?.value || "00";
    const current = `${hour}:${minute}`;
    return schedule.days.includes(day) && current >= schedule.start && current <= schedule.end;
  } catch {
    return true;
  }
}

function managerQueueUid(ownerUid: string): string {
  const row = db.prepare(
    `SELECT uid FROM users
     WHERE workspace_owner_uid = ? AND active = 1 AND uid IS NOT NULL AND role IN ('manager','admin')
     ORDER BY CASE role WHEN 'manager' THEN 0 ELSE 1 END, created_at ASC LIMIT 1`,
  ).get(ownerUid) as { uid?: string } | undefined;
  return row?.uid || ownerUid;
}

function ensureServiceTask(
  call: Record<string, unknown>,
  department: IvrDepartment,
  agent: IvrAgent | null,
  priority: "normal" | "high" = "normal",
): string {
  const existing = db.prepare(
    "SELECT id FROM crm_tasks WHERE owner_uid = ? AND related_type = 'call' AND related_id = ? AND status = 'open' LIMIT 1",
  ).get(call.owner_uid, call.id) as { id?: string } | undefined;
  const dueAt = new Date(Date.now() + 15 * 60_000).toISOString();
  if (existing?.id) {
    if (priority === "high") {
      db.prepare(
        "UPDATE crm_tasks SET priority = 'high', due_at = ?, due_date = ?, updated_at = ? WHERE id = ?",
      ).run(dueAt, dueAt.slice(0, 10), nowIso(), existing.id);
    }
    return existing.id;
  }
  const taskId = newId("task");
  const assignedTo = agent?.user_id || department.fallback_user_id || managerQueueUid(String(call.owner_uid));
  db.prepare(
    `INSERT INTO crm_tasks
      (id, owner_uid, title, status, priority, due_date, due_at, assigned_to, related_type,
       related_id, customer_id, contact_phone, source, notes, created_at, updated_at)
     VALUES (?, ?, ?, 'open', ?, ?, ?, ?, 'call', ?, ?, ?, 'phone_call', ?, ?, ?)`,
  ).run(
    taskId,
    call.owner_uid,
    `متابعة مكالمة ${department.name}`,
    priority,
    priority === "high" ? dueAt.slice(0, 10) : null,
    priority === "high" ? dueAt : null,
    assignedTo,
    call.id,
    call.customer_id || null,
    call.from_phone_norm || call.from_phone || null,
    `اتصال وارد إلى قسم ${department.name}`,
    nowIso(),
    nowIso(),
  );
  return taskId;
}

function ensurePhoneLead(
  call: Record<string, unknown>,
  department: IvrDepartment,
  agent: IvrAgent | null,
): string | null {
  if (call.customer_id) return null;
  const phone = String(call.from_phone_norm || normalizeDialNumber(String(call.from_phone || "")));
  if (!phone) return null;
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
  const existing = db.prepare(
    `SELECT id FROM crm_deals
     WHERE owner_uid = ? AND source = 'phone_call' AND customer_phone = ?
       AND stage NOT IN ('paid','lost') AND updated_at >= ?
       AND notes LIKE ? ORDER BY updated_at DESC LIMIT 1`,
  ).get(call.owner_uid, phone, cutoff, `%department:${department.id}%`) as { id?: string } | undefined;
  if (existing?.id) return existing.id;
  const leadId = newId("deal");
  db.prepare(
    `INSERT INTO crm_deals
      (id, owner_uid, title, customer_phone, stage, amount, currency, probability,
       assigned_to, source, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'lead', 0, 'SAR', 10, ?, 'phone_call', ?, ?, ?)`,
  ).run(
    leadId,
    call.owner_uid,
    `متصل جديد - ${department.name}`,
    phone,
    agent?.user_id || department.fallback_user_id || managerQueueUid(String(call.owner_uid)),
    `department:${department.id}; call:${call.id}`,
    nowIso(),
    nowIso(),
  );
  return leadId;
}

function createDepartmentWorkItem(callSid: string, department: IvrDepartment, agent: IvrAgent | null) {
  const call = getCallBySid(callSid);
  if (!call) return;
  if (department.workflow_action === "lead") {
    const leadId = ensurePhoneLead(call, department, agent);
    if (leadId) updateCallBySid(callSid, { lead_id: leadId });
  } else if (department.workflow_action === "service_task") {
    const taskId = ensureServiceTask(call, department, agent);
    updateCallBySid(callSid, { task_id: taskId });
  }
}

/** Start a fresh, independently authenticated call session. */
export function buildGreeting(ownerUid: string, call: NormalizedInboundCall, baseUrl: string): IvrInstruction[] {
  const config = getTelephonyConfig(ownerUid);
  if (!config.enabled) {
    return [
      { action: "say", text: "عذرًا، خدمة الرد الآلي غير متاحة حاليًا. سيتواصل معك فريقنا قريبًا.", language: "ar" },
      { action: "hangup" },
    ];
  }
  const { greeting, prompt } = buildMenuText(ownerUid);
  const session = createCallSession(ownerUid, config.provider, {
    ...call,
    to: call.to || config.main_number,
  });
  return [{
    action: "gather",
    text: `${greeting} ${prompt}`,
    numDigits: 1,
    timeoutSec: 8,
    responseUrl: ivrResponseUrl(baseUrl, session.token),
    language: "ar",
  }];
}

/** Live route variant that enriches the new call through the configured CRM adapter. */
export async function buildGreetingForProvider(
  ownerUid: string,
  call: NormalizedInboundCall,
  baseUrl: string,
): Promise<IvrInstruction[]> {
  const config = getTelephonyConfig(ownerUid);
  if (!config.enabled) return buildGreeting(ownerUid, call, baseUrl);
  const { greeting, prompt } = buildMenuText(ownerUid);
  const customer = await findCustomerByPhoneRepository(ownerUid, call.from).catch(() => null);
  const session = createCallSession(ownerUid, config.provider, {
    ...call,
    to: call.to || config.main_number,
  });
  if (customer) {
    updateCallById(ownerUid, String(session.call.id), {
      // These fields are intentionally not client-controlled; they come from
      // the selected CRM repository.
      customer_id: customer.id,
      customer_name: customer.name,
    });
  }
  return [{
    action: "gather",
    text: `${greeting} ${prompt}`,
    numDigits: 1,
    timeoutSec: 8,
    responseUrl: ivrResponseUrl(baseUrl, session.token),
    language: "ar",
  }];
}

/** Route a session-bound digit to one active specialist using round-robin. */
export function handleDigit(ownerUid: string, call: NormalizedInboundCall, baseUrl: string): IvrInstruction[] {
  const config = getTelephonyConfig(ownerUid);
  const existing = getCallBySid(call.callSid);
  if (!config.enabled || !existing) {
    return [
      { action: "say", text: "عذرًا، انتهت جلسة المكالمة. سيتواصل معك فريقنا قريبًا.", language: "ar" },
      { action: "hangup" },
    ];
  }
  const digit = String(call.digit || "");
  const department = getDepartmentByDigit(ownerUid, digit);
  if (!department) {
    const attempts = Number(existing.invalid_attempts || 0) + 1;
    updateCallBySid(call.callSid, { invalid_attempts: attempts, status: "menu", call_status: "menu" });
    if (attempts < 2 && call.sessionToken) {
      const { greeting, prompt } = buildMenuText(ownerUid);
      return [{
        action: "gather",
        text: `اختيار غير صحيح. ${greeting} ${prompt}`,
        numDigits: 1,
        timeoutSec: 8,
        responseUrl: ivrResponseUrl(baseUrl, call.sessionToken),
        language: "ar",
      }];
    }
    updateCallBySid(call.callSid, {
      status: "no_answer", call_status: "no_answer", follow_up_status: "new",
      missed: 1, ended_at: nowIso(),
    });
    runMissedCallFlow(call.callSid).catch((error) => logError("ivr.invalid_choice_followup_failed", error));
    return [
      { action: "say", text: "عذرًا، لم نستلم اختيارًا صحيحًا. أنشأنا طلب متابعة وسنتصل بك قريبًا.", language: "ar" },
      { action: "hangup" },
    ];
  }

  if (!departmentOpenNow(department)) {
    updateCallBySid(call.callSid, {
      department_id: department.id, department_name: department.name, selected_digit: digit,
      status: "no_answer", call_status: "no_answer", follow_up_status: "new",
      missed: 1, ended_at: nowIso(),
    });
    createDepartmentWorkItem(call.callSid, department, null);
    runMissedCallFlow(call.callSid).catch((error) => logError("ivr.out_of_hours_followup_failed", error));
    return [
      { action: "say", text: `قسم ${department.name} خارج ساعات العمل حاليًا. أنشأنا طلب متابعة وسنتصل بك قريبًا.`, language: "ar" },
      { action: "hangup" },
    ];
  }

  const assigned = existing.agent_phone
    ? department.agents.find((candidate) => candidate.phone === existing.agent_phone) || null
    : pickAgentRoundRobin(department);
  if (!assigned) {
    updateCallBySid(call.callSid, {
      department_id: department.id, department_name: department.name, selected_digit: digit,
      status: "no_answer", call_status: "no_answer", follow_up_status: "new",
      missed: 1, ended_at: nowIso(),
    });
    createDepartmentWorkItem(call.callSid, department, null);
    runMissedCallFlow(call.callSid).catch((error) => logError("ivr.no_agent_followup_failed", error));
    return [
      { action: "say", text: `لا يوجد مختص متاح في قسم ${department.name} حاليًا. أنشأنا طلب متابعة.`, language: "ar" },
      { action: "hangup" },
    ];
  }

  updateCallBySid(call.callSid, {
    department_id: department.id,
    department_name: department.name,
    selected_digit: digit,
    agent_user_id: assigned.user_id,
    assigned_user_id: assigned.user_id,
    agent_phone: assigned.phone,
    agent_name: assigned.name,
    status: "forwarding",
    call_status: "forwarding",
    follow_up_status: assigned.user_id ? "assigned" : "new",
    forwarded_at: nowIso(),
  });
  createDepartmentWorkItem(call.callSid, department, assigned);
  return [{
    action: "dial",
    text: `يتم تحويلك الآن إلى ${department.name}. يرجى الانتظار.`,
    number: normalizeDialNumber(assigned.phone),
    callerId: config.main_number ? normalizeDialNumber(config.main_number) : undefined,
    ringTimeoutSec: department.ring_timeout_sec || config.ring_timeout_sec,
    statusCallbackUrl: statusCallbackUrl(baseUrl),
    recording: false,
  }];
}

/**
 * Status webhook entry point. Returns a short summary for logging. On a
 * not-connected outcome it triggers the missed-call WhatsApp flow.
 */
export async function handleCallStatus(status: NormalizedCallStatus): Promise<Record<string, unknown>> {
  let call = status.callSid ? getCallBySid(status.callSid) : null;
  if (!call) {
    const from = normalizeDialNumber(status.from || "");
    const to = normalizeDialNumber(status.to || "");
    const cutoff = new Date(Date.now() - 5 * 60_000).toISOString();
    const clauses = ["created_at >= ?"];
    const args: unknown[] = [cutoff];
    if (from) {
      clauses.push("from_phone_norm = ?");
      args.push(from);
    }
    if (to) {
      clauses.push("to_phone_norm = ?");
      args.push(to);
    }
    const candidates = db.prepare(
      `SELECT * FROM call_logs WHERE ${clauses.join(" AND ")}
       AND call_status IN ('new','menu','selected','forwarding','ringing','connected','in_progress')
       ORDER BY created_at DESC LIMIT 3`,
    ).all(...args) as Array<Record<string, unknown>>;
    if (candidates.length !== 1) {
      return {
        handled: false,
        reason: candidates.length > 1 ? "ambiguous_recent_call" : "unknown_call",
        callSid: status.callSid,
      };
    }
    call = candidates[0];
  }
  if (!call) {
    return { handled: false, reason: "unknown_call_sid", callSid: status.callSid };
  }

  const missedStatuses: NormalizedCallStatus["status"][] = ["no_answer", "busy", "failed", "voicemail"];
  const completedWithoutSelection = status.status === "completed" && ["new", "menu"].includes(String(call.call_status));
  const isMissed = missedStatuses.includes(status.status) || completedWithoutSelection;
  const callId = String(call.id);
  const ownerUid = String(call.owner_uid);
  const internalSid = String(call.call_sid);
  const terminal = ["completed", "no_answer", "busy", "failed"].includes(String(call.call_status));
  const incomingTerminal = status.status === "completed" || isMissed;
  if (terminal && (!incomingTerminal || String(call.call_status) === "completed" || status.status !== "completed")) {
    return { handled: true, ignored: true, reason: "late_or_regressive_event", callId };
  }
  const callStatus = completedWithoutSelection
    ? "no_answer"
    : status.status === "in_progress"
    ? "connected"
    : status.status === "voicemail"
      ? "no_answer"
      : status.status;

  updateCallById(ownerUid, callId, {
    provider_call_sid: status.callSid || call.provider_call_sid || null,
    status: status.status,
    call_status: callStatus,
    duration_sec: status.durationSec ?? Number(call.duration_sec || 0),
    ended_at: incomingTerminal ? nowIso() : call.ended_at || null,
    missed: isMissed ? 1 : 0,
    live_verified: status.callSid ? 1 : Number(call.live_verified || 0),
  });
  if (status.callSid) {
    db.prepare(
      `UPDATE telephony_numbers SET live_verified_at = COALESCE(live_verified_at, ?), updated_at = ?
       WHERE owner_uid = ? AND phone_norm = ? AND active = 1`,
    ).run(nowIso(), nowIso(), ownerUid, String(call.to_phone_norm || ""));
  }

  if (isMissed) {
    const result = await runMissedCallFlow(internalSid);
    return { handled: true, missed: true, ...result };
  }
  return { handled: true, missed: false, status: callStatus, callId };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function beginTelephonyEvent(ownerUid: string, provider: string, status: NormalizedCallStatus) {
  const canonical = stableJson({
    callSid: status.callSid,
    status: status.status,
    occurredAt: status.occurredAt || null,
    from: normalizeDialNumber(status.from || ""),
    to: normalizeDialNumber(status.to || ""),
    durationSec: status.durationSec ?? null,
    raw: status.raw,
  });
  const eventKey = crypto.createHash("sha256").update(canonical).digest("hex");
  const eventId = newId("televent");
  const result = db.prepare(
    `INSERT OR IGNORE INTO telephony_events
      (id, owner_uid, provider, event_key, event_type, provider_call_sid, payload, status, attempts, received_at)
     VALUES (?, ?, ?, ?, 'call_status', ?, ?, 'processing', 1, ?)`,
  ).run(eventId, ownerUid, provider, eventKey, status.callSid || null, canonical, nowIso());
  const existing = db.prepare(
    "SELECT id, status FROM telephony_events WHERE owner_uid = ? AND provider = ? AND event_key = ?",
  ).get(ownerUid, provider, eventKey) as { id: string; status: string };
  if (result.changes === 0 && existing.status === "failed") {
    db.prepare(
      "UPDATE telephony_events SET status = 'processing', attempts = attempts + 1, error = NULL WHERE id = ?",
    ).run(existing.id);
  }
  return { duplicate: result.changes === 0 && existing.status !== "failed", eventId: existing.id };
}

export function completeTelephonyEvent(eventId: string, callId?: string) {
  db.prepare(
    "UPDATE telephony_events SET status = 'processed', call_id = ?, processed_at = ?, error = NULL WHERE id = ?",
  ).run(callId || null, nowIso(), eventId);
}

export function failTelephonyEvent(eventId: string, error: unknown) {
  db.prepare(
    "UPDATE telephony_events SET status = 'failed', error = ?, attempts = attempts + 1 WHERE id = ?",
  ).run(error instanceof Error ? error.message : String(error), eventId);
}

// ── Missed-call WhatsApp flow ─────────────────────────────────────────────────
/**
 * Sends the apology to the customer and the call-back alert to the agent.
 * Idempotent per flag — re-running won't double-send. Never throws.
 */
export async function legacyRunMissedCallFlow(callSid: string): Promise<Record<string, unknown>> {
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
        // Show the agent a canonical number (966… for local; genuine
        // international numbers are left intact) instead of the raw provider form.
        vars: { department_name: departmentName || "-", customer_phone: (customerPhone && normalizeDialNumber(customerPhone)) || "-", call_time: callTime },
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

/** Create the callback task and dispatch each notification exactly once. */
export async function runMissedCallFlow(callSid: string): Promise<Record<string, unknown>> {
  const call = getCallBySid(callSid);
  if (!call) return { sent: false, reason: "unknown_call" };

  const ownerUid = String(call.owner_uid || "");
  const customerPhone = String(call.from_phone || "");
  const departmentName = String(call.department_name || "المتابعة العامة");
  const agentName = String(call.agent_name || "أحد موظفينا");
  let agentPhone = String(call.agent_phone || "");
  const department = call.department_id
    ? getDepartment(ownerUid, String(call.department_id))
    : null;
  const fallbackDepartment: IvrDepartment = department || {
    id: "general",
    owner_uid: ownerUid,
    digit: "",
    name: departmentName,
    ring_timeout_sec: DEFAULT_RING_TIMEOUT,
    active: true,
    sort_order: 0,
    workflow_action: "none",
    schedule_json: "",
    fallback_user_id: null,
    agents: [],
  };
  const assignedAgent: IvrAgent | null = agentPhone ? {
    id: String(call.agent_user_id || agentPhone),
    department_id: fallbackDepartment.id,
    owner_uid: ownerUid,
    user_id: call.agent_user_id ? String(call.agent_user_id) : null,
    name: agentName,
    phone: agentPhone,
    sort_order: 0,
    active: true,
  } : null;
  const assignedUid = assignedAgent?.user_id || fallbackDepartment.fallback_user_id || managerQueueUid(ownerUid);
  if (!agentPhone && assignedUid) {
    const user = db.prepare(
      "SELECT phone FROM users WHERE workspace_owner_uid = ? AND uid = ? AND active = 1 LIMIT 1",
    ).get(ownerUid, assignedUid) as { phone?: string } | undefined;
    agentPhone = String(user?.phone || "");
  }
  const taskId = ensureServiceTask(call, fallbackDepartment, assignedAgent, "high");
  updateCallBySid(callSid, {
    task_id: taskId,
    follow_up_status: assignedAgent?.user_id ? "assigned" : "new",
    assigned_user_id: assignedUid,
  });

  const callTime = new Date(String(call.created_at || nowIso())).toLocaleString("ar-SA", {
    timeZone: process.env.APP_TIMEZONE || "Asia/Riyadh",
  });
  const output: Record<string, unknown> = { sent: true, customer: false, agent: false, taskId };

  if (customerPhone && Number(call.wa_customer_notified || 0) === 0) {
    try {
      const delivery = await dispatchCommunicationJob({
        ownerUid,
        idempotencyKey: `${String(call.id)}:missed:customer`,
        callId: String(call.id),
        role: "customer",
        phone: customerPhone,
        template: "missed_call_customer",
        vars: { department_name: departmentName, agent_name: agentName },
      });
      if (delivery.channel !== "pending") updateCallBySid(callSid, { wa_customer_notified: 1 });
      output.customer = delivery.channel;
    } catch (error) {
      logError("ivr.missed_call.customer_dispatch_failed", error);
      output.sent = false;
    }
  }

  if (agentPhone && Number(call.wa_agent_notified || 0) === 0) {
    try {
      const delivery = await dispatchCommunicationJob({
        ownerUid,
        idempotencyKey: `${String(call.id)}:missed:agent`,
        callId: String(call.id),
        role: assignedAgent ? "agent" : "manager",
        phone: agentPhone,
        template: "missed_call_agent",
        vars: {
          department_name: departmentName,
          customer_phone: normalizeDialNumber(customerPhone) || "-",
          call_time: callTime,
        },
      });
      if (delivery.channel !== "pending") updateCallBySid(callSid, { wa_agent_notified: 1 });
      output.agent = delivery.channel;
    } catch (error) {
      logError("ivr.missed_call.agent_dispatch_failed", error);
      output.sent = false;
    }
  }

  logEvent("info", "ivr.missed_call.followup_created", {
    callSid,
    taskId,
    customerChannel: output.customer,
    agentChannel: output.agent,
  });
  return output;
}
