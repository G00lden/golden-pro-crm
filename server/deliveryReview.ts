import crypto from "node:crypto";
import db from "./db";
import { communicationJobStore } from "./communicationJobs";
import { normalizePhoneDigits, phoneTail } from "../shared/phone";
import {
  createDeliveryReviewStore,
  type DeliveryReviewRequest,
} from "./deliveryReviewStorage";

export const deliveryReviewStore = createDeliveryReviewStore(db);

const CUSTOMER_PHONE_SQL = `
  REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone, '+', ''), ' ', ''), '-', ''), '(', ''), ')', '')
`;

function boundedMinutes(value: unknown, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(minimum, Math.min(maximum, parsed))
    : fallback;
}

function delayMinutes() {
  return boundedMinutes(
    process.env.SALLA_DELIVERY_REVIEW_DELAY_MINUTES,
    120,
    0,
    7 * 24 * 60,
  );
}

function expiryMinutes() {
  return boundedMinutes(
    process.env.SALLA_DELIVERY_REVIEW_EXPIRY_MINUTES,
    7 * 24 * 60,
    60,
    30 * 24 * 60,
  );
}

export function deliveredStatusSlugs() {
  const configured = String(process.env.SALLA_DELIVERED_STATUS_SLUGS || "delivered")
    .split(/[,\s]+/)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return new Set(configured.length ? configured : ["delivered"]);
}

export function isDeliveredSallaStatus(value: unknown) {
  return deliveredStatusSlugs().has(String(value || "").trim().toLowerCase());
}

export function queueDeliveryReview(input: {
  ownerUid: string;
  orderId: string;
  orderNumber?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  deliveredAt?: string | null;
}) {
  const deliveredAt = input.deliveredAt || new Date().toISOString();
  const customerPhone = normalizePhoneDigits(input.customerPhone || "");
  const saved = deliveryReviewStore.upsertDelivered({
    ownerUid: input.ownerUid,
    orderId: String(input.orderId),
    orderNumber: String(input.orderNumber || input.orderId),
    customerName: String(input.customerName || ""),
    customerPhone,
    deliveredAt,
  });

  if (process.env.SALLA_DELIVERY_REVIEW_ENABLED === "false") {
    deliveryReviewStore.setOutreach(input.ownerUid, input.orderId, { status: "feature_disabled" });
    return { queued: false, reason: "feature_disabled", review: saved };
  }
  if (!/^\d{10,15}$/.test(customerPhone)) {
    deliveryReviewStore.setOutreach(input.ownerUid, input.orderId, { status: "invalid_phone" });
    return { queued: false, reason: "invalid_phone", review: saved };
  }
  if (saved && ["submitted", "feedback_pending", "escalated"].includes(saved.status)) {
    return { queued: false, reason: `review_${saved.status}`, review: saved };
  }

  const deliveredMs = Date.parse(deliveredAt);
  const availableAt = new Date(
    (Number.isFinite(deliveredMs) ? deliveredMs : Date.now()) + delayMinutes() * 60_000,
  ).toISOString();
  const customerName = saved?.customer_name || "عميلنا";
  const orderNumber = saved?.order_number || input.orderId;
  const job = communicationJobStore.enqueue({
    ownerUid: input.ownerUid,
    eventKey: `salla-order:${input.orderId}:delivery-review:1`,
    recipientPhone: customerPhone,
    templateName: "delivery_review_request",
    kind: "whatsapp_template",
    role: "customer",
    maxAttempts: 5,
    availableAt,
    expiresInMinutes: expiryMinutes(),
    payload: {
      purpose: "salla_delivery_review",
      orderId: input.orderId,
      orderNumber,
      customerName,
      vars: {
        customer_name: customerName,
        order_number: orderNumber,
      },
    },
  });
  const updated = deliveryReviewStore.setOutreach(input.ownerUid, input.orderId, {
    status: job.status === "sent" ? "sent" : job.status === "blocked" ? "blocked" : "queued",
    jobId: job.id,
    providerMessageId: job.provider_message_id,
    requestedAt: job.sent_at,
  });
  return {
    queued: ["pending", "retry", "processing"].includes(job.status),
    job,
    review: updated,
  };
}

function reviewTaskId(ownerUid: string, orderId: string) {
  const hash = crypto
    .createHash("sha256")
    .update(`${ownerUid}:${orderId}:delivery-review`)
    .digest("hex")
    .slice(0, 24);
  return `wa_review_${hash}`;
}

function customerId(ownerUid: string, phone: string) {
  const tail = phoneTail(phone);
  if (!tail) return null;
  const customer = db.prepare(
    `SELECT id FROM customers
      WHERE owner_uid = ? AND ${CUSTOMER_PHONE_SQL} LIKE ?
      ORDER BY updated_at DESC LIMIT 1`,
  ).get(ownerUid, `%${tail}`) as { id?: string } | undefined;
  return customer?.id || null;
}

function taskNotes(review: DeliveryReviewRequest, feedback?: string | null) {
  return [
    `رقم الطلب: ${review.order_number || review.order_id}`,
    `تقييم العميل: ${review.rating || "غير محدد"} من 5`,
    `اسم العميل: ${review.customer_name || "غير محدد"}`,
    `هاتف العميل: ${review.customer_phone}`,
    feedback ? `ملاحظة العميل: ${feedback.slice(0, 2000)}` : "بانتظار تفاصيل العميل عن سبب التقييم.",
  ].join("\n");
}

function upsertLowRatingTask(review: DeliveryReviewRequest, at: string, feedback?: string | null) {
  const taskId = reviewTaskId(review.owner_uid, review.order_id);
  db.prepare(
    `INSERT INTO crm_tasks (
       id, owner_uid, title, status, priority, due_date, assigned_to,
       related_type, related_id, customer_id, notes, created_at, updated_at
     ) VALUES (?, ?, ?, 'open', 'high', ?, NULL, 'salla_delivery_review', ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status = CASE WHEN crm_tasks.status = 'completed' THEN crm_tasks.status ELSE 'open' END,
       priority = 'high',
       notes = excluded.notes,
       updated_at = excluded.updated_at`,
  ).run(
    taskId,
    review.owner_uid,
    `متابعة تقييم منخفض للطلب ${review.order_number || review.order_id}`,
    at.slice(0, 10),
    review.order_id,
    customerId(review.owner_uid, review.customer_phone),
    taskNotes(review, feedback),
    at,
    at,
  );
  deliveryReviewStore.setEscalatedTask(review.owner_uid, review.order_id, taskId, at);
  return taskId;
}

export function recordDeliveryRating(
  ownerUid: string,
  orderId: string,
  rating: number,
  at = new Date().toISOString(),
) {
  const review = deliveryReviewStore.recordRating(ownerUid, orderId, rating, at);
  if (!review) return { review: null, taskId: null };
  const taskId = review.rating !== null && review.rating <= 3
    ? upsertLowRatingTask(review, at)
    : null;
  return {
    review: deliveryReviewStore.get(ownerUid, orderId),
    taskId,
  };
}

export function recordDeliveryFeedback(
  ownerUid: string,
  orderId: string,
  feedback: string,
  at = new Date().toISOString(),
) {
  const current = deliveryReviewStore.get(ownerUid, orderId);
  if (!current) return { review: null, taskId: null };
  const taskId = upsertLowRatingTask(current, at, feedback);
  return {
    review: deliveryReviewStore.recordFeedback(ownerUid, orderId, feedback, taskId, at),
    taskId,
  };
}
