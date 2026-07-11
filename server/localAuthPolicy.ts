import crypto from "node:crypto";

const MINIMUM_SECRET_LENGTH = 32;
const LOCAL_UID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const DEFAULT_ALLOWED_HOSTS = ["localhost", "127.0.0.1", "::1"];

type Environment = Record<string, string | undefined>;

export type LocalAuthPolicy = {
  requested: boolean;
  enabled: boolean;
  secret: string;
  allowedHosts: ReadonlySet<string>;
  reason: string | null;
};

export function getLocalAuthPolicy(env: Environment = process.env): LocalAuthPolicy {
  const requested = env.ALLOW_LOCAL_AUTH === "true";
  const production = env.NODE_ENV === "production";
  const secret = String(env.LOCAL_AUTH_TOKEN || "").trim();
  const allowedHosts = new Set(
    String(env.LOCAL_AUTH_ALLOWED_HOSTS || DEFAULT_ALLOWED_HOSTS.join(","))
      .split(",")
      .map((value) => value.trim().replace(/^\[|\]$/g, "").toLowerCase())
      .filter(Boolean),
  );

  let reason: string | null = null;
  if (!requested) reason = "ALLOW_LOCAL_AUTH is not enabled.";
  else if (production) reason = "Local authentication is forbidden in production.";
  else if (secret.length < MINIMUM_SECRET_LENGTH) {
    reason = `LOCAL_AUTH_TOKEN must contain at least ${MINIMUM_SECRET_LENGTH} characters.`;
  } else if (allowedHosts.size === 0) reason = "No local authentication hosts are allowed.";

  return { requested, enabled: reason === null, secret, allowedHosts, reason };
}

export function isLoopbackAddress(address: string | undefined) {
  const normalized = String(address || "").trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "::ffff:127.0.0.1";
}

export function isAllowedLocalRequest(
  hostname: string,
  remoteAddress: string | undefined,
  policy: LocalAuthPolicy,
) {
  const normalizedHost = String(hostname || "").trim().replace(/^\[|\]$/g, "").toLowerCase();
  return policy.enabled && policy.allowedHosts.has(normalizedHost) && isLoopbackAddress(remoteAddress);
}

export function createSignedLocalToken(uid: string, secret: string, now = Date.now()) {
  if (!LOCAL_UID_PATTERN.test(uid)) throw new Error("Invalid local user id.");
  if (secret.length < MINIMUM_SECRET_LENGTH) throw new Error("Local authentication secret is too short.");
  const expiresAt = Math.floor(now / 1000) + 15 * 60;
  const payload = `${uid}:${expiresAt}`;
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `local-dev:${payload}:${signature}`;
}

export function verifySignedLocalToken(token: string, secret: string, now = Date.now()) {
  const match = /^local-dev:([A-Za-z0-9_-]{1,80}):(\d{10}):([a-f0-9]{64})$/.exec(token);
  if (!match || secret.length < MINIMUM_SECRET_LENGTH) return null;
  const [, uid, expiresAtText, providedSignature] = match;
  const expiresAt = Number(expiresAtText);
  if (!Number.isFinite(expiresAt) || expiresAt < Math.floor(now / 1000)) return null;

  const expected = crypto.createHmac("sha256", secret).update(`${uid}:${expiresAt}`).digest();
  const provided = Buffer.from(providedSignature, "hex");
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return null;
  return uid;
}
