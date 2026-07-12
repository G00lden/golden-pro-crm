import crypto from "node:crypto";
import type Database from "better-sqlite3";
import db from "./db";
import { normalizePhoneDigits } from "../shared/phone";

export type CommunicationJobStatus =
  | "pending"
  | "processing"
  | "retry"
  | "sent"
  | "failed"
  | "blocked"
  | "expired";

export type CommunicationJob = {
  id: string;
  owner_uid: string;
  event_key: string;
  kind: string;
  channel: string;
  recipient_phone: string;
  template_name: string | null;
  payload: Record<string, unknown>;
  role: string;
  call_id: string | null;
  campaign_id: string | null;
  campaign_recipient_id: string | null;
  status: CommunicationJobStatus;
  attempts: number;
  max_attempts: number;
  available_at: string;
  lease_until: string | null;
  last_error: string | null;
  provider_message_id: string | null;
  expires_at: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
};

export type EnqueueCommunicationJob = {
  ownerUid: string;
  eventKey: string;
  recipientPhone: string;
  templateName: string;
  payload?: Record<string, unknown>;
  role?: "customer" | "agent" | string;
  callId?: string;
  kind?: string;
  channel?: string;
  maxAttempts?: number;
  expiresInMinutes?: number;
  availableAt?: string;
  campaignId?: string;
  campaignRecipientId?: string;
};

function nowIso() {
  return new Date().toISOString();
}

function id() {
  return `comm_${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`;
}

function safePayload(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string") return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function row(value: Record<string, unknown> | undefined): CommunicationJob | null {
  if (!value) return null;
  return {
    ...(value as unknown as CommunicationJob),
    attempts: Number(value.attempts || 0),
    max_attempts: Number(value.max_attempts || 5),
    payload: safePayload(value.payload),
  };
}

export function retryDelayMs(attempts: number): number {
  return Math.min(15 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));
}

export function createCommunicationJobStore(database: Database.Database) {
  const get = (jobId: string) => row(
    database.prepare("SELECT * FROM communication_jobs WHERE id = ?").get(jobId) as Record<string, unknown> | undefined,
  );

  const enqueue = (input: EnqueueCommunicationJob): CommunicationJob => {
    const phone = normalizePhoneDigits(input.recipientPhone);
    if (!/^\d{10,15}$/.test(phone)) throw new Error("Invalid communication recipient phone.");
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + Math.max(1, input.expiresInMinutes ?? 30) * 60_000).toISOString();
    const jobId = id();
    database.prepare(
      `INSERT OR IGNORE INTO communication_jobs (
        id, owner_uid, event_key, kind, channel, recipient_phone, template_name,
        payload, role, call_id, campaign_id, campaign_recipient_id, status,
        attempts, max_attempts, available_at, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?)`,
    ).run(
      jobId,
      input.ownerUid,
      input.eventKey,
      input.kind || "whatsapp_template",
      input.channel || "whatsapp",
      phone,
      input.templateName,
      JSON.stringify(input.payload || {}),
      input.role || "customer",
      input.callId || null,
      input.campaignId || null,
      input.campaignRecipientId || null,
      Math.max(1, Math.min(10, input.maxAttempts ?? 5)),
      input.availableAt || createdAt,
      expiresAt,
      createdAt,
      createdAt,
    );
    const saved = database
      .prepare("SELECT * FROM communication_jobs WHERE owner_uid = ? AND event_key = ?")
      .get(input.ownerUid, input.eventKey) as Record<string, unknown> | undefined;
    const normalized = row(saved);
    if (!normalized) throw new Error("Communication job could not be persisted.");
    return normalized;
  };

  const claimNext = (leaseMs = 30_000): CommunicationJob | null => database.transaction(() => {
    const now = nowIso();
    database.prepare(
      "UPDATE communication_jobs SET status = 'retry', lease_until = NULL, updated_at = ? WHERE status = 'processing' AND lease_until <= ?",
    ).run(now, now);
    database.prepare(
      "UPDATE communication_jobs SET status = 'expired', lease_until = NULL, updated_at = ? WHERE status IN ('pending','retry') AND expires_at IS NOT NULL AND expires_at <= ?",
    ).run(now, now);

    const candidate = database.prepare(
      `SELECT id FROM communication_jobs
       WHERE status IN ('pending','retry') AND available_at <= ?
         AND (lease_until IS NULL OR lease_until <= ?)
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY available_at ASC, created_at ASC LIMIT 1`,
    ).get(now, now, now) as { id?: string } | undefined;
    if (!candidate?.id) return null;

    const leaseUntil = new Date(Date.now() + Math.max(5_000, leaseMs)).toISOString();
    const changed = database.prepare(
      `UPDATE communication_jobs
       SET status = 'processing', attempts = attempts + 1, lease_until = ?, updated_at = ?
       WHERE id = ? AND status IN ('pending','retry')`,
    ).run(leaseUntil, now, candidate.id).changes;
    return changed ? get(candidate.id) : null;
  })();

  const markSent = (jobId: string, providerMessageId?: string | null) => {
    const now = nowIso();
    database.prepare(
      `UPDATE communication_jobs SET status = 'sent', provider_message_id = ?, sent_at = ?,
       lease_until = NULL, last_error = NULL, updated_at = ? WHERE id = ? AND status = 'processing'`,
    ).run(providerMessageId || null, now, now, jobId);
    return get(jobId);
  };

  const markBlocked = (jobId: string, reason: string) => {
    database.prepare(
      "UPDATE communication_jobs SET status = 'blocked', last_error = ?, lease_until = NULL, updated_at = ? WHERE id = ? AND status = 'processing'",
    ).run(reason.slice(0, 2000), nowIso(), jobId);
    return get(jobId);
  };

  const markFailed = (jobId: string, error: unknown) => {
    const current = get(jobId);
    if (!current || current.status !== "processing") return current;
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
    const terminal = current.attempts >= current.max_attempts;
    const availableAt = new Date(Date.now() + retryDelayMs(current.attempts)).toISOString();
    database.prepare(
      `UPDATE communication_jobs SET status = ?, available_at = ?, last_error = ?,
       lease_until = NULL, updated_at = ? WHERE id = ? AND status = 'processing'`,
    ).run(terminal ? "failed" : "retry", availableAt, message, nowIso(), jobId);
    return get(jobId);
  };

  const defer = (jobId: string, delayMs: number, reason: string) => {
    const availableAt = new Date(Date.now() + Math.max(1_000, delayMs)).toISOString();
    database.prepare(
      `UPDATE communication_jobs SET status = 'retry', available_at = ?,
       attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END,
       last_error = ?, lease_until = NULL, updated_at = ?
       WHERE id = ? AND status = 'processing'`,
    ).run(availableAt, reason.slice(0, 2000), nowIso(), jobId);
    return get(jobId);
  };

  const listRecent = (ownerUid: string, limit = 50): CommunicationJob[] => {
    const rows = database.prepare(
      `SELECT * FROM communication_jobs
       WHERE owner_uid = ? ORDER BY created_at DESC LIMIT ?`,
    ).all(ownerUid, Math.max(1, Math.min(200, limit))) as Array<Record<string, unknown>>;
    return rows.map((value) => row(value)).filter((value): value is CommunicationJob => Boolean(value));
  };

  const summary = (ownerUid: string) => {
    const counts = database.prepare(
      `SELECT status, COUNT(*) AS count FROM communication_jobs
       WHERE owner_uid = ? GROUP BY status`,
    ).all(ownerUid) as Array<{ status: CommunicationJobStatus; count: number }>;
    const byStatus: Record<CommunicationJobStatus, number> = {
      pending: 0,
      processing: 0,
      retry: 0,
      sent: 0,
      failed: 0,
      blocked: 0,
      expired: 0,
    };
    for (const item of counts) {
      if (item.status in byStatus) byStatus[item.status] = Number(item.count || 0);
    }
    return {
      ...byStatus,
      waiting: byStatus.pending + byStatus.processing + byStatus.retry,
      attention: byStatus.failed + byStatus.blocked,
      total: Object.values(byStatus).reduce((sum, count) => sum + count, 0),
    };
  };

  return { enqueue, get, claimNext, markSent, markBlocked, markFailed, defer, listRecent, summary };
}

export const communicationJobStore = createCommunicationJobStore(db);
