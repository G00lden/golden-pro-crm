import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSallaOrderUpdatePermitted,
  assertSallaOrderWriteScope,
  normalizeSallaStatusCommand,
  normalizeSallaStatuses,
  sanitizeSallaOrderUpdate,
  sallaOrderPayloadHash,
} from "./sallaOrderControl";

const statuses = normalizeSallaStatuses({ data: [
  { id: 10, name: "قيد التنفيذ", slug: "in_progress", is_active: true, sort: 2 },
  { id: 20, name: "تم", slug: "completed", is_active: true, sort: 3 },
  { id: 30, name: "قديم", slug: "inactive", is_active: false, sort: 4 },
  { id: 40, name: "حالة مخصصة", slug: "custom-child", type: "custom", original: "in_progress", parent: { id: 10 }, message: "رسالة", is_active: true, sort: 5 },
] });

test("status commands accept only a live status advertised by the store", () => {
  assert.deepEqual(normalizeSallaStatusCommand({ slug: "completed" }, statuses), {
    request: { slug: "completed" },
    desired: statuses[1],
  });
  assert.throws(() => normalizeSallaStatusCommand({ slug: "missing" }, statuses), /not available/);
  assert.throws(() => normalizeSallaStatusCommand({ slug: "inactive" }, statuses), /inactive/);
  assert.throws(() => normalizeSallaStatusCommand({ slug: "completed", status_id: 20 }, statuses), /exactly one/);
  assert.deepEqual(normalizeSallaStatusCommand({ status_id: 40 }, statuses), {
    request: { status_id: 40 },
    desired: statuses[3],
  });
  assert.equal(statuses[3].original, "in_progress");
  assert.equal(statuses[3].parent, "10");
  assert.equal(statuses[3].message, "رسالة");
});

test("order writes require the read-write scope", () => {
  assert.doesNotThrow(() => assertSallaOrderWriteScope("offline_access orders.read_write"));
  assert.throws(() => assertSallaOrderWriteScope("orders.read"), /orders\.read_write/);
});

test("order edit payloads reject unknown fields and incomplete national addresses", () => {
  assert.deepEqual(sanitizeSallaOrderUpdate({ receiver: { name: "مستلم", phone: "966500000000", notify: false } }), {
    receiver: { name: "مستلم", phone: "966500000000", notify: false },
  });
  assert.throws(() => sanitizeSallaOrderUpdate({ total: 1 }), /Unsupported/);
  assert.throws(() => sanitizeSallaOrderUpdate({ ship_to: { city: 1 } }), /mandatory National Address/);
  assert.throws(() => sanitizeSallaOrderUpdate({ ship_to: {
    country: 1,
    city: 2,
    address_line: "x",
    street_number: "1",
    block: "A",
    short_address: "ABCD1234",
    building_number: "10",
    additional_number: "20",
    postal_code: "12345",
    geo_coordinates: { lat: 200, lng: 46 },
  } }), /lat and lng/);
  assert.throws(() => sanitizeSallaOrderUpdate({ receiver: { notify: "yes" } }), /must be a boolean/);
  assert.throws(() => sanitizeSallaOrderUpdate({ receiver: { email: "not-an-email" } }), /email is invalid/);
  assert.throws(() => sanitizeSallaOrderUpdate({ coupon_code: 123 }), /non-empty string/);
  assert.throws(() => normalizeSallaStatusCommand({ slug: "completed", restore_items: "yes" }, statuses), /must be a boolean/);
});

test("completed and paid orders reject fields Salla cannot edit", () => {
  assert.throws(
    () => assertSallaOrderUpdatePermitted({ status: { slug: "completed" } }, { receiver: { name: "x" } }),
    /after an order is completed/,
  );
  assert.throws(
    () => assertSallaOrderUpdatePermitted({ payment: { status: "paid" } }, { payment: { status: "pending" } }),
    /payment is pending/,
  );
});

test("command hashes are stable across object key order", () => {
  assert.equal(sallaOrderPayloadHash({ slug: "completed", restore_items: false }), sallaOrderPayloadHash({
    restore_items: false,
    slug: "completed",
  }));
});
