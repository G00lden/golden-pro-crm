import assert from "node:assert/strict";
import test from "node:test";
import { sallaRemoteActionsAreAvailable } from "./sallaAvailability";

test("Salla remote actions require the latest successful availability check", () => {
  assert.equal(sallaRemoteActionsAreAvailable({ loading: false, error: null, available: true }), true);
  assert.equal(sallaRemoteActionsAreAvailable({ loading: false, error: null, available: false }), false);
  assert.equal(sallaRemoteActionsAreAvailable({ loading: true, error: null, available: true }), false);
  assert.equal(sallaRemoteActionsAreAvailable({ loading: false, error: "regional block", available: true }), false);
});
