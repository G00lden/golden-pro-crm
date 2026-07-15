import crypto from "node:crypto";
import { getMessaging } from "firebase-admin/messaging";
import db from "./db";
import { adminApp } from "./firebaseAdmin";
import { handleGatewayEvent } from "./gateway";
import type { AuthenticatedGatewayDevice } from "./gatewayPairing";
import { getCallReplyPolicy, normalizePolicyPhone } from "./callReplyPolicy";
import { logError, logEvent } from "./logger";

export const MOBILE_COMMAND_TYPES = [
  "dial_request",
  "open_customer",
  "show_task",
  "sync_contacts",
  "refresh_policy",
  "collect_health",
  "local_wipe",
] as const;
export type MobileCommandType = (typeof MOBILE_COMMAND_TYPES)[number];
export type MobileCommandStatus =
  | "pending"
  | "delivered"
  | "confirmed"
  | "completed"
  | "failed"
  | "expired"
  | "cancelled";

export type MobileEventEnvelope = {
  schemaVersion: number;
  eventId: string;
  type: string;
  simKey?: string;
  occurredAt: string;
  payload?: Record<string, unknown>;
};

type CommandRow = {
  id: string;
  owner_uid: string;
  device_id: string;
  actor_uid: string | null;
  command_type: MobileCommandType;
  payload: string | Record<string, unknown>;
  status: MobileCommandStatus;
  expires_at: string;
  delivered_at: string | null;
  confirmed_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  cancelled_at: string | null;
  error: string | null;
  result: string | Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

function nowIso(date = new Date()) {
  return date.toISOString();
}

function newId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`;
}

function safeJson(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") return value as Record<string, unknown>;
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function normalizedCommand(row: CommandRow) {
  return { ...row, payload: safeJson(row.payload), result: safeJson(row.result) };
}

function mobileEncryptionKey() {
  const source = String(
    process.env.MOBILE_DATA_ENCRYPTION_KEY ||
    process.env.GATEWAY_DEVICE_HMAC_SECRET ||
    process.env.GATEWAY_TOKEN ||
    "",
  ).trim();
  return source ? crypto.createHash("sha256").update(source).digest() : null;
}

function encryptSecret(value: string) {
  const key = mobileEncryptionKey();
  if (!key || !value) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}

function decryptSecret(value: string | null | undefined) {
  const key = mobileEncryptionKey();
  if (!key || !value) return "";
  try {
    const [iv, tag, encrypted] = value.split(".").map((part) => Buffer.from(part, "base64url"));
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

function audit(input: {
  ownerUid: string;
  actorUid?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  summary: string;
  before?: unknown;
  after?: unknown;
}) {
  db.prepare(
    `INSERT INTO audit_logs
      (id, owner_uid, actor_uid, action, entity_type, entity_id, summary, before_data, after_data, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId("audit"), input.ownerUid, input.actorUid || null, input.action,
    input.entityType, input.entityId, input.summary,
    input.before === undefined ? null : JSON.stringify(input.before),
    input.after === undefined ? null : JSON.stringify(input.after), nowIso(),
  );
}

function deviceRow(ownerUid: string, deviceId: string) {
  return db.prepare(
    `SELECT d.*, u.name AS assigned_user_name
     FROM gateway_devices d LEFT JOIN users u ON u.uid = d.assigned_user_uid
     WHERE d.owner_uid = ? AND d.id = ? LIMIT 1`,
  ).get(ownerUid, deviceId) as Record<string, unknown> | undefined;
}

function publicDevice(row: Record<string, unknown>) {
  const sims = db.prepare(
    `SELECT sim_key, slot_index, carrier_name, display_name, phone_suffix, active, last_seen_at
     FROM mobile_device_sims WHERE owner_uid = ? AND device_id = ?
     ORDER BY active DESC, slot_index ASC`,
  ).all(row.owner_uid, row.id) as Array<Record<string, unknown>>;
  return {
    id: row.id,
    name: row.name,
    company_number: row.company_number,
    assigned_user_uid: row.assigned_user_uid || null,
    assigned_user_name: row.assigned_user_name || null,
    branch_id: row.branch_id || null,
    management_mode: row.management_mode || "byod",
    work_sim_key: row.work_sim_key || null,
    capabilities: safeJson(row.capabilities_json),
    policy_version: Number(row.policy_version || 0),
    app_version: row.app_version || null,
    platform_version: row.platform_version || null,
    manufacturer: row.manufacturer || null,
    model: row.model || null,
    battery_percent: row.battery_percent === null ? null : Number(row.battery_percent),
    network_type: row.network_type || null,
    permissions: safeJson(row.permissions_json),
    health: safeJson(row.health_json),
    last_health_at: row.last_health_at || null,
    last_seen_at: row.last_seen_at || null,
    created_at: row.created_at,
    revoked_at: row.revoked_at || null,
    sims,
  };
}

export function listMobileDevices(ownerUid: string) {
  const rows = db.prepare(
    `SELECT d.*, u.name AS assigned_user_name
     FROM gateway_devices d LEFT JOIN users u ON u.uid = d.assigned_user_uid
     WHERE d.owner_uid = ? ORDER BY d.revoked_at IS NULL DESC, d.created_at DESC`,
  ).all(ownerUid) as Array<Record<string, unknown>>;
  return rows.map(publicDevice);
}

export type DeviceProfileInput = {
  appVersion?: string;
  platformVersion?: string;
  manufacturer?: string;
  model?: string;
  batteryPercent?: number;
  networkType?: string;
  permissions?: Record<string, boolean>;
  health?: Record<string, unknown>;
  fcmToken?: string;
  sims?: Array<{
    simKey: string;
    slotIndex?: number;
    carrierName?: string;
    displayName?: string;
    phoneSuffix?: string;
  }>;
};

export function updateDeviceProfile(device: AuthenticatedGatewayDevice, profile: DeviceProfileInput) {
  const sims = (profile.sims || []).slice(0, 4).map((sim) => ({
    simKey: String(sim.simKey || "").trim(),
    slotIndex: Number.isInteger(sim.slotIndex) ? Number(sim.slotIndex) : null,
    carrierName: String(sim.carrierName || "").trim().slice(0, 80),
    displayName: String(sim.displayName || "").trim().slice(0, 80),
    phoneSuffix: String(sim.phoneSuffix || "").replace(/\D/g, "").slice(-4),
  }));
  if (sims.some((sim) => !/^[A-Za-z0-9_-]{32,128}$/.test(sim.simKey))) {
    throw new Error("SIM profile contains an invalid opaque key.");
  }
  const now = nowIso();
  const update = db.transaction(() => {
    if (sims.length) {
      db.prepare(
        "UPDATE mobile_device_sims SET active = 0, updated_at = ? WHERE owner_uid = ? AND device_id = ?",
      ).run(now, device.owner_uid, device.id);
      const upsert = db.prepare(
        `INSERT INTO mobile_device_sims
          (id, owner_uid, device_id, sim_key, slot_index, carrier_name, display_name,
           phone_suffix, active, last_seen_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT(owner_uid, device_id, sim_key) DO UPDATE SET
           slot_index = excluded.slot_index, carrier_name = excluded.carrier_name,
           display_name = excluded.display_name, phone_suffix = excluded.phone_suffix,
           active = 1, last_seen_at = excluded.last_seen_at, updated_at = excluded.updated_at`,
      );
      for (const sim of sims) {
        upsert.run(
          `${device.id}:${sim.simKey}`, device.owner_uid, device.id, sim.simKey,
          sim.slotIndex, sim.carrierName, sim.displayName, sim.phoneSuffix, now, now, now,
        );
      }
    }
    const encryptedFcm = profile.fcmToken ? encryptSecret(String(profile.fcmToken).trim()) : null;
    db.prepare(
      `UPDATE gateway_devices SET
        app_version = ?, platform_version = ?, manufacturer = ?, model = ?,
        battery_percent = ?, network_type = ?, permissions_json = ?, health_json = ?,
        fcm_token_ciphertext = COALESCE(?, fcm_token_ciphertext),
        last_health_at = ?, last_seen_at = ?, updated_at = ?
       WHERE owner_uid = ? AND id = ? AND revoked_at IS NULL`,
    ).run(
      String(profile.appVersion || "").slice(0, 40) || null,
      String(profile.platformVersion || "").slice(0, 40) || null,
      String(profile.manufacturer || "").slice(0, 80) || null,
      String(profile.model || "").slice(0, 80) || null,
      Number.isFinite(profile.batteryPercent) ? Math.max(0, Math.min(100, Number(profile.batteryPercent))) : null,
      String(profile.networkType || "").slice(0, 40) || null,
      JSON.stringify(profile.permissions || {}),
      JSON.stringify(profile.health || {}),
      encryptedFcm,
      now, now, now, device.owner_uid, device.id,
    );
  });
  update();
  return publicDevice(deviceRow(device.owner_uid, device.id)!);
}

export type UpdateMobileDeviceInput = {
  name?: string;
  assignedUserUid?: string | null;
  branchId?: string | null;
  managementMode?: "byod" | "company";
  workSimKey?: string | null;
  capabilities?: Record<string, boolean>;
};

export function updateMobileDevice(
  ownerUid: string,
  actorUid: string,
  deviceId: string,
  input: UpdateMobileDeviceInput,
) {
  const before = deviceRow(ownerUid, deviceId);
  if (!before || before.revoked_at) throw new Error("الجهاز غير موجود أو تم إلغاء ربطه.");
  const has = (key: keyof UpdateMobileDeviceInput) => Object.prototype.hasOwnProperty.call(input, key);
  const workSimKey = has("workSimKey")
    ? String(input.workSimKey || "").trim()
    : String(before.work_sim_key || "").trim();
  if (workSimKey) {
    const sim = db.prepare(
      `SELECT 1 FROM mobile_device_sims
       WHERE owner_uid = ? AND device_id = ? AND sim_key = ? AND active = 1`,
    ).get(ownerUid, deviceId, workSimKey);
    if (!sim) throw new Error("شريحة العمل المختارة غير موجودة على هذا الجهاز.");
  }
  const assignedUserUid = has("assignedUserUid")
    ? String(input.assignedUserUid || "").trim()
    : String(before.assigned_user_uid || "").trim();
  if (assignedUserUid) {
    const user = db.prepare("SELECT 1 FROM users WHERE uid = ? AND active = 1").get(assignedUserUid);
    if (!user) throw new Error("الموظف المختار غير موجود أو حسابه موقوف.");
  }
  const capabilities = has("capabilities")
    ? Object.fromEntries(
      Object.entries(input.capabilities || {}).filter(([, value]) => typeof value === "boolean").slice(0, 50),
    )
    : safeJson(before.capabilities_json);
  db.prepare(
    `UPDATE gateway_devices SET name = ?, assigned_user_uid = ?, branch_id = ?,
      management_mode = ?, work_sim_key = ?, capabilities_json = ?,
      policy_version = COALESCE(policy_version, 0) + 1, updated_at = ?
     WHERE owner_uid = ? AND id = ? AND revoked_at IS NULL`,
  ).run(
    String(has("name") ? input.name : before.name || "").trim().slice(0, 80),
    assignedUserUid || null,
    String(has("branchId") ? input.branchId || "" : before.branch_id || "").trim().slice(0, 80) || null,
    has("managementMode") ? (input.managementMode === "company" ? "company" : "byod") : String(before.management_mode || "byod"),
    workSimKey || null,
    JSON.stringify(capabilities),
    nowIso(), ownerUid, deviceId,
  );
  const after = deviceRow(ownerUid, deviceId)!;
  audit({
    ownerUid, actorUid, action: "mobile.device.updated", entityType: "gateway_device",
    entityId: deviceId, summary: `تحديث إعدادات الجهاز ${String(after.name || deviceId)}`,
    before: publicDevice(before), after: publicDevice(after),
  });
  return publicDevice(after);
}

export function selectDeviceWorkSim(device: AuthenticatedGatewayDevice, workSimKey: string) {
  const selected = String(workSimKey || "").trim();
  return updateMobileDevice(
    device.owner_uid,
    `device:${device.id}`,
    device.id,
    { workSimKey: selected || null },
  );
}

export function getMobileDevicePolicy(device: AuthenticatedGatewayDevice) {
  const current = deviceRow(device.owner_uid, device.id);
  if (!current || current.revoked_at) throw new Error("Device link was revoked.");
  const callReply = getCallReplyPolicy(device.owner_uid);
  return {
    schemaVersion: 1,
    deviceId: device.id,
    assignedUserUid: current.assigned_user_uid || null,
    assignedUserName: current.assigned_user_name || null,
    branchId: current.branch_id || null,
    managementMode: current.management_mode || "byod",
    workSimKey: current.work_sim_key || null,
    policyVersion: Number(current.policy_version || 0),
    capabilities: safeJson(current.capabilities_json),
    callReply: {
      enabled: callReply.enabled,
      mode: callReply.mode,
      version: callReply.version,
      unifonicEnabled: callReply.unifonicEnabled,
    },
    commandPollSeconds: 60,
    failClosedWithoutWorkSim: true,
    updatedAt: current.updated_at || current.created_at,
  };
}

async function pushCommand(command: ReturnType<typeof normalizedCommand>) {
  const row = db.prepare(
    "SELECT fcm_token_ciphertext FROM gateway_devices WHERE owner_uid = ? AND id = ? AND revoked_at IS NULL",
  ).get(command.owner_uid, command.device_id) as { fcm_token_ciphertext?: string } | undefined;
  const token = decryptSecret(row?.fcm_token_ciphertext);
  if (!token) return false;
  try {
    await getMessaging(adminApp).send({
      token,
      data: { commandId: command.id },
      android: { priority: "high" },
    });
    return true;
  } catch (error) {
    logError("mobile.command.push_failed", error, { commandId: command.id, deviceId: command.device_id });
    return false;
  }
}

export function createMobileCommand(input: {
  ownerUid: string;
  actorUid: string;
  deviceId: string;
  type: MobileCommandType;
  payload?: Record<string, unknown>;
  expiresInSeconds?: number;
}) {
  if (!MOBILE_COMMAND_TYPES.includes(input.type)) throw new Error("نوع أمر الجوال غير مدعوم.");
  const device = deviceRow(input.ownerUid, input.deviceId);
  if (!device || device.revoked_at) throw new Error("الجهاز غير موجود أو غير متصل.");
  const payload = { ...(input.payload || {}) };
  if (input.type === "dial_request") {
    const phone = normalizePolicyPhone(String(payload.phone || ""));
    if (!phone) throw new Error("أدخل رقم اتصال صالحًا.");
    const workSimKey = String(device.work_sim_key || "").trim();
    if (!workSimKey) throw new Error("اعتمد شريحة العمل على الجهاز قبل إرسال طلب الاتصال.");
    const workSim = db.prepare(
      `SELECT sim_key, slot_index, carrier_name, display_name
       FROM mobile_device_sims
       WHERE owner_uid = ? AND device_id = ? AND sim_key = ? AND active = 1
       LIMIT 1`,
    ).get(input.ownerUid, input.deviceId, workSimKey) as Record<string, unknown> | undefined;
    if (!workSim) throw new Error("شريحة العمل المعتمدة غير نشطة على هذا الجهاز.");
    payload.phone = phone;
    payload.customerName = String(payload.customerName || "").trim().slice(0, 120);
    payload.reason = String(payload.reason || "").trim().slice(0, 300);
    payload.workSimKey = workSimKey;
    payload.workSimSlotIndex = Number(workSim.slot_index ?? -1);
    payload.workSimLabel = String(workSim.carrier_name || workSim.display_name || "").trim().slice(0, 80);
  }
  const createdAt = nowIso();
  const expiresAt = nowIso(new Date(Date.now() + Math.max(30, Math.min(86_400, input.expiresInSeconds || (input.type === "dial_request" ? 300 : 86_400))) * 1000));
  const commandId = newId("mcmd");
  db.prepare(
    `INSERT INTO mobile_commands
      (id, owner_uid, device_id, actor_uid, command_type, payload, status, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
  ).run(commandId, input.ownerUid, input.deviceId, input.actorUid, input.type, JSON.stringify(payload), expiresAt, createdAt, createdAt);
  const command = normalizedCommand(db.prepare("SELECT * FROM mobile_commands WHERE id = ?").get(commandId) as CommandRow);
  audit({
    ownerUid: input.ownerUid, actorUid: input.actorUid, action: "mobile.command.created",
    entityType: "mobile_command", entityId: commandId,
    summary: `إنشاء أمر ${input.type} للجهاز ${String(device.name || input.deviceId)}`,
    after: { ...command, payload: input.type === "dial_request" ? { ...command.payload, phone: "[redacted]" } : command.payload },
  });
  void pushCommand(command);
  return command;
}

export function listDeviceCommands(device: AuthenticatedGatewayDevice, limit = 20) {
  const now = nowIso();
  const claim = db.transaction(() => {
    db.prepare(
      `UPDATE mobile_commands SET status = 'expired', updated_at = ?
       WHERE owner_uid = ? AND device_id = ? AND status IN ('pending','delivered') AND expires_at <= ?`,
    ).run(now, device.owner_uid, device.id, now);
    const rows = db.prepare(
      `SELECT * FROM mobile_commands WHERE owner_uid = ? AND device_id = ?
       AND status IN ('pending','delivered') AND expires_at > ?
       ORDER BY created_at ASC LIMIT ?`,
    ).all(device.owner_uid, device.id, now, Math.max(1, Math.min(50, limit))) as CommandRow[];
    const delivered = db.prepare(
      `UPDATE mobile_commands SET status = 'delivered', delivered_at = COALESCE(delivered_at, ?), updated_at = ?
       WHERE id = ? AND status = 'pending'`,
    );
    for (const row of rows) delivered.run(now, now, row.id);
    return rows.map((row) => normalizedCommand({ ...row, status: "delivered", delivered_at: row.delivered_at || now }));
  });
  return claim();
}

export function acknowledgeMobileCommand(
  device: AuthenticatedGatewayDevice,
  commandId: string,
  status: Exclude<MobileCommandStatus, "pending" | "delivered" | "expired">,
  result?: Record<string, unknown>,
  error?: string,
) {
  const row = db.prepare(
    "SELECT * FROM mobile_commands WHERE owner_uid = ? AND device_id = ? AND id = ?",
  ).get(device.owner_uid, device.id, commandId) as CommandRow | undefined;
  if (!row) throw new Error("Mobile command was not found.");
  if (["completed", "failed", "cancelled", "expired"].includes(row.status)) return normalizedCommand(row);
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    db.prepare("UPDATE mobile_commands SET status = 'expired', updated_at = ? WHERE id = ?").run(nowIso(), commandId);
    return normalizedCommand({ ...row, status: "expired", updated_at: nowIso() });
  }
  const allowed = status === "confirmed"
    ? ["pending", "delivered"].includes(row.status)
    : ["pending", "delivered", "confirmed"].includes(row.status);
  if (!allowed) throw new Error("Invalid mobile command state transition.");
  const now = nowIso();
  const timestampColumn = status === "confirmed" ? "confirmed_at" : status === "completed" ? "completed_at" : status === "failed" ? "failed_at" : "cancelled_at";
  db.prepare(
    `UPDATE mobile_commands SET status = ?, ${timestampColumn} = ?, result = ?, error = ?, updated_at = ?
     WHERE id = ? AND owner_uid = ? AND device_id = ?`,
  ).run(status, now, JSON.stringify(result || {}), String(error || "").slice(0, 1000) || null, now, commandId, device.owner_uid, device.id);
  const updated = normalizedCommand(db.prepare("SELECT * FROM mobile_commands WHERE id = ?").get(commandId) as CommandRow);
  logEvent("info", "mobile.command.acknowledged", { commandId, deviceId: device.id, status });
  return updated;
}

function outcomeEvent(device: AuthenticatedGatewayDevice, event: MobileEventEnvelope) {
  const payload = event.payload || {};
  const callSid = String(payload.callSid || "").trim();
  const outcome = String(payload.outcome || "").trim();
  const allowed = new Set(["contacted", "no_answer", "follow_up", "interested", "not_interested", "wrong_number"]);
  if (!callSid || !allowed.has(outcome)) throw new Error("Invalid call outcome payload.");
  const call = db.prepare(
    "SELECT * FROM call_logs WHERE owner_uid = ? AND device_id = ? AND call_sid = ? LIMIT 1",
  ).get(device.owner_uid, device.id, callSid) as Record<string, unknown> | undefined;
  if (!call) throw new Error("Call for outcome was not found.");
  const note = String(payload.note || "").trim().slice(0, 2000);
  const now = nowIso();
  db.prepare(
    "UPDATE call_logs SET outcome = ?, handled = ?, handled_at = ?, handled_by = ?, updated_at = ? WHERE id = ?",
  ).run(outcome, outcome === "no_answer" || outcome === "follow_up" ? 0 : 1, now, device.assigned_user_uid || device.id, now, call.id);
  if (note && call.customer_id) {
    db.prepare(
      `INSERT INTO crm_notes (id, owner_uid, customer_id, body, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(newId("note"), device.owner_uid, call.customer_id, note, device.assigned_user_uid || device.id, now);
  }
  if (outcome === "follow_up") {
    const dueAt = new Date(String(payload.followUpAt || ""));
    const due = Number.isFinite(dueAt.getTime()) ? dueAt.toISOString() : new Date(Date.now() + 60 * 60_000).toISOString();
    db.prepare(
      `INSERT INTO crm_tasks
        (id, owner_uid, title, status, priority, due_date, assigned_to, related_type, related_id,
         customer_id, notes, created_at, updated_at)
       VALUES (?, ?, ?, 'open', 'high', ?, ?, 'call', ?, ?, ?, ?, ?)`,
    ).run(
      newId("task"), device.owner_uid, `متابعة اتصال ${String(call.customer_name || call.from_phone || "")}`,
      due, device.assigned_user_uid || null, call.id, call.customer_id || null,
      note || "متابعة أضيفت من BreeXe Connect.", now, now,
    );
  }
  return { callId: call.id, callSid, outcome, noteSaved: Boolean(note && call.customer_id) };
}

const CALL_EVENT_TYPES = new Set([
  "answered", "call_answered", "no_answer", "missed_call", "busy", "unreachable",
  "rejected", "after_hours", "outgoing", "blocked", "unknown",
]);

async function processOneEvent(device: AuthenticatedGatewayDevice, event: MobileEventEnvelope) {
  const callScoped = CALL_EVENT_TYPES.has(event.type) || event.type === "call_outcome";
  const current = callScoped ? deviceRow(device.owner_uid, device.id) : null;
  const workSimKey = String(current?.work_sim_key || "");
  const acceptedWorkSim = !callScoped || Boolean(workSimKey && event.simKey && event.simKey === workSimKey);
  // Never persist a phone number, note, or call id received for a personal or
  // unknown SIM. The opaque SIM key and event id are enough for idempotency.
  const storedPayload = acceptedWorkSim ? event.payload || {} : {};
  const inserted = db.prepare(
    `INSERT OR IGNORE INTO mobile_events
      (id, owner_uid, device_id, event_id, schema_version, event_type, sim_key,
       occurred_at, payload, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?)`,
  ).run(
    newId("mevt"), device.owner_uid, device.id, event.eventId, event.schemaVersion,
    event.type, event.simKey || "", event.occurredAt, JSON.stringify(storedPayload), nowIso(),
  );
  if (inserted.changes === 0) {
    const existing = db.prepare(
      "SELECT status, result FROM mobile_events WHERE owner_uid = ? AND device_id = ? AND event_id = ?",
    ).get(device.owner_uid, device.id, event.eventId) as { status: string; result: string };
    return { eventId: event.eventId, duplicate: true, status: existing.status, result: safeJson(existing.result) };
  }

  let status = "processed";
  let result: Record<string, unknown> = {};
  try {
    if (CALL_EVENT_TYPES.has(event.type)) {
      if (!acceptedWorkSim) {
        status = "ignored";
        result = { handled: false, reason: "personal_or_unknown_sim" };
      } else {
        const payload = event.payload || {};
        result = await handleGatewayEvent(device.owner_uid, {
          id: event.eventId,
          eventId: event.eventId,
          callSid: String(payload.callSid || event.eventId),
          type: event.type,
          disposition: String(payload.disposition || event.type),
          from: String(payload.from || ""),
          to: String(payload.to || ""),
          occurredAt: event.occurredAt,
          durationSeconds: Number(payload.durationSeconds || 0),
          source: "android_mobile_v1",
          deviceId: device.id,
          simKey: event.simKey,
        });
      }
    } else if (event.type === "call_outcome") {
      if (!acceptedWorkSim) {
        status = "ignored";
        result = { handled: false, reason: "personal_or_unknown_sim" };
      } else {
        result = outcomeEvent(device, event);
      }
    } else if (event.type === "health") {
      updateDeviceProfile(device, { health: event.payload || {} });
      result = { updated: true };
    } else {
      status = "ignored";
      result = { handled: false, reason: "unsupported_event_type" };
    }
  } catch (error) {
    status = "failed";
    result = { error: error instanceof Error ? error.message : String(error) };
  }
  const processedAt = nowIso();
  db.prepare(
    `UPDATE mobile_events SET status = ?, result = ?, processed_at = ?
     WHERE owner_uid = ? AND device_id = ? AND event_id = ?`,
  ).run(status, JSON.stringify(result), processedAt, device.owner_uid, device.id, event.eventId);
  return { eventId: event.eventId, status, result };
}

export async function processMobileEventBatch(device: AuthenticatedGatewayDevice, events: MobileEventEnvelope[]) {
  const output = [];
  for (const event of events.slice(0, 100)) output.push(await processOneEvent(device, event));
  return output;
}

export function mobileDashboard(device: AuthenticatedGatewayDevice) {
  const assigned = String(deviceRow(device.owner_uid, device.id)?.assigned_user_uid || "");
  const tasks = assigned
    ? db.prepare(
      `SELECT id, title, status, priority, due_date, customer_id, notes
       FROM crm_tasks WHERE owner_uid = ? AND assigned_to = ? AND status = 'open'
       ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,
         due_date IS NULL, due_date ASC LIMIT 50`,
    ).all(device.owner_uid, assigned)
    : [];
  const callStats = db.prepare(
    `SELECT COUNT(*) AS total,
      SUM(CASE WHEN missed = 1 THEN 1 ELSE 0 END) AS missed,
      SUM(CASE WHEN handled = 0 AND missed = 1 THEN 1 ELSE 0 END) AS pending
     FROM call_logs WHERE owner_uid = ? AND device_id = ? AND created_at >= datetime('now','-1 day')`,
  ).get(device.owner_uid, device.id) as Record<string, unknown>;
  return {
    generatedAt: nowIso(),
    device: publicDevice(deviceRow(device.owner_uid, device.id)!),
    tasks,
    calls: {
      total: Number(callStats.total || 0),
      missed: Number(callStats.missed || 0),
      pending: Number(callStats.pending || 0),
    },
  };
}

export function mobileCustomerCache(device: AuthenticatedGatewayDevice, limit = 500) {
  const assigned = String(deviceRow(device.owner_uid, device.id)?.assigned_user_uid || "");
  if (!assigned) return [];
  return db.prepare(
    `SELECT c.id, c.name, c.phone, c.city, c.updated_at,
      (SELECT d.title FROM crm_deals d WHERE d.owner_uid = c.owner_uid AND d.customer_id = c.id
       ORDER BY d.updated_at DESC LIMIT 1) AS latest_deal,
      (SELECT d.assigned_to FROM crm_deals d WHERE d.owner_uid = c.owner_uid AND d.customer_id = c.id
       ORDER BY d.updated_at DESC LIMIT 1) AS assigned_to,
      EXISTS(SELECT 1 FROM crm_tasks t WHERE t.owner_uid = c.owner_uid AND t.customer_id = c.id
       AND t.status = 'open' AND t.due_date < ?) AS has_overdue_task
     FROM customers c WHERE c.owner_uid = ? AND (
       EXISTS(SELECT 1 FROM crm_deals d WHERE d.owner_uid = c.owner_uid AND d.customer_id = c.id AND d.assigned_to = ?)
       OR EXISTS(SELECT 1 FROM crm_tasks t WHERE t.owner_uid = c.owner_uid AND t.customer_id = c.id AND t.assigned_to = ?)
     ) ORDER BY c.updated_at DESC LIMIT ?`,
  ).all(nowIso(), device.owner_uid, assigned, assigned, Math.max(1, Math.min(1000, limit)));
}
