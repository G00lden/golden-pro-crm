import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildCustomerFacets,
  customerSource,
  enrichCustomerRecordsWithOrders,
  filterCustomerRecords,
  normalizeCustomerPhone,
  paginateCustomerRecords,
  parseCustomerListQuery,
  sortCustomerRecords,
} from "./customerPagination";
import type { OwnedRecord } from "./repositories/ownedRepository";

const customerPageSource = readFileSync(new URL("../src/pages/Customers.tsx", import.meta.url), "utf8");
const sharedSource = readFileSync(new URL("../src/shared.tsx", import.meta.url), "utf8");

function customer(index: number, overrides: Partial<OwnedRecord> = {}): OwnedRecord {
  return {
    id: `customer-${index}`,
    createdBy: "owner-a",
    name: `عميل ${String(index).padStart(4, "0")}`,
    phone: `050${String(index).padStart(7, "0")}`,
    city: index === 3_999 ? "مدينة النهاية" : "الرياض",
    source: "manual",
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

test("customer query parser normalizes the full filter contract and clamps unsafe values", () => {
  assert.deepEqual(parseCustomerListQuery({
    search: "  عميل  ",
    source: " salla ",
    city: " الرياض ",
    country: " السعودية ",
    gender: " male ",
    group: " vip ",
    status: "blocked",
    activity: "recent",
    date_from: "2026-07-01",
    date_to: "2026-07-31",
    sort_by: "total_spent",
    sort_direction: "DESC",
    page: "-4",
    page_size: "9999",
    all: "true",
  }), {
    search: "عميل",
    source: "salla",
    city: "الرياض",
    country: "السعودية",
    gender: "male",
    group: "vip",
    status: "blocked",
    activity: "recent",
    dateFrom: "2026-07-01",
    dateTo: "2026-07-31",
    sortBy: "total_spent",
    sortDirection: "desc",
    page: 1,
    pageSize: 100,
    all: true,
  });
});

test("customer query parser rejects unsupported enums and impossible calendar dates", () => {
  const parsed = parseCustomerListQuery({
    status: "deleted",
    activity: "sometimes",
    date_from: "2026-02-30",
    date_to: "not-a-date",
    sort_by: "phone",
    sort_direction: "sideways",
  });
  assert.equal(parsed.status, "");
  assert.equal(parsed.activity, "");
  assert.equal(parsed.dateFrom, "");
  assert.equal(parsed.dateTo, "");
  assert.equal(parsed.sortBy, "name");
  assert.equal(parsed.sortDirection, "asc");
});

test("customer search scans every supported normalized field before pagination", () => {
  const customers = Array.from({ length: 4_000 }, (_, index) => customer(index));
  customers[3_999] = customer(3_999, {
    country: "السعودية",
    email: "LAST@example.com",
    store_customer_id: "REMOTE-٩٩",
  });

  for (const search of ["مدينة النهاية", "last@EXAMPLE.com", "remote-99", "966500003999"]) {
    const query = parseCustomerListQuery({ search });
    const result = paginateCustomerRecords(filterCustomerRecords(customers, query), query);
    assert.equal(result.total, 1);
    assert.equal(result.data[0]?.id, "customer-3999");
  }
});

test("source treats a Salla provider as authoritative over a manual origin", () => {
  const linkedManual = customer(1, { source: "manual", store_provider: "salla" });
  const plainManual = customer(2, { source: "manual" });
  assert.equal(customerSource(linkedManual), "salla");
  assert.deepEqual(
    filterCustomerRecords([linkedManual, plainManual], parseCustomerListQuery({ source: "salla" })).map((row) => row.id),
    [linkedManual.id],
  );
});

test("date range is inclusive in Riyadh and a reversed range returns no rows", () => {
  const nearMidnight = customer(1, { createdAt: "2026-07-01T21:30:00.000Z" });
  const inclusive = parseCustomerListQuery({ date_from: "2026-07-02", date_to: "2026-07-02" });
  assert.deepEqual(filterCustomerRecords([nearMidnight], inclusive).map((row) => row.id), [nearMidnight.id]);
  assert.equal(filterCustomerRecords(
    [nearMidnight],
    parseCustomerListQuery({ date_from: "2026-07-03", date_to: "2026-07-01" }),
  ).length, 0);
});

test("customer creation date prefers the remote account date over the local import date", () => {
  const importedLater = customer(1, {
    remote_created_at: "2025-12-15T12:00:00.000Z",
    createdAt: "2026-07-01T00:00:00.000Z",
  });
  assert.equal(filterCustomerRecords(
    [importedLater],
    parseCustomerListQuery({ date_from: "2025-12-15", date_to: "2025-12-15" }),
  ).length, 1);
  assert.equal(filterCustomerRecords(
    [importedLater],
    parseCustomerListQuery({ date_from: "2026-07-01", date_to: "2026-07-01" }),
  ).length, 0);

  const olderRemote = customer(2, { remote_created_at: "2025-01-01", createdAt: "2026-01-01" });
  assert.deepEqual(sortCustomerRecords(
    [olderRemote, importedLater],
    { sortBy: "created_at", sortDirection: "asc" },
  ).map((row) => row.id), [olderRemote.id, importedLater.id]);

  const invalidRemote = customer(3, { remote_created_at: "invalid", createdAt: "2026-07-01" });
  assert.equal(filterCustomerRecords(
    [invalidRemote],
    parseCustomerListQuery({ date_from: "2026-07-01", date_to: "2026-07-01" }),
  ).length, 1);
});

test("order aggregation prefers customer_id, falls back to one normalized phone, and computes activity", () => {
  const rows = [
    customer(1, { phone: "0500000001" }),
    customer(2, { phone: "0500000002" }),
    customer(3, { phone: "0500000003" }),
    customer(4, { phone: "٠٥٠٠٠٠٠٠٠٤" }),
  ];
  const orders: OwnedRecord[] = [
    {
      id: "order-1",
      customer_id: rows[0].id,
      customer_phone: rows[1].phone,
      order_date: "2026-07-12",
      total: 100,
    },
    {
      id: "order-2",
      customer_id: rows[0].id,
      order_date: "2026-01-01",
      total: { amount: 50 },
    },
    {
      id: "order-3",
      customer_id: rows[1].id,
      order_date: "2026-04-13",
      total: 75,
    },
    {
      id: "order-4",
      customer_phone: "+966500000004",
      order_date: "2026-07-01",
      items: [{ unit_price: 10, quantity: 2 }],
    },
  ];

  const enriched = enrichCustomerRecordsWithOrders(rows, orders, { now: "2026-07-13T00:00:00.000Z" });
  assert.deepEqual(
    enriched.map((row) => ({
      id: row.id,
      count: row.orders_count,
      spent: row.total_spent,
      last: row.last_order_at,
      activity: row.activity_status,
    })),
    [
      { id: rows[0].id, count: 2, spent: 150, last: "2026-07-12", activity: "recent" },
      { id: rows[1].id, count: 1, spent: 75, last: "2026-04-13", activity: "inactive" },
      { id: rows[2].id, count: 0, spent: 0, last: null, activity: "no_orders" },
      { id: rows[3].id, count: 1, spent: 20, last: "2026-07-01", activity: "recent" },
    ],
  );
});

test("90-day activity boundary is recent while an older order is inactive", () => {
  const rows = [customer(1), customer(2)];
  const enriched = enrichCustomerRecordsWithOrders(rows, [
    { id: "boundary", customer_id: rows[0].id, order_date: "2026-04-14" },
    { id: "older", customer_id: rows[1].id, order_date: "2026-04-13T23:59:59.999Z" },
  ], { now: "2026-07-13T00:00:00.000Z" });
  assert.equal(enriched[0].activity_status, "recent");
  assert.equal(enriched[1].activity_status, "inactive");
  assert.equal(filterCustomerRecords(enriched, parseCustomerListQuery({ activity: "has_orders" })).length, 2);
  assert.deepEqual(
    filterCustomerRecords(enriched, parseCustomerListQuery({ activity: "recent" })).map((row) => row.id),
    [rows[0].id],
  );
});

test("sync timestamps never turn an undated order into recent customer activity", () => {
  const row = customer(1);
  const enriched = enrichCustomerRecordsWithOrders([row], [
    {
      id: "undated-order",
      customer_id: row.id,
      imported_at: "2026-07-12T23:59:00.000Z",
      remote_updated_at: "2026-07-12T23:59:00.000Z",
      createdAt: "2026-07-12T23:59:00.000Z",
      total: 10,
    },
  ], { now: "2026-07-13T00:00:00.000Z" });
  assert.equal(enriched[0].orders_count, 1);
  assert.equal(enriched[0].last_order_at, null);
  assert.equal(enriched[0].activity_status, "unknown");
  assert.equal(filterCustomerRecords(enriched, parseCustomerListQuery({ activity: "recent" })).length, 0);
  assert.equal(filterCustomerRecords(enriched, parseCustomerListQuery({ activity: "has_orders" })).length, 1);
});

test("phone fallback does not assign an order when the phone belongs to multiple customers", () => {
  const rows = [customer(1, { phone: "0500000009" }), customer(2, { phone: "+966500000009" })];
  assert.equal(normalizeCustomerPhone(rows[0].phone), normalizeCustomerPhone(rows[1].phone));
  const enriched = enrichCustomerRecordsWithOrders(rows, [
    { id: "ambiguous", customer_phone: "0500000009", order_date: "2026-07-01", total: 99 },
  ]);
  assert.deepEqual(enriched.map((row) => row.orders_count), [0, 0]);
});

test("combined source, demographic, status, activity, and date filters run before pagination", () => {
  const rows = enrichCustomerRecordsWithOrders([
    customer(1, {
      source: "manual",
      store_provider: "salla",
      city: "جدة",
      country: "السعودية",
      gender: "female",
      customer_groups: [{ id: "vip", name: "كبار العملاء" }],
      is_blocked: false,
      createdAt: "2026-07-05T00:00:00.000Z",
    }),
    customer(2, {
      city: "جدة",
      country: "السعودية",
      gender: "female",
      is_blocked: false,
      createdAt: "2026-07-05T00:00:00.000Z",
    }),
    customer(3, { store_provider: "salla", is_blocked: true }),
  ], [
    { id: "order-1", customer_id: "customer-1", order_date: "2026-07-10", total: 20 },
  ], { now: "2026-07-13T00:00:00.000Z" });
  const query = parseCustomerListQuery({
    source: "salla",
    city: "جدة",
    country: "السعودية",
    gender: "female",
    group: "كبار العملاء",
    status: "active",
    activity: "recent",
    date_from: "2026-07-01",
    date_to: "2026-07-31",
    page_size: 1,
  });
  const result = paginateCustomerRecords(sortCustomerRecords(filterCustomerRecords(rows, query), query), query);
  assert.equal(result.total, 1);
  assert.equal(result.data[0]?.id, "customer-1");
});

test("customer sorting supports every allowlisted metric, is stable, and keeps null dates last", () => {
  const rows: OwnedRecord[] = [
    customer(2, { name: "ب", createdAt: "2026-01-02", last_order_at: null, orders_count: 1, total_spent: 20 }),
    customer(1, { name: "أ", createdAt: "2026-01-01", last_order_at: "2026-06-01", orders_count: 3, total_spent: 10 }),
    customer(3, { name: "أ", createdAt: "2026-01-03", last_order_at: "2026-07-01", orders_count: 2, total_spent: 30 }),
    customer(4, { name: "ج", createdAt: null, last_order_at: null, orders_count: null, total_spent: null }),
  ];
  assert.deepEqual(sortCustomerRecords(rows, { sortBy: "name", sortDirection: "asc" }).map((row) => row.id), ["customer-1", "customer-3", "customer-2", "customer-4"]);
  assert.deepEqual(sortCustomerRecords(rows, { sortBy: "created_at", sortDirection: "desc" }).map((row) => row.id), ["customer-3", "customer-2", "customer-1", "customer-4"]);
  assert.deepEqual(sortCustomerRecords(rows, { sortBy: "last_order_at", sortDirection: "desc" }).map((row) => row.id), ["customer-3", "customer-1", "customer-2", "customer-4"]);
  assert.deepEqual(sortCustomerRecords(rows, { sortBy: "orders_count", sortDirection: "desc" }).map((row) => row.id), ["customer-1", "customer-3", "customer-2", "customer-4"]);
  assert.deepEqual(sortCustomerRecords(rows, { sortBy: "total_spent", sortDirection: "asc" }).map((row) => row.id), ["customer-1", "customer-2", "customer-3", "customer-4"]);
});

test("facets use authoritative source and normalized values with stable counts", () => {
  const facets = buildCustomerFacets([
    customer(1, { source: "manual", store_provider: "salla", city: "الرياض", country: "السعودية", gender: "male", is_blocked: false, customer_groups: [{ id: "vip", name: "كبار العملاء" }, "wholesale"] }),
    customer(2, { source: "salla", city: " الرياض ", country: "السعودية", gender: "female", is_blocked: true, customer_groups: [{ id: "vip", title: "كبار العملاء" }] }),
    customer(3, { source: "manual" }),
  ]);
  assert.deepEqual(facets.sources.map(({ value, count }) => ({ value, count })), [
    { value: "manual", count: 1 },
    { value: "salla", count: 2 },
  ]);
  assert.deepEqual(facets.cities.map(({ value, count }) => ({ value, count })), [{ value: "الرياض", count: 3 }]);
  assert.deepEqual(
    facets.groups.map(({ value, label, count }) => ({ value, label, count })).sort((a, b) => a.value.localeCompare(b.value)),
    [
      { value: "vip", label: "كبار العملاء", count: 2 },
      { value: "wholesale", label: "wholesale", count: 1 },
    ],
  );
  assert.deepEqual(facets.statuses.map(({ value, count }) => ({ value, count })).sort((a, b) => a.value.localeCompare(b.value)), [
    { value: "active", count: 1 },
    { value: "blocked", count: 1 },
    { value: "unknown", count: 1 },
  ]);
});

test("customer pagination reports real totals, all mode, navigation, and the 10k cap", () => {
  const rows = Array.from({ length: 247 }, (_, index) => customer(index));
  const result = paginateCustomerRecords(rows, { page: 3, pageSize: 50, all: false });
  assert.equal(result.total, 247);
  assert.equal(result.page, 3);
  assert.equal(result.totalPages, 5);
  assert.equal(result.data.length, 50);
  assert.equal(result.hasPrevious, true);
  assert.equal(result.hasNext, true);

  const all = paginateCustomerRecords(rows, { page: 9, pageSize: 10, all: true });
  assert.equal(all.page, 1);
  assert.equal(all.pageSize, 247);
  assert.equal(all.data.length, 247);

  const capped = paginateCustomerRecords(
    Array.from({ length: 10_001 }, (_, index) => customer(index)),
    { page: 1, pageSize: 50, all: false },
  );
  assert.equal(capped.data.length, 50);
  assert.equal(capped.total, 10_000);
  assert.equal(capped.capped, true);
});

test("customer search is debounced and stale data requests cannot win", () => {
  assert.match(customerPageSource, /setDebouncedSearch\(search\), 300/);
  assert.match(customerPageSource, /getCustomers\(debouncedSearch/);
  assert.match(sharedSource, /requestGeneration/);
  assert.match(sharedSource, /generation === requestGeneration\.current\) setData\(next\)/);
});
