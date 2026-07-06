import crypto from "crypto";
import type { NextFunction, Request, Response } from "express";
import { adminAuth } from "./firebaseAdmin";
import { ensureUserRecord, getUserByUid, type UserRole } from "./userManagement";
import { logError, logEvent } from "./logger";

const DEFAULT_LOCAL_UID = "local-dev-owner";

function localSharedUid() {
  return process.env.LOCAL_AUTH_SHARED_UID || DEFAULT_LOCAL_UID;
}

/** Constant-time string comparison that also hides length differences. */
function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

let warnedOpenLocalAuth = false;

/**
 * Resolve the uid carried by a `local-dev:` bearer token.
 *
 * Two modes, selected by whether LOCAL_AUTH_TOKEN is configured:
 *
 *  - LOCAL_AUTH_TOKEN unset (default — behavior unchanged): the token is
 *    `local-dev:<uid>` and any caller may pick any uid. Fine for a laptop-only
 *    dev box, but OPEN if the server is reachable beyond localhost (e.g. behind
 *    a public tunnel). We log a one-time warning nudging the operator to set a
 *    shared secret.
 *  - LOCAL_AUTH_TOKEN set (opt-in hardening): the token must be
 *    `local-dev:<uid>:<secret>` and <secret> must match LOCAL_AUTH_TOKEN
 *    (constant-time). Tokens without the correct secret are rejected — closing
 *    the "anyone can send local-dev:<owner> and become admin" hole. The secret
 *    must not contain a colon (use a hex / base64url token).
 *
 * Returns the resolved uid, or null when the token must be rejected.
 */
function resolveLocalUid(token: string): string | null {
  const rest = token.slice("local-dev:".length);
  const requiredSecret = process.env.LOCAL_AUTH_TOKEN || "";

  if (requiredSecret) {
    const sep = rest.lastIndexOf(":");
    const provided = sep >= 0 ? rest.slice(sep + 1) : "";
    const uidPart = sep >= 0 ? rest.slice(0, sep) : "";
    if (!provided || !safeEqual(provided, requiredSecret)) {
      return null;
    }
    return uidPart.trim() || localSharedUid();
  }

  if (!warnedOpenLocalAuth) {
    warnedOpenLocalAuth = true;
    logEvent("warn", "auth.local_token_open", {
      message:
        "Local-dev auth accepts any uid because LOCAL_AUTH_TOKEN is unset. " +
        "If this server is reachable beyond localhost (e.g. a tunnel), set " +
        "LOCAL_AUTH_TOKEN (and VITE_LOCAL_AUTH_TOKEN) to require a shared secret.",
    });
  }
  return rest.trim() || localSharedUid();
}

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
    const uid = resolveLocalUid(token);
    if (uid === null) {
      return res.status(401).json({ error: "Invalid local authentication token." });
    }
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
        role: uid === localSharedUid() ? "admin" as UserRole : "user" as UserRole,
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
