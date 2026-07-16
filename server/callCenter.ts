import crypto from "node:crypto";
import db from "./db";
import { normalizePhoneDigits, phoneTail } from "../shared/phone";
import { createMobileCommand } from "./mobilePlatform";
import { communicationJobStore } from "./communicationJobs";
import { decideOutbound, isDryRunSendResult, outboundSafetyStatus } from "./outboundSafety";
import { recordWhatsAppMessage, whatsappService } from "./whatsapp";
import { syncGoogleCustomer } from "./googleContacts";

export type CallCenterFilters = {
  q?: string;
  dispositions?: string[];
  direction?: "incoming" | "outgoing" | "";
  dateFrom?: string;
  dateTo?: string;
  handled?: "true" | "false" | "";
  whatsappStatus?: "not_sent" | "queued" | "sent" | "failed" | "";
  contactState?: "known" | "needs_name" | "unknown" | "";
  deviceId?: string;
  simKey?: string;
  employeeUid?: string;
  provider?: string;
  page?: number;
  pageSize?: number;
  sortBy?: "created_at" | "customer_name" | "disposition" | "duration_sec";
  sortDirection?: "asc" | "desc";
};

type CallRow = Record<string, unknown>;

const DISPOSITION_SQL = `COALESCE(NULLIF(c.disposition,''), CASE
  WHEN c.status = 'completed' THEN 'answered'
  WHEN c.status = 'handled' AND c.missed = 1 THEN 'no_answer'
  WHEN c.status = 'handled' THEN 'answered'
  WHEN c.status = 'failed' THEN 'unknown'
  ELSE COALESCE(NULLIF(c.status,''), 'unknown') END)`;

const DIRECTION_SQL = `CASE WHEN ${DISPOSITION_SQL} = 'outgoing' THEN 'outgoing' ELSE 'incoming' END`;

function nowIso(date = new Date()) {
  return date.toISOString();
}

function newId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`;
}

function safeJson(value: unknown) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value) return null;
  try { return JSON.parse(value); } catch { return value; }
}

function placeholders(count: number) {
  return Array.from({ length: count }, () => "?").join(",");
}

function normalizedFilters(filters: CallCenterFilters): CallCenterFilters {
  const allowedDispositions = new Set([
    "answered", "no_answer", "busy", "unreachable", "rejected", "after_hours",
    "outgoing", "blocked", "unknown", "ringing", "in_progress",
  ]);
  return {
    q: String(filters.q || "").trim().slice(0, 120),
    dispositions: [...new Set((filters.dispositions || []).filter((item) => allowedDispositions.has(item)))].slice(0, 20),
    direction: filters.direction === "incoming" || filters.direction === "outgoing" ? filters.direction : "",
    dateFrom: /^\d{4}-\d{2}-\d{2}$/.test(String(filters.dateFrom || "")) ? filters.dateFrom : "",
    dateTo: /^\d{4}-\d{2}-\d{2}$/.test(String(filters.dateTo || "")) ? filters.dateTo : "",
    handled: filters.handled === "true" || filters.handled === "false" ? filters.handled : "",
    whatsappStatus: ["not_sent", "queued", "sent", "failed"].includes(String(filters.whatsappStatus || ""))
      ? filters.whatsappStatus : "",
    contactState: ["known", "needs_name", "unknown"].includes(String(filters.contactState || ""))
      ? filters.contactState : "",
    deviceId: String(filters.deviceId || "").trim().slice(0, 160),
    simKey: String(filters.simKey || "").trim().slice(0, 180),
    employeeUid: String(filters.employeeUid || "").trim().slice(0, 160),
    provider: String(filters.provider || "").trim().slice(0, 80),
    page: Math.max(1, Number(filters.page || 1)),
    pageSize: Math.max(10, Math.min(100, Number(filters.pageSize || 25))),
    sortBy: ["created_at", "customer_name", "disposition", "duration_sec"].includes(String(filters.sortBy || ""))
      ? filters.sortBy : "created_at",
    sortDirection: filters.sortDirection === "asc" ? "asc" : "desc",
  } as CallCenterFilters;
}

function whereClause(ownerUid: string, input: CallCenterFilters) {
  const filters = normalizedFilters(input);
  const clauses = ["c.owner_uid = ?"];
  const args: unknown[] = [ownerUid];

  if (filters.q) {
    const digits = normalizePhoneDigits(filters.q);
    clauses.push("(LOWER(COALESCE(c.customer_name, cu.name, '')) LIKE ? OR c.from_phone LIKE ? OR c.to_phone LIKE ?)");
    args.push(`%${filters.q.toLowerCase()}%`, `%${digits || filters.q}%`, `%${digits || filters.q}%`);
  }
  if (filters.dispositions?.length) {
    clauses.push(`${DISPOSITION_SQL} IN (${placeholders(filters.dispositions.length)})`);
    args.push(...filters.dispositions);
  }
  if (filters.direction) {
    clauses.push(`${DIRECTION_SQL} = ?`);
    args.push(filters.direction);
  }
  if (filters.dateFrom) {
    clauses.push("SUBSTR(c.created_at, 1, 10) >= ?");
    args.push(filters.dateFrom);
  }
  if (filters.dateTo) {
    clauses.push("SUBSTR(c.created_at, 1, 10) <= ?");
    args.push(filters.dateTo);
  }
  if (filters.handled) {
    clauses.push("COALESCE(c.handled, 0) = ?");
    args.push(filters.handled === "true" ? 1 : 0);
  }
  if (filters.whatsappStatus === "not_sent") {
    clauses.push("COALESCE(c.wa_customer_notified, 0) = 0 AND COALESCE(c.wa_customer_status, '') = ''");
  } else if (filters.whatsappStatus === "queued") {
    clauses.push("COALESCE(c.wa_customer_status, '') IN ('pending','processing','retry','queued')");
  } else if (filters.whatsappStatus === "sent") {
    clauses.push("(COALESCE(c.wa_customer_notified, 0) = 1 OR COALESCE(c.wa_customer_status, '') = 'sent')");
  } else if (filters.whatsappStatus === "failed") {
    clauses.push("COALESCE(c.wa_customer_status, '') IN ('failed','blocked','expired')");
  }
  if (filters.contactState === "known") {
    clauses.push("c.customer_id IS NOT NULL AND COALESCE(cu.contact_needs_name, 0) = 0 AND TRIM(COALESCE(cu.name, c.customer_name, '')) <> ''");
  } else if (filters.contactState === "needs_name") {
    clauses.push("c.customer_id IS NOT NULL AND COALESCE(cu.contact_needs_name, 0) = 1");
  } else if (filters.contactState === "unknown") {
    clauses.push("c.customer_id IS NULL");
  }
  if (filters.deviceId) {
    clauses.push("c.device_id = ?");
    args.push(filters.deviceId);
  }
  if (filters.simKey) {
    clauses.push("c.sim_key = ?");
    args.push(filters.simKey);
  }
  if (filters.employeeUid) {
    clauses.push("(c.agent_user_id = ? OR gd.assigned_user_uid = ?)");
    args.push(filters.employeeUid, filters.employeeUid);
  }
  if (filters.provider) {
    clauses.push("c.provider = ?");
    args.push(filters.provider);
  }
  return { filters, sql: clauses.join(" AND "), args };
}

const CALL_SELECT = `SELECT c.*,
  ${DISPOSITION_SQL} AS normalized_disposition,
  ${DIRECTION_SQL} AS direction,
  COALESCE(cu.name, c.customer_name, '') AS resolved_customer_name,
  COALESCE(cu.company, '') AS customer_company,
  COALESCE(cu.contact_needs_name, CASE WHEN c.customer_id IS NULL THEN 1 ELSE 0 END) AS contact_needs_name,
  gd.name AS device_name, gd.assigned_user_uid, u.name AS assigned_user_name,
  ms.slot_index AS sim_slot_index, ms.carrier_name AS sim_carrier_name,
  ms.display_name AS sim_display_name, ms.phone_suffix AS sim_phone_suffix
 FROM call_logs c
 LEFT JOIN customers cu ON cu.owner_uid = c.owner_uid AND cu.id = c.customer_id
 LEFT JOIN gateway_devices gd ON gd.owner_uid = c.owner_uid AND gd.id = c.device_id
 LEFT JOIN users u ON u.uid = gd.assigned_user_uid
 LEFT JOIN mobile_device_sims ms ON ms.owner_uid = c.owner_uid AND ms.device_id = c.device_id AND ms.sim_key = c.sim_key`;

function normalizeCall(row: CallRow): CallRow & {
  disposition: string;
  direction: string;
  customer_name: string;
  contact_needs_name: number;
  whatsapp_status: string;
  duration_sec: number;
  missed: number;
  handled: number;
} {
  const disposition = String(row.normalized_disposition || "unknown");
  const waStatus = String(row.wa_customer_status || "") || (Number(row.wa_customer_notified || 0) ? "sent" : "not_sent");
  return {
    ...row,
    metadata: safeJson(row.metadata),
    disposition,
    direction: String(row.direction || (disposition === "outgoing" ? "outgoing" : "incoming")),
    customer_name: String(row.resolved_customer_name || row.customer_name || ""),
    contact_needs_name: Number(row.contact_needs_name || 0),
    whatsapp_status: waStatus,
    duration_sec: Number(row.duration_sec || 0),
    missed: Number(row.missed || 0),
    handled: Number(row.handled || 0),
  };
}

export function listCallCenterCalls(ownerUid: string, input: CallCenterFilters) {
  const { filters, sql, args } = whereClause(ownerUid, input);
  const page = Number(filters.page || 1);
  const pageSize = Number(filters.pageSize || 25);
  const sortColumn = {
    created_at: "c.created_at",
    customer_name: "resolved_customer_name",
    disposition: "normalized_disposition",
    duration_sec: "c.duration_sec",
  }[String(filters.sortBy || "created_at")] || "c.created_at";
  const sortDirection = filters.sortDirection === "asc" ? "ASC" : "DESC";
  const total = Number((db.prepare(
    `SELECT COUNT(*) AS count FROM call_logs c
     LEFT JOIN customers cu ON cu.owner_uid = c.owner_uid AND cu.id = c.customer_id
     LEFT JOIN gateway_devices gd ON gd.owner_uid = c.owner_uid AND gd.id = c.device_id
     WHERE ${sql}`,
  ).get(...args) as { count?: number })?.count || 0);
  const rows = db.prepare(
    `${CALL_SELECT} WHERE ${sql} ORDER BY ${sortColumn} ${sortDirection}, c.id DESC LIMIT ? OFFSET ?`,
  ).all(...args, pageSize, (page - 1) * pageSize) as CallRow[];

  const dispositionFacets = db.prepare(
    `SELECT ${DISPOSITION_SQL} AS value, COUNT(*) AS count
     FROM call_logs c WHERE c.owner_uid = ? GROUP BY value ORDER BY count DESC`,
  ).all(ownerUid) as Array<{ value: string; count: number }>;
  const providers = db.prepare(
    "SELECT provider AS value, COUNT(*) AS count FROM call_logs WHERE owner_uid = ? GROUP BY provider ORDER BY count DESC",
  ).all(ownerUid);
  const devices = db.prepare(
    `SELECT id AS value, name AS label FROM gateway_devices
     WHERE owner_uid = ? AND revoked_at IS NULL ORDER BY name ASC`,
  ).all(ownerUid);
  const sims = db.prepare(
    `SELECT s.sim_key AS value, s.device_id, s.slot_index, s.carrier_name, s.display_name, s.phone_suffix
     FROM mobile_device_sims s JOIN gateway_devices d ON d.id = s.device_id AND d.owner_uid = s.owner_uid
     WHERE s.owner_uid = ? AND s.active = 1 AND d.revoked_at IS NULL ORDER BY d.name, s.slot_index`,
  ).all(ownerUid);
  const employees = db.prepare(
    `SELECT DISTINCT u.uid AS value, u.name AS label FROM users u
     JOIN gateway_devices d ON d.assigned_user_uid = u.uid
     WHERE d.owner_uid = ? AND d.revoked_at IS NULL ORDER BY u.name`,
  ).all(ownerUid);
  return {
    calls: rows.map(normalizeCall), total, page, pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    facets: { dispositions: dispositionFacets, providers, devices, sims, employees },
  };
}

export function getCallCenterCall(ownerUid: string, callId: string) {
  const row = db.prepare(`${CALL_SELECT} WHERE c.owner_uid = ? AND c.id = ? LIMIT 1`).get(ownerUid, callId) as CallRow | undefined;
  return row ? normalizeCall(row) : null;
}

function audit(input: {
  ownerUid: string; actorUid: string; action: string; entityType: string;
  entityId: string; summary: string; before?: unknown; after?: unknown;
}) {
  db.prepare(
    `INSERT INTO audit_logs
      (id, owner_uid, actor_uid, action, entity_type, entity_id, summary, before_data, after_data, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId("audit"), input.ownerUid, input.actorUid, input.action, input.entityType,
    input.entityId, input.summary,
    input.before === undefined ? null : JSON.stringify(input.before),
    input.after === undefined ? null : JSON.stringify(input.after), nowIso(),
  );
}

export async function sendCallWhatsApp(input: {
  ownerUid: string; actorUid: string; callId: string; message: string; outboundCode?: string;
}) {
  const call = getCallCenterCall(input.ownerUid, input.callId);
  if (!call) throw new Error("المكالمة غير موجودة.");
  const phone = normalizePhoneDigits(String(call.from_phone || call.to_phone || ""));
  if (!/^\d{10,15}$/.test(phone)) throw new Error("رقم المكالمة غير صالح للإرسال.");
  const message = String(input.message || "").trim();
  if (!message) throw new Error("اكتب نص الرسالة قبل الإرسال.");
  const status = whatsappService.getStatus();
  if (status.provider === "web" && status.status !== "connected") {
    throw new Error("واتساب ويب غير متصل. اربطه من مركز الاتصالات ثم أعد الإرسال.");
  }
  const result = await whatsappService.sendText(phone, message, { confirmationCode: input.outboundCode });
  if (isDryRunSendResult(result)) throw new Error(result.reason);
  recordWhatsAppMessage({
    type: "sent", provider: status.provider, direction: "outbound", to_phone: phone,
    message, message_id: result.messageId || null, status: "sent", owner_uid: input.ownerUid,
    metadata: { kind: "call_center_manual", call_id: input.callId, actor_uid: input.actorUid },
  });
  db.prepare(
    `UPDATE call_logs SET wa_customer_notified = 1, wa_customer_status = 'sent',
     updated_at = ? WHERE owner_uid = ? AND id = ?`,
  ).run(nowIso(), input.ownerUid, input.callId);
  audit({
    ownerUid: input.ownerUid, actorUid: input.actorUid, action: "calls.whatsapp.sent",
    entityType: "call", entityId: input.callId, summary: "إرسال واتساب يدوي من مركز الاتصالات",
    after: { phone: "[redacted]", messageId: result.messageId || null },
  });
  return { sent: true, messageId: result.messageId || null, provider: status.provider };
}

export function dialCallFromDevice(input: {
  ownerUid: string; actorUid: string; callId: string; deviceId: string; reason?: string;
}) {
  const call = getCallCenterCall(input.ownerUid, input.callId);
  if (!call) throw new Error("المكالمة غير موجودة.");
  const phone = normalizePhoneDigits(String(call.from_phone || call.to_phone || ""));
  if (!/^\d{8,15}$/.test(phone)) throw new Error("رقم المكالمة غير صالح للاتصال.");
  const command = createMobileCommand({
    ownerUid: input.ownerUid, actorUid: input.actorUid, deviceId: input.deviceId,
    type: "dial_request", expiresInSeconds: 300,
    payload: {
      phone,
      customerName: String(call.customer_name || ""),
      reason: String(input.reason || "معاودة اتصال من مركز الاتصالات").slice(0, 300),
      callId: input.callId,
    },
  });
  audit({
    ownerUid: input.ownerUid, actorUid: input.actorUid, action: "calls.dial.requested",
    entityType: "call", entityId: input.callId, summary: "إرسال طلب اتصال إلى الجوال",
    after: { deviceId: input.deviceId, commandId: command.id, phone: "[redacted]" },
  });
  return command;
}

export function upsertCallContact(input: {
  ownerUid: string; actorUid: string; callId: string; name: string; phone?: string;
  company?: string; notes?: string; deviceId?: string; baseUrl?: string;
}) {
  const call = getCallCenterCall(input.ownerUid, input.callId);
  if (!call) throw new Error("المكالمة غير موجودة.");
  const name = String(input.name || "").trim();
  if (name.length < 2) throw new Error("أدخل اسمًا واضحًا من حرفين على الأقل.");
  const phone = normalizePhoneDigits(String(input.phone || call.from_phone || call.to_phone || ""));
  if (!/^\d{8,15}$/.test(phone)) throw new Error("رقم جهة الاتصال غير صالح.");
  const company = String(input.company || "").trim().slice(0, 160);
  const notes = String(input.notes || "").trim().slice(0, 2000);
  let customerId = String(call.customer_id || "");
  const tail = phoneTail(phone);
  if (!customerId && tail) {
    const existing = db.prepare(
      "SELECT id FROM customers WHERE owner_uid = ? AND phone LIKE ? ORDER BY updated_at DESC LIMIT 1",
    ).get(input.ownerUid, `%${tail}`) as { id?: string } | undefined;
    customerId = String(existing?.id || "");
  }
  const timestamp = nowIso();
  const before = customerId
    ? db.prepare("SELECT * FROM customers WHERE owner_uid = ? AND id = ?").get(input.ownerUid, customerId)
    : null;
  if (customerId) {
    db.prepare(
      `UPDATE customers SET name = ?, phone = ?, company = ?, notes = CASE WHEN ? = '' THEN notes ELSE ? END,
       contact_needs_name = 0, updated_at = ? WHERE owner_uid = ? AND id = ?`,
    ).run(name, `+${phone}`, company, notes, notes, timestamp, input.ownerUid, customerId);
  } else {
    customerId = newId("customer");
    db.prepare(
      `INSERT INTO customers
        (id, owner_uid, name, phone, company, source, notes, contact_needs_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'phone_call', ?, 0, ?, ?)`,
    ).run(customerId, input.ownerUid, name, `+${phone}`, company, notes, timestamp, timestamp);
  }
  db.prepare(
    `UPDATE call_logs SET customer_id = ?, customer_name = ?, updated_at = ?
     WHERE owner_uid = ? AND (id = ? OR customer_id = ? OR from_phone LIKE ?)`,
  ).run(customerId, name, timestamp, input.ownerUid, input.callId, customerId, `%${tail}`);
  db.prepare(
    `INSERT INTO gateway_contact_outbox
      (id, owner_uid, customer_id, phone, name, status, error, created_at, saved_at)
     VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)
     ON CONFLICT(owner_uid, customer_id) DO UPDATE SET
       phone = excluded.phone, name = excluded.name, status = 'pending', error = NULL, saved_at = NULL`,
  ).run(newId("gct"), input.ownerUid, customerId, `+${phone}`, name, timestamp);

  const targetDeviceId = String(input.deviceId || call.device_id || "");
  let commandId = "";
  if (targetDeviceId) {
    try {
      commandId = String(createMobileCommand({
        ownerUid: input.ownerUid, actorUid: input.actorUid, deviceId: targetDeviceId,
        type: "sync_contact", expiresInSeconds: 3600,
        payload: { customerId, name, phone: `+${phone}`, company },
      }).id || "");
    } catch {
      // The durable gateway outbox remains the fallback for an offline/legacy device.
    }
  }
  void syncGoogleCustomer({
    ownerUid: input.ownerUid, userUid: input.actorUid, customerId, baseUrl: input.baseUrl,
  }).catch(() => undefined);
  audit({
    ownerUid: input.ownerUid, actorUid: input.actorUid, action: before ? "contacts.updated" : "contacts.created",
    entityType: "customer", entityId: customerId, summary: before ? "تعديل جهة اتصال من سجل المكالمات" : "حفظ متصل كجهة اتصال",
    before, after: { name, phone: "[redacted]", company, deviceId: targetDeviceId || null, commandId: commandId || null },
  });
  return { customerId, name, phone: `+${phone}`, company, commandId: commandId || null, googleSync: "scheduled" };
}

function selectionRows(ownerUid: string, input: { ids?: string[]; filters?: CallCenterFilters; excludedIds?: string[] }) {
  const excluded = new Set((input.excludedIds || []).map(String));
  let rows: CallRow[];
  if (input.ids?.length) {
    const ids = [...new Set(input.ids.map(String))].filter(Boolean).slice(0, 5000);
    rows = ids.length
      ? db.prepare(`${CALL_SELECT} WHERE c.owner_uid = ? AND c.id IN (${placeholders(ids.length)}) ORDER BY c.created_at DESC`).all(ownerUid, ...ids) as CallRow[]
      : [];
  } else {
    const { sql, args } = whereClause(ownerUid, { ...(input.filters || {}), page: 1, pageSize: 100 });
    rows = db.prepare(`${CALL_SELECT} WHERE ${sql} ORDER BY c.created_at DESC LIMIT 5001`).all(...args) as CallRow[];
  }
  return rows.filter((item) => !excluded.has(String(item.id))).map(normalizeCall);
}

export function previewCallSelection(input: {
  ownerUid: string; actorUid: string; action: "whatsapp" | "export";
  ids?: string[]; filters?: CallCenterFilters; excludedIds?: string[]; outboundCode?: string;
}) {
  db.prepare("DELETE FROM call_selection_snapshots WHERE expires_at <= ?").run(nowIso());
  const raw = selectionRows(input.ownerUid, input);
  const capped = raw.length > 5000;
  const candidate = raw.slice(0, 5000);
  const seenPhones = new Set<string>();
  const excluded: Array<{ callId: string; reason: string }> = [];
  const calls = input.action === "export" ? candidate : candidate.filter((call) => {
    const phone = normalizePhoneDigits(String(call.from_phone || call.to_phone || ""));
    if (!/^\d{10,15}$/.test(phone)) {
      excluded.push({ callId: String(call.id), reason: "invalid_phone" });
      return false;
    }
    if (seenPhones.has(phone)) {
      excluded.push({ callId: String(call.id), reason: "duplicate_phone" });
      return false;
    }
    const decision = decideOutbound(phone, { confirmationCode: input.outboundCode });
    if (!decision.allowed) {
      excluded.push({ callId: String(call.id), reason: decision.reason || "outbound_blocked" });
      return false;
    }
    seenPhones.add(phone);
    return true;
  });
  if (!calls.length) throw new Error(input.action === "whatsapp" ? "لا توجد أرقام صالحة ومسموحة للإرسال ضمن التحديد." : "لا توجد مكالمات ضمن التحديد.");
  const selectionId = newId("csel");
  const expiresAt = nowIso(new Date(Date.now() + 10 * 60_000));
  db.prepare(
    `INSERT INTO call_selection_snapshots
      (id, owner_uid, actor_uid, call_ids, filters, excluded_count, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    selectionId, input.ownerUid, input.actorUid, JSON.stringify(calls.map((call) => call.id)),
    JSON.stringify(input.filters || { ids: input.ids || [] }), excluded.length, expiresAt, nowIso(),
  );
  return {
    selectionId, expiresAt, count: calls.length, excludedCount: excluded.length, capped,
    sample: calls.slice(0, 8).map((call) => ({
      id: call.id, name: call.customer_name || "يحتاج اسمًا",
      phone: call.from_phone || call.to_phone || "", disposition: call.disposition,
    })),
    excluded: excluded.slice(0, 20),
    outbound: outboundSafetyStatus(),
  };
}

function loadSelection(ownerUid: string, actorUid: string, selectionId: string) {
  const snapshot = db.prepare(
    `SELECT * FROM call_selection_snapshots
     WHERE id = ? AND owner_uid = ? AND actor_uid = ? AND expires_at > ? LIMIT 1`,
  ).get(selectionId, ownerUid, actorUid, nowIso()) as Record<string, unknown> | undefined;
  if (!snapshot) throw new Error("انتهت صلاحية المعاينة. أعد تحديد المكالمات ثم راجعها من جديد.");
  const ids = safeJson(snapshot.call_ids);
  if (!Array.isArray(ids) || !ids.length) throw new Error("التحديد فارغ.");
  const rows = db.prepare(`${CALL_SELECT} WHERE c.owner_uid = ? AND c.id IN (${placeholders(ids.length)}) ORDER BY c.created_at DESC`)
    .all(ownerUid, ...ids) as CallRow[];
  return { snapshot, calls: rows.map(normalizeCall) };
}

export function queueBulkCallWhatsApp(input: {
  ownerUid: string; actorUid: string; selectionId: string; message: string; outboundCode?: string;
}) {
  const message = String(input.message || "").trim();
  if (!message) throw new Error("اكتب نص الرسالة الجماعية قبل التأكيد.");
  if (message.length > 2000) throw new Error("نص الرسالة أطول من 2000 حرف.");
  const wa = whatsappService.getStatus();
  if (wa.provider === "web" && wa.status !== "connected") throw new Error("واتساب ويب غير متصل. لم تُحفظ الرسائل للإرسال لاحقًا.");
  const { calls } = loadSelection(input.ownerUid, input.actorUid, input.selectionId);
  const runId = newId("cbr");
  const createdAt = nowIso();
  db.prepare(
    `INSERT INTO call_bulk_runs
      (id, owner_uid, actor_uid, selection_id, action, status, total_count, created_at)
     VALUES (?, ?, ?, ?, 'whatsapp', 'confirmed', ?, ?)`,
  ).run(runId, input.ownerUid, input.actorUid, input.selectionId, calls.length, createdAt);

  let queued = 0;
  let skipped = 0;
  for (const call of calls) {
    const phone = normalizePhoneDigits(String(call.from_phone || call.to_phone || ""));
    const decision = decideOutbound(phone, { confirmationCode: input.outboundCode });
    if (!decision.allowed) { skipped += 1; continue; }
    const recent = db.prepare(
      `SELECT 1 FROM communication_jobs WHERE owner_uid = ? AND recipient_phone = ?
       AND role = 'customer' AND status IN ('pending','processing','retry','sent')
       AND created_at >= ? LIMIT 1`,
    ).get(input.ownerUid, phone, nowIso(new Date(Date.now() - 10 * 60_000)));
    if (recent) { skipped += 1; continue; }
    const job = communicationJobStore.enqueue({
      ownerUid: input.ownerUid,
      eventKey: `call-bulk:${runId}:${String(call.id)}`,
      recipientPhone: phone,
      templateName: "general_reminder",
      payload: { vars: { message }, purpose: "call_bulk_manual", bulkRunId: runId, actorUid: input.actorUid },
      role: "customer", callId: String(call.id), kind: "whatsapp_template",
      maxAttempts: 5, expiresInMinutes: 24 * 60,
    });
    db.prepare(
      `UPDATE call_logs SET wa_customer_job_id = ?, wa_customer_status = 'queued', updated_at = ?
       WHERE owner_uid = ? AND id = ?`,
    ).run(job.id, createdAt, input.ownerUid, call.id);
    queued += 1;
  }
  const finalStatus = queued ? "queued" : "completed";
  db.prepare(
    `UPDATE call_bulk_runs SET status = ?, queued_count = ?, skipped_count = ?, completed_at = ? WHERE id = ?`,
  ).run(finalStatus, queued, skipped, queued ? null : nowIso(), runId);
  audit({
    ownerUid: input.ownerUid, actorUid: input.actorUid, action: "calls.bulk.whatsapp.queued",
    entityType: "call_bulk_run", entityId: runId, summary: "تأكيد إرسال واتساب جماعي من سجل المكالمات",
    after: { selectionId: input.selectionId, total: calls.length, queued, skipped },
  });
  return { runId, status: finalStatus, total: calls.length, queued, skipped };
}

function csvEscape(value: unknown) {
  const text = String(value ?? "").replace(/"/g, '""');
  return `"${text}"`;
}

const EXPORT_COLUMNS: Array<{ key: string; label: string }> = [
  { key: "created_at", label: "الوقت" },
  { key: "customer_name", label: "الاسم" },
  { key: "from_phone", label: "رقم المتصل" },
  { key: "to_phone", label: "الرقم المستهدف" },
  { key: "disposition", label: "نتيجة المكالمة" },
  { key: "direction", label: "الاتجاه" },
  { key: "duration_sec", label: "المدة بالثواني" },
  { key: "handled", label: "تمت المعالجة" },
  { key: "whatsapp_status", label: "حالة واتساب" },
  { key: "device_name", label: "الجهاز" },
  { key: "sim_carrier_name", label: "الشريحة" },
  { key: "provider", label: "المصدر" },
];

function xmlEscape(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  }[char] || char));
}

export function exportCallSelection(input: {
  ownerUid: string; actorUid: string; selectionId: string; format: "csv" | "excel";
}) {
  const { calls } = loadSelection(input.ownerUid, input.actorUid, input.selectionId);
  const stamp = nowIso().slice(0, 10);
  audit({
    ownerUid: input.ownerUid, actorUid: input.actorUid, action: "calls.exported",
    entityType: "call_selection", entityId: input.selectionId, summary: "تصدير سجل المكالمات",
    after: { format: input.format, count: calls.length },
  });
  if (input.format === "csv") {
    const lines = [
      EXPORT_COLUMNS.map((column) => csvEscape(column.label)).join(","),
      ...calls.map((call) => EXPORT_COLUMNS.map((column) => csvEscape(call[column.key])).join(",")),
    ];
    return {
      filename: `breexe-calls-${stamp}.csv`,
      contentType: "text/csv; charset=utf-8",
      body: `\uFEFF${lines.join("\r\n")}`,
    };
  }
  const header = EXPORT_COLUMNS.map((column) => `<Cell><Data ss:Type="String">${xmlEscape(column.label)}</Data></Cell>`).join("");
  const rows = calls.map((call) => `<Row>${EXPORT_COLUMNS.map((column) => `<Cell><Data ss:Type="String">${xmlEscape(call[column.key])}</Data></Cell>`).join("")}</Row>`).join("");
  return {
    filename: `breexe-calls-${stamp}.xls`,
    contentType: "application/vnd.ms-excel; charset=utf-8",
    body: `<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?>\n<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="BreeXe Calls"><Table><Row>${header}</Row>${rows}</Table></Worksheet></Workbook>`,
  };
}
