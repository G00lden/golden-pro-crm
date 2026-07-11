import assert from "node:assert/strict";
import test from "node:test";
import {
  bookingCreateSchema,
  customerCreateSchema,
  quoteCreateSchema,
  settingsUpdateSchema,
} from "./crmValidation";

test("customer input strips unknown privilege fields", () => {
  const parsed = customerCreateSchema.parse({ name: "A", phone: "0500000000", role: "admin" });
  assert.deepEqual(parsed, { name: "A", phone: "0500000000" });
});

test("invalid booking dates and times are rejected", () => {
  const result = bookingCreateSchema.safeParse({
    customer_id: "c1", customer_name: "A", product_id: "p1", product_name: "P",
    technician_id: "t1", tech_name: "T", date: "31/01/2026", scheduled_time: "29:90",
  });
  assert.equal(result.success, false);
  assert.equal(bookingCreateSchema.safeParse({
    customer_id: "c1", customer_name: "A", product_id: "p1", product_name: "P",
    technician_id: "t1", tech_name: "T", date: "2026-02-30", scheduled_time: "10:30",
  }).success, false);
});

test("quote bounds reject negative money and too many installments", () => {
  const base = { customer_name: "A", items: [{ description: "X", quantity: 1, unit_price: 100 }] };
  assert.equal(quoteCreateSchema.safeParse({ ...base, discount_value: -1 }).success, false);
  assert.equal(quoteCreateSchema.safeParse({ ...base, discount_mode: "percent", discount_value: 101 }).success, false);
  assert.equal(quoteCreateSchema.safeParse({
    ...base,
    installments: Array.from({ length: 7 }, () => ({ percent: 100 / 7, label: "x" })),
  }).success, false);
});

test("settings reject empty and out-of-range updates", () => {
  assert.equal(settingsUpdateSchema.safeParse({}).success, false);
  assert.equal(settingsUpdateSchema.safeParse({ response_rate: 101 }).success, false);
  assert.equal(settingsUpdateSchema.safeParse({ response_rate: 75 }).success, true);
});
