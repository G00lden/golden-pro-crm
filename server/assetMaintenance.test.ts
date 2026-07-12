import assert from "node:assert/strict";
import test from "node:test";
import { addServiceInterval, createAssetPublicToken, nextOverdueReminderDate } from "./assetMaintenance";

test("monthly service dates clamp safely at month end", () => {
  assert.equal(addServiceInterval("2026-01-31", 1, "months"), "2026-02-28");
  assert.equal(addServiceInterval("2024-01-31", 1, "months"), "2024-02-29");
});

test("year crossing preserves the intended day", () => {
  assert.equal(addServiceInterval("2026-11-15", 3, "months"), "2027-02-15");
});

test("day intervals use calendar days", () => {
  assert.equal(addServiceInterval("2026-12-30", 5, "days"), "2027-01-04");
});

test("public asset tokens are signed and contain no raw path separators", () => {
  const previous = process.env.ASSET_PUBLIC_TOKEN_SECRET;
  process.env.ASSET_PUBLIC_TOKEN_SECRET = "test-secret-only";
  try {
    const token = createAssetPublicToken("asset_1234567890abcdef");
    assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.equal(token.split(".").length, 2);
  } finally {
    if (previous === undefined) delete process.env.ASSET_PUBLIC_TOKEN_SECRET;
    else process.env.ASSET_PUBLIC_TOKEN_SECRET = previous;
  }
});

test("overdue reminders use ten days for twelve attempts then monthly", () => {
  assert.equal(nextOverdueReminderDate("2026-07-13", 1), "2026-07-23");
  assert.equal(nextOverdueReminderDate("2026-07-13", 12), "2026-07-23");
  assert.equal(nextOverdueReminderDate("2026-07-13", 13), "2026-08-12");
});
