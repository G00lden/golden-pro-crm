import assert from "node:assert/strict";
import test from "node:test";
import {
  filterStoreOrderRecords,
  paginateStoreOrderRecords,
  parseStoreOrderListQuery,
} from "./storeOrderPagination";
import type { OwnedRecord } from "./repositories/ownedRepository";

function order(index: number): OwnedRecord {
  return {
    id: `store-${index}`,
    createdBy: "owner-a",
    order_id: String(1_000_000 + index),
    order_number: `ORD-${String(index).padStart(5, "0")}`,
    customer_name: `عميل ${index}`,
    customer_phone: `050${String(index).padStart(7, "0")}`,
    customer_city: index === 2_617 ? "مدينة الطلب الأخير" : "الرياض",
    status: index % 2 ? "in_progress" : "completed",
    remote_status_slug: index % 2 ? "in_progress" : "completed",
    journey_status: index % 3 ? "received" : "needs_review",
    order_types: [index % 3 ? "sale_only" : "needs_review"],
    items: [{ name: index === 2_617 ? "منتج خاص" : "منتج", sku: `SKU-${index}`, order_type: "sale_only" }],
  };
}

test("store order query parsing clamps unsafe values", () => {
  assert.deepEqual(parseStoreOrderListQuery({
    search: "  ORD  ",
    type: "sale_only",
    journey: "received",
    status: "completed",
    page: "-9",
    page_size: "500",
  }), {
    search: "ORD",
    type: "sale_only",
    journey: "received",
    status: "completed",
    city: "",
    product: "",
    minTotal: null,
    maxTotal: null,
    page: 1,
    pageSize: 100,
  });
});

test("advanced city, product, and total filters remain available server-side", () => {
  const first = order(1);
  first.customer_city = "جدة";
  first.total = 250;
  first.items = [{ name: "فلتر ماء", sku: "FILTER-1", quantity: 1 }];
  const second = order(2);
  second.customer_city = "الرياض";
  second.total = 50;
  const query = parseStoreOrderListQuery({ city: "جدة", product: "FILTER", min_total: "200", max_total: "300" });
  assert.deepEqual(filterStoreOrderRecords([first, second], query).map((row) => row.id), [first.id]);

  const itemPriced = order(3);
  itemPriced.total = null;
  itemPriced.items = [{ name: "بدون إجمالي مباشر", sku: "UNIT-1", quantity: 3, unit_price: 90, total_price: null }];
  assert.equal(filterStoreOrderRecords(
    [itemPriced],
    parseStoreOrderListQuery({ min_total: "270", max_total: "270" }),
  ).length, 1);
});

test("store order search covers all remote and item fields before pagination", () => {
  const rows = Array.from({ length: 2_618 }, (_, index) => order(index));
  const query = parseStoreOrderListQuery({ search: "مدينة الطلب الأخير", page: 1 });
  const matches = filterStoreOrderRecords(rows, query);
  const page = paginateStoreOrderRecords(matches, query);
  assert.equal(matches.length, 1);
  assert.equal(page.total, 1);
  assert.equal(page.data[0]?.id, "store-2617");

  const itemMatches = filterStoreOrderRecords(rows, parseStoreOrderListQuery({ search: "منتج خاص" }));
  assert.equal(itemMatches.length, 1);
});

test("store order filters combine type, journey, and remote status", () => {
  const rows = Array.from({ length: 30 }, (_, index) => order(index));
  const query = parseStoreOrderListQuery({
    type: "needs_review",
    journey: "needs_review",
    status: "completed",
  });
  const matches = filterStoreOrderRecords(rows, query);
  assert.ok(matches.length > 0);
  assert.ok(matches.every((row) => row.journey_status === "needs_review"));
  assert.ok(matches.every((row) => row.remote_status_slug === "completed"));
});

test("journey filters also match an item workflow state", () => {
  const row = order(5);
  row.journey_status = "received";
  row.items = [{ ...row.items[0], status: "awaiting_schedule" }];
  const matches = filterStoreOrderRecords([row], parseStoreOrderListQuery({ journey: "awaiting_schedule" }));
  assert.equal(matches.length, 1);
});

test("store order pagination reports the real total and navigation", () => {
  const rows = Array.from({ length: 2_618 }, (_, index) => order(index));
  const page = paginateStoreOrderRecords(rows, { page: 53, pageSize: 50 });
  assert.equal(page.total, 2_618);
  assert.equal(page.page, 53);
  assert.equal(page.totalPages, 53);
  assert.equal(page.data.length, 18);
  assert.equal(page.hasPrevious, true);
  assert.equal(page.hasNext, false);
  assert.equal(page.capped, false);
});

test("store order pagination signals the 10k safety cap", () => {
  const rows = Array.from({ length: 10_001 }, (_, index) => order(index));
  const page = paginateStoreOrderRecords(rows, { page: 1, pageSize: 50 });
  assert.equal(page.total, 10_001);
  assert.equal(page.capped, true);
  assert.match(page.warning || "", /10000/);
});
