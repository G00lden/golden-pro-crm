import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const adminUsersSource = readFileSync(new URL("./AdminUsers.tsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../../server/userManagement.ts", import.meta.url), "utf8");

test("user administration exposes role defaults and explicit mobile permission overrides", () => {
  assert.match(adminUsersSource, /<span>الدور<\/span>/);
  assert.match(adminUsersSource, /ROLE_OPTIONS\.map/);
  assert.match(adminUsersSource, /PERMISSION_OPTIONS/);
  assert.match(adminUsersSource, /صلاحيات الجوال المخصصة/);
  assert.match(adminUsersSource, /permissions:\s*payload\.permissions/);
});

test("both navigation and every user-management route use the admin capability", () => {
  assert.match(appSource, /hasAppCapability\(currentRole, "users\.manage", permissions\)/);
  assert.match(appSource, /adminUsers:\s*canManageUsers/);
  assert.doesNotMatch(serverSource, /requireRole\(\["admin",\s*"manager"\]\)/);
  assert.equal((serverSource.match(/requireCapability\("users\.manage"\)/g) || []).length, 6);
});
