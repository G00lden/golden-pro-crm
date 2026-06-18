/**
 * Admin escalation queue.
 *
 * Populated by `reminderEngine.escalateIfNeeded()` whenever an installation
 * crosses three reminders without a customer response. Provides CRUD helpers
 * + a stats summary for the admin dashboard.
 */
import crypto from "crypto";
import db from "./db";

export type EscalationStatus = "active" | "assigned" | "resolved";

export type EscalationRecord = {
  id: string;
  installation_id: string | null;
  customer_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  product_name: string | null;
  original_maintenance_date: string | null;
  remind_count: number;
  last_reminded_at: string | null;
  status: EscalationStatus;
  assigned_to: string | null;
  notes: string;
  resolved_at: string | null;
  resolved_by: string | null;
  owner_uid: string | null;
  created_at: string;
  updated_at: string;
};

function newId() {
  return `esc_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function rowToEscalation(row: Record<string, unknown> | undefined): EscalationRecord | null {
  if (!row) return null;
  return {
    id: String(row.id),
    installation_id: (row.installation_id as string) || null,
    customer_id: (row.customer_id as string) || null,
    customer_name: (row.customer_name as string) || null,
    customer_phone: (row.customer_phone as string) || null,
    product_name: (row.product_name as string) || null,
    original_maintenance_date: (row.original_maintenance_date as string) || null,
    remind_count: Number(row.remind_count || 0),
    last_reminded_at: (row.last_reminded_at as string) || null,
    status: (row.status as EscalationStatus) || "active",
    assigned_to: (row.assigned_to as string) || null,
    notes: (row.notes as string) || "",
    resolved_at: (row.resolved_at as string) || null,
    resolved_by: (row.resolved_by as string) || null,
    owner_uid: (row.owner_uid as string) || null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at || row.created_at),
  };
}

export type CreateEscalationInput = {
  installation_id: string;
  customer_id?: string | null;
  customer_name?: string | null;
  customer_phone?: string | null;
  product_name?: string | null;
  original_maintenance_date?: string | null;
  remind_count?: number;
  last_reminded_at?: string | null;
  owner_uid: string;
  notes?: string;
};

/**
 * Idempotent: if an unresolved escalation for the same installation already
 * exists, it is updated in place instead of creating a duplicate row. This
 * keeps the admin queue tidy across multiple over-threshold reminder runs.
 */
export function recordEscalation(input: CreateEscalationInput): EscalationRecord {
  const existing = db
    .prepare(
      `SELECT * FROM escalations WHERE installation_id = ? AND status IN ('active', 'assigned')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(input.installation_id) as Record<string, unknown> | undefined;

  if (existing) {
    db.prepare(
      `UPDATE escalations
       SET remind_count = ?, last_reminded_at = ?, customer_phone = COALESCE(?, customer_phone),
           updated_at = ?
       WHERE id = ?`,
    ).run(
      input.remind_count ?? Number(existing.remind_count || 0),
      input.last_reminded_at || (existing.last_reminded_at as string | null) || null,
      input.customer_phone || null,
      nowIso(),
      existing.id,
    );
    return rowToEscalation(
      db.prepare("SELECT * FROM escalations WHERE id = ?").get(existing.id) as Record<string, unknown>,
    )!;
  }

  const id = newId();
  db.prepare(
    `INSERT INTO escalations (
      id, installation_id, customer_id, customer_name, customer_phone, product_name,
      original_maintenance_date, remind_count, last_reminded_at, status, notes,
      owner_uid, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
  ).run(
    id,
    input.installation_id,
    input.customer_id || null,
    input.customer_name || null,
    input.customer_phone || null,
    input.product_name || null,
    input.original_maintenance_date || null,
    input.remind_count ?? 0,
    input.last_reminded_at || null,
    input.notes || "",
    input.owner_uid,
    nowIso(),
    nowIso(),
  );
  return rowToEscalation(
    db.prepare("SELECT * FROM escalations WHERE id = ?").get(id) as Record<string, unknown>,
  )!;
}

export function listEscalations(opts: {
  ownerUid?: string;
  status?: EscalationStatus | "all";
  limit?: number;
} = {}): EscalationRecord[] {
  const status = opts.status && opts.status !== "all" ? opts.status : null;
  const limit = Math.min(500, opts.limit || 100);
  let sql = "SELECT * FROM escalations";
  const args: unknown[] = [];
  const where: string[] = [];
  if (opts.ownerUid) {
    where.push("owner_uid = ?");
    args.push(opts.ownerUid);
  }
  if (status) {
    where.push("status = ?");
    args.push(status);
  }
  if (where.length) sql += " WHERE " + where.join(" AND ");
  // Most urgent first: longest since last_reminded_at (or created_at fallback).
  sql += ` ORDER BY COALESCE(last_reminded_at, created_at) ASC LIMIT ?`;
  args.push(limit);
  const rows = db.prepare(sql).all(...args) as Array<Record<string, unknown>>;
  return rows.map((row) => rowToEscalation(row)!).filter(Boolean);
}

export function getEscalation(id: string): EscalationRecord | null {
  return rowToEscalation(
    db.prepare("SELECT * FROM escalations WHERE id = ?").get(id) as Record<string, unknown>,
  );
}

export function resolveEscalation(id: string, resolvedBy: string, notes?: string): EscalationRecord | null {
  if (!getEscalation(id)) return null;
  db.prepare(
    `UPDATE escalations
     SET status = 'resolved', resolved_at = ?, resolved_by = ?,
         notes = CASE WHEN COALESCE(?, '') = '' THEN notes ELSE COALESCE(notes, '') || char(10) || ? END,
         updated_at = ?
     WHERE id = ?`,
  ).run(nowIso(), resolvedBy, notes || "", notes || "", nowIso(), id);
  return getEscalation(id);
}

export function assignEscalation(id: string, assignedTo: string, performedBy: string, notes?: string): EscalationRecord | null {
  if (!getEscalation(id)) return null;
  db.prepare(
    `UPDATE escalations
     SET status = 'assigned', assigned_to = ?,
         notes = CASE WHEN COALESCE(?, '') = '' THEN notes ELSE COALESCE(notes, '') || char(10) || '[assigned by ' || ? || '] ' || ? END,
         updated_at = ?
     WHERE id = ?`,
  ).run(assignedTo, notes || "", performedBy, notes || "", nowIso(), id);
  return getEscalation(id);
}

export function escalationStats(ownerUid?: string) {
  const todayPrefix = new Date().toISOString().slice(0, 10);
  const baseWhere = ownerUid ? "WHERE owner_uid = ?" : "";
  const args = ownerUid ? [ownerUid] : [];
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM escalations ${baseWhere}`).get(...args) as { c: number }).c;
  const active = (db
    .prepare(`SELECT COUNT(*) AS c FROM escalations ${baseWhere ? baseWhere + " AND" : "WHERE"} status = 'active'`)
    .get(...args) as { c: number }).c;
  const assigned = (db
    .prepare(`SELECT COUNT(*) AS c FROM escalations ${baseWhere ? baseWhere + " AND" : "WHERE"} status = 'assigned'`)
    .get(...args) as { c: number }).c;
  const resolved = (db
    .prepare(`SELECT COUNT(*) AS c FROM escalations ${baseWhere ? baseWhere + " AND" : "WHERE"} status = 'resolved'`)
    .get(...args) as { c: number }).c;
  const todayResolved = (db
    .prepare(
      `SELECT COUNT(*) AS c FROM escalations ${baseWhere ? baseWhere + " AND" : "WHERE"} status = 'resolved' AND resolved_at LIKE ?`,
    )
    .get(...args, `${todayPrefix}%`) as { c: number }).c;
  const todayCreated = (db
    .prepare(
      `SELECT COUNT(*) AS c FROM escalations ${baseWhere ? baseWhere + " AND" : "WHERE"} created_at LIKE ?`,
    )
    .get(...args, `${todayPrefix}%`) as { c: number }).c;
  return {
    total,
    active,
    assigned,
    resolved,
    today_resolved: todayResolved,
    today_created: todayCreated,
  };
}
