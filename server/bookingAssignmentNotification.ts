import crypto from "node:crypto";
import db from "./db";
import {
  communicationJobStore,
  type CommunicationJob,
} from "./communicationJobs";
import { normalizePhoneDigits } from "../shared/phone";
import { renderTemplate, type RenderVars } from "./whatsappTemplates";

export type BookingAssignmentInput = {
  ownerUid: string;
  bookingId: string;
  technicianId: string;
  technicianName: string;
  technicianPhone: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
  customerAddress: string;
  productId: string;
  productName: string;
  date: string;
  scheduledTime: string;
  createdAt: string;
};

function notificationId(ownerUid: string, bookingId: string) {
  const hash = crypto
    .createHash("sha256")
    .update(`${ownerUid}:${bookingId}:technician-assignment`)
    .digest("hex")
    .slice(0, 24);
  return `tech_booking_${hash}`;
}

function upsertNotification(
  input: BookingAssignmentInput,
  id: string,
  status: string,
  message: string,
  error?: string | null,
  messageId?: string | null,
  provider?: string | null,
) {
  const sentAt = status === "sent" ? new Date().toISOString() : null;
  db.prepare(
    `INSERT INTO technician_notifications (
       id, owner_uid, technician_id, technician_name, technician_phone,
       booking_id, notification_type, channel, status, sent_at, error,
       customer_id, customer_name, customer_phone, product_id, product_name,
       message, trigger, whatsapp_message_id, whatsapp_provider, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'booking_assigned', 'whatsapp', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'whatsapp_self_service', ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status = CASE
         WHEN technician_notifications.status = 'sent' THEN 'sent'
         ELSE excluded.status
       END,
       sent_at = COALESCE(technician_notifications.sent_at, excluded.sent_at),
       error = CASE
         WHEN technician_notifications.status = 'sent' THEN technician_notifications.error
         ELSE excluded.error
       END,
       whatsapp_message_id = COALESCE(technician_notifications.whatsapp_message_id, excluded.whatsapp_message_id),
       whatsapp_provider = COALESCE(excluded.whatsapp_provider, technician_notifications.whatsapp_provider)`,
  ).run(
    id,
    input.ownerUid,
    input.technicianId,
    input.technicianName,
    input.technicianPhone,
    input.bookingId,
    status,
    sentAt,
    error || null,
    input.customerId,
    input.customerName,
    input.customerPhone,
    input.productId,
    input.productName,
    message,
    messageId || null,
    provider || null,
    input.createdAt,
  );
}

function createMissingPhoneTask(input: BookingAssignmentInput, id: string) {
  db.prepare(
    `INSERT OR IGNORE INTO crm_tasks (
       id, owner_uid, title, status, priority, due_date, assigned_to,
       related_type, related_id, customer_id, notes, created_at, updated_at
     ) VALUES (?, ?, ?, 'open', 'high', ?, NULL, 'booking_notification', ?, ?, ?, ?, ?)`,
  ).run(
    `task_${id}`,
    input.ownerUid,
    `تعذر إشعار المندوب بالحجز ${input.bookingId}`,
    input.createdAt.slice(0, 10),
    input.bookingId,
    input.customerId,
    [
      `المندوب: ${input.technicianName}`,
      "السبب: رقم جوال المندوب غير صالح أو غير موجود.",
      `العميل: ${input.customerName} - ${input.customerPhone}`,
      `الموعد: ${input.date} ${input.scheduledTime}`,
    ].join("\n"),
    input.createdAt,
    input.createdAt,
  );
}

function assignmentVars(input: BookingAssignmentInput): RenderVars {
  return {
    technician_name: input.technicianName,
    customer_name: input.customerName,
    customer_phone: input.customerPhone,
    product_name: input.productName,
    customer_address: input.customerAddress,
    maintenance_date: input.date,
    scheduled_time: input.scheduledTime,
    booking_id: input.bookingId,
  };
}

export function queueBookingAssignmentNotification(input: BookingAssignmentInput) {
  const id = notificationId(input.ownerUid, input.bookingId);
  const technicianPhone = normalizePhoneDigits(input.technicianPhone);
  const normalized = {
    ...input,
    technicianPhone,
    customerPhone: normalizePhoneDigits(input.customerPhone),
  };
  const vars = assignmentVars(normalized);
  const message = renderTemplate("technician_assigned", vars);

  if (process.env.WHATSAPP_BOOKING_TECHNICIAN_NOTIFY_ENABLED === "false") {
    upsertNotification(normalized, id, "feature_disabled", message, "feature_disabled");
    return { queued: false, reason: "feature_disabled", notificationId: id };
  }
  if (!/^\d{10,15}$/.test(technicianPhone)) {
    upsertNotification(normalized, id, "invalid_phone", message, "invalid_technician_phone");
    createMissingPhoneTask(normalized, id);
    return { queued: false, reason: "invalid_technician_phone", notificationId: id };
  }

  const job = communicationJobStore.enqueue({
    ownerUid: input.ownerUid,
    eventKey: `booking:${input.bookingId}:technician-assignment:1`,
    recipientPhone: technicianPhone,
    templateName: "technician_assigned",
    kind: "whatsapp_template",
    role: "agent",
    maxAttempts: 5,
    expiresInMinutes: 24 * 60,
    payload: {
      purpose: "whatsapp_booking_technician_assignment",
      bookingId: input.bookingId,
      technicianNotificationId: id,
      vars,
    },
  });
  upsertNotification(
    normalized,
    id,
    job.status === "sent" ? "sent" : job.status === "blocked" ? "blocked" : "queued",
    message,
    job.last_error,
    job.provider_message_id,
  );
  return {
    queued: ["pending", "retry", "processing"].includes(job.status),
    notificationId: id,
    job,
  };
}

export function bookingAssignmentNotificationId(job: CommunicationJob) {
  return job.payload.purpose === "whatsapp_booking_technician_assignment"
    ? String(job.payload.technicianNotificationId || "").trim()
    : "";
}

export function updateBookingAssignmentNotification(
  job: CommunicationJob,
  status: string,
  input: {
    error?: string | null;
    providerMessageId?: string | null;
    provider?: string | null;
  } = {},
) {
  const id = bookingAssignmentNotificationId(job);
  if (!id) return;
  db.prepare(
    `UPDATE technician_notifications SET
       status = CASE WHEN status = 'sent' THEN 'sent' ELSE ? END,
       sent_at = CASE WHEN ? = 'sent' THEN COALESCE(sent_at, ?) ELSE sent_at END,
       error = CASE WHEN status = 'sent' THEN error ELSE ? END,
       whatsapp_message_id = COALESCE(?, whatsapp_message_id),
       whatsapp_provider = COALESCE(?, whatsapp_provider)
     WHERE id = ? AND owner_uid = ? AND booking_id = ?`,
  ).run(
    status,
    status,
    status === "sent" ? new Date().toISOString() : null,
    input.error || null,
    input.providerMessageId || null,
    input.provider || null,
    id,
    job.owner_uid,
    String(job.payload.bookingId || ""),
  );
}
