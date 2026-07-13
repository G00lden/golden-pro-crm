import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./StoreOrders.tsx", import.meta.url), "utf8");

test("disconnected Salla operations are disabled with a visible reason", () => {
  assert.match(source, /sallaRemoteActionsAvailable = sallaRemoteActionsAreAvailable/);
  assert.match(source, /disabled=\{!sallaRemoteActionsAvailable\}[\s\S]{0,180}?تحديث فوري/);
  assert.match(source, /disabled=\{orders\.loading \|\| sallaStatuses\.loading \|\| !sallaRemoteActionsAvailable\}/);
  assert.match(source, /disabled=\{sallaStatuses\.loading \|\| !sallaRemoteActionsAvailable\}/);
  assert.match(source, /disabled=\{!sallaRemoteActionsAvailable\}[\s\S]{0,180}?تعديل بيانات سلة/);
  assert.match(source, /عمليات سلة البعيدة متوقفة:/);
  assert.match(source, /role=\{sallaStatuses\.error \? "alert" : "status"\}/);
  assert.match(source, /aria-live=\{sallaStatuses\.error \? undefined : "polite"\}/);
  assert.match(source, /aria-describedby="salla-remote-actions-status"/);
  assert.match(source, /id="salla-remote-actions-status"/);
  assert.doesNotMatch(source, /name="salla_status_filter"[\s\S]{0,180}?disabled=/);
});

test("Salla sync fails closed and exposes a persistent operation error", () => {
  assert.match(source, /if \(options\.sync && !sallaRemoteActionsAvailable\)/);
  assert.match(source, /setSallaActionError\(message\)/);
  assert.match(source, /فشلت عملية سلة: \{sallaActionError\}/);
  assert.match(source, /role="alert" aria-live="assertive"/);
});
