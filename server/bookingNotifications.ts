import { adminDb } from "./firebaseAdmin";
import { isDryRunSendResult } from "./outboundSafety";
import { whatsappService } from "./whatsapp";
import { logError } from "./logger";

type Booking = {
  id: string;
  installation_id?: string;
  customer_id: string;
  customer_name: string;
  customer_phone?: string;
  product_id: string;
  product_name: string;
  technician_id: string;
  tech_name: string;
  date: string;
  scheduled_time: string;
  status: "confirmed" | "completed" | "cancelled";
  booking_type?: "installation" | "maintenance" | "external_maintenance";
  store_order_number?: string;
  createdBy: string;
};

type Technician = {
  id: string;
  name: string;
  phone: string;
  specialty?: string;
  createdBy: string;
};

function httpError(status: number, message: string) {
  const err = new Error(message) as Error & { status?: number };
  err.status = status;
  return err;
}

function statusText(status: string) {
  if (status === "confirmed") return "مؤكد";
  if (status === "completed") return "مكتمل";
  if (status === "cancelled") return "ملغي";
  return status;
}

function triggerText(trigger?: string) {
  if (trigger === "created") return "تم تأكيد موعد جديد";
  if (trigger === "updated") return "تم تعديل موعد مؤكد";
  return "تنبيه موعد مؤكد";
}

const COMPANY_NAME = process.env.COMPANY_NAME || "BreeXe Pro";

export function buildTechnicianBookingMessage(booking: Booking, technician: Technician, trigger?: string) {
  if (trigger === "pre_alert") {
    return [
      `🔔 تذكير قبل الموعد`,
      "",
      `عزيزي الفني ${technician.name}،`,
      `موعدك بعد قليل:`,
      `- العميل: ${booking.customer_name}`,
      `- الهاتف: ${booking.customer_phone || "-"}`,
      `- المنتج: ${booking.product_name}`,
      `- الوقت: ${booking.scheduled_time}`,
      `يرجى الالتزام بالموعد.`,
      `${COMPANY_NAME}`,
    ].filter(Boolean).join("\n");
  }
  return [
    `${COMPANY_NAME} - ${triggerText(trigger)}`,
    "",
    `عزيزي الفني ${technician.name}،`,
    `تم تعيينك لموعد صيانة:`,
    `- العميل: ${booking.customer_name}`,
    `- المنتج: ${booking.product_name}`,
    `- الهاتف: ${booking.customer_phone || "-"}`,
    booking.store_order_number ? `- رقم طلب المتجر: ${booking.store_order_number}` : null,
    booking.booking_type ? `- نوع المهمة: ${booking.booking_type}` : null,
    `- التاريخ: ${booking.date}`,
    `- الوقت: ${booking.scheduled_time}`,
    `- الحالة: ${statusText(booking.status)}`,
    "",
    `يرجى تأكيد الاستلام بالرد بـ "تم".`,
  ].filter(Boolean).join("\n");
}

export async function notifyTechnicianForBooking(
  bookingId: string,
  uid: string,
  trigger?: string,
  outboundCode?: string,
) {
  const bookingRef = adminDb.collection("bookings").doc(bookingId);
  const bookingSnap = await bookingRef.get();
  if (!bookingSnap.exists) throw httpError(404, "الحجز غير موجود.");

  const booking = { id: bookingSnap.id, ...bookingSnap.data() } as Booking;
  if (booking.createdBy !== uid) throw httpError(403, "لا تملك صلاحية هذا الحجز.");
  if (booking.status !== "confirmed") throw httpError(400, "إشعار الفني يرسل للحجوزات المؤكدة فقط.");
  if (!booking.technician_id) throw httpError(422, "الحجز لا يحتوي فني.");

  const technicianRef = adminDb.collection("technicians").doc(booking.technician_id);
  const technicianSnap = await technicianRef.get();
  if (!technicianSnap.exists) throw httpError(404, "الفني غير موجود.");

  const technician = { id: technicianSnap.id, ...technicianSnap.data() } as Technician;
  if (technician.createdBy !== uid) throw httpError(403, "لا تملك صلاحية هذا الفني.");
  if (!technician.phone) throw httpError(422, "رقم جوال الفني غير موجود.");

  const message = buildTechnicianBookingMessage(booking, technician, trigger);
  const now = new Date().toISOString();

  try {
    const result = await whatsappService.sendText(technician.phone, message, {
      confirmationCode: outboundCode,
    });
    const provider = "provider" in result ? result.provider : whatsappService.getStatus().provider;
    const dryRun = isDryRunSendResult(result);
    await adminDb.collection("technician_notifications").add({
      booking_id: booking.id,
      technician_id: technician.id,
      technician_name: technician.name,
      technician_phone: technician.phone,
      customer_id: booking.customer_id,
      customer_name: booking.customer_name,
      customer_phone: booking.customer_phone || "",
      product_id: booking.product_id,
      product_name: booking.product_name,
      message,
      trigger: trigger || "manual",
      status: dryRun ? "dry_run" : "sent",
      sent_at: now,
      error: dryRun ? result.reason : null,
      whatsapp_jid: result.jid,
      whatsapp_message_id: result.messageId || null,
      whatsapp_provider: provider,
      createdBy: uid,
    });

    return {
      success: !dryRun,
      dry_run: dryRun,
      technician_id: technician.id,
      technician_phone: technician.phone,
      message_id: result.messageId || null,
      provider,
      reason: dryRun ? result.reason : undefined,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await adminDb.collection("technician_notifications").add({
      booking_id: booking.id,
      technician_id: technician.id,
      technician_name: technician.name,
      technician_phone: technician.phone,
      customer_id: booking.customer_id,
      customer_name: booking.customer_name,
      customer_phone: booking.customer_phone || "",
      product_id: booking.product_id,
      product_name: booking.product_name,
      message,
      trigger: trigger || "manual",
      status: "failed",
      sent_at: now,
      error: errorMessage,
      whatsapp_provider: whatsappService.getStatus().provider,
      createdBy: uid,
    });
    throw error;
  }
}

/**
 * Sends a 1-hour-before reminder to the assigned technician for every booking
 * whose date+scheduled_time falls inside the upcoming TECH_PREALERT_MINUTES
 * window and which has not been pre-alerted yet. Idempotent: writes
 * `technician_reminded_at` on the booking so the same row is never alerted
 * twice within the window.
 */
export async function sendTechnicianPreAlerts() {
  const dbMod = (await import("./db")).default;
  const windowMinutes = Number(process.env.TECH_PREALERT_MINUTES || 60);
  const now = new Date();
  const upperBound = new Date(now.getTime() + windowMinutes * 60_000);
  const todayStr = now.toISOString().slice(0, 10);
  const tomorrowStr = upperBound.toISOString().slice(0, 10);

  const rows = dbMod
    .prepare(
      `SELECT * FROM bookings
       WHERE status = 'confirmed'
         AND date IN (?, ?)
         AND technician_id IS NOT NULL
         AND (technician_reminded_at IS NULL OR technician_reminded_at = '')`,
    )
    .all(todayStr, tomorrowStr) as Array<Record<string, unknown>>;

  const dispatched: Array<{ booking_id: string; technician_id: string; due_at: string }> = [];
  let simulated = 0;

  for (const row of rows) {
    const date = String(row.date || "");
    const time = String(row.scheduled_time || "00:00");
    const due = new Date(`${date}T${time.length === 5 ? time + ":00" : time}+03:00`);
    if (!Number.isFinite(due.getTime())) continue;
    if (due.getTime() < now.getTime()) continue; // already past
    if (due.getTime() > upperBound.getTime()) continue; // outside the window

    try {
      const result = await notifyTechnicianForBooking(
        String(row.id),
        String(row.owner_uid || row.createdBy || "local-dev-owner"),
        "pre_alert",
      );
      if (result.dry_run) {
        simulated += 1;
        continue;
      }
      if (!result.success) continue;
      dbMod.prepare("UPDATE bookings SET technician_reminded_at = ?, updated_at = ? WHERE id = ?").run(
        new Date().toISOString(),
        new Date().toISOString(),
        row.id,
      );
      dispatched.push({ booking_id: String(row.id), technician_id: String(row.technician_id), due_at: due.toISOString() });
    } catch (error) {
      logError("technician.prealert_dispatch_failed", error, {
        bookingId: row.id,
        technicianId: row.technician_id,
      });
    }
  }

  return { checked: rows.length, dispatched: dispatched.length, simulated, items: dispatched };
}
