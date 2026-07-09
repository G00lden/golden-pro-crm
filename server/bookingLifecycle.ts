import { adminDb } from "./firebaseAdmin";

function httpError(status: number, message: string) {
  const err = new Error(message) as Error & { status?: number };
  err.status = status;
  return err;
}

function addMonths(date: string, months: number) {
  // Security (L4): reject malformed dates before arithmetic so an invalid
  // webhook/user value cannot produce an Invalid Date and a leaked 500.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) {
    date = new Date().toISOString().slice(0, 10);
  }
  const [year, month, day] = date.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCMonth(d.getUTCMonth() + months);
  // setUTCMonth overflows month-end dates (Jan 31 + 1 month => Mar 3, not Feb 28).
  // Clamp back to the intended month's last day when the day rolled over.
  if (d.getUTCDate() !== day) {
    d.setUTCDate(0);
  }
  return d.toISOString().slice(0, 10);
}

async function productIntervalMonths(productId: string | undefined, uid: string) {
  const fallback = Number(process.env.STORE_WEBHOOK_DEFAULT_MAINTENANCE_MONTHS || 3);
  if (!productId) return Number.isFinite(fallback) && fallback > 0 ? fallback : 3;
  const product = await adminDb.collection("products").doc(productId).get();
  // Security (H5): only trust a product the caller actually owns. A booking
  // could reference another tenant's product id; never read its interval.
  if (!product.exists || product.data()?.createdBy !== uid) {
    return Number.isFinite(fallback) && fallback > 0 ? fallback : 3;
  }
  const months = Number(product.data()?.interval_months || fallback);
  return Number.isFinite(months) && months > 0 ? months : 3;
}

export async function completeBooking(bookingId: string, uid: string) {
  const bookingRef = adminDb.collection("bookings").doc(bookingId);
  const bookingDoc = await bookingRef.get();
  if (!bookingDoc.exists) throw httpError(404, "Booking was not found.");

  const booking = bookingDoc.data() || {};
  if (booking.createdBy !== uid) throw httpError(403, "You do not own this booking.");

  const now = new Date().toISOString();
  const bookingDate = booking.date || now.slice(0, 10);
  const bookingType =
    booking.booking_type === "installation"
      ? "installation"
      : booking.booking_type === "external_maintenance"
        ? "external_maintenance"
        : "maintenance";

  const updates: Record<string, unknown> = {
    status: "completed",
    completed_at: now,
    updatedAt: now,
  };

  if (booking.installation_id) {
    const installationRef = adminDb.collection("installations").doc(String(booking.installation_id));
    const installationDoc = await installationRef.get();
    if (!installationDoc.exists) throw httpError(404, "Linked installation was not found.");

    const installation = installationDoc.data() || {};
    if (installation.createdBy !== uid) throw httpError(403, "You do not own the linked installation.");

    const months = await productIntervalMonths(booking.product_id || installation.product_id, uid);
    const nextMaintenance = addMonths(bookingDate, months);
    await installationRef.set({
      status: "active",
      install_date: bookingType === "installation" || bookingType === "external_maintenance"
        ? bookingDate
        : installation.install_date || bookingDate,
      next_maintenance: nextMaintenance,
      remind_count: 0,
      next_remind_type: "first",
      completed_date: null,
      last_remind_at: null,
      last_remind_attempt_at: null,
      updatedAt: now,
    }, { merge: true });
  }

  await bookingRef.set(updates, { merge: true });

  if (booking.store_order_id) {
    const orderRef = adminDb.collection("store_orders").doc(String(booking.store_order_id));
    const orderDoc = await orderRef.get();
    if (orderDoc.exists && orderDoc.data()?.createdBy === uid) {
      const order = orderDoc.data() || {};
      const items = Array.isArray(order.items)
        ? order.items.map((item: any) =>
            item.booking_id === bookingId ||
            (booking.installation_id != null && item.installation_id === booking.installation_id)
              ? { ...item, status: "completed", completed_at: now }
              : item,
          )
        : [];

      await orderRef.set({
        journey_status: "completed",
        current_step: "completed",
        items,
        last_event_at: now,
        updatedAt: now,
      }, { merge: true });
    }
  }

  return {
    success: true,
    booking_id: bookingId,
    installation_id: booking.installation_id || null,
    booking_type: bookingType,
    completed_at: now,
  };
}
