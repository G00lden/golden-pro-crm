import assert from "node:assert/strict";
import test from "node:test";
import {
  parsePrefixedUrlState,
  serializePrefixedUrlState,
  type UrlFilterSchema,
} from "./filterUrlState";

const defaults = {
  q: "",
  status: "",
  date_from: "",
  sort_direction: "desc",
  page: "1",
  page_size: "50",
};

const schema: UrlFilterSchema<typeof defaults> = {
  q: { type: "text", maxLength: 20, trim: false },
  status: { type: "enum", values: ["", "active", "blocked"] },
  date_from: { type: "date" },
  sort_direction: { type: "enum", values: ["asc", "desc"] },
  page: { type: "integer", minimum: 1, maximum: 10_000 },
  page_size: { type: "enum", values: ["25", "50", "100"] },
};

test("prefixed URL parsing applies allowlists, dates, and numeric clamps", () => {
  assert.deepEqual(parsePrefixedUrlState(
    "?o_q=%D8%B9%D9%85%D9%8A%D9%84&o_status=admin&o_date_from=2026-02-31&o_page=-4&o_page_size=100",
    "o",
    defaults,
    schema,
  ), {
    ...defaults,
    q: "عميل",
    page_size: "100",
  });
});

test("prefixed URL serialization preserves unrelated application parameters", () => {
  const serialized = serializePrefixedUrlState(
    "?section=storeOrders&salla=connected&o_status=blocked&o_page=9",
    "o",
    { ...defaults, status: "active", date_from: "2026-07-01", page: "2" },
    defaults,
    schema,
  );
  const params = new URLSearchParams(serialized);
  assert.equal(params.get("section"), "storeOrders");
  assert.equal(params.get("salla"), "connected");
  assert.equal(params.get("o_status"), "active");
  assert.equal(params.get("o_date_from"), "2026-07-01");
  assert.equal(params.get("o_page"), "2");
  assert.equal(params.get("o_page_size"), null);
});
