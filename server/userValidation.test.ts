import assert from "node:assert/strict";
import test from "node:test";
import {
  managedUserCreateSchema,
  managedUserListQuerySchema,
  managedUserUpdateSchema,
} from "./userValidation";

test("managed user requires a name or valid email", () => {
  assert.equal(managedUserCreateSchema.safeParse({ role: "admin" }).success, false);
  assert.equal(managedUserCreateSchema.safeParse({ email: "bad" }).success, false);
  assert.equal(managedUserCreateSchema.safeParse({ email: "Owner@Example.com", role: "manager" }).success, true);
});

test("roles and permission names are allowlisted", () => {
  assert.equal(managedUserCreateSchema.safeParse({ name: "A", role: "root" }).success, false);
  assert.equal(managedUserCreateSchema.safeParse({ name: "A", permissions: { "crm.read": true } }).success, true);
  assert.equal(managedUserCreateSchema.safeParse({ name: "A", permissions: { "bad key": true } }).success, false);
});

test("empty updates and invalid query flags are rejected", () => {
  assert.equal(managedUserUpdateSchema.safeParse({}).success, false);
  assert.equal(managedUserListQuerySchema.safeParse({ active: "yes" }).success, false);
});
