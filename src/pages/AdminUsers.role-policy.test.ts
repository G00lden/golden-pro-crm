import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const adminUsersSource = readFileSync(new URL("./AdminUsers.tsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../../server/userManagement.ts", import.meta.url), "utf8");

test("user administration is role-based and does not present inactive custom permissions", () => {
  assert.match(adminUsersSource, /<span>الدور<\/span>/);
  assert.match(adminUsersSource, /ROLE_OPTIONS\.map/);
  assert.doesNotMatch(adminUsersSource, /PERMISSION_OPTIONS/);
  assert.doesNotMatch(adminUsersSource, /صلاحيات إضافية/);
  assert.doesNotMatch(adminUsersSource, /permissions:\s*payload\.permissions/);
});

test("both navigation and every user-management route use the admin capability", () => {
  assert.match(appSource, /hasAppCapability\(currentRole, "users\.manage"\)/);
  assert.match(appSource, /adminUsers:\s*canManageUsers/);
  assert.doesNotMatch(serverSource, /requireRole\(\["admin",\s*"manager"\]\)/);
  assert.equal((serverSource.match(/requireCapability\("users\.manage"\)/g) || []).length, 6);
});
