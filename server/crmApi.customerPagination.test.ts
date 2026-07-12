import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  filterCustomerRecords,
  paginateCustomerRecords,
  parseCustomerListQuery,
} from "./customerPagination";
import type { OwnedRecord } from "./repositories/ownedRepository";

const customerPageSource = readFileSync(new URL("../src/pages/Customers.tsx", import.meta.url), "utf8");
const sharedSource = readFileSync(new URL("../src/shared.tsx", import.meta.url), "utf8");

function customer(index: number): OwnedRecord {
  return {
    id: `customer-${index}`,
    createdBy: "owner-a",
    name: `عميل ${String(index).padStart(4, "0")}`,
    phone: `050${String(index).padStart(7, "0")}`,
    city: index === 3_999 ? "مدينة النهاية" : "الرياض",
  };
}

test("customer query parsing clamps page sizes and supports explicit all mode", () => {
  assert.deepEqual(parseCustomerListQuery({
    search: "  عميل  ",
    page: "-4",
    page_size: "9999",
    all: "true",
  }), {
    search: "عميل",
    page: 1,
    pageSize: 100,
    all: true,
  });
});

test("customer search scans the complete owner set before pagination", () => {
  const customers = Array.from({ length: 4_000 }, (_, index) => customer(index));
  const matches = filterCustomerRecords(customers, "مدينة النهاية");
  const result = paginateCustomerRecords(matches, { page: 1, pageSize: 50, all: false });

  assert.equal(matches.length, 1);
  assert.equal(result.total, 1);
  assert.equal(result.data[0]?.id, "customer-3999");
  assert.equal(result.totalPages, 1);
});

test("customer pagination reports real totals and navigation state", () => {
  const customers = Array.from({ length: 247 }, (_, index) => customer(index));
  const result = paginateCustomerRecords(customers, { page: 3, pageSize: 50, all: false });

  assert.equal(result.total, 247);
  assert.equal(result.page, 3);
  assert.equal(result.pageSize, 50);
  assert.equal(result.totalPages, 5);
  assert.equal(result.data.length, 50);
  assert.equal(result.data[0]?.id, "customer-100");
  assert.equal(result.hasPrevious, true);
  assert.equal(result.hasNext, true);
});

test("customer search is debounced and stale data requests cannot win", () => {
  assert.match(customerPageSource, /setDebouncedSearch\(search\), 300/);
  assert.match(customerPageSource, /getCustomers\(debouncedSearch/);
  assert.match(sharedSource, /requestGeneration/);
  assert.match(sharedSource, /generation === requestGeneration\.current\) setData\(next\)/);
});
