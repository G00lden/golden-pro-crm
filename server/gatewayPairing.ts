import crypto from "crypto";
import db from "./db";

const PAIRING_TTL_MS = 10 * 60 * 1000;
const DEVICE_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export type GatewayDevice = {
  id: string;
  name: string;
  company_number: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
};

type PairingRow = {
  id: string;
  owner_uid: string;
  expires_at: string;
};

function gatewaySigningSecret(): string {
  return (
    process.env.GATEWAY_DEVICE_HMAC_SECRET ||
    process.env.GATEWAY_TOKEN ||
    process.env.TELEPHONY_WEBHOOK_SECRET ||
    ""
  ).trim();
}

function fingerprint(kind: "pair" | "device" | "nonce" | "issued-token", value: string): string {
  const secret = gatewaySigningSecret();
  if (!secret) throw new Error("Gateway credential signing is not configured.");
  return crypto.createHmac("sha256", secret).update(`${kind}:${value}`, "utf8").digest("base64url");
}

function tokenForDevice(deviceId: string): string {
  return `${deviceId}.${fingerprint("issued-token", deviceId)}`;
}

function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function iso(time: number): string {
  return new Date(time).toISOString();
}

export function gatewayDeviceAuthConfigured(): boolean {
  return Boolean(gatewaySigningSecret());
}

export function createGatewayPairingCode(
  ownerUid: string,
  createdBy: string,
  options: { now?: number; ttlMs?: number } = {},
) {
  if (!gatewayDeviceAuthConfigured()) {
    throw new Error("GATEWAY_TOKEN or GATEWAY_DEVICE_HMAC_SECRET must be configured first.");
  }

  const now = options.now ?? Date.now();
  const expiresAt = iso(now + (options.ttlMs ?? PAIRING_TTL_MS));
  const code = crypto.randomInt(0, 100_000_000).toString().padStart(8, "0");
  const id = `gpc_${crypto.randomBytes(12).toString("base64url")}`;

  const create = db.transaction(() => {
    // A fresh code invalidates earlier unused codes for this CRM owner. This
    // keeps the mobile flow unambiguous and limits the number of live secrets.
    db.prepare(`
      UPDATE gateway_pairing_codes
      SET used_at = ?
      WHERE owner_uid = ? AND used_at IS NULL
    `).run(iso(now), ownerUid);
    db.prepare(`
      INSERT INTO gateway_pairing_codes
        (id, owner_uid, code_hash, expires_at, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, ownerUid, fingerprint("pair", code), expiresAt, createdBy, iso(now));
  });
  create();

  return { code, expiresAt };
}

export function redeemGatewayPairingCode(input: {
  code: string;
  deviceName: string;
  companyNumber?: string;
  clientNonce: string;
  now?: number;
}): { token: string; deviceId: string; ownerUid: string } | null {
  if (!gatewayDeviceAuthConfigured()) return null;

  const now = input.now ?? Date.now();
  const nowIso = iso(now);
  const codeHash = fingerprint("pair", input.code);
  const nonceHash = fingerprint("nonce", input.clientNonce);
  const replay = db.prepare(`
    SELECT d.id, d.owner_uid
    FROM gateway_pairing_codes p
    JOIN gateway_devices d ON d.pairing_code_id = p.id
    WHERE p.code_hash = ?
      AND p.expires_at > ?
      AND d.pairing_nonce_hash = ?
      AND d.revoked_at IS NULL
    ORDER BY d.created_at DESC
    LIMIT 1
  `).get(codeHash, nowIso, nonceHash) as { id: string; owner_uid: string } | undefined;
  if (replay) {
    return { token: tokenForDevice(replay.id), deviceId: replay.id, ownerUid: replay.owner_uid };
  }

  const row = db.prepare(`
    SELECT id, owner_uid, expires_at
    FROM gateway_pairing_codes
    WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(codeHash, nowIso) as PairingRow | undefined;
  if (!row) return null;

  const deviceId = `gwd_${crypto.randomBytes(12).toString("base64url")}`;
  const token = tokenForDevice(deviceId);

  const claim = db.transaction(() => {
    const used = db.prepare(`
      UPDATE gateway_pairing_codes
      SET used_at = ?
      WHERE id = ? AND used_at IS NULL AND expires_at > ?
    `).run(nowIso, row.id, nowIso);
    if (used.changes !== 1) return false;

    db.prepare(`
      INSERT INTO gateway_devices
        (id, owner_uid, name, company_number, token_hash, pairing_code_id, pairing_nonce_hash, last_seen_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      deviceId,
      row.owner_uid,
      input.deviceName.trim(),
      (input.companyNumber || "").trim(),
      fingerprint("device", token),
      row.id,
      nonceHash,
      nowIso,
      nowIso,
    );
    return true;
  });

  return claim() ? { token, deviceId, ownerUid: row.owner_uid } : null;
}

export function verifyGatewayDeviceToken(ownerUid: string, token: string, now = Date.now()): boolean {
  if (!gatewayDeviceAuthConfigured()) return false;
  const match = token.match(/^(gwd_[A-Za-z0-9_-]{16})\.[A-Za-z0-9_-]{40,}$/);
  if (!match) return false;

  const row = db.prepare(`
    SELECT token_hash
    FROM gateway_devices
    WHERE id = ? AND owner_uid = ? AND revoked_at IS NULL
  `).get(match[1], ownerUid) as { token_hash: string } | undefined;
  if (!row || !safeEquals(row.token_hash, fingerprint("device", token))) return false;

  db.prepare(`
    UPDATE gateway_devices
    SET last_seen_at = ?
    WHERE id = ? AND (
      last_seen_at IS NULL OR last_seen_at < ?
    )
  `).run(iso(now), match[1], iso(now - DEVICE_TOUCH_INTERVAL_MS));
  return true;
}

export function listGatewayDevices(ownerUid: string): GatewayDevice[] {
  return db.prepare(`
    SELECT id, name, company_number, created_at, last_seen_at, revoked_at
    FROM gateway_devices
    WHERE owner_uid = ?
    ORDER BY revoked_at IS NULL DESC, created_at DESC
  `).all(ownerUid) as GatewayDevice[];
}

export function revokeGatewayDevice(ownerUid: string, deviceId: string, now = Date.now()): boolean {
  const result = db.prepare(`
    UPDATE gateway_devices
    SET revoked_at = ?
    WHERE id = ? AND owner_uid = ? AND revoked_at IS NULL
  `).run(iso(now), deviceId, ownerUid);
  return result.changes === 1;
}

export function activeGatewayDeviceCount(ownerUid: string): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM gateway_devices
    WHERE owner_uid = ? AND revoked_at IS NULL
  `).get(ownerUid) as { count: number };
  return row.count;
}
