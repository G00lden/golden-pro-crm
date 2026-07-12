import assert from "node:assert/strict";
import test from "node:test";
import { advanceMessageStatus } from "./communicationStatus";

test("delivery states advance monotonically", () => {
  assert.equal(advanceMessageStatus("sent", "delivered"), "delivered");
  assert.equal(advanceMessageStatus("delivered", "read"), "read");
  assert.equal(advanceMessageStatus("read", "delivered"), "read");
});

test("late failures do not overwrite confirmed delivery", () => {
  assert.equal(advanceMessageStatus("delivered", "failed"), "delivered");
  assert.equal(advanceMessageStatus("read", "failed"), "read");
  assert.equal(advanceMessageStatus("sent", "failed"), "failed");
});

test("confirmed receipts can recover a provisional failure", () => {
  assert.equal(advanceMessageStatus("failed", "sent"), "failed");
  assert.equal(advanceMessageStatus("failed", "delivered"), "delivered");
});

test("terminal safety states remain terminal", () => {
  assert.equal(advanceMessageStatus("dry_run", "sent"), "dry_run");
  assert.equal(advanceMessageStatus("blocked", "read"), "blocked");
});
