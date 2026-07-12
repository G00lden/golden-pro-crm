import assert from "node:assert/strict";
import test from "node:test";
import { addCalendarMonths, addCalendarMonthsOr } from "./date";

test("clamps month-end instead of overflowing into the following month", () => {
  assert.equal(addCalendarMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(addCalendarMonths("2024-01-31", 1), "2024-02-29");
  assert.equal(addCalendarMonths("2024-02-29", 12), "2025-02-28");
});

test("supports negative deltas and year boundaries", () => {
  assert.equal(addCalendarMonths("2026-03-31", -1), "2026-02-28");
  assert.equal(addCalendarMonths("2026-12-15", 2), "2027-02-15");
  assert.equal(addCalendarMonths("2026-01-15", -2), "2025-11-15");
});

test("zero months preserves a valid date", () => {
  assert.equal(addCalendarMonths("2026-07-12", 0), "2026-07-12");
});

test("rejects malformed and impossible dates", () => {
  assert.throws(() => addCalendarMonths("2026-02-30", 1));
  assert.throws(() => addCalendarMonths("12/07/2026", 1));
});

test("safe variant uses an explicit valid fallback", () => {
  assert.equal(addCalendarMonthsOr("bad", 1, "2026-01-31"), "2026-02-28");
});
