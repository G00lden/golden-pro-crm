import crypto from "node:crypto";
import db from "./db";
import { normalizeOutboundPhone } from "./outboundSafety";

export const CALL_REPLY_MODES = ["disabled", "specific", "all_except", "all"] as const;
export type CallReplyMode = (typeof CALL_REPLY_MODES)[number];
export type CallReplyDisposition = "no_answer" | "busy" | "unreachable" | "rejected" | "after_hours";

export type CallReplyPolicy = {
  enabled: boolean;
  mode: CallReplyMode;
  selectedDeviceId: string | null;
  selectedSimKey: string | null;
  unifonicEnabled: boolean;
  insideHoursMessage: string;
  afterHoursMessage: string;
  version: number;
  numbers: Array<{ phone: string; label: string; kind: "allow" | "exclude" }>;
  updatedAt: string | null;
};

type StoredPolicy = {
  enabled: number;
  mode: string;
  selected_device_id: string | null;
  selected_sim_key: string | null;
  unifonic_enabled: number;
  inside_hours_message: string | null;
  after_hours_message: string | null;
  version: number;
  updated_at: string | null;
};

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function nowIso() {
  return new Date().toISOString();
}

export function defaultCallReplyMessages() {
  const company = String(process.env.COMPANY_NAME || "BreeXe Pro").trim();
  return {
    insideHoursMessage: `شكرًا لاتصالك بـ${company}. تعذر علينا الرد الآن. اكتب لنا هنا ماذا تحتاج، وسنتواصل معك في أقرب فرصة.`,
    afterHoursMessage: `شكرًا لاتصالك بـ${company}. نحن خارج أوقات الدوام حاليًا. اكتب لنا هنا ماذا تحتاج، وسنتواصل معك في أقرب فرصة.`,
  };
}

function normalizeReplyMessage(value: unknown, fallback: string) {
  const message = String(value || "").trim();
  if (!message) return fallback;
  if (message.length < 10) throw new Error("نص رسالة واتساب قصير جدًا.");
  if (message.length > 700) throw new Error("الحد الأقصى لنص رسالة واتساب هو 700 حرف.");
  return message;
}

export function normalizePolicyPhone(value: string): string {
  const phone = normalizeOutboundPhone(value);
  return /^\d{10,15}$/.test(phone) ? phone : "";
}

export function getCallReplyPolicy(ownerUid: string): CallReplyPolicy {
  const stored = db.prepare(
    `SELECT enabled, mode, selected_device_id, selected_sim_key, unifonic_enabled,
            inside_hours_message, after_hours_message, version, updated_at
     FROM call_reply_policies WHERE owner_uid = ?`,
  ).get(ownerUid) as StoredPolicy | undefined;
  const numbers = db.prepare(
    `SELECT phone, label, list_kind AS kind FROM call_reply_policy_numbers
     WHERE owner_uid = ? ORDER BY created_at ASC`,
  ).all(ownerUid) as Array<{ phone: string; label: string; kind: "allow" | "exclude" }>;
  const mode = CALL_REPLY_MODES.includes(stored?.mode as CallReplyMode)
    ? stored?.mode as CallReplyMode
    : "disabled";
  const defaults = defaultCallReplyMessages();
  return {
    enabled: Boolean(stored?.enabled) && mode !== "disabled",
    mode,
    selectedDeviceId: stored?.selected_device_id || null,
    selectedSimKey: stored?.selected_sim_key || null,
    unifonicEnabled: stored ? Boolean(stored.unifonic_enabled) : true,
    insideHoursMessage: stored?.inside_hours_message?.trim() || defaults.insideHoursMessage,
    afterHoursMessage: stored?.after_hours_message?.trim() || defaults.afterHoursMessage,
    version: Number(stored?.version || 0),
    numbers,
    updatedAt: stored?.updated_at || null,
  };
}

export type SaveCallReplyPolicyInput = {
  enabled: boolean;
  mode: CallReplyMode;
  selectedDeviceId?: string | null;
  selectedSimKey?: string | null;
  unifonicEnabled?: boolean;
  insideHoursMessage?: string;
  afterHoursMessage?: string;
  version?: number;
  confirmationPhrase?: string;
  numbers?: Array<{ phone: string; label?: string }>;
};

function validateActiveSource(ownerUid: string, deviceId: string, simKey: string) {
  return db.prepare(
    `SELECT 1 FROM gateway_devices d
     JOIN mobile_device_sims s ON s.device_id = d.id AND s.owner_uid = d.owner_uid
     WHERE d.owner_uid = ? AND d.id = ? AND d.revoked_at IS NULL
       AND s.sim_key = ? AND s.active = 1 LIMIT 1`,
  ).get(ownerUid, deviceId, simKey);
}

export function saveCallReplyPolicy(
  ownerUid: string,
  actorUid: string,
  input: SaveCallReplyPolicyInput,
): CallReplyPolicy {
  if (!CALL_REPLY_MODES.includes(input.mode)) throw new Error("وضع سياسة الرد غير صالح.");
  const current = getCallReplyPolicy(ownerUid);
  if (input.version !== undefined && input.version !== current.version) {
    throw new Error("تم تعديل السياسة من مستخدم آخر. حدّث الصفحة ثم أعد المحاولة.");
  }

  const enabled = Boolean(input.enabled) && input.mode !== "disabled";
  const deviceId = String(input.selectedDeviceId || "").trim();
  const simKey = String(input.selectedSimKey || "").trim();
  if (enabled && (!deviceId || !simKey || !validateActiveSource(ownerUid, deviceId, simKey))) {
    throw new Error("اختر جهازًا نشطًا وشريحة عمل معروفة قبل تفعيل الردود.");
  }

  const normalized = (input.numbers || []).map((item) => ({
    phone: normalizePolicyPhone(item.phone),
    label: String(item.label || "").trim().slice(0, 80),
  }));
  if (normalized.some((item) => !item.phone)) throw new Error("تتضمن القائمة رقمًا غير صالح.");
  const deduplicated = [...new Map(normalized.map((item) => [item.phone, item])).values()];
  if (deduplicated.length > 500) throw new Error("الحد الأقصى هو 500 رقم في السياسة.");
  if (enabled && input.mode === "specific" && deduplicated.length === 0) {
    throw new Error("أضف رقمًا واحدًا على الأقل لوضع الأرقام المحددة.");
  }
  const opensEveryone = enabled && (input.mode === "all" || (input.mode === "all_except" && deduplicated.length === 0));
  if (opensEveryone && input.confirmationPhrase !== "فتح الرد للجميع") {
    throw new Error("اكتب «فتح الرد للجميع» لتأكيد هذا التغيير.");
  }
  const defaults = defaultCallReplyMessages();
  const insideHoursMessage = normalizeReplyMessage(input.insideHoursMessage, current.insideHoursMessage || defaults.insideHoursMessage);
  const afterHoursMessage = normalizeReplyMessage(input.afterHoursMessage, current.afterHoursMessage || defaults.afterHoursMessage);

  const saved = db.transaction(() => {
    const nextVersion = current.version + 1;
    const now = nowIso();
    db.prepare(
      `INSERT INTO call_reply_policies
        (owner_uid, enabled, mode, selected_device_id, selected_sim_key, unifonic_enabled,
         inside_hours_message, after_hours_message, version, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_uid) DO UPDATE SET
         enabled = excluded.enabled, mode = excluded.mode,
         selected_device_id = excluded.selected_device_id,
         selected_sim_key = excluded.selected_sim_key,
         unifonic_enabled = excluded.unifonic_enabled,
         inside_hours_message = excluded.inside_hours_message,
         after_hours_message = excluded.after_hours_message,
         version = excluded.version, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    ).run(
      ownerUid,
      enabled ? 1 : 0,
      input.mode,
      deviceId || null,
      simKey || null,
      input.unifonicEnabled === false ? 0 : 1,
      insideHoursMessage,
      afterHoursMessage,
      nextVersion,
      actorUid,
      now,
      now,
    );
    db.prepare("DELETE FROM call_reply_policy_numbers WHERE owner_uid = ?").run(ownerUid);
    const kind = input.mode === "all_except" ? "exclude" : "allow";
    const insert = db.prepare(
      `INSERT INTO call_reply_policy_numbers
        (id, owner_uid, list_kind, phone, label, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const item of deduplicated) {
      insert.run(id("crn"), ownerUid, kind, item.phone, item.label, actorUid, now);
    }
    db.prepare(
      `UPDATE gateway_devices SET policy_version = COALESCE(policy_version, 0) + 1, updated_at = ?
       WHERE owner_uid = ? AND revoked_at IS NULL`,
    ).run(now, ownerUid);
    db.prepare(
      `INSERT INTO audit_logs
        (id, owner_uid, actor_uid, action, entity_type, entity_id, summary, before_data, after_data, created_at)
       VALUES (?, ?, ?, 'mobile.call_reply_policy.updated', 'call_reply_policy', ?, ?, ?, ?, ?)`,
    ).run(
      id("audit"),
      ownerUid,
      actorUid,
      ownerUid,
      `تحديث سياسة ردود المكالمات إلى ${input.mode}`,
      JSON.stringify(current),
      JSON.stringify({ ...input, confirmationPhrase: undefined }),
      now,
    );
    return getCallReplyPolicy(ownerUid);
  });
  return saved();
}

export function evaluateCallReplyRecipient(ownerUid: string, phoneValue: string) {
  const policy = getCallReplyPolicy(ownerUid);
  const phone = normalizePolicyPhone(phoneValue);
  if (!phone) return { allowed: false, reason: "invalid_phone", phone, policy };
  if (!policy.enabled || policy.mode === "disabled") return { allowed: false, reason: "policy_disabled", phone, policy };
  const numbers = new Set(policy.numbers.map((item) => item.phone));
  if (policy.mode === "specific" && !numbers.has(phone)) {
    return { allowed: false, reason: "recipient_not_selected", phone, policy };
  }
  if (policy.mode === "all_except" && numbers.has(phone)) {
    return { allowed: false, reason: "recipient_excluded", phone, policy };
  }
  return { allowed: true, reason: "allowed", phone, policy };
}

export function evaluateCallReplySource(
  policy: CallReplyPolicy,
  input: { source?: unknown; deviceId?: unknown; simKey?: unknown },
) {
  const source = String(input.source || "").trim().toLowerCase();
  if (source === "unifonic") {
    return { allowed: policy.unifonicEnabled, reason: policy.unifonicEnabled ? "allowed" : "unifonic_disabled" };
  }
  if (source === "gateway" || source.startsWith("android")) {
    const matches = Boolean(
      policy.selectedDeviceId && policy.selectedSimKey &&
      String(input.deviceId || "") === policy.selectedDeviceId &&
      String(input.simKey || "") === policy.selectedSimKey,
    );
    return { allowed: matches, reason: matches ? "allowed" : "source_not_selected" };
  }
  return { allowed: false, reason: "unknown_source" };
}

function riyadhParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Riyadh",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return { weekday: value("weekday"), minutes: Number(value("hour")) * 60 + Number(value("minute")) };
}

export function isWithinCallBusinessHours(date = new Date()) {
  const { weekday, minutes } = riyadhParts(date);
  return weekday !== "Fri" && minutes >= 8 * 60 && minutes < 21 * 60;
}

export function renderCallReplyMessage(
  disposition: CallReplyDisposition,
  date = new Date(),
  messages: Pick<CallReplyPolicy, "insideHoursMessage" | "afterHoursMessage"> = defaultCallReplyMessages(),
) {
  const outside = disposition === "after_hours" || !isWithinCallBusinessHours(date);
  return outside ? messages.afterHoursMessage : messages.insideHoursMessage;
}
