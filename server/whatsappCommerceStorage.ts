import type Database from "better-sqlite3";

export const WHATSAPP_COMMERCE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS whatsapp_commerce_sessions (
    owner_uid TEXT NOT NULL,
    phone TEXT NOT NULL,
    step TEXT NOT NULL,
    context_json TEXT NOT NULL DEFAULT '{}',
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (owner_uid, phone)
  );
  CREATE INDEX IF NOT EXISTS idx_whatsapp_commerce_sessions_expires
    ON whatsapp_commerce_sessions(expires_at);
`;

export type WhatsAppCommerceStep =
  | "awaiting_action"
  | "awaiting_name"
  | "awaiting_address"
  | "awaiting_booking_kind"
  | "awaiting_installation"
  | "awaiting_product"
  | "awaiting_slot"
  | "awaiting_cart_question"
  | "awaiting_campaign_filter_request"
  | "awaiting_delivery_rating"
  | "awaiting_delivery_feedback";

export type WhatsAppCommerceSession<TContext extends Record<string, unknown> = Record<string, unknown>> = {
  owner_uid: string;
  phone: string;
  step: WhatsAppCommerceStep;
  context: TContext;
  expires_at: string;
  created_at: string;
  updated_at: string;
};

type CommerceDatabase = Pick<Database.Database, "prepare">;

type StoredCommerceSession = Omit<WhatsAppCommerceSession, "context"> & {
  context_json: string;
};

function safeContext(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function getWhatsAppCommerceSession(
  database: CommerceDatabase,
  ownerUid: string,
  phone: string,
  now = new Date().toISOString(),
): WhatsAppCommerceSession | null {
  database.prepare(
    "DELETE FROM whatsapp_commerce_sessions WHERE expires_at <= ?",
  ).run(now);
  const row = database.prepare(
    `SELECT owner_uid, phone, step, context_json, expires_at, created_at, updated_at
       FROM whatsapp_commerce_sessions
      WHERE owner_uid = ? AND phone = ? AND expires_at > ?
      LIMIT 1`,
  ).get(ownerUid, phone, now) as StoredCommerceSession | undefined;
  if (!row) return null;
  return {
    owner_uid: row.owner_uid,
    phone: row.phone,
    step: row.step,
    context: safeContext(row.context_json),
    expires_at: row.expires_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function saveWhatsAppCommerceSession(
  database: CommerceDatabase,
  input: {
    ownerUid: string;
    phone: string;
    step: WhatsAppCommerceStep;
    context?: Record<string, unknown>;
    now?: string;
    ttlMinutes?: number;
  },
) {
  const now = input.now || new Date().toISOString();
  const ttlMinutes = Math.max(5, Math.min(7 * 24 * 60, Number(input.ttlMinutes || 30)));
  const expiresAt = new Date(Date.parse(now) + ttlMinutes * 60_000).toISOString();
  database.prepare(
    `INSERT INTO whatsapp_commerce_sessions (
       owner_uid, phone, step, context_json, expires_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(owner_uid, phone) DO UPDATE SET
       step = excluded.step,
       context_json = excluded.context_json,
       expires_at = excluded.expires_at,
       updated_at = excluded.updated_at`,
  ).run(
    input.ownerUid,
    input.phone,
    input.step,
    JSON.stringify(input.context || {}),
    expiresAt,
    now,
    now,
  );
  return expiresAt;
}

export function clearWhatsAppCommerceSession(
  database: CommerceDatabase,
  ownerUid: string,
  phone: string,
) {
  return database.prepare(
    "DELETE FROM whatsapp_commerce_sessions WHERE owner_uid = ? AND phone = ?",
  ).run(ownerUid, phone).changes > 0;
}
