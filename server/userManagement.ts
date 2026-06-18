import crypto from "crypto";
import type { Express, NextFunction, Request, Response } from "express";
import db from "./db";
import type { AuthedRequest } from "./auth";

export type UserRole = "admin" | "manager" | "technician" | "user";

const ROLES: ReadonlyArray<UserRole> = ["admin", "manager", "technician", "user"];

export type ManagedUser = {
  id: string;
  uid: string | null;
  name: string;
  email: string | null;
  phone: string;
  role: UserRole;
  permissions: Record<string, boolean>;
  active: boolean;
  provider: string;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
};

type Row = {
  id: string;
  uid: string | null;
  name: string;
  email: string | null;
  phone: string;
  role: string | null;
  permissions: string | null;
  active: number | null;
  provider: string | null;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
};

function nowIso() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function newId() {
  return `usr_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function parsePermissions(raw: string | null | undefined): Record<string, boolean> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, v]) => [key, Boolean(v)]),
      );
    }
  } catch {
    // fall through
  }
  return {};
}

function normalizeRole(value: unknown): UserRole {
  const v = String(value || "").toLowerCase();
  return (ROLES as ReadonlyArray<string>).includes(v) ? (v as UserRole) : "user";
}

function rowToUser(row: Row | undefined): ManagedUser | null {
  if (!row) return null;
  return {
    id: row.id,
    uid: row.uid,
    name: row.name || "",
    email: row.email,
    phone: row.phone || "",
    role: normalizeRole(row.role),
    permissions: parsePermissions(row.permissions),
    active: row.active === null ? true : row.active === 1,
    provider: row.provider || "firebase",
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_login_at: row.last_login_at,
  };
}

export function getUserByUid(uid: string): ManagedUser | null {
  const row = db.prepare("SELECT * FROM users WHERE uid = ?").get(uid) as Row | undefined;
  return rowToUser(row);
}

export function getUserByEmail(email: string): ManagedUser | null {
  const row = db.prepare("SELECT * FROM users WHERE email = ?").get(email) as Row | undefined;
  return rowToUser(row);
}

export function getUserById(id: string): ManagedUser | null {
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Row | undefined;
  return rowToUser(row);
}

export function countUsers(): number {
  const row = db.prepare("SELECT COUNT(*) AS c FROM users").get() as { c: number };
  return Number(row?.c || 0);
}

function countFirebaseAdmins(): number {
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND IFNULL(provider,'') NOT IN ('local-dev','manual')")
    .get() as { c: number };
  return Number(row?.c || 0);
}

export function listUsers(filter: { search?: string; role?: string; active?: boolean } = {}): ManagedUser[] {
  const where: string[] = [];
  const args: unknown[] = [];

  if (filter.search) {
    where.push("(LOWER(name) LIKE ? OR LOWER(IFNULL(email,'')) LIKE ? OR phone LIKE ?)");
    const needle = `%${filter.search.toLowerCase()}%`;
    args.push(needle, needle, `%${filter.search}%`);
  }
  if (filter.role && (ROLES as ReadonlyArray<string>).includes(filter.role)) {
    where.push("role = ?");
    args.push(filter.role);
  }
  if (typeof filter.active === "boolean") {
    where.push("active = ?");
    args.push(filter.active ? 1 : 0);
  }

  const sql = `SELECT * FROM users${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT 500`;
  const rows = db.prepare(sql).all(...args) as Row[];
  return rows.map((row) => rowToUser(row)).filter((u): u is ManagedUser => u !== null);
}

export type EnsureUserInput = {
  uid: string;
  email?: string | null;
  name?: string | null;
  provider?: string;
};

export function ensureUserRecord(input: EnsureUserInput): ManagedUser {
  const existing = getUserByUid(input.uid);
  if (existing) {
    db.prepare("UPDATE users SET last_login_at = ?, updated_at = ? WHERE uid = ?").run(
      nowIso(),
      nowIso(),
      input.uid,
    );
    return { ...existing, last_login_at: nowIso() };
  }

  const byEmail = input.email ? getUserByEmail(input.email) : null;
  if (byEmail && !byEmail.uid) {
    db.prepare(
      "UPDATE users SET uid = ?, last_login_at = ?, updated_at = ?, provider = COALESCE(provider, ?) WHERE id = ?",
    ).run(input.uid, nowIso(), nowIso(), input.provider || "firebase", byEmail.id);
    return { ...byEmail, uid: input.uid, last_login_at: nowIso() };
  }

  const provider = input.provider || "firebase";
  const isLocalDev = provider === "local-dev";
  const localOwnerUid = process.env.LOCAL_AUTH_SHARED_UID || "local-dev-owner";
  // Seed-admin rule:
  //   * The configured local-dev owner remains admin for single-tenant demos.
  //   * Arbitrary local-dev:<uid> identities join as users.
  //   * The FIRST real Firebase/Google sign-in becomes admin if no Firebase admin exists yet.
  //   * Everyone afterwards joins as "user" and must be promoted by an admin.
  const role: UserRole =
    (isLocalDev && input.uid === localOwnerUid) || (!isLocalDev && countFirebaseAdmins() === 0)
      ? "admin"
      : "user";
  const id = newId();
  db.prepare(
    `INSERT INTO users (id, uid, name, email, phone, password_hash, role, permissions, active, provider, created_at, updated_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, '', ?, '{}', 1, ?, ?, ?, ?)`,
  ).run(
    id,
    input.uid,
    (input.name || input.email || "").trim() || "مستخدم",
    input.email || null,
    "",
    role,
    provider,
    nowIso(),
    nowIso(),
    nowIso(),
  );
  return getUserByUid(input.uid)!;
}

function updateUserFields(id: string, fields: Partial<{
  name: string;
  email: string | null;
  phone: string;
  role: UserRole;
  permissions: Record<string, boolean>;
  active: boolean;
}>) {
  const set: string[] = [];
  const args: unknown[] = [];

  if (fields.name !== undefined) {
    set.push("name = ?");
    args.push(String(fields.name).trim());
  }
  if (fields.email !== undefined) {
    set.push("email = ?");
    args.push(fields.email ? String(fields.email).trim().toLowerCase() : null);
  }
  if (fields.phone !== undefined) {
    set.push("phone = ?");
    args.push(String(fields.phone).trim());
  }
  if (fields.role !== undefined) {
    set.push("role = ?");
    args.push(normalizeRole(fields.role));
  }
  if (fields.permissions !== undefined) {
    set.push("permissions = ?");
    args.push(JSON.stringify(fields.permissions || {}));
  }
  if (fields.active !== undefined) {
    set.push("active = ?");
    args.push(fields.active ? 1 : 0);
  }

  if (set.length === 0) return getUserById(id);

  set.push("updated_at = ?");
  args.push(nowIso());
  args.push(id);

  db.prepare(`UPDATE users SET ${set.join(", ")} WHERE id = ?`).run(...args);
  return getUserById(id);
}

export function requireRole(allowed: UserRole[]) {
  return function roleGuard(req: Request, res: Response, next: NextFunction) {
    const user = (req as AuthedRequest).user;
    if (!user) {
      res.status(401).json({ error: "Authentication required." });
      return;
    }
    if (!allowed.includes(user.role as UserRole)) {
      res.status(403).json({ error: "ليست لديك الصلاحية الكافية لتنفيذ هذا الإجراء." });
      return;
    }
    next();
  };
}

export function requirePermission(permission: string) {
  return function permissionGuard(req: Request, res: Response, next: NextFunction) {
    const user = (req as AuthedRequest).user;
    if (!user) {
      res.status(401).json({ error: "Authentication required." });
      return;
    }
    if (user.role === "admin") return next();
    if (user.permissions?.[permission]) return next();
    res.status(403).json({ error: `صلاحية ${permission} غير متوفرة لحسابك.` });
  };
}

function publicUser(user: ManagedUser) {
  return user;
}

export function registerUserAdminRoutes(app: Express) {
  app.get("/api/me", (req, res) => {
    const user = (req as AuthedRequest).user;
    if (!user) {
      res.status(401).json({ error: "Authentication required." });
      return;
    }
    const record = getUserByUid(user.uid);
    res.json({
      uid: user.uid,
      email: user.email || record?.email || null,
      name: user.name || record?.name || "",
      role: (record?.role || user.role || "user") as UserRole,
      permissions: record?.permissions || user.permissions || {},
      active: record?.active ?? true,
      record,
    });
  });

  app.get("/api/admin/users", requireRole(["admin", "manager"]), (req, res) => {
    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    const role = typeof req.query.role === "string" ? req.query.role : undefined;
    const activeQ = typeof req.query.active === "string" ? req.query.active : undefined;
    const active =
      activeQ === "true" ? true : activeQ === "false" ? false : undefined;
    const users = listUsers({ search, role, active });
    res.json({ users: users.map(publicUser) });
  });

  app.post("/api/admin/users", requireRole(["admin"]), (req, res) => {
    const body = (req.body || {}) as {
      name?: string;
      email?: string;
      phone?: string;
      role?: UserRole;
      permissions?: Record<string, boolean>;
      uid?: string;
    };

    const email = body.email ? String(body.email).trim().toLowerCase() : null;
    if (!body.name && !email) {
      res.status(400).json({ error: "الاسم أو البريد مطلوب لإنشاء المستخدم." });
      return;
    }

    if (email && getUserByEmail(email)) {
      res.status(409).json({ error: "هذا البريد مسجّل بالفعل." });
      return;
    }

    const id = newId();
    const role = normalizeRole(body.role);
    db.prepare(
      `INSERT INTO users (id, uid, name, email, phone, password_hash, role, permissions, active, provider, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '', ?, ?, 1, 'manual', ?, ?)`,
    ).run(
      id,
      body.uid ? String(body.uid) : null,
      String(body.name || email || "").trim() || "مستخدم",
      email,
      String(body.phone || "").trim(),
      role,
      JSON.stringify(body.permissions || {}),
      nowIso(),
      nowIso(),
    );

    res.status(201).json({ user: getUserById(id) });
  });

  app.put("/api/admin/users/:id", requireRole(["admin"]), (req, res) => {
    const id = req.params.id;
    if (!getUserById(id)) {
      res.status(404).json({ error: "المستخدم غير موجود." });
      return;
    }
    const body = (req.body || {}) as Partial<{
      name: string;
      email: string | null;
      phone: string;
      role: UserRole;
      permissions: Record<string, boolean>;
      active: boolean;
    }>;
    const updated = updateUserFields(id, body);
    res.json({ user: updated });
  });

  app.post("/api/admin/users/:id/deactivate", requireRole(["admin"]), (req, res) => {
    const id = req.params.id;
    if (!getUserById(id)) {
      res.status(404).json({ error: "المستخدم غير موجود." });
      return;
    }
    const updated = updateUserFields(id, { active: false });
    res.json({ user: updated });
  });

  app.post("/api/admin/users/:id/activate", requireRole(["admin"]), (req, res) => {
    const id = req.params.id;
    if (!getUserById(id)) {
      res.status(404).json({ error: "المستخدم غير موجود." });
      return;
    }
    const updated = updateUserFields(id, { active: true });
    res.json({ user: updated });
  });

  app.delete("/api/admin/users/:id", requireRole(["admin"]), (req, res) => {
    const id = req.params.id;
    const target = getUserById(id);
    if (!target) {
      res.status(404).json({ error: "المستخدم غير موجود." });
      return;
    }
    const me = (req as AuthedRequest).user;
    if (target.uid && me && target.uid === me.uid) {
      res.status(400).json({ error: "لا يمكنك حذف حسابك أثناء استخدامه." });
      return;
    }
    db.prepare("DELETE FROM users WHERE id = ?").run(id);
    res.json({ success: true });
  });
}
