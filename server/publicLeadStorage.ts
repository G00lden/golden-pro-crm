import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { PublicLeadInput } from "./validation";

export const PUBLIC_LEAD_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS public_leads (
    id TEXT PRIMARY KEY,
    owner_uid TEXT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    service TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'landing',
    utm_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'new',
    request_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (source IN ('landing', 'landing-v2')),
    CHECK (status IN ('new', 'contacted', 'qualified', 'closed', 'spam'))
  );
  CREATE INDEX IF NOT EXISTS idx_public_leads_owner_status_created
    ON public_leads(owner_uid, status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_public_leads_phone_created
    ON public_leads(phone, created_at DESC);

  CREATE TABLE IF NOT EXISTS public_lead_projections (
    lead_id TEXT PRIMARY KEY,
    owner_uid TEXT NOT NULL,
    dedupe_fingerprint TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    target_type TEXT NOT NULL DEFAULT 'crm_deal',
    target_id TEXT,
    last_error TEXT,
    next_retry_at TEXT,
    projected_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (lead_id) REFERENCES public_leads(id) ON DELETE CASCADE,
    CHECK (status IN ('pending', 'projected', 'failed')),
    CHECK (target_type = 'crm_deal'),
    CHECK (attempts >= 0)
  );
  CREATE INDEX IF NOT EXISTS idx_public_lead_projections_owner_status_created
    ON public_lead_projections(owner_uid, status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_public_lead_projections_owner_fingerprint_created
    ON public_lead_projections(owner_uid, dedupe_fingerprint, created_at DESC);
`;

export type PublicLeadDatabase = Pick<Database.Database, "prepare" | "transaction">;
export type PublicLeadStatus = "new" | "contacted" | "qualified" | "closed" | "spam";
export type PublicLeadProjectionStatus = "pending" | "projected" | "failed";

export type PublicLeadRecord = {
  id: string;
  owner_uid: string | null;
  name: string;
  phone: string;
  service: string;
  message: string;
  source: PublicLeadInput["source"];
  utm_json: string;
  status: PublicLeadStatus;
  request_id: string | null;
  created_at: string;
  updated_at: string;
};

export type PublicLeadProjectionRecord = {
  lead_id: string;
  owner_uid: string;
  dedupe_fingerprint: string;
  status: PublicLeadProjectionStatus;
  attempts: number;
  target_type: "crm_deal";
  target_id: string | null;
  last_error: string | null;
  next_retry_at: string | null;
  projected_at: string | null;
  created_at: string;
  updated_at: string;
};

export type PublicLeadInboxRecord = PublicLeadRecord & {
  projection_status: PublicLeadProjectionStatus;
  projection_attempts: number;
  projection_target_id: string | null;
  projection_last_error: string | null;
  projection_next_retry_at: string | null;
  projected_at: string | null;
};

type CreatePublicLeadOptions = {
  ownerUid: string;
  requestId?: string | null;
  idFactory?: () => string;
  now?: () => string;
  dedupeWindowMs?: number;
};

type ProjectionOptions = {
  ownerUid: string;
  now?: () => string;
  force?: boolean;
};

export type PublicLeadProjectionResult = {
  projection: PublicLeadProjectionRecord;
  attempted: boolean;
  error?: unknown;
};

const DEFAULT_DEDUPE_WINDOW_MS = 15 * 60_000;

function requiredOwnerUid(value: string) {
  const ownerUid = String(value || "").trim();
  if (!ownerUid) throw new Error("Public lead owner is not configured.");
  return ownerUid;
}

function canonicalText(value: unknown) {
  return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function safeJsonObject(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function canonicalUtm(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined && item !== null && String(item).trim() !== "")
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function normalizeLeadPhone(value: string) {
  const trimmed = String(value || "").trim();
  const hasInternationalPrefix = trimmed.startsWith("+") || trimmed.startsWith("00");
  const digits = trimmed.replace(/\D/g, "");
  if (!hasInternationalPrefix) return digits;
  return `+${digits.replace(/^00/, "")}`;
}

export function publicLeadFingerprint(input: {
  name: string;
  phone: string;
  service: string;
  message: string;
  source: string;
  utm?: Record<string, unknown>;
}) {
  const canonical = {
    name: canonicalText(input.name),
    phone: normalizeLeadPhone(input.phone),
    service: canonicalText(input.service),
    message: canonicalText(input.message),
    source: canonicalText(input.source),
    utm: canonicalUtm(input.utm || {}),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function normalizePublicLead(
  input: PublicLeadInput,
  options: CreatePublicLeadOptions,
  timestamp: string,
): PublicLeadRecord {
  return {
    id: (options.idFactory || randomUUID)(),
    owner_uid: requiredOwnerUid(options.ownerUid),
    name: input.name.trim(),
    phone: normalizeLeadPhone(input.phone),
    service: input.service.trim(),
    message: input.message.trim(),
    source: input.source,
    utm_json: JSON.stringify(canonicalUtm(input.utm || {})),
    status: "new",
    request_id: String(options.requestId || "").trim() || null,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

export function capturePublicLeadRecord(
  database: PublicLeadDatabase,
  input: PublicLeadInput,
  options: CreatePublicLeadOptions,
): { lead: PublicLeadRecord; duplicate: boolean } {
  const timestamp = (options.now || (() => new Date().toISOString()))();
  const ownerUid = requiredOwnerUid(options.ownerUid);
  const candidate = normalizePublicLead(input, { ...options, ownerUid }, timestamp);
  const fingerprint = publicLeadFingerprint({
    ...candidate,
    utm: safeJsonObject(candidate.utm_json),
  });
  const dedupeWindowMs = Math.max(1_000, options.dedupeWindowMs || DEFAULT_DEDUPE_WINDOW_MS);
  const parsedTimestamp = Date.parse(timestamp);
  const cutoff = new Date(
    (Number.isFinite(parsedTimestamp) ? parsedTimestamp : Date.now()) - dedupeWindowMs,
  ).toISOString();

  const transaction = database.transaction(() => {
    const existing = database.prepare(`
      SELECT leads.*
      FROM public_leads AS leads
      INNER JOIN public_lead_projections AS projections ON projections.lead_id = leads.id
      WHERE projections.owner_uid = ?
        AND projections.dedupe_fingerprint = ?
        AND leads.created_at >= ?
      ORDER BY leads.created_at DESC
      LIMIT 1
    `).get(ownerUid, fingerprint, cutoff) as PublicLeadRecord | undefined;
    if (existing) return { lead: existing, duplicate: true };

    database.prepare(`
      INSERT INTO public_leads (
        id, owner_uid, name, phone, service, message, source,
        utm_json, status, request_id, created_at, updated_at
      ) VALUES (
        @id, @owner_uid, @name, @phone, @service, @message, @source,
        @utm_json, @status, @request_id, @created_at, @updated_at
      )
    `).run(candidate);
    database.prepare(`
      INSERT INTO public_lead_projections (
        lead_id, owner_uid, dedupe_fingerprint, status, attempts,
        target_type, target_id, last_error, next_retry_at, projected_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', 0, 'crm_deal', NULL, NULL, ?, NULL, ?, ?)
    `).run(candidate.id, ownerUid, fingerprint, timestamp, timestamp, timestamp);
    return { lead: candidate, duplicate: false };
  });

  return transaction.immediate();
}

// Backwards-compatible helper for callers that only need the stored record.
// New code should use capturePublicLeadRecord so it can observe deduplication.
export function createPublicLeadRecord(
  database: PublicLeadDatabase,
  input: PublicLeadInput,
  options: CreatePublicLeadOptions,
): PublicLeadRecord {
  return capturePublicLeadRecord(database, input, options).lead;
}

function projectionRecord(database: PublicLeadDatabase, leadId: string, ownerUid: string) {
  return database.prepare(
    "SELECT * FROM public_lead_projections WHERE lead_id = ? AND owner_uid = ?",
  ).get(leadId, ownerUid) as PublicLeadProjectionRecord | undefined;
}

function dealIdForLead(leadId: string) {
  const digest = createHash("sha256").update(leadId).digest("hex").slice(0, 24);
  return `deal_public_${digest}`;
}

function retryAt(timestamp: string, previousAttempts: number) {
  const parsed = Date.parse(timestamp);
  const base = Number.isFinite(parsed) ? parsed : Date.now();
  const delayMs = Math.min(24 * 60 * 60_000, 60_000 * (2 ** Math.min(previousAttempts, 10)));
  return new Date(base + delayMs).toISOString();
}

function projectionNotes(lead: PublicLeadRecord) {
  const utm = safeJsonObject(lead.utm_json);
  const lines = [
    "طلب وارد من نموذج الموقع",
    lead.service ? `الخدمة: ${lead.service}` : "",
    lead.message ? `الرسالة: ${lead.message}` : "",
    `مرجع الطلب: ${lead.id}`,
    Object.keys(utm).length ? `بيانات الحملة: ${JSON.stringify(utm)}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

export function projectPublicLeadToCrm(
  database: PublicLeadDatabase,
  leadId: string,
  options: ProjectionOptions,
): PublicLeadProjectionResult {
  const ownerUid = requiredOwnerUid(options.ownerUid);
  const timestamp = (options.now || (() => new Date().toISOString()))();
  const current = projectionRecord(database, leadId, ownerUid);
  if (!current) throw new Error("Public lead projection was not found.");
  if (current.status === "projected") return { projection: current, attempted: false };
  if (!options.force && current.next_retry_at && current.next_retry_at > timestamp) {
    return { projection: current, attempted: false };
  }

  try {
    const transaction = database.transaction(() => {
      const lead = database.prepare(
        "SELECT * FROM public_leads WHERE id = ? AND owner_uid = ?",
      ).get(leadId, ownerUid) as PublicLeadRecord | undefined;
      if (!lead) throw new Error("Public lead was not found in its owner partition.");

      const targetId = dealIdForLead(lead.id);
      database.prepare(`
        INSERT OR IGNORE INTO crm_deals (
          id, owner_uid, title, customer_id, customer_name, customer_phone,
          stage, amount, currency, probability, expected_close, assigned_to,
          source, quote_id, invoice_id, notes, created_at, updated_at
        ) VALUES (
          @id, @owner_uid, @title, NULL, @customer_name, @customer_phone,
          'lead', 0, 'SAR', 10, NULL, NULL,
          'public_lead', NULL, NULL, @notes, @created_at, @updated_at
        )
      `).run({
        id: targetId,
        owner_uid: ownerUid,
        title: `طلب موقع: ${lead.service || lead.name}`,
        customer_name: lead.name,
        customer_phone: lead.phone,
        notes: projectionNotes(lead),
        created_at: lead.created_at,
        updated_at: timestamp,
      });

      const target = database.prepare(
        "SELECT owner_uid, source FROM crm_deals WHERE id = ?",
      ).get(targetId) as { owner_uid: string; source: string } | undefined;
      if (!target || target.owner_uid !== ownerUid || target.source !== "public_lead") {
        throw new Error("CRM projection target conflicts with an existing record.");
      }

      database.prepare(`
        UPDATE public_lead_projections
        SET status = 'projected', attempts = attempts + 1, target_id = ?,
            last_error = NULL, next_retry_at = NULL, projected_at = ?, updated_at = ?
        WHERE lead_id = ? AND owner_uid = ?
      `).run(targetId, timestamp, timestamp, leadId, ownerUid);
      return projectionRecord(database, leadId, ownerUid)!;
    });
    return { projection: transaction.immediate(), attempted: true };
  } catch (error) {
    database.prepare(`
      UPDATE public_lead_projections
      SET status = 'failed', attempts = attempts + 1,
          last_error = 'projection_failed', next_retry_at = ?, updated_at = ?
      WHERE lead_id = ? AND owner_uid = ?
    `).run(retryAt(timestamp, current.attempts), timestamp, leadId, ownerUid);
    const failed = projectionRecord(database, leadId, ownerUid);
    if (!failed) throw error;
    return { projection: failed, attempted: true, error };
  }
}

export function ensurePublicLeadProjectionRows(
  database: PublicLeadDatabase,
  ownerUidValue: string,
  now: () => string = () => new Date().toISOString(),
) {
  const ownerUid = requiredOwnerUid(ownerUidValue);
  const timestamp = now();
  const transaction = database.transaction(() => {
    // Leads accepted before ownership became mandatory belong to the configured
    // public-form partition; assigning them here prevents silent orphaning.
    database.prepare(`
      UPDATE public_leads
      SET owner_uid = ?, updated_at = ?
      WHERE owner_uid IS NULL OR TRIM(owner_uid) = ''
    `).run(ownerUid, timestamp);

    const missing = database.prepare(`
      SELECT leads.*
      FROM public_leads AS leads
      LEFT JOIN public_lead_projections AS projections ON projections.lead_id = leads.id
      WHERE leads.owner_uid = ? AND projections.lead_id IS NULL
      ORDER BY leads.created_at ASC
    `).all(ownerUid) as PublicLeadRecord[];
    const insert = database.prepare(`
      INSERT INTO public_lead_projections (
        lead_id, owner_uid, dedupe_fingerprint, status, attempts,
        target_type, target_id, last_error, next_retry_at, projected_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', 0, 'crm_deal', NULL, NULL, ?, NULL, ?, ?)
    `);
    for (const lead of missing) {
      const fingerprint = publicLeadFingerprint({
        ...lead,
        utm: safeJsonObject(lead.utm_json),
      });
      insert.run(
        lead.id,
        ownerUid,
        fingerprint,
        timestamp,
        lead.created_at || timestamp,
        timestamp,
      );
    }
    return missing.length;
  });
  return transaction.immediate();
}

export function listPublicLeadInbox(
  database: PublicLeadDatabase,
  ownerUidValue: string,
  limit = 200,
): PublicLeadInboxRecord[] {
  const ownerUid = requiredOwnerUid(ownerUidValue);
  const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit) || 200));
  return database.prepare(`
    SELECT leads.*,
      projections.status AS projection_status,
      projections.attempts AS projection_attempts,
      projections.target_id AS projection_target_id,
      projections.last_error AS projection_last_error,
      projections.next_retry_at AS projection_next_retry_at,
      projections.projected_at
    FROM public_leads AS leads
    INNER JOIN public_lead_projections AS projections ON projections.lead_id = leads.id
    WHERE leads.owner_uid = ? AND projections.owner_uid = ?
    ORDER BY leads.created_at DESC
    LIMIT ?
  `).all(ownerUid, ownerUid, boundedLimit) as PublicLeadInboxRecord[];
}

export function getPublicLeadInboxRecord(
  database: PublicLeadDatabase,
  leadId: string,
  ownerUidValue: string,
): PublicLeadInboxRecord | null {
  const ownerUid = requiredOwnerUid(ownerUidValue);
  return (database.prepare(`
    SELECT leads.*,
      projections.status AS projection_status,
      projections.attempts AS projection_attempts,
      projections.target_id AS projection_target_id,
      projections.last_error AS projection_last_error,
      projections.next_retry_at AS projection_next_retry_at,
      projections.projected_at
    FROM public_leads AS leads
    INNER JOIN public_lead_projections AS projections ON projections.lead_id = leads.id
    WHERE leads.id = ? AND leads.owner_uid = ? AND projections.owner_uid = ?
  `).get(leadId, ownerUid, ownerUid) as PublicLeadInboxRecord | undefined) || null;
}

export function reconcilePublicLeadProjections(
  database: PublicLeadDatabase,
  ownerUidValue: string,
  options: { now?: () => string; limit?: number } = {},
) {
  const ownerUid = requiredOwnerUid(ownerUidValue);
  const now = options.now || (() => new Date().toISOString());
  const timestamp = now();
  const backfilled = ensurePublicLeadProjectionRows(database, ownerUid, () => timestamp);
  const limit = Math.max(1, Math.min(500, Math.trunc(options.limit || 100)));
  const due = database.prepare(`
    SELECT lead_id
    FROM public_lead_projections
    WHERE owner_uid = ?
      AND status IN ('pending', 'failed')
      AND (next_retry_at IS NULL OR next_retry_at <= ?)
    ORDER BY created_at ASC
    LIMIT ?
  `).all(ownerUid, timestamp, limit) as Array<{ lead_id: string }>;
  let projected = 0;
  let failed = 0;
  for (const item of due) {
    const result = projectPublicLeadToCrm(database, item.lead_id, {
      ownerUid,
      now: () => timestamp,
    });
    if (result.projection.status === "projected") projected += 1;
    else failed += 1;
  }
  return { backfilled, attempted: due.length, projected, failed };
}

export function updatePublicLeadStatus(
  database: PublicLeadDatabase,
  leadId: string,
  ownerUidValue: string,
  status: PublicLeadStatus,
  now: () => string = () => new Date().toISOString(),
) {
  const ownerUid = requiredOwnerUid(ownerUidValue);
  const result = database.prepare(`
    UPDATE public_leads
    SET status = ?, updated_at = ?
    WHERE id = ? AND owner_uid = ?
  `).run(status, now(), leadId, ownerUid);
  if (result.changes === 0) return null;
  return database.prepare(
    "SELECT * FROM public_leads WHERE id = ? AND owner_uid = ?",
  ).get(leadId, ownerUid) as PublicLeadRecord;
}
