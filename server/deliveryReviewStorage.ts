import type Database from "better-sqlite3";

export const DELIVERY_REVIEW_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS delivery_review_requests (
    owner_uid TEXT NOT NULL,
    order_id TEXT NOT NULL,
    order_number TEXT NOT NULL DEFAULT '',
    customer_name TEXT NOT NULL DEFAULT '',
    customer_phone TEXT NOT NULL DEFAULT '',
    delivered_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'not_queued',
    communication_job_id TEXT,
    provider_message_id TEXT,
    requested_at TEXT,
    rating INTEGER,
    feedback TEXT,
    submitted_at TEXT,
    escalated_task_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (owner_uid, order_id)
  );
  CREATE INDEX IF NOT EXISTS idx_delivery_review_requests_owner_status
    ON delivery_review_requests(owner_uid, status, delivered_at DESC);
  CREATE INDEX IF NOT EXISTS idx_delivery_review_requests_phone
    ON delivery_review_requests(owner_uid, customer_phone, updated_at DESC);
`;

export type DeliveryReviewRequest = {
  owner_uid: string;
  order_id: string;
  order_number: string;
  customer_name: string;
  customer_phone: string;
  delivered_at: string;
  status: string;
  communication_job_id: string | null;
  provider_message_id: string | null;
  requested_at: string | null;
  rating: number | null;
  feedback: string | null;
  submitted_at: string | null;
  escalated_task_id: string | null;
  created_at: string;
  updated_at: string;
};

type ReviewDatabase = Pick<Database.Database, "prepare">;

function row(value: DeliveryReviewRequest | undefined): DeliveryReviewRequest | null {
  if (!value) return null;
  return {
    ...value,
    rating: value.rating === null ? null : Number(value.rating),
  };
}

export function createDeliveryReviewStore(database: ReviewDatabase) {
  const get = (ownerUid: string, orderId: string) => row(database.prepare(
    `SELECT * FROM delivery_review_requests
      WHERE owner_uid = ? AND order_id = ? LIMIT 1`,
  ).get(ownerUid, orderId) as DeliveryReviewRequest | undefined);

  const upsertDelivered = (input: {
    ownerUid: string;
    orderId: string;
    orderNumber: string;
    customerName: string;
    customerPhone: string;
    deliveredAt: string;
  }) => {
    const now = new Date().toISOString();
    database.prepare(
      `INSERT INTO delivery_review_requests (
         owner_uid, order_id, order_number, customer_name, customer_phone,
         delivered_at, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'not_queued', ?, ?)
       ON CONFLICT(owner_uid, order_id) DO UPDATE SET
         order_number = CASE WHEN excluded.order_number <> '' THEN excluded.order_number ELSE order_number END,
         customer_name = CASE WHEN excluded.customer_name <> '' THEN excluded.customer_name ELSE customer_name END,
         customer_phone = CASE WHEN excluded.customer_phone <> '' THEN excluded.customer_phone ELSE customer_phone END,
         delivered_at = CASE WHEN excluded.delivered_at < delivered_at THEN excluded.delivered_at ELSE delivered_at END,
         updated_at = excluded.updated_at`,
    ).run(
      input.ownerUid,
      input.orderId,
      input.orderNumber,
      input.customerName,
      input.customerPhone,
      input.deliveredAt,
      now,
      now,
    );
    return get(input.ownerUid, input.orderId);
  };

  const setOutreach = (
    ownerUid: string,
    orderId: string,
    input: {
      status: string;
      jobId?: string | null;
      providerMessageId?: string | null;
      requestedAt?: string | null;
    },
  ) => {
    const now = new Date().toISOString();
    database.prepare(
      `UPDATE delivery_review_requests SET
         status = ?,
         communication_job_id = COALESCE(?, communication_job_id),
         provider_message_id = COALESCE(?, provider_message_id),
         requested_at = COALESCE(?, requested_at),
         updated_at = ?
       WHERE owner_uid = ? AND order_id = ?`,
    ).run(
      input.status,
      input.jobId || null,
      input.providerMessageId || null,
      input.requestedAt || null,
      now,
      ownerUid,
      orderId,
    );
    return get(ownerUid, orderId);
  };

  const recordRating = (
    ownerUid: string,
    orderId: string,
    rating: number,
    at: string,
  ) => {
    const safeRating = Math.max(1, Math.min(5, Math.trunc(rating)));
    database.prepare(
      `UPDATE delivery_review_requests SET
         rating = ?,
         status = ?,
         submitted_at = ?,
         updated_at = ?
       WHERE owner_uid = ? AND order_id = ?`,
    ).run(
      safeRating,
      safeRating <= 3 ? "feedback_pending" : "submitted",
      at,
      at,
      ownerUid,
      orderId,
    );
    return get(ownerUid, orderId);
  };

  const recordFeedback = (
    ownerUid: string,
    orderId: string,
    feedback: string,
    taskId: string,
    at: string,
  ) => {
    database.prepare(
      `UPDATE delivery_review_requests SET
         feedback = ?,
         status = 'escalated',
         escalated_task_id = ?,
         submitted_at = COALESCE(submitted_at, ?),
         updated_at = ?
       WHERE owner_uid = ? AND order_id = ?`,
    ).run(
      feedback.slice(0, 2000),
      taskId,
      at,
      at,
      ownerUid,
      orderId,
    );
    return get(ownerUid, orderId);
  };

  const setEscalatedTask = (
    ownerUid: string,
    orderId: string,
    taskId: string,
    at: string,
  ) => {
    database.prepare(
      `UPDATE delivery_review_requests SET
         escalated_task_id = ?,
         updated_at = ?
       WHERE owner_uid = ? AND order_id = ?`,
    ).run(taskId, at, ownerUid, orderId);
    return get(ownerUid, orderId);
  };

  const list = (ownerUid: string, limit = 100) => {
    const requestedLimit = Number(limit);
    const safeLimit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(500, Math.floor(requestedLimit)))
      : 100;
    return (database.prepare(
      `SELECT * FROM delivery_review_requests
        WHERE owner_uid = ?
        ORDER BY delivered_at DESC
        LIMIT ?`,
    ).all(ownerUid, safeLimit) as DeliveryReviewRequest[]).map((value) => row(value)!);
  };

  return {
    get,
    upsertDelivered,
    setOutreach,
    recordRating,
    recordFeedback,
    setEscalatedTask,
    list,
  };
}
