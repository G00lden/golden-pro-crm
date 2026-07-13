export const APP_ROLES = ["admin", "manager", "sales", "technician", "user"] as const;

export type AppRole = (typeof APP_ROLES)[number];

export type AppCapability =
  | "users.manage"
  | "whatsapp.manage"
  | "campaigns.manage"
  | "calls.manage"
  | "public_leads.manage"
  | "operations.prepare"
  | "demo.seed";

const CAPABILITY_ROLES: Record<AppCapability, ReadonlySet<AppRole>> = {
  "users.manage": new Set(["admin"]),
  "whatsapp.manage": new Set(["admin"]),
  "campaigns.manage": new Set(["admin", "manager"]),
  "calls.manage": new Set(["admin", "manager"]),
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

export function hasAppCapability(role: unknown, capability: AppCapability): boolean {
  return CAPABILITY_ROLES[capability].has(normalizeAppRole(role));
}

export function isProductionEnvironment(environment: unknown): boolean {
  return String(environment || "").trim().toLowerCase() === "production";
}
