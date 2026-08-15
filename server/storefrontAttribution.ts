import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { adminDb } from "./firebaseAdmin";
import { compareAndSetDocument } from "./atomicDocumentUpdate";
import { deliverOrderAnalytics } from "./orderAnalytics";
import { getStoreOrderDocId, type StoreOrderAttribution } from "./storeWebhook";

export type StorefrontAttributionClaimInput = {
  checkoutId: string;
  claimNonce: string;
  attribution: StoreOrderAttribution;
};

export type StorefrontOrderAttributionInput = {
  orderId: string;
  checkoutId: string;
  claimToken: string;
  total: number;
  currency: string;
};

export class StorefrontAttributionError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "StorefrontAttributionError";
    this.status = status;
  }
}

const defaultStorefrontOrigins = ["https://goldenksa.store", "https://www.goldenksa.store"];

function clean(value: unknown, max: number) {
  return String(value ?? "").trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max);
}

function optionalCampaignValue(value: unknown) {
  const normalized = clean(value, 200);
  return normalized || undefined;
}

function optionalClickId(value: unknown) {
  const normalized = clean(value, 200);
  if (!normalized) return undefined;
  if (!/^[A-Za-z0-9._~-]{6,200}$/.test(normalized)) {
    throw new StorefrontAttributionError(422, "Invalid advertising click identifier.");
  }
  return normalized;
}

function requiredCheckoutId(value: unknown) {
  const checkoutId = clean(value, 100);
  if (!/^[A-Za-z0-9._:-]{6,100}$/.test(checkoutId)) {
    throw new StorefrontAttributionError(422, "A valid checkout identifier is required.");
  }
  return checkoutId;
}

function normalizeAttributionFields(record: Record<string, unknown>) {
  const clientId = clean(record.client_id, 80);
  if (!/^\d{1,20}\.\d{1,20}$/.test(clientId)) {
    throw new StorefrontAttributionError(422, "A valid consented GA client identifier is required.");
  }
  const sessionId = clean(record.session_id, 40);
  if (sessionId && !/^\d{1,20}$/.test(sessionId)) {
    throw new StorefrontAttributionError(422, "Invalid GA session identifier.");
  }
  const gclid = optionalClickId(record.gclid);
  const gbraid = optionalClickId(record.gbraid);
  const wbraid = optionalClickId(record.wbraid);
  const utmSource = optionalCampaignValue(record.utm_source);
  const utmMedium = optionalCampaignValue(record.utm_medium);
  const utmCampaign = optionalCampaignValue(record.utm_campaign);
  const utmContent = optionalCampaignValue(record.utm_content);
  const utmTerm = optionalCampaignValue(record.utm_term);
  return {
    clientId,
    ...(sessionId ? { sessionId } : {}),
    ...(gclid ? { gclid } : {}),
    ...(gbraid ? { gbraid } : {}),
    ...(wbraid ? { wbraid } : {}),
    ...(utmSource ? { utmSource } : {}),
    ...(utmMedium ? { utmMedium } : {}),
    ...(utmCampaign ? { utmCampaign } : {}),
    ...(utmContent ? { utmContent } : {}),
    ...(utmTerm ? { utmTerm } : {}),
  } satisfies StoreOrderAttribution;
}

function objectBody(value: unknown) {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new StorefrontAttributionError(400, "Invalid attribution payload.");
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new StorefrontAttributionError(400, "Invalid attribution payload.");
  }
  return parsed as Record<string, unknown>;
}

function requiredOrderTotal(value: unknown) {
  const normalized = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isFinite(normalized) || normalized <= 0 || normalized > 10_000_000) {
    throw new StorefrontAttributionError(422, "A valid order total is required.");
  }
  return Math.round(normalized * 100) / 100;
}

export function storefrontAttributionAllowedOrigins(env: NodeJS.ProcessEnv = process.env) {
  const configured = String(env.STORE_ATTRIBUTION_ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const source = configured.length ? configured : defaultStorefrontOrigins;
  return new Set(source.map((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" ? url.origin : "";
    } catch {
      return "";
    }
  }).filter(Boolean));
}

export function storefrontAttributionOriginAllowed(
  origin: unknown,
  env: NodeJS.ProcessEnv = process.env,
) {
  const candidate = clean(origin, 300);
  if (!candidate) return false;
  try {
    return storefrontAttributionAllowedOrigins(env).has(new URL(candidate).origin);
  } catch {
    return false;
  }
}

export function normalizeStorefrontOrderAttribution(body: unknown): StorefrontOrderAttributionInput {
  const record = objectBody(body);
  const orderId = clean(record.order_id, 80);
  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(orderId)) {
    throw new StorefrontAttributionError(422, "Invalid order identifier.");
  }
  const total = requiredOrderTotal(record.total);
  const currency = clean(record.currency, 12).toUpperCase();
  if (currency !== "SAR") {
    throw new StorefrontAttributionError(422, "The storefront order currency must be SAR.");
  }
  const claimToken = clean(record.claim_token, 2_000);
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(claimToken)) {
    throw new StorefrontAttributionError(401, "A signed checkout attribution claim is required.");
  }
  return {
    orderId,
    checkoutId: requiredCheckoutId(record.checkout_id),
    claimToken,
    total,
    currency,
  };
}

export function normalizeStorefrontAttributionClaim(body: unknown): StorefrontAttributionClaimInput {
  const record = objectBody(body);
  const claimNonce = clean(record.claim_nonce, 200);
  if (!/^[A-Za-z0-9_-]{22,200}$/.test(claimNonce)) {
    throw new StorefrontAttributionError(422, "A strong browser claim nonce is required.");
  }
  return {
    checkoutId: requiredCheckoutId(record.checkout_id),
    claimNonce,
    attribution: normalizeAttributionFields(record),
  };
}

export function resolveStorefrontAttributionOwnerUid(env: NodeJS.ProcessEnv = process.env) {
  return clean(env.STORE_WEBHOOK_OWNER_UID || env.SALLA_APP_OWNER_UID, 256) || null;
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function stableAttribution(value: StoreOrderAttribution) {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
}

function claimDocumentId(ownerUid: string, checkoutId: string) {
  return `attr_${digest(`${ownerUid}:salla:${checkoutId}`).slice(0, 40)}`;
}

function signingSecret(env: NodeJS.ProcessEnv = process.env) {
  const secret = String(env.STORE_ATTRIBUTION_SIGNING_SECRET || "").trim();
  if (secret.length < 32) {
    throw new StorefrontAttributionError(503, "Storefront attribution signing is not configured.");
  }
  return secret;
}

function claimTtlSeconds(env: NodeJS.ProcessEnv = process.env) {
  const value = Number(env.STORE_ATTRIBUTION_CLAIM_TTL_SECONDS || 14_400);
  return Number.isFinite(value) ? Math.min(86_400, Math.max(300, Math.floor(value))) : 14_400;
}

function encodeClaimToken(payload: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", signingSecret(env)).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function decodeClaimToken(token: string, env: NodeJS.ProcessEnv = process.env) {
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra) throw new StorefrontAttributionError(401, "Invalid attribution claim token.");
  const expected = createHmac("sha256", signingSecret(env)).update(encoded).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    throw new StorefrontAttributionError(401, "Invalid attribution claim token.");
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new StorefrontAttributionError(401, "Invalid attribution claim token.");
  }
  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new StorefrontAttributionError(401, "Invalid attribution claim token.");
  }
}

function isAlreadyExistsError(error: unknown) {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  return record.code === "ALREADY_EXISTS" || record.code === 6 ||
    /already exists|duplicate key|constraint/i.test(error instanceof Error ? error.message : String(error));
}

export async function issueStorefrontAttributionClaim(
  ownerUid: string,
  input: StorefrontAttributionClaimInput,
  env: NodeJS.ProcessEnv = process.env,
) {
  const nowMs = Date.now();
  const claimId = claimDocumentId(ownerUid, input.checkoutId);
  const claimRef = adminDb.collection("storefront_attribution_claims").doc(claimId);
  const nonceHash = digest(input.claimNonce);
  const attributionHash = digest(stableAttribution(input.attribution));
  let issuedAt = new Date(nowMs).toISOString();
  let expiresAt = new Date(nowMs + claimTtlSeconds(env) * 1_000).toISOString();
  let existing = await claimRef.get();

  if (!existing.exists) {
    try {
      await claimRef.create({
        createdBy: ownerUid,
        provider: "salla",
        checkout_id: input.checkoutId,
        claim_nonce_hash: nonceHash,
        attribution_hash: attributionHash,
        attribution: input.attribution,
        status: "issued",
        issued_at: issuedAt,
        expires_at: expiresAt,
        createdAt: issuedAt,
        updatedAt: issuedAt,
      });
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      existing = await claimRef.get();
    }
  }

  if (existing.exists) {
    const saved = existing.data() || {};
    if (String(saved.createdBy || saved.owner_uid || "") !== ownerUid) {
      throw new StorefrontAttributionError(403, "Attribution claim ownership mismatch.");
    }
    if (String(saved.status || "") !== "issued") {
      throw new StorefrontAttributionError(409, "This checkout can no longer accept a new attribution claim.");
    }
    if (String(saved.claim_nonce_hash || "") !== nonceHash || String(saved.attribution_hash || "") !== attributionHash) {
      throw new StorefrontAttributionError(409, "This checkout already has a different attribution claim.");
    }
    issuedAt = String(saved.issued_at || issuedAt);
    expiresAt = String(saved.expires_at || expiresAt);
    const expiresAtMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
      throw new StorefrontAttributionError(410, "The checkout attribution claim has expired.");
    }
  }

  const claimToken = encodeClaimToken({
    v: 1,
    claim_id: claimId,
    checkout_id: input.checkoutId,
    nonce_hash: nonceHash,
    issued_at: issuedAt,
    expires_at: expiresAt,
  }, env);
  const tokenHash = digest(claimToken);
  await claimRef.set({ claim_token_hash: tokenHash, updatedAt: new Date().toISOString() }, { merge: true });
  return { success: true, checkout_id: input.checkoutId, claim_token: claimToken, expires_at: expiresAt };
}

export async function closeStorefrontAttributionClaim(ownerUid: string, checkoutId: string, orderId: string) {
  if (!checkoutId) return;
  const claimId = claimDocumentId(ownerUid, checkoutId);
  const claimRef = adminDb.collection("storefront_attribution_claims").doc(claimId);
  const now = new Date().toISOString();
  try {
    await claimRef.create({
      createdBy: ownerUid,
      provider: "salla",
      checkout_id: checkoutId,
      status: "closed_without_claim",
      authoritative_order_id: orderId,
      issued_at: now,
      expires_at: now,
      createdAt: now,
      updatedAt: now,
    });
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
    await claimRef.set({ authoritative_order_id: orderId, updatedAt: now }, { merge: true });
  }
}

async function verifiedClaim(
  ownerUid: string,
  input: StorefrontOrderAttributionInput,
  env: NodeJS.ProcessEnv = process.env,
) {
  const payload = decodeClaimToken(input.claimToken, env);
  const claimId = clean(payload.claim_id, 100);
  const tokenExpiresAt = String(payload.expires_at || "");
  const tokenExpiresAtMs = Date.parse(tokenExpiresAt);
  if (Number(payload.v) !== 1 || claimId !== claimDocumentId(ownerUid, input.checkoutId) ||
      clean(payload.checkout_id, 100) !== input.checkoutId || !Number.isFinite(tokenExpiresAtMs) || tokenExpiresAtMs <= Date.now()) {
    throw new StorefrontAttributionError(401, "The checkout attribution claim is invalid or expired.");
  }
  const claimRef = adminDb.collection("storefront_attribution_claims").doc(claimId);
  const snapshot = await claimRef.get();
  if (!snapshot.exists) throw new StorefrontAttributionError(401, "The checkout attribution claim was not found.");
  const claim = snapshot.data() || {};
  if (String(claim.createdBy || claim.owner_uid || "") !== ownerUid ||
      String(claim.checkout_id || "") !== input.checkoutId ||
      String(claim.claim_nonce_hash || "") !== String(payload.nonce_hash || "") ||
      String(claim.expires_at || "") !== tokenExpiresAt ||
      String(claim.claim_token_hash || "") !== digest(input.claimToken) ||
      !["issued", "consumed"].includes(String(claim.status || ""))) {
    throw new StorefrontAttributionError(401, "The checkout attribution claim does not match this order.");
  }
  const authoritativeOrderId = String(claim.authoritative_order_id || "");
  if (!authoritativeOrderId) {
    throw new StorefrontAttributionError(404, "The signed Salla order is not ready for attribution yet.");
  }
  if (authoritativeOrderId !== input.orderId) {
    throw new StorefrontAttributionError(401, "The checkout attribution claim does not match this order.");
  }
  return { claimId, claimRef, claim };
}

export async function attachStorefrontOrderAttribution(
  ownerUid: string,
  input: StorefrontOrderAttributionInput,
) {
  const verified = await verifiedClaim(ownerUid, input);
  const orderDocId = getStoreOrderDocId(ownerUid, "salla", input.orderId);
  const orderRef = adminDb.collection("store_orders").doc(orderDocId);
  const snapshot = await orderRef.get();
  if (!snapshot.exists) {
    throw new StorefrontAttributionError(404, "The order is not ready for attribution yet.");
  }
  const order = snapshot.data() || {};
  if (String(order.createdBy || order.owner_uid || "") !== ownerUid) {
    throw new StorefrontAttributionError(403, "Order ownership mismatch.");
  }
  const storedTotal = Number(order.total);
  const storedCurrency = String(order.currency || "SAR").trim().toUpperCase();
  if (!Number.isFinite(storedTotal) || storedTotal <= 0) {
    throw new StorefrontAttributionError(409, "The authoritative order total is not ready yet.");
  }
  if (Math.abs(storedTotal - input.total) > 0.01 || storedCurrency !== input.currency) {
    throw new StorefrontAttributionError(409, "Storefront order value does not match the authoritative order.");
  }
  if (String(order.checkout_id || "") !== input.checkoutId) {
    throw new StorefrontAttributionError(409, "Checkout identifier does not match the signed Salla order.");
  }
  const existingClaimId = String(order.attribution_claim_id || "");
  if (existingClaimId && existingClaimId !== verified.claimId) {
    throw new StorefrontAttributionError(409, "This order is already bound to another attribution claim.");
  }
  const existing = order.attribution && typeof order.attribution === "object" ? order.attribution as StoreOrderAttribution : {};
  const claimedAttribution = verified.claim.attribution && typeof verified.claim.attribution === "object"
    ? verified.claim.attribution as StoreOrderAttribution
    : {};
  const attribution = { ...existing, ...claimedAttribution };
  const now = new Date().toISOString();
  if (!existingClaimId) {
    const bound = await compareAndSetDocument(orderRef, { attribution_claim_id: order.attribution_claim_id ?? null }, {
      attribution,
      attribution_claim_id: verified.claimId,
      attribution_claimed_at: now,
      updatedAt: now,
    });
    if (!bound) {
      const latest = await orderRef.get();
      if (!latest.exists || String(latest.data()?.attribution_claim_id || "") !== verified.claimId) {
        throw new StorefrontAttributionError(409, "Order attribution changed concurrently; retry safely.");
      }
    }
  }

  if (String(verified.claim.status || "") === "issued") {
    const consumed = await compareAndSetDocument(verified.claimRef, { status: "issued" }, {
      status: "consumed",
      order_id: input.orderId,
      consumed_at: now,
      updatedAt: now,
    });
    if (!consumed) {
      const latestClaim = await verified.claimRef.get();
      if (!latestClaim.exists || String(latestClaim.data()?.order_id || "") !== input.orderId) {
        throw new StorefrontAttributionError(409, "Attribution claim changed concurrently; retry safely.");
      }
    }
  } else if (String(verified.claim.order_id || "") !== input.orderId) {
    throw new StorefrontAttributionError(409, "This attribution claim was consumed by another order.");
  }

  const analytics = await deliverOrderAnalytics(ownerUid, orderDocId, {
    eventType: "order.created",
    eventId: `storefront:order-completed:${input.orderId}`,
    orderId: input.orderId,
    orderNumber: String(order.order_number || input.orderId),
    status: String(order.status || "completed"),
    paymentStatus: String(order.payment_status || ""),
    paymentTypeGroup: String(order.payment_type_group || ""),
    currency: String(order.currency || "SAR"),
    attribution,
    items: [],
  });
  if (analytics.status === "retry_pending" || analytics.status === "failed") {
    throw new StorefrontAttributionError(503, "Order analytics delivery is pending; retry safely.");
  }

  return {
    success: true,
    order_id: input.orderId,
    analytics_status: analytics.status,
    transaction_id: "transaction_id" in analytics ? analytics.transaction_id || null : null,
  };
}
