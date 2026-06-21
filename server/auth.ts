import type { NextFunction, Request, Response } from "express";
import { adminAuth } from "./firebaseAdmin";
import { ensureUserRecord, getUserByUid, type UserRole } from "./userManagement";
import { logError } from "./logger";

export type AuthedRequest = Request & {
  user: {
    uid: string;
    email?: string;
    name?: string;
    role: UserRole;
    permissions: Record<string, boolean>;
    active: boolean;
    local: boolean;
  };
};

function attachUser(req: Request, payload: AuthedRequest["user"]) {
  (req as AuthedRequest).user = payload;
}

export async function requireFirebaseUser(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    return res.status(401).json({ error: "Authentication token is required." });
  }

    const token = match[1].trim();
  const dbProvider = process.env.DATA_PROVIDER || process.env.DB_PROVIDER || "firebase";
  const allowLocalAuth = process.env.ALLOW_LOCAL_AUTH === "true" || dbProvider === "sqlite";

  // Local-dev / Demo token shortcut. Honored when:
  //   * ALLOW_LOCAL_AUTH=true outside production, OR
  //   * the server is running in SQLite mode (single-tenant local DB, no Firebase project required).
  // Real production deployments backed by Firebase/Firestore must use a real Firebase ID token.
  if (token.startsWith("local-dev:")) {
    if (!allowLocalAuth) {
      return res.status(401).json({ error: "Local development tokens are disabled." });
    }
    const uid = token.slice("local-dev:".length).trim() || process.env.LOCAL_AUTH_SHARED_UID || "local-dev-owner";
    try {
      const record = ensureUserRecord({
        uid,
        email: "local@golden-pro-crm.dev",
        name: "Local user",
        provider: "local-dev",
      });
      if (!record.active) {
        return res.status(403).json({ error: "تم تعليق حسابك. تواصل مع المسؤول." });
      }
      attachUser(req, {
        uid,
        email: record.email || "local@golden-pro-crm.dev",
        name: record.name || "Local user",
        role: record.role,
        permissions: record.permissions,
        active: record.active,
        local: true,
      });
      return next();
    } catch (err) {
      logError("auth.ensure_user_record_failed", err, { uid });
      // Fallback: create user with basic info directly
      attachUser(req, {
        uid,
        email: "local@golden-pro-crm.dev",
        name: "Local user",
        role: uid === (process.env.LOCAL_AUTH_SHARED_UID || "local-dev-owner") ? "admin" as UserRole : "user" as UserRole,
        permissions: {},
        active: true,
        local: true,
      });
      return next();
    }
  }

  // Firebase ID token path (the only path for real users in production).
  try {
    const decoded = await adminAuth.verifyIdToken(token);
    const uid = decoded.uid;
    const email = decoded.email || null;
    const name = (decoded as { name?: string }).name || decoded.email || "";

    const record = ensureUserRecord({
      uid,
      email,
      name,
      provider: (decoded.firebase as { sign_in_provider?: string })?.sign_in_provider || "firebase",
    });

    if (!record.active) {
      return res.status(403).json({ error: "تم تعليق حسابك. تواصل مع المسؤول." });
    }

    attachUser(req, {
      uid,
      email: record.email || decoded.email || "",
      name: record.name || name,
      role: record.role,
      permissions: record.permissions,
      active: record.active,
      local: false,
    });
    return next();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("firebase admin")) {
      return res.status(500).json({ error: "Firebase Admin غير مهيأ على السيرفر." });
    }
    return res.status(401).json({ error: "Invalid or expired authentication token." });
  }
}

export function loadAuthedUser(req: Request) {
  return (req as AuthedRequest).user;
}

export { getUserByUid };
