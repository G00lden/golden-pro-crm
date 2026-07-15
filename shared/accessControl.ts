export const APP_ROLES = ["admin", "manager", "sales", "technician", "user"] as const;

export type AppRole = (typeof APP_ROLES)[number];

export type AppCapability =
  | "users.manage"
  | "whatsapp.manage"
  | "campaigns.manage"
  | "calls.manage"
  | "mobile.devices.view"
  | "mobile.devices.pair"
  | "mobile.devices.manage"
  | "mobile.calls.view"
  | "mobile.calls.execute"
  | "mobile.contacts.sync"
  | "mobile.tasks.update"
  | "mobile.reply_policy.manage"
  | "mobile.tests.send"
  | "mobile.device.lock"
  | "mobile.device.wipe"
  | "public_leads.manage"
  | "operations.prepare"
  | "demo.seed";

const CAPABILITY_ROLES: Record<AppCapability, ReadonlySet<AppRole>> = {
  "users.manage": new Set(["admin"]),
  "whatsapp.manage": new Set(["admin"]),
  "campaigns.manage": new Set(["admin", "manager"]),
  "calls.manage": new Set(["admin", "manager"]),
  "mobile.devices.view": new Set(["admin", "manager", "sales", "technician", "user"]),
  "mobile.devices.pair": new Set(["admin", "manager"]),
  "mobile.devices.manage": new Set(["admin", "manager"]),
  "mobile.calls.view": new Set(["admin", "manager", "sales", "technician"]),
  "mobile.calls.execute": new Set(["admin", "manager", "sales", "technician"]),
  "mobile.contacts.sync": new Set(["admin", "manager", "sales", "technician"]),
  "mobile.tasks.update": new Set(["admin", "manager", "sales", "technician"]),
  "mobile.reply_policy.manage": new Set(["admin", "manager"]),
  "mobile.tests.send": new Set(["admin"]),
  "mobile.device.lock": new Set(["admin"]),
  "mobile.device.wipe": new Set(["admin"]),
  "public_leads.manage": new Set(["admin", "manager"]),
  "operations.prepare": new Set(["admin", "manager"]),
  "demo.seed": new Set(["admin"]),
};

export function normalizeAppRole(role: unknown): AppRole {
  const value = String(role || "").trim().toLowerCase();
  // "viewer" is a UI/business label; the persisted least-privilege role is "user".
  if (value === "viewer") return "user";
  return APP_ROLES.includes(value as AppRole) ? value as AppRole : "user";
}

export function hasAppCapability(
  role: unknown,
  capability: AppCapability,
  permissions: Record<string, boolean> = {},
): boolean {
  if (typeof permissions[capability] === "boolean") return permissions[capability];
  return CAPABILITY_ROLES[capability].has(normalizeAppRole(role));
}

export function isProductionEnvironment(environment: unknown): boolean {
  return String(environment || "").trim().toLowerCase() === "production";
}
