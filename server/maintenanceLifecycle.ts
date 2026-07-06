/**
 * Maintenance lifecycle engine.
 *
 * Higher-level wrapper over the existing installations + bookings + reminders
 * tables. Provides create / complete / reschedule / cancel / timeline / overdue /
 * upcoming / score functions and writes every transition to the new
 * `maintenance_history` audit table.
 */
import crypto from "crypto";
import db from "./db";

export type MaintenanceAction =
  | "created"
  | "completed"
  | "rescheduled"
  | "cancelled"
  | "reminded"
  | "confirmed"
  | "technician_assigned"
  | "booking_created";

export type CreateMaintenanceParams = {
  uid: string;
  customer_id: string;
  customer_name: string;
  customer_phone: string;
  customer_address?: string;
  product_id: string;
  product_name: string;
  product_sku?: string;
  install_date?: string;
  next_maintenance: string;
  technician_id?: string;
  technician_name?: string;
  scheduled_time?: string;
  notes?: string;
};

export type RescheduleParams = {
  installationId: string;
  newDate: string;
  uid: string;
  reason?: string;
};

export type CompleteParams = {
  installationId: string;
  uid: string;
  completedDate?: string;
  notes?: string;
};

export type CancelParams = {
  installationId: string;
  uid: string;
  reason?: string;
};

function newId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function addMonthsIso(dateStr: string, months: number) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
}

function dayDiff(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  const ams = Date.UTC(ay, am - 1, ad);
  const bms = Date.UTC(by, bm - 1, bd);
  return Math.floor((ams - bms) / 86_400_000);
}

function logHistory(entry: {
  installation_id: string;
  customer_id?: string;
  action: MaintenanceAction;
  old_value?: string | null;
  new_value?: string | null;
  performed_by?: string;
  notes?: string;
  metadata?: Record<string, unknown>;
}) {
  db.prepare(
    `INSERT INTO maintenance_history (id, installation_id, customer_id, action, old_value, new_value, performed_by, notes, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId("mh"),
    entry.installation_id,
    entry.customer_id || null,
    entry.action,
    entry.old_value ?? null,
    entry.new_value ?? null,
    entry.performed_by || null,
    entry.notes || null,
    entry.metadata ? JSON.stringify(entry.metadata) : null,
    nowIso(),
  );
}

function getInstallationRow(installationId: string): Record<string, unknown> | null {
  return (db.prepare("SELECT * FROM installations WHERE id = ?").get(installationId) as Record<string, unknown>) || null;
}

function ownerMatches(row: Record<string, unknown> | null, uid: string): boolean {
  if (!row) return false;
  return row.owner_uid === uid || row.createdBy === uid;
}

function productIntervalMonths(productId: string | undefined | null): number {
  if (!productId) return Number(process.env.STORE_WEBHOOK_DEFAULT_MAINTENANCE_MONTHS || 6);
  const row = db.prepare("SELECT interval_months FROM products WHERE id = ?").get(productId) as { interval_months?: number } | undefined;
  return Number(row?.interval_months || process.env.STORE_WEBHOOK_DEFAULT_MAINTENANCE_MONTHS || 6);
}

export function createMaintenance(params: CreateMaintenanceParams) {
  const installationId = newId("inst");
  const installDate = params.install_date || todayIso();

  db.prepare(
    `INSERT INTO installations (
      id, owner_uid, customer_id, customer_name, customer_phone, product_id, product_name, product_sku,
      install_date, next_maintenance, remind_count, next_remind_type, status, source, notes,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'first', 'active', 'manual', ?, ?, ?)`,
  ).run(
    installationId,
    params.uid,
    params.customer_id,
    params.customer_name,
    params.customer_phone,
    params.product_id,
    params.product_name,
    params.product_sku || "",
    installDate,
    params.next_maintenance,
    params.notes || "",
    nowIso(),
    nowIso(),
  );

  let bookingId: string | null = null;
  if (params.technician_id && params.scheduled_time) {
    bookingId = newId("book");
    db.prepare(
      `INSERT INTO bookings (
        id, owner_uid, installation_id, customer_id, customer_name, customer_phone,
        product_id, product_name, technician_id, tech_name,
        date, scheduled_time, status, booking_type, source, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', 'maintenance', 'manual', '', ?, ?)`,
    ).run(
      bookingId,
      params.uid,
      installationId,
      params.customer_id,
      params.customer_name,
      params.customer_phone,
      params.product_id,
      params.product_name,
      params.technician_id,
      params.technician_name || "",
      params.next_maintenance,
      params.scheduled_time,
      nowIso(),
      nowIso(),
    );
    logHistory({
      installation_id: installationId,
      customer_id: params.customer_id,
      action: "booking_created",
      new_value: bookingId,
      performed_by: params.uid,
      metadata: { technician_id: params.technician_id, scheduled_time: params.scheduled_time },
    });
  }

  logHistory({
    installation_id: installationId,
    customer_id: params.customer_id,
    action: "created",
    new_value: params.next_maintenance,
    performed_by: params.uid,
    metadata: {
      install_date: installDate,
      product_id: params.product_id,
      product_name: params.product_name,
    },
  });

  return { installation_id: installationId, booking_id: bookingId };
}

export function completeMaintenance(params: CompleteParams) {
  const row = getInstallationRow(params.installationId);
  if (!row) throw new Error("Installation not found.");
  if (!ownerMatches(row, params.uid)) throw new Error("You do not own this installation.");

  const completedDate = params.completedDate || todayIso();
  const intervalMonths = productIntervalMonths(row.product_id as string);
  const nextDate = addMonthsIso(completedDate, intervalMonths);

  db.prepare(
    `UPDATE installations
     SET status = 'completed', completed_date = ?, next_remind_type = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(completedDate, nowIso(), params.installationId);

  // Spawn a fresh installation row for the next cycle so the reminder engine
  // picks it up automatically — mirrors how completed jobs roll forward in
  // the existing CRM UI.
  const followUpId = newId("inst");
  db.prepare(
    `INSERT INTO installations (
      id, owner_uid, customer_id, customer_name, customer_phone, product_id, product_name, product_sku,
      install_date, next_maintenance, remind_count, next_remind_type, status, source, notes,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'first', 'active', 'manual', ?, ?, ?)`,
  ).run(
    followUpId,
    row.owner_uid,
    row.customer_id,
    row.customer_name,
    row.customer_phone,
    row.product_id,
    row.product_name,
    row.product_sku || "",
    completedDate,
    nextDate,
    `auto-renewed from ${params.installationId}`,
    nowIso(),
    nowIso(),
  );

  logHistory({
    installation_id: params.installationId,
    customer_id: row.customer_id as string,
    action: "completed",
    old_value: row.next_maintenance as string,
    new_value: completedDate,
    performed_by: params.uid,
    notes: params.notes,
    metadata: { follow_up_installation_id: followUpId, next_maintenance: nextDate, interval_months: intervalMonths },
  });

  return {
    installation_id: params.installationId,
    completed_date: completedDate,
    next_installation_id: followUpId,
    next_maintenance: nextDate,
    interval_months: intervalMonths,
  };
}

export function rescheduleMaintenance(params: RescheduleParams) {
  const row = getInstallationRow(params.installationId);
  if (!row) throw new Error("Installation not found.");
  if (!ownerMatches(row, params.uid)) throw new Error("You do not own this installation.");

  const oldDate = row.next_maintenance as string;
  db.prepare(
    `UPDATE installations
     SET next_maintenance = ?, remind_count = 0, next_remind_type = 'first', last_remind_at = NULL, last_remind_attempt_at = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(params.newDate, nowIso(), params.installationId);

  logHistory({
    installation_id: params.installationId,
    customer_id: row.customer_id as string,
    action: "rescheduled",
    old_value: oldDate,
    new_value: params.newDate,
    performed_by: params.uid,
    notes: params.reason,
  });

  return { installation_id: params.installationId, old_date: oldDate, new_date: params.newDate };
}

export function cancelMaintenance(params: CancelParams) {
  const row = getInstallationRow(params.installationId);
  if (!row) throw new Error("Installation not found.");
  if (!ownerMatches(row, params.uid)) throw new Error("You do not own this installation.");

  db.prepare(
    `UPDATE installations
     SET status = 'cancelled', next_remind_type = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(nowIso(), params.installationId);

  logHistory({
    installation_id: params.installationId,
    customer_id: row.customer_id as string,
    action: "cancelled",
    old_value: row.status as string,
    new_value: "cancelled",
    performed_by: params.uid,
    notes: params.reason,
  });

  return { installation_id: params.installationId, status: "cancelled" };
}

export type TimelineEvent = {
  at: string;
  source: "history" | "reminder" | "booking" | "whatsapp";
  action: string;
  detail: Record<string, unknown>;
};

export function getMaintenanceTimeline(installationId: string): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  const history = db
    .prepare("SELECT * FROM maintenance_history WHERE installation_id = ? ORDER BY created_at ASC")
    .all(installationId) as Array<Record<string, unknown>>;
  for (const row of history) {
    events.push({
      at: String(row.created_at),
      source: "history",
      action: String(row.action),
      detail: {
        old_value: row.old_value,
        new_value: row.new_value,
        performed_by: row.performed_by,
        notes: row.notes,
        metadata: row.metadata ? safeJson(row.metadata as string) : null,
      },
    });
  }

  const reminders = db
    .prepare("SELECT * FROM reminders WHERE installation_id = ? ORDER BY sent_at ASC")
    .all(installationId) as Array<Record<string, unknown>>;
  for (const row of reminders) {
    events.push({
      at: String(row.sent_at),
      source: "reminder",
      action: `reminder:${row.remind_type || "unknown"}`,
      detail: {
        status: row.status,
        message: row.message,
        customer_phone: row.customer_phone,
      },
    });
  }

  const bookings = db
    .prepare("SELECT * FROM bookings WHERE installation_id = ? ORDER BY created_at ASC")
    .all(installationId) as Array<Record<string, unknown>>;
  for (const row of bookings) {
    events.push({
      at: String(row.created_at),
      source: "booking",
      action: `booking:${row.status || "confirmed"}`,
      detail: {
        booking_id: row.id,
        technician_id: row.technician_id,
        tech_name: row.tech_name,
        date: row.date,
        scheduled_time: row.scheduled_time,
      },
    });
  }

  const whatsapp = db
    .prepare("SELECT * FROM whatsapp_messages WHERE installation_id = ? ORDER BY created_at ASC")
    .all(installationId) as Array<Record<string, unknown>>;
  for (const row of whatsapp) {
    events.push({
      at: String(row.created_at),
      source: "whatsapp",
      action: `${row.direction || row.type}:${row.status || "logged"}`,
      detail: {
        from_phone: row.from_phone,
        to_phone: row.to_phone,
        message: row.message,
        template: row.template_name,
        status: row.status,
      },
    });
  }

  events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return events;
}

export function getOverdueList(uid: string, daysPast = 0) {
  const today = todayIso();
  const cutoff = addMonthsIso(today, 0); // today
  const rows = db
    .prepare(
      `SELECT * FROM installations
       WHERE owner_uid = ? AND status = 'active' AND next_maintenance < ?
       ORDER BY next_maintenance ASC LIMIT 500`,
    )
    .all(uid, cutoff) as Array<Record<string, unknown>>;
  return rows
    .map((row) => ({
      ...row,
      days_overdue: dayDiff(today, String(row.next_maintenance)),
    }))
    .filter((row) => row.days_overdue >= daysPast);
}

export function getUpcomingList(uid: string, daysAhead = 7) {
  const today = todayIso();
  const limit = addDaysIso(today, daysAhead);
  const rows = db
    .prepare(
      `SELECT * FROM installations
       WHERE owner_uid = ? AND status = 'active' AND next_maintenance >= ? AND next_maintenance <= ?
       ORDER BY next_maintenance ASC LIMIT 500`,
    )
    .all(uid, today, limit) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    ...row,
    days_until: dayDiff(String(row.next_maintenance), today),
  }));
}

function addDaysIso(dateStr: string, days: number) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

export type CustomerScore = {
  customer_id: string;
  total_installations: number;
  completed_count: number;
  cancelled_count: number;
  reminders_sent: number;
  reminders_confirmed: number;
  response_rate: number;
  on_time_rate: number;
  overdue_count: number;
  score: number;
  grade: "A" | "B" | "C" | "D";
};

export function getCustomerScore(customerId: string): CustomerScore {
  const installs = db
    .prepare("SELECT * FROM installations WHERE customer_id = ?")
    .all(customerId) as Array<Record<string, unknown>>;
  const total = installs.length;
  const completed = installs.filter((r) => r.status === "completed").length;
  const cancelled = installs.filter((r) => r.status === "cancelled").length;
  const today = todayIso();
  const overdue = installs.filter((r) => r.status === "active" && String(r.next_maintenance) < today).length;

  const reminders = db
    .prepare(
      `SELECT * FROM reminders WHERE customer_id = ? AND status IN ('sent', 'dry_run', 'confirmed')`,
    )
    .all(customerId) as Array<Record<string, unknown>>;
  const remindersSent = reminders.filter((r) => r.status === "sent").length;
  const confirmed = reminders.filter((r) => r.status === "confirmed").length;
  const responseRate = remindersSent === 0 ? 1 : confirmed / remindersSent;
  const onTimeRate = total === 0 ? 1 : completed / Math.max(1, completed + cancelled + overdue);

  // 0-100 composite. Weight on-time adherence (60%) + response rate (40%).
  const rawScore = Math.round(onTimeRate * 60 + responseRate * 40);
  const score = Math.max(0, Math.min(100, rawScore));
  const grade: CustomerScore["grade"] = score >= 85 ? "A" : score >= 70 ? "B" : score >= 50 ? "C" : "D";

  return {
    customer_id: customerId,
    total_installations: total,
    completed_count: completed,
    cancelled_count: cancelled,
    reminders_sent: remindersSent,
    reminders_confirmed: confirmed,
    response_rate: Math.round(responseRate * 100) / 100,
    on_time_rate: Math.round(onTimeRate * 100) / 100,
    overdue_count: overdue,
    score,
    grade,
  };
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Called by the WhatsApp inbound parser when a customer replies with a positive
 * confirmation ("نعم", "تمام", etc.). Marks the most recent reminder for the
 * matched phone as `confirmed`, sets the linked installation's next_remind_type
 * to NULL (so the engine stops chasing), and logs to history.
 */
export function recordCustomerConfirmation(uid: string, phone: string, message: string) {
  const normalized = phone.replace(/\D/g, "");
  // Match on the last 9 digits (the KSA local significant number) anchored to
  // the END, consistent with the rest of the app. The previous `%<last-8>%`
  // substring match could confirm a DIFFERENT customer's reminder (and NULL the
  // wrong installation's next_remind_type) when 8 digits collided mid-number.
  const tail = normalized.slice(-9) || normalized;
  const reminder = db
    .prepare(
      `SELECT * FROM reminders
       WHERE owner_uid = ? AND customer_phone LIKE ?
       ORDER BY sent_at DESC LIMIT 1`,
    )
    .get(uid, `%${tail}`) as Record<string, unknown> | undefined;
  if (!reminder) return { matched: false };

  db.prepare("UPDATE reminders SET status = 'confirmed' WHERE id = ?").run(reminder.id);
  if (reminder.installation_id) {
    db.prepare(
      "UPDATE installations SET next_remind_type = NULL, updated_at = ? WHERE id = ?",
    ).run(nowIso(), reminder.installation_id);
    logHistory({
      installation_id: String(reminder.installation_id),
      customer_id: (reminder.customer_id as string) || undefined,
      action: "confirmed",
      old_value: String(reminder.remind_type || "unknown"),
      new_value: "confirmed",
      performed_by: uid,
      notes: message.slice(0, 200),
    });
  }
  return { matched: true, reminder_id: reminder.id, installation_id: reminder.installation_id };
}
