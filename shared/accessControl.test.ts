import assert from "node:assert/strict";
import test from "node:test";
import {
  hasAppCapability,
  isProductionEnvironment,
  normalizeAppRole,
  type AppCapability,
} from "./accessControl";

const expected: Record<"admin" | "manager" | "viewer", Record<AppCapability, boolean>> = {
  admin: {
    "users.manage": true,
    "whatsapp.manage": true,
    "campaigns.manage": true,
    "calls.manage": true,
    "mobile.devices.view": true,
    "mobile.devices.pair": true,
    "mobile.devices.manage": true,
    "mobile.calls.view": true,
    "mobile.calls.execute": true,
    "mobile.contacts.sync": true,
    "mobile.tasks.update": true,
    "mobile.reply_policy.manage": true,
    "mobile.tests.send": true,
    "mobile.device.lock": true,
    "mobile.device.wipe": true,
    "public_leads.manage": true,
    "operations.prepare": true,
    "demo.seed": true,
  },
  manager: {
    "users.manage": false,
    "whatsapp.manage": false,
    "campaigns.manage": true,
    "calls.manage": true,
    "mobile.devices.view": true,
    "mobile.devices.pair": true,
    "mobile.devices.manage": true,
    "mobile.calls.view": true,
    "mobile.calls.execute": true,
    "mobile.contacts.sync": true,
    "mobile.tasks.update": true,
    "mobile.reply_policy.manage": true,
    "mobile.tests.send": false,
    "mobile.device.lock": false,
    "mobile.device.wipe": false,
    "public_leads.manage": true,
    "operations.prepare": true,
    "demo.seed": false,
  },
  viewer: {
    "users.manage": false,
    "whatsapp.manage": false,
    "campaigns.manage": false,
    "calls.manage": false,
    "mobile.devices.view": true,
    "mobile.devices.pair": false,
    "mobile.devices.manage": false,
    "mobile.calls.view": false,
    "mobile.calls.execute": false,
    "mobile.contacts.sync": false,
    "mobile.tasks.update": false,
    "mobile.reply_policy.manage": false,
    "mobile.tests.send": false,
    "mobile.device.lock": false,
    "mobile.device.wipe": false,
    "public_leads.manage": false,
    "operations.prepare": false,
    "demo.seed": false,
  },
};

for (const [role, capabilities] of Object.entries(expected)) {
  test(`${role} capability matrix`, () => {
    for (const [capability, allowed] of Object.entries(capabilities)) {
      assert.equal(hasAppCapability(role, capability as AppCapability), allowed, capability);
    }
  });
}

test("viewer is normalized to the persisted least-privilege user role", () => {
  assert.equal(normalizeAppRole("viewer"), "user");
  assert.equal(normalizeAppRole("unknown"), "user");
});

test("production detection is explicit and case-insensitive", () => {
  assert.equal(isProductionEnvironment("production"), true);
  assert.equal(isProductionEnvironment(" Production "), true);
  assert.equal(isProductionEnvironment("development"), false);
  assert.equal(isProductionEnvironment(undefined), false);
});
