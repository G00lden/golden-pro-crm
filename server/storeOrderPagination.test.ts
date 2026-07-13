import assert from "node:assert/strict";
import test from "node:test";
import {
  buildStoreOrderFacets,
  filterStoreOrderRecords,
  paginateStoreOrderRecords,
  parseStoreOrderListQuery,
  sortStoreOrderRecords,
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
    order_created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index % 60)).toISOString(),
    order_date: "2026-01-01",
    remote_updated_at: new Date(Date.UTC(2026, 0, 2, 0, 0, index % 60)).toISOString(),
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
    dateFrom: "",
    dateTo: "",
    paymentMethod: "",
    shippingCompany: "",
    shipmentStatus: "",
    country: "",
    salesChannel: "",
    assignedEmployee: "",
    pickupBranch: "",
    tag: "",
    readState: "",
    orderKind: "",
    sortBy: "order_created_at",
    sortDirection: "desc",
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

test("date range is inclusive and uses the local Salla order date", () => {
  const before = order(1);
  before.order_date = "2026-01-09";
  const firstBoundary = order(2);
  firstBoundary.order_date = "2026-01-10";
  const lastBoundary = order(3);
  lastBoundary.order_date = "2026-01-12";
  const after = order(4);
  after.order_date = "2026-01-13";

  const query = parseStoreOrderListQuery({ date_from: "2026-01-10", date_to: "2026-01-12" });
  assert.deepEqual(
    filterStoreOrderRecords([before, firstBoundary, lastBoundary, after], query).map((row) => row.id),
    [firstBoundary.id, lastBoundary.id],
  );
});

test("all supported order sorts are deterministic in both directions", () => {
  const first = order(1);
  const second = order(2);
  const third = order(3);
  Object.assign(first, {
    order_created_at: "2026-01-01T10:00:00.000Z",
    order_date: "2026-01-01",
    remote_updated_at: "2026-01-03T10:00:00.000Z",
    total: 300,
    order_number: "ORD-30",
    customer_name: "جيم",
  });
  Object.assign(second, {
    order_created_at: "2026-01-02T10:00:00.000Z",
    order_date: "2026-01-02",
    remote_updated_at: "2026-01-01T10:00:00.000Z",
    total: 100,
    order_number: "ORD-10",
    customer_name: "ألف",
  });
  Object.assign(third, {
    order_created_at: "2026-01-03T10:00:00.000Z",
    order_date: "2026-01-03",
    remote_updated_at: "2026-01-02T10:00:00.000Z",
    total: 200,
    order_number: "ORD-20",
    customer_name: "باء",
  });
  const rows = [first, second, third];
  const cases: Array<[string, string[]]> = [
    ["order_created_at", [first.id, second.id, third.id]],
    ["order_date", [first.id, second.id, third.id]],
    ["remote_updated_at", [second.id, third.id, first.id]],
    ["total", [second.id, third.id, first.id]],
    ["order_number", [second.id, third.id, first.id]],
    ["customer_name", [second.id, third.id, first.id]],
  ];

  for (const [sortBy, ascending] of cases) {
    const asc = parseStoreOrderListQuery({ sort_by: sortBy, sort_direction: "asc" });
    const desc = parseStoreOrderListQuery({ sort_by: sortBy, sort_direction: "desc" });
    assert.deepEqual(sortStoreOrderRecords(rows, asc).map((row) => row.id), ascending, `${sortBy} asc`);
    assert.deepEqual(sortStoreOrderRecords(rows, desc).map((row) => row.id), [...ascending].reverse(), `${sortBy} desc`);
  }
});

test("advanced Salla filters combine before pagination", () => {
  const match = order(1);
  Object.assign(match, {
    order_date: "2026-02-10",
    payment_method: "bank",
    shipping_company: "Aramex",
    shipment_status: "shipped",
    country: "السعودية",
    sales_channel: "store",
    assigned_employee: "موظف 1",
    pickup_branch: "فرع الرياض",
    order_tags: ["VIP", "priority"],
    is_read: false,
    is_price_quote: true,
  });
  const mismatch = order(2);
  Object.assign(mismatch, { ...match, id: "store-mismatch", payment_method: "cash" });
  const query = parseStoreOrderListQuery({
    date_from: "2026-02-10",
    date_to: "2026-02-10",
    payment_method: "bank",
    shipping_company: "aramex",
    shipment_status: "shipped",
    country: "السعودية",
    sales_channel: "store",
    assigned_employee: "موظف 1",
    pickup_branch: "فرع الرياض",
    tag: "vip",
    read_state: "unread",
    order_kind: "price_quote",
  });

  const filtered = filterStoreOrderRecords([mismatch, match], query);
  const page = paginateStoreOrderRecords(sortStoreOrderRecords(filtered, query), query);
  assert.deepEqual(page.data.map((row) => row.id), [match.id]);
  assert.equal(page.total, 1);
});

test("order kind treats legacy null as an order and only true as price quote", () => {
  const legacy = order(1);
  legacy.is_price_quote = null;
  const regular = order(2);
  regular.is_price_quote = false;
  const quote = order(3);
  quote.is_price_quote = true;

  assert.deepEqual(
    filterStoreOrderRecords([legacy, regular, quote], parseStoreOrderListQuery({ order_kind: "order" }))
      .map((row) => row.id),
    [legacy.id, regular.id],
  );
  assert.deepEqual(
    filterStoreOrderRecords([legacy, regular, quote], parseStoreOrderListQuery({ order_kind: "price_quote" }))
      .map((row) => row.id),
    [quote.id],
  );
});

test("facets expose stable counts for every Salla filter", () => {
  const first = order(1);
  Object.assign(first, {
    remote_status_slug: "under_review",
    customer_city: "الرياض",
    payment_method: "bank",
    shipping_company: "Aramex",
    shipment_status: "shipped",
    country: "السعودية",
    sales_channel: "store",
    assigned_employee: "موظف 1",
    pickup_branch: "فرع الرياض",
    order_tags: ["VIP", "priority"],
    is_read: true,
    is_price_quote: true,
  });
  const second = order(2);
  Object.assign(second, {
    remote_status_slug: "under_review",
    customer_city: "جدة",
    payment_method: "bank",
    shipping_company: "Aramex",
    shipment_status: "pending",
    country: "السعودية",
    sales_channel: "store",
    assigned_employee: "موظف 2",
    pickup_branch: "فرع جدة",
    order_tags: ["VIP"],
    is_read: false,
    is_price_quote: null,
  });

  const facets = buildStoreOrderFacets([first, second]);
  assert.deepEqual(facets.payment_method, [{ value: "bank", count: 2 }]);
  assert.deepEqual(facets.tag, [{ value: "priority", count: 1 }, { value: "VIP", count: 2 }]);
  assert.deepEqual(facets.read_state, [{ value: "read", count: 1 }, { value: "unread", count: 1 }]);
  assert.deepEqual(facets.order_kind, [{ value: "order", count: 1 }, { value: "price_quote", count: 1 }]);
  assert.deepEqual(facets.status, [{ value: "under_review", count: 2 }]);
});
