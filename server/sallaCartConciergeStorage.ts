import type Database from "better-sqlite3";

export const SALLA_CART_CONCIERGE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS salla_abandoned_carts (
    owner_uid TEXT NOT NULL,
    cart_id TEXT NOT NULL,
    merchant_id TEXT,
    customer_name TEXT NOT NULL DEFAULT '',
    customer_phone TEXT NOT NULL DEFAULT '',
    checkout_url TEXT,
    items_json TEXT NOT NULL DEFAULT '[]',
    total_amount NUMERIC,
    currency TEXT DEFAULT 'SAR',
    age_in_minutes INTEGER,
    status TEXT NOT NULL DEFAULT 'active',
    outreach_job_id TEXT,
    outreach_status TEXT NOT NULL DEFAULT 'not_queued',
    provider_message_id TEXT,
    first_seen_at TEXT NOT NULL,
    last_event_at TEXT NOT NULL,
    outreach_sent_at TEXT,
    purchased_at TEXT,
    last_question TEXT,
    last_question_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (owner_uid, cart_id)
  );
  CREATE INDEX IF NOT EXISTS idx_salla_abandoned_carts_owner_status
    ON salla_abandoned_carts(owner_uid, status, last_event_at DESC);
  CREATE INDEX IF NOT EXISTS idx_salla_abandoned_carts_outreach
    ON salla_abandoned_carts(owner_uid, outreach_status, updated_at DESC);
`;

export type SallaCartProductContext = {
  productId: string | null;
  name: string;
  quantity: number;
  price: number | null;
  currency: string;
  description: string;
  productType: string;
  storeUrl: string | null;
  isAvailable: boolean | null;
  stockQuantity: number | null;
};

export type SallaAbandonedCartRecord = {
  owner_uid: string;
  cart_id: string;
  merchant_id: string | null;
  customer_name: string;
  customer_phone: string;
  checkout_url: string | null;
  items: SallaCartProductContext[];
  total_amount: number | null;
  currency: string;
  age_in_minutes: number | null;
  status: string;
  outreach_job_id: string | null;
  outreach_status: string;
  provider_message_id: string | null;
  first_seen_at: string;
  last_event_at: string;
  outreach_sent_at: string | null;
  purchased_at: string | null;
  last_question: string | null;
  last_question_at: string | null;
  created_at: string;
  updated_at: string;
};

type CartDatabase = Pick<Database.Database, "prepare">;

type StoredCart = Omit<SallaAbandonedCartRecord, "items"> & {
  items_json: string;
};

function safeItems(value: string): SallaCartProductContext[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as SallaCartProductContext[] : [];
  } catch {
    return [];
  }
}

function cartRow(value: StoredCart | undefined): SallaAbandonedCartRecord | null {
  if (!value) return null;
  return {
    ...value,
    total_amount: value.total_amount === null ? null : Number(value.total_amount),
    age_in_minutes: value.age_in_minutes === null ? null : Number(value.age_in_minutes),
    items: safeItems(value.items_json),
  };
}

export function createSallaCartConciergeStore(database: CartDatabase) {
  const get = (ownerUid: string, cartId: string) => cartRow(database.prepare(
    "SELECT * FROM salla_abandoned_carts WHERE owner_uid = ? AND cart_id = ? LIMIT 1",
  ).get(ownerUid, cartId) as StoredCart | undefined);

  const upsertActive = (input: {
    ownerUid: string;
    cartId: string;
    merchantId?: string | null;
    customerName: string;
    customerPhone: string;
    checkoutUrl?: string | null;
    items: SallaCartProductContext[];
    totalAmount?: number | null;
    currency?: string;
    ageInMinutes?: number | null;
    eventAt: string;
  }) => {
    const now = new Date().toISOString();
    database.prepare(
      `INSERT INTO salla_abandoned_carts (
         owner_uid, cart_id, merchant_id, customer_name, customer_phone,
         checkout_url, items_json, total_amount, currency, age_in_minutes,
         status, outreach_status, first_seen_at, last_event_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'not_queued', ?, ?, ?, ?)
       ON CONFLICT(owner_uid, cart_id) DO UPDATE SET
         merchant_id = COALESCE(excluded.merchant_id, merchant_id),
         customer_name = CASE WHEN excluded.customer_name <> '' THEN excluded.customer_name ELSE customer_name END,
         customer_phone = CASE WHEN excluded.customer_phone <> '' THEN excluded.customer_phone ELSE customer_phone END,
         checkout_url = COALESCE(excluded.checkout_url, checkout_url),
         items_json = CASE WHEN excluded.items_json <> '[]' THEN excluded.items_json ELSE items_json END,
         total_amount = COALESCE(excluded.total_amount, total_amount),
         currency = CASE WHEN excluded.currency <> '' THEN excluded.currency ELSE currency END,
         age_in_minutes = COALESCE(excluded.age_in_minutes, age_in_minutes),
         status = CASE WHEN status = 'purchased' THEN status ELSE 'active' END,
         last_event_at = CASE WHEN excluded.last_event_at > last_event_at THEN excluded.last_event_at ELSE last_event_at END,
         updated_at = excluded.updated_at`,
    ).run(
      input.ownerUid,
      input.cartId,
      input.merchantId || null,
      input.customerName,
      input.customerPhone,
      input.checkoutUrl || null,
      JSON.stringify(input.items),
      input.totalAmount ?? null,
      input.currency || "SAR",
      input.ageInMinutes ?? null,
      input.eventAt,
      input.eventAt,
      now,
      now,
    );
    return get(input.ownerUid, input.cartId);
  };

  const setOutreach = (
    ownerUid: string,
    cartId: string,
    input: {
      status: string;
      jobId?: string | null;
      providerMessageId?: string | null;
      sentAt?: string | null;
    },
  ) => {
    const now = new Date().toISOString();
    database.prepare(
      `UPDATE salla_abandoned_carts SET
         outreach_status = ?,
         outreach_job_id = COALESCE(?, outreach_job_id),
         provider_message_id = COALESCE(?, provider_message_id),
         outreach_sent_at = COALESCE(?, outreach_sent_at),
         updated_at = ?
       WHERE owner_uid = ? AND cart_id = ?`,
    ).run(
      input.status,
      input.jobId || null,
      input.providerMessageId || null,
      input.sentAt || null,
      now,
      ownerUid,
      cartId,
    );
    return get(ownerUid, cartId);
  };

  const markTerminal = (
    ownerUid: string,
    cartId: string,
    status: "purchased" | "cancelled",
    eventAt: string,
  ) => {
    const now = new Date().toISOString();
    database.prepare(
      `INSERT INTO salla_abandoned_carts (
         owner_uid, cart_id, status, outreach_status, first_seen_at,
         last_event_at, purchased_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, CASE WHEN ? = 'purchased' THEN ? ELSE NULL END, ?, ?)
       ON CONFLICT(owner_uid, cart_id) DO UPDATE SET
         status = excluded.status,
         outreach_status = CASE
           WHEN outreach_status = 'sent' THEN outreach_status
           ELSE excluded.outreach_status
         END,
         purchased_at = COALESCE(excluded.purchased_at, purchased_at),
         last_event_at = CASE WHEN excluded.last_event_at > last_event_at THEN excluded.last_event_at ELSE last_event_at END,
         updated_at = excluded.updated_at`,
    ).run(
      ownerUid,
      cartId,
      status,
      `cart_${status}`,
      eventAt,
      eventAt,
      status,
      eventAt,
      now,
      now,
    );
    return get(ownerUid, cartId);
  };

  const recordQuestion = (ownerUid: string, cartId: string, question: string, at: string) => {
    database.prepare(
      `UPDATE salla_abandoned_carts
          SET last_question = ?, last_question_at = ?, updated_at = ?
        WHERE owner_uid = ? AND cart_id = ?`,
    ).run(question.slice(0, 1000), at, at, ownerUid, cartId);
    return get(ownerUid, cartId);
  };

  const list = (ownerUid: string, limit = 100) => {
    const requestedLimit = Number(limit);
    const safeLimit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(500, Math.floor(requestedLimit)))
      : 100;
    const rows = database.prepare(
      `SELECT * FROM salla_abandoned_carts
        WHERE owner_uid = ?
        ORDER BY last_event_at DESC
        LIMIT ?`,
    ).all(ownerUid, safeLimit) as StoredCart[];
    return rows.map((value) => cartRow(value)).filter((value): value is SallaAbandonedCartRecord => Boolean(value));
  };

  return { get, upsertActive, setOutreach, markTerminal, recordQuestion, list };
}
