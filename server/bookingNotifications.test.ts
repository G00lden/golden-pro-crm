import assert from "node:assert/strict";
import test from "node:test";
import { buildTechnicianBookingMessage } from "./bookingNotifications";

test("technician WhatsApp assignment includes the customer address and map link", () => {
  const message = buildTechnicianBookingMessage({
    id: "booking-1",
    customer_id: "customer-1",
    customer_name: "عميل الاختبار",
    customer_phone: "0500000000",
    customer_address: "الرياض، حي الاختبار",
    customer_latitude: 24.7136,
    customer_longitude: 46.6753,
    product_id: "product-1",
    product_name: "جهاز اختبار",
    technician_id: "tech-1",
    tech_name: "يعقوب",
    date: "2026-07-28",
    scheduled_time: "10:00",
    status: "confirmed",
    createdBy: "owner-1",
  }, {
    id: "tech-1",
    name: "يعقوب",
    phone: "0511111111",
    createdBy: "owner-1",
  }, "created");

  assert.match(message, /الرياض، حي الاختبار/);
  assert.match(message, /google\.com\/maps\/search/);
  assert.match(message, /24\.7136/);
  assert.match(message, /يعقوب/);
});
