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
    "public_leads.manage": true,
    "operations.prepare": true,
    "demo.seed": true,
  },
  manager: {
    "users.manage": false,
    "whatsapp.manage": false,
    "campaigns.manage": true,
    "calls.manage": true,
    "public_leads.manage": true,
    "operations.prepare": true,
    "demo.seed": false,
  },
  viewer: {
    "users.manage": false,
    "whatsapp.manage": false,
    "campaigns.manage": false,
    "calls.manage": false,
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
