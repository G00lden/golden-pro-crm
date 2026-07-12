import db from "../server/db";
import { ensureUserRecord } from "../server/userManagement";

const localOwner = ensureUserRecord({ uid: "local-owner", email: null, name: "Owner", provider: "local-dev" });
const localUser = ensureUserRecord({ uid: "local-user", email: null, name: "User", provider: "local-dev" });
if (localOwner.role !== "admin" || localUser.role !== "user") throw new Error("Local roles are incorrect.");
if (localOwner.email !== null || localUser.email !== null) throw new Error("Local test identities must not share a synthetic email.");

const firstRegistrant = ensureUserRecord({
  uid: "firebase-first",
  email: "first@example.com",
  name: "First",
  provider: "password",
  emailVerified: true,
});
if (firstRegistrant.role !== "user") throw new Error("First registrant was promoted without explicit authorization.");

const bootstrapAdmin = ensureUserRecord({
  uid: "firebase-owner",
  email: "OWNER@EXAMPLE.COM",
  name: "Configured owner",
  provider: "google.com",
  emailVerified: true,
});
if (bootstrapAdmin.role !== "admin" || bootstrapAdmin.email !== "owner@example.com") {
  throw new Error("Configured bootstrap admin was not normalized and promoted.");
}

db.prepare(`
  INSERT INTO users (id, uid, name, email, phone, password_hash, role, permissions, active, provider, created_at, updated_at)
  VALUES ('invited', NULL, 'Invited', 'Invite@Example.com', '', '', 'manager', '{}', 1, 'manual', datetime('now'), datetime('now'))
`).run();
const invited = ensureUserRecord({
  uid: "firebase-invited",
  email: "invite@example.com",
  name: "Invited login",
  provider: "google.com",
  emailVerified: true,
});
if (invited.id !== "invited" || invited.role !== "manager" || invited.uid !== "firebase-invited") {
  throw new Error("Verified email did not link to the case-insensitive invitation.");
}

const users = db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number };
db.close();
console.log(JSON.stringify({ users: users.count, roles: [localOwner.role, localUser.role, firstRegistrant.role, bootstrapAdmin.role, invited.role] }));
