import type { Express, NextFunction, Request, Response } from "express";
import { adminAuth } from "./firebaseAdmin";
import { ensureUserRecord, getUserByUid, type UserRole } from "./userManagement";
import { logError } from "./logger";
import {
  createSignedLocalToken,
  getLocalAuthPolicy,
  isAllowedLocalRequest,
  verifySignedLocalToken,
} from "./localAuthPolicy";

const DEFAULT_LOCAL_UID = "local-dev-owner";

function localSharedUid() {
  return process.env.LOCAL_AUTH_SHARED_UID || DEFAULT_LOCAL_UID;
}

export function registerLocalDevAuthRoute(app: Express) {
  app.post("/api/dev/local-token", (req, res) => {
    const policy = getLocalAuthPolicy();
    if (!isAllowedLocalRequest(req.hostname, req.socket.remoteAddress, policy)) {
      res.status(404).json({ error: "Not found." });
      return;
    }

    const uid = String(req.body?.uid || localSharedUid()).trim();
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json({ token: createSignedLocalToken(uid, policy.secret) });
    } catch {
      res.status(400).json({ error: "Invalid local user id." });
    }
  });
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
    authTime?: number;
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

  // Local tokens are development/test-only, short-lived, signed, and accepted
  // only over a loopback connection with an allowlisted Host header.
  if (token.startsWith("local-dev:")) {
    const policy = getLocalAuthPolicy();
    if (!isAllowedLocalRequest(req.hostname, req.socket.remoteAddress, policy)) {
      return res.status(401).json({ error: "Local development tokens are disabled." });
    }
    const uid = verifySignedLocalToken(token, policy.secret);
    if (uid === null) {
      return res.status(401).json({ error: "Invalid local authentication token." });
    }
    try {
      const record = ensureUserRecord({
        uid,
        email: null,
        name: "Local user",
        provider: "local-dev",
      });
      if (!record.active) {
        return res.status(403).json({ error: "تم تعليق حسابك. تواصل مع المسؤول." });
      }
      attachUser(req, {
        uid,
        email: record.email || undefined,
        name: record.name || "Local user",
        role: record.role,
        permissions: record.permissions,
        active: record.active,
        local: true,
        authTime: Date.now(),
      });
      return next();
    } catch (err) {
      logError("auth.ensure_user_record_failed", err, { uid });
      return res.status(500).json({ error: "Unable to initialize the local test user." });
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
      // Only trust the email for account-linking / first-admin seeding when
      // Firebase says it's verified — otherwise an unverified email matching a
      // pre-provisioned invite could inherit that account's role.
      emailVerified: (decoded as { email_verified?: boolean }).email_verified === true,
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
      authTime: Number(decoded.auth_time || 0) * 1000,
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
