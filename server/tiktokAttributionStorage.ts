import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";

export const TIKTOK_ATTRIBUTION_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS marketing_attribution_sessions (
    reference TEXT PRIMARY KEY,
    owner_uid TEXT NOT NULL,
    consent_state TEXT NOT NULL DEFAULT 'granted',
    ttclid TEXT,
    ttp TEXT,
    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT,
    utm_content TEXT,
    utm_term TEXT,
    landing_path TEXT NOT NULL DEFAULT '/',
    landing_url TEXT,
    referrer TEXT,
    client_ip TEXT,
    user_agent TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    CHECK (consent_state = 'granted')
  );
  CREATE INDEX IF NOT EXISTS idx_marketing_sessions_owner_last_seen
    ON marketing_attribution_sessions(owner_uid, last_seen_at DESC);
  CREATE INDEX IF NOT EXISTS idx_marketing_sessions_ttclid
    ON marketing_attribution_sessions(ttclid)
    WHERE ttclid IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_marketing_sessions_expires
    ON marketing_attribution_sessions(expires_at);

  CREATE TABLE IF NOT EXISTS marketing_attribution_events (
    event_id TEXT PRIMARY KEY,
    owner_uid TEXT NOT NULL,
    reference TEXT,
    event_name TEXT NOT NULL,
    source TEXT NOT NULL,
    phone_sha256 TEXT,
    value REAL,
    currency TEXT,
    content_name TEXT,
    occurred_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    available_at TEXT NOT NULL,
    lease_until TEXT,
    last_error TEXT,
    response_code TEXT,
    sent_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (reference) REFERENCES marketing_attribution_sessions(reference) ON DELETE SET NULL,
    CHECK (event_name IN ('ViewContent','ClickButton','Contact','SubmitForm','CompletePayment')),
    CHECK (source IN ('landing','whatsapp','crm','order')),
    CHECK (status IN ('pending','processing','retry','sent','failed','blocked')),
    CHECK (attempts >= 0),
    CHECK (currency IS NULL OR currency GLOB '[A-Z][A-Z][A-Z]')
  );
  CREATE INDEX IF NOT EXISTS idx_marketing_events_dispatch
    ON marketing_attribution_events(status, available_at, created_at);
  CREATE INDEX IF NOT EXISTS idx_marketing_events_owner_created
    ON marketing_attribution_events(owner_uid, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_marketing_events_reference
    ON marketing_attribution_events(reference, occurred_at DESC);
`;

export type AttributionDatabase = Pick<Database.Database, "prepare" | "transaction">;

export type AttributionSessionInput = {
  reference: string;
  ownerUid: string;
  ttclid?: string | null;
  ttp?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmContent?: string | null;
  utmTerm?: string | null;
  landingPath: string;
  landingUrl?: string | null;
  referrer?: string | null;
  clientIp?: string | null;
  userAgent?: string | null;
  now?: string;
  ttlDays?: number;
};

export type AttributionSessionRecord = {
  reference: string;
  owner_uid: string;
  consent_state: "granted";
  ttclid: string | null;
  ttp: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  landing_path: string;
  landing_url: string | null;
  referrer: string | null;
  client_ip: string | null;
  user_agent: string | null;
  first_seen_at: string;
  last_seen_at: string;
  expires_at: string;
};

export type AttributionEventName = "ViewContent" | "ClickButton" | "Contact" | "SubmitForm" | "CompletePayment";
export type AttributionEventStatus = "pending" | "processing" | "retry" | "sent" | "failed" | "blocked";

export type AttributionEventRecord = {
  event_id: string;
  owner_uid: string;
  reference: string | null;
  event_name: AttributionEventName;
  source: "landing" | "whatsapp" | "crm" | "order";
  phone_sha256: string | null;
  value: number | null;
  currency: string | null;
  content_name: string | null;
  occurred_at: string;
  status: AttributionEventStatus;
  attempts: number;
  available_at: string;
  lease_until: string | null;
  last_error: string | null;
  response_code: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ClaimedAttributionEvent = AttributionEventRecord & AttributionSessionRecord;

const MAX_ERROR_LENGTH = 600;

function clean(value: unknown, max: number) {
  const result = String(value || "").trim();
  return result ? result.slice(0, max) : null;
}

export function normalizeAttributionReference(value: unknown) {
  const reference = String(value || "").trim().toUpperCase();
  return /^[A-F0-9]{16}$/.test(reference) ? reference : null;
}

export function newAttributionReference() {
  return randomBytes(8).toString("hex").toUpperCase();
}

export function normalizeSaudiPhone(value: unknown) {
  const digits = String(value || "").replace(/\D/g, "");
  if (/^9665\d{8}$/.test(digits)) return `+${digits}`;
  if (/^05\d{8}$/.test(digits)) return `+966${digits.slice(1)}`;
  if (/^5\d{8}$/.test(digits)) return `+966${digits}`;
  if (/^[1-9]\d{7,14}$/.test(digits)) return `+${digits}`;
  return null;
}

export function sha256Phone(value: unknown) {
  const phone = normalizeSaudiPhone(value);
  return phone ? createHash("sha256").update(phone).digest("hex") : null;
}

export function parseAttributionReference(message: unknown) {
  const match = String(message || "").match(/(?:مرجع(?:\s+الطلب)?|REF)\s*[:：-]\s*([A-F0-9]{16})/iu);
  return normalizeAttributionReference(match?.[1]);
}

export function upsertAttributionSession(database: AttributionDatabase, input: AttributionSessionInput) {
  const reference = normalizeAttributionReference(input.reference);
  if (!reference) throw new Error("Invalid attribution reference.");
  const ownerUid = clean(input.ownerUid, 160);
  if (!ownerUid) throw new Error("Attribution owner is not configured.");
  const now = input.now || new Date().toISOString();
  const parsed = Date.parse(now);
  const ttlDays = Math.min(180, Math.max(1, Number(input.ttlDays || 90)));
  const expiresAt = new Date((Number.isFinite(parsed) ? parsed : Date.now()) + ttlDays * 86_400_000).toISOString();
  const row = {
    reference,
    owner_uid: ownerUid,
    ttclid: clean(input.ttclid, 512),
    ttp: clean(input.ttp, 256),
    utm_source: clean(input.utmSource, 120),
    utm_medium: clean(input.utmMedium, 120),
    utm_campaign: clean(input.utmCampaign, 180),
    utm_content: clean(input.utmContent, 180),
    utm_term: clean(input.utmTerm, 180),
    landing_path: clean(input.landingPath, 256) || "/",
    landing_url: clean(input.landingUrl, 1_500),
    referrer: clean(input.referrer, 1_500),
    client_ip: clean(input.clientIp, 64),
    user_agent: clean(input.userAgent, 600),
    now,
    expires_at: expiresAt,
  };
  database.prepare(`
    INSERT INTO marketing_attribution_sessions (
      reference, owner_uid, consent_state, ttclid, ttp,
      utm_source, utm_medium, utm_campaign, utm_content, utm_term,
      landing_path, landing_url, referrer, client_ip, user_agent,
      first_seen_at, last_seen_at, expires_at
    ) VALUES (
      @reference, @owner_uid, 'granted', @ttclid, @ttp,
      @utm_source, @utm_medium, @utm_campaign, @utm_content, @utm_term,
      @landing_path, @landing_url, @referrer, @client_ip, @user_agent,
      @now, @now, @expires_at
    )
    ON CONFLICT(reference) DO UPDATE SET
      last_seen_at = excluded.last_seen_at,
      expires_at = excluded.expires_at,
      ttclid = COALESCE(marketing_attribution_sessions.ttclid, excluded.ttclid),
      ttp = COALESCE(marketing_attribution_sessions.ttp, excluded.ttp),
      utm_source = COALESCE(marketing_attribution_sessions.utm_source, excluded.utm_source),
      utm_medium = COALESCE(marketing_attribution_sessions.utm_medium, excluded.utm_medium),
      utm_campaign = COALESCE(marketing_attribution_sessions.utm_campaign, excluded.utm_campaign),
      utm_content = COALESCE(marketing_attribution_sessions.utm_content, excluded.utm_content),
      utm_term = COALESCE(marketing_attribution_sessions.utm_term, excluded.utm_term),
      landing_url = COALESCE(marketing_attribution_sessions.landing_url, excluded.landing_url),
      referrer = COALESCE(marketing_attribution_sessions.referrer, excluded.referrer),
      client_ip = COALESCE(marketing_attribution_sessions.client_ip, excluded.client_ip),
      user_agent = COALESCE(marketing_attribution_sessions.user_agent, excluded.user_agent)
    WHERE marketing_attribution_sessions.owner_uid = excluded.owner_uid
  `).run(row);
  return database.prepare(
    "SELECT * FROM marketing_attribution_sessions WHERE reference = ? AND owner_uid = ?",
  ).get(reference, ownerUid) as AttributionSessionRecord;
}

export function enqueueAttributionEvent(database: AttributionDatabase, input: {
  eventId: string;
  ownerUid: string;
  reference?: string | null;
  eventName: AttributionEventName;
  source: AttributionEventRecord["source"];
  phone?: string | null;
  value?: number | null;
  currency?: string | null;
  contentName?: string | null;
  occurredAt?: string;
}) {
  const eventId = clean(input.eventId, 160);
  const ownerUid = clean(input.ownerUid, 160);
  if (!eventId || !ownerUid) throw new Error("Attribution event id and owner are required.");
  const reference = normalizeAttributionReference(input.reference);
  const occurredAt = input.occurredAt || new Date().toISOString();
  const currency = clean(input.currency, 3)?.toUpperCase() || null;
  const value = input.value == null ? null : Number(input.value);
  const row = {
    event_id: eventId,
    owner_uid: ownerUid,
    reference,
    event_name: input.eventName,
    source: input.source,
    phone_sha256: sha256Phone(input.phone),
    value: value != null && Number.isFinite(value) && value >= 0 ? value : null,
    currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null,
    content_name: clean(input.contentName, 200),
    occurred_at: occurredAt,
  };
  const result = database.prepare(`
    INSERT OR IGNORE INTO marketing_attribution_events (
      event_id, owner_uid, reference, event_name, source, phone_sha256,
      value, currency, content_name, occurred_at, status, attempts,
      available_at, created_at, updated_at
    ) VALUES (
      @event_id, @owner_uid, @reference, @event_name, @source, @phone_sha256,
      @value, @currency, @content_name, @occurred_at, 'pending', 0,
      @occurred_at, @occurred_at, @occurred_at
    )
  `).run(row);
  return {
    created: result.changes === 1,
    event: database.prepare("SELECT * FROM marketing_attribution_events WHERE event_id = ?").get(eventId) as AttributionEventRecord,
  };
}

export function claimNextAttributionEvent(database: AttributionDatabase, now = new Date().toISOString()) {
  const leaseUntil = new Date(Date.parse(now) + 60_000).toISOString();
  const transaction = database.transaction(() => {
    database.prepare(`
      UPDATE marketing_attribution_events
      SET status = 'retry', lease_until = NULL, available_at = ?, updated_at = ?
      WHERE status = 'processing' AND lease_until <= ?
    `).run(now, now, now);
    const candidate = database.prepare(`
      SELECT event_id FROM marketing_attribution_events
      WHERE status IN ('pending','retry') AND available_at <= ?
      ORDER BY available_at ASC, created_at ASC
      LIMIT 1
    `).get(now) as { event_id: string } | undefined;
    if (!candidate) return null;
    const claimed = database.prepare(`
      UPDATE marketing_attribution_events
      SET status = 'processing', attempts = attempts + 1, lease_until = ?, updated_at = ?
      WHERE event_id = ? AND status IN ('pending','retry')
    `).run(leaseUntil, now, candidate.event_id);
    if (claimed.changes !== 1) return null;
    return database.prepare(`
      SELECT events.*, sessions.*
      FROM marketing_attribution_events AS events
      LEFT JOIN marketing_attribution_sessions AS sessions ON sessions.reference = events.reference
      WHERE events.event_id = ?
    `).get(candidate.event_id) as ClaimedAttributionEvent;
  });
  return transaction.immediate();
}

export function markAttributionEventSent(
  database: AttributionDatabase,
  eventId: string,
  responseCode: string | null,
  now = new Date().toISOString(),
) {
  database.prepare(`
    UPDATE marketing_attribution_events
    SET status = 'sent', response_code = ?, sent_at = ?, lease_until = NULL,
        last_error = NULL, updated_at = ?
    WHERE event_id = ? AND status = 'processing'
  `).run(clean(responseCode, 120), now, now, eventId);
}

export function markAttributionEventFailed(
  database: AttributionDatabase,
  event: Pick<AttributionEventRecord, "event_id" | "attempts">,
  error: unknown,
  now = new Date().toISOString(),
) {
  const retryable = event.attempts < 8;
  const parsed = Date.parse(now);
  const delay = Math.min(6 * 60 * 60_000, 30_000 * (2 ** Math.min(event.attempts, 10)));
  const next = new Date((Number.isFinite(parsed) ? parsed : Date.now()) + delay).toISOString();
  database.prepare(`
    UPDATE marketing_attribution_events
    SET status = ?, available_at = ?, lease_until = NULL, last_error = ?, updated_at = ?
    WHERE event_id = ? AND status = 'processing'
  `).run(
    retryable ? "retry" : "failed",
    retryable ? next : now,
    clean(error instanceof Error ? error.message : error, MAX_ERROR_LENGTH),
    now,
    event.event_id,
  );
}

export function pruneAttributionData(database: AttributionDatabase, now = new Date().toISOString()) {
  database.prepare(`
    DELETE FROM marketing_attribution_events
    WHERE created_at < datetime(?, '-400 days') AND status IN ('sent','failed','blocked')
  `).run(now);
  return database.prepare(`
    DELETE FROM marketing_attribution_sessions
    WHERE expires_at <= ? AND reference NOT IN (
      SELECT reference FROM marketing_attribution_events
      WHERE reference IS NOT NULL AND status IN ('pending','processing','retry')
    )
  `).run(now).changes;
}
