import assert from "node:assert/strict";
import test from "node:test";
import { firstSallaDate, parseSallaDate } from "./sallaDate";

test("parses the official Salla date object in its declared timezone", () => {
  const result = parseSallaDate({
    date: "2022-06-16 14:48:20.000000",
    timezone_type: 3,
    timezone: "Asia/Riyadh",
  });

  assert.deepEqual(result, {
    createdAt: "2022-06-16T11:48:20.000Z",
    orderDate: "2022-06-16",
    timezone: "Asia/Riyadh",
  });
});

test("supports ISO strings and epoch seconds or milliseconds", () => {
  const epochMs = Date.UTC(2022, 5, 16, 11, 48, 20);
  const expected = {
    createdAt: "2022-06-16T11:48:20.000Z",
    orderDate: "2022-06-16",
    timezone: "Asia/Riyadh",
  };

  assert.deepEqual(parseSallaDate("2022-06-16T11:48:20.000Z"), expected);
  assert.deepEqual(parseSallaDate(epochMs / 1000), expected);
  assert.deepEqual(parseSallaDate(epochMs), expected);
});

test("invalid dates never become today's date", () => {
  assert.equal(parseSallaDate({ date: "not-a-date", timezone: "Asia/Riyadh" }), null);
  assert.equal(parseSallaDate({ date: "2022-02-31 10:00:00", timezone: "Asia/Riyadh" }), null);
  assert.equal(parseSallaDate({ date: "2022-06-16 10:00:00", timezone: "Mars/Olympus" }), null);
  assert.equal(parseSallaDate(null), null);
  assert.equal(parseSallaDate(""), null);
});

test("firstSallaDate keeps created and updated candidates independent", () => {
  const created = firstSallaDate([
    undefined,
    { date: "2022-06-16 14:48:20.000000", timezone: "Asia/Riyadh" },
  ]);
  const updated = firstSallaDate([
    { date: "2022-06-17 09:00:00.000000", timezone: "Asia/Riyadh" },
    created?.createdAt,
  ]);

  assert.equal(created?.createdAt, "2022-06-16T11:48:20.000Z");
  assert.equal(updated?.createdAt, "2022-06-17T06:00:00.000Z");
});
