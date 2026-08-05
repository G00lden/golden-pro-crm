import assert from "node:assert/strict";
import test from "node:test";
import { formatMaintenanceTime } from "./maintenanceTime";

test("maintenance times display in Arabic 12-hour format without changing stored values", () => {
  assert.equal(formatMaintenanceTime("00:00"), "12:00 ص");
  assert.equal(formatMaintenanceTime("09:00"), "9:00 ص");
  assert.equal(formatMaintenanceTime("12:00"), "12:00 م");
  assert.equal(formatMaintenanceTime("14:30"), "2:30 م");
  assert.equal(formatMaintenanceTime("23:59"), "11:59 م");
  assert.equal(formatMaintenanceTime("invalid"), "invalid");
  assert.equal(formatMaintenanceTime(null), "");
});
