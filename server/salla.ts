import crypto from "crypto";
import { promises as fs } from "fs";
import path from "path";
import type { Request } from "express";
import { normalizePhoneDigits } from "../shared/phone";
import { adminDb } from "./firebaseAdmin";
import {
  getStoreOrderDocId,
  importStoreOrderForUser,
  normalizeStorePayload,
  type StoreItemType,
  type StoreWebhookOrder,
} from "./storeWebhook";

type SallaIntegrationRecord = {
  provider: "salla";
  createdBy: string;
  status: "not_configured" | "ready_to_connect" | "connected" | "error";
  access_token?: string | null;
  refresh_token?: string | null;
  expires_at?: string | null;
  scope?: string;
  token_type?: string;
  merchant_id?: string | number | null;
  store_name?: string | null;
  store_url?: string | null;
  auth_mode?: "easy" | "custom" | null;
  last_authorized_at?: string | null;
  last_event_at?: string | null;
  last_event_type?: string | null;
  last_sync_at?: string | null;
  last_sync_status?: "success" | "error" | "idle" | null;
  last_sync_count?: number;
  last_sync_error?: string | null;
  last_product_sync_at?: string | null;
  last_product_sync_count?: number;
  last_product_sync_error?: string | null;
  last_customer_sync_at?: string | null;
  last_customer_sync_status?: "success" | "failed" | "error" | "idle" | null;
  last_customer_sync_count?: number;
  last_customer_sync_error?: string | null;
  last_customer_sync_complete?: boolean;
  last_remote_update_at?: string | null;
  updatedAt?: string;
  createdAt?: string;
};

type SallaTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
};

type SallaAuthorizedSession = {
  uid: string;
  accessToken: string;
};

type SallaRequestOptions = {
  timeoutMs?: number;
  maxRetries?: number;
  retryable?: boolean;
};

type SallaMerchantProfile = {
  merchantId: string | null;
  storeName: string | null;
  storeUrl: string | null;
};

type SyncResult = {
  success: boolean;
  imported: number;
  updated: number;
  failed: number;
  pages: number;
  fetched: number;
  last_sync_at: string;
  last_error?: string | null;
  partial?: boolean;
  cap_reached?: boolean;
  skipped?: boolean;
};

const SALLA_AUTHORIZE_URL = "https://accounts.salla.sa/oauth2/auth";
const SALLA_TOKEN_URL = "https://accounts.salla.sa/oauth2/token";
const SALLA_USERINFO_URL = "https://accounts.salla.sa/oauth2/user/info";
const SALLA_API_BASE = "https://api.salla.dev/admin/v2";
const SALLA_STOREINFO_URL = `${SALLA_API_BASE}/store/info`;
const SALLA_CALLBACK_PATH = "/api/integrations/salla/callback";
const SALLA_APP_WEBHOOK_PATH = "/api/integrations/salla/webhook";
const DEFAULT_LOCAL_SALLA_STORE_PATH = path.resolve(process.cwd(), ".runtime", "salla-integrations.json");
const DEFAULT_SALLA_REQUEST_TIMEOUT_MS = 15_000;
const TRANSIENT_SALLA_STATUSES = new Set([429, 500, 502, 503]);
const REFRESH_OUTCOME_UNKNOWN_MESSAGE =
  "Salla could not confirm token refresh. Reconnect the Salla app before syncing again.";

class SallaRequestError extends Error {
  readonly status?: number;
  readonly transient: boolean;
  readonly outcomeUnknown: boolean;

  constructor(
    message: string,
    options: { status?: number; transient?: boolean; outcomeUnknown?: boolean } = {},
  ) {
    super(message);
    this.name = "SallaRequestError";
    this.status = options.status;
    this.transient = Boolean(options.transient);
    this.outcomeUnknown = Boolean(options.outcomeUnknown);
  }
}

const refreshLocks = new Map<string, Promise<unknown>>();
const customerSyncLocks = new Map<string, Promise<SyncResult>>();
let localIntegrationWriteLock: Promise<unknown> = Promise.resolve();

function nowIso() {
  return new Date().toISOString();
}

function toSettingsShape(data: Partial<SallaIntegrationRecord>) {
  const next: Record<string, unknown> = {
    salla_provider: "salla",
  };
  for (const [key, value] of Object.entries(data)) {
    next[`salla_${key}`] = value;
  }
  return next;
}

function usingSupabaseAdapter() {
  // True for ANY non-Firestore backend (Supabase or local SQLite). Both lack
  // the `settings.salla_*` columns the Firestore adapter expects, so the local
  // JSON store at .runtime/salla-integrations.json is the durable record.
  const provider = (process.env.DATA_PROVIDER || process.env.DB_PROVIDER || "").toLowerCase();
  return provider === "supabase" || provider === "sqlite";
}

function localSallaStorePath() {
  const override = process.env.SALLA_INTEGRATION_STORE_PATH;
  if (!override) return DEFAULT_LOCAL_SALLA_STORE_PATH;
  if (process.env.NODE_ENV !== "test") {
    throw new Error("SALLA_INTEGRATION_STORE_PATH is test-only and cannot override the production token store path.");
  }
  return path.resolve(override);
}

async function readLocalIntegrationStore(): Promise<Record<string, SallaIntegrationRecord>> {
  const storePath = localSallaStorePath();
  let raw: string;
  try {
    raw = await fs.readFile(storePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return {};
    throw new Error(`Unable to read the Salla integration store at ${storePath}.`, { cause: error });
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, SallaIntegrationRecord>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Expected a JSON object keyed by CRM owner.");
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `The Salla integration store at ${storePath} is corrupted and was not replaced. Restore it from backup before continuing.`,
      { cause: error },
    );
  }
}

async function writeLocalIntegrationStore(data: Record<string, SallaIntegrationRecord>) {
  const storePath = localSallaStorePath();
  const directory = path.dirname(storePath);
  const tempPath = path.join(
    directory,
    `.${path.basename(storePath)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`,
  );
  await fs.mkdir(directory, { recursive: true });

  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(tempPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tempPath, storePath);
    await fs.chmod(storePath, 0o600).catch((error) => {
      if (process.platform !== "win32") throw error;
    });

    // Persist the rename across a host crash where the filesystem supports
    // directory fsync (Linux VPS). Windows does not expose this consistently.
    let directoryHandle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      directoryHandle = await fs.open(directory, "r");
      await directoryHandle.sync();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (process.platform !== "win32" && code !== "EINVAL" && code !== "ENOTSUP") throw error;
    } finally {
      await directoryHandle?.close().catch(() => undefined);
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.unlink(tempPath).catch((error) => {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    });
  }
}

async function withLocalIntegrationWriteLock<T>(task: () => Promise<T>): Promise<T> {
  const run = localIntegrationWriteLock.catch(() => undefined).then(task);
  localIntegrationWriteLock = run;
  return run;
}

function fromSettingsShape(data: Record<string, any> | null | undefined): SallaIntegrationRecord | null {
  if (!data) return null;
  const status = firstText(data.salla_status);
  const token = firstText(data.salla_access_token);
  const refresh = firstText(data.salla_refresh_token);
  if (!status && !token && !refresh) return null;

  return {
    provider: "salla",
    createdBy: firstText(data.createdBy, data.owner_uid),
    status: (status || "error") as SallaIntegrationRecord["status"],
    access_token: token || undefined,
    refresh_token: refresh || undefined,
    expires_at: firstText(data.salla_expires_at) || null,
    scope: firstText(data.salla_scope) || undefined,
    token_type: firstText(data.salla_token_type) || undefined,
    merchant_id: firstText(data.salla_merchant_id) || null,
    store_name: firstText(data.salla_store_name) || null,
    store_url: firstText(data.salla_store_url) || null,
    auth_mode: (firstText(data.salla_auth_mode) || "easy") as SallaIntegrationRecord["auth_mode"],
    last_authorized_at: firstText(data.salla_last_authorized_at) || null,
    last_event_at: firstText(data.salla_last_event_at) || null,
    last_event_type: firstText(data.salla_last_event_type) || null,
    last_sync_at: firstText(data.salla_last_sync_at) || null,
    last_sync_status: (firstText(data.salla_last_sync_status) || "idle") as SallaIntegrationRecord["last_sync_status"],
    last_sync_count: Number(data.salla_last_sync_count || 0),
    last_sync_error: firstText(data.salla_last_sync_error) || null,
    last_product_sync_at: firstText(data.salla_last_product_sync_at) || null,
    last_product_sync_count: Number(data.salla_last_product_sync_count || 0),
    last_product_sync_error: firstText(data.salla_last_product_sync_error) || null,
    last_customer_sync_at: firstText(data.salla_last_customer_sync_at) || null,
    last_customer_sync_status: (firstText(data.salla_last_customer_sync_status) || "idle") as SallaIntegrationRecord["last_customer_sync_status"],
    last_customer_sync_count: Number(data.salla_last_customer_sync_count || 0),
    last_customer_sync_error: firstText(data.salla_last_customer_sync_error) || null,
    last_customer_sync_complete: data.salla_last_customer_sync_complete === true || String(data.salla_last_customer_sync_complete) === "true",
    last_remote_update_at: firstText(data.salla_last_remote_update_at) || null,
    updatedAt: firstText(data.salla_updatedAt || data.updatedAt) || undefined,
    createdAt: firstText(data.salla_createdAt || data.createdAt) || undefined,
  };
}

function stateSecret() {
  // Security (H2): never fall back to a hardcoded constant — a known state
  // secret lets an attacker forge the OAuth `state` and bind a Salla
  // connection to an arbitrary uid. Require an explicit secret.
  const secret = process.env.SALLA_STATE_SECRET || process.env.STORE_WEBHOOK_SECRET || "";
  if (!secret) {
    throw new Error(
      "SALLA_STATE_SECRET (or STORE_WEBHOOK_SECRET) must be set to sign Salla OAuth state.",
    );
  }
  return secret;
}

// Security (M5): OAuth state must expire so a captured/signed state cannot be
// replayed indefinitely.
function stateMaxAgeMs() {
  return Math.max(60_000, Number(process.env.SALLA_STATE_MAX_AGE_MS || 600_000));
}

function clientId() {
  return process.env.SALLA_CLIENT_ID || "";
}

function clientSecret() {
  return process.env.SALLA_CLIENT_SECRET || "";
}

function withRequiredCustomerScope(value: string) {
  const scopes = String(value || "").split(/\s+/).map((scope) => scope.trim()).filter(Boolean);
  if (!scopes.includes("customers.read")) scopes.push("customers.read");
  return [...new Set(scopes)].join(" ");
}

function defaultScopes() {
  return withRequiredCustomerScope(process.env.SALLA_SCOPES || "offline_access orders.read products.read customers.read");
}

function authMode(): "easy" | "custom" {
  return process.env.SALLA_AUTH_MODE === "custom" ? "custom" : "easy";
}

function syncSchedule() {
  return process.env.SALLA_SYNC_CRON_SCHEDULE || "*/15 * * * *";
}

function syncEnabled() {
  return process.env.SALLA_SYNC_CRON_ENABLED === "true";
}

function maxSyncPages() {
  return Math.max(1, Math.min(200, Number(process.env.SALLA_SYNC_MAX_PAGES || 3)));
}

function pageSize() {
  // The current List Orders contract caps reliable sequential pagination at
  // 30 rows. Using a larger requested size can make Salla return 30 while our
  // loop mistakes that short page for the end of the collection.
  return Math.max(10, Math.min(30, Number(process.env.SALLA_SYNC_PAGE_SIZE || 30)));
}

function customerMaxSyncPages() {
  return boundedInteger(process.env.SALLA_CUSTOMER_SYNC_MAX_PAGES, 200, 1, 200);
}

function customerPageSize() {
  return boundedInteger(process.env.SALLA_CUSTOMER_SYNC_PAGE_SIZE, 60, 1, 60);
}

function customerSyncIntervalMinutes() {
  return boundedInteger(process.env.SALLA_CUSTOMER_SYNC_INTERVAL_MINUTES, 360, 1, 10_080);
}

function customerSyncIsDue(integration: SallaIntegrationRecord | null, at = Date.now()) {
  if (
    !integration ||
    integration.last_customer_sync_status !== "success" ||
    integration.last_customer_sync_complete !== true
  ) return true;
  const lastSyncAt = Date.parse(integration.last_customer_sync_at || "");
  if (!Number.isFinite(lastSyncAt)) return true;
  return at - lastSyncAt >= customerSyncIntervalMinutes() * 60_000;
}

function configured() {
  return Boolean(clientId() && clientSecret());
}

function sallaAppWebhookSecret() {
  return process.env.SALLA_APP_WEBHOOK_SECRET || process.env.STORE_WEBHOOK_SECRET || "";
}

function sallaAppOwnerUid() {
  return process.env.SALLA_APP_OWNER_UID || process.env.STORE_WEBHOOK_OWNER_UID || process.env.LOCAL_AUTH_SHARED_UID || "";
}

function base64url(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function fromBase64url(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function hmac(value: string) {
  return crypto.createHmac("sha256", stateSecret()).update(value).digest("hex");
}

function signState(payload: Record<string, unknown>) {
  const encoded = base64url(JSON.stringify(payload));
  return `${encoded}.${hmac(encoded)}`;
}

function verifyState(state: string) {
  const [encoded, signature] = String(state || "").split(".");
  if (!encoded || !signature) throw new Error("Invalid Salla OAuth state.");
  // Security (H2): constant-time signature comparison.
  const expected = Buffer.from(hmac(encoded));
  const provided = Buffer.from(signature);
  if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
    throw new Error("Salla OAuth state signature is invalid.");
  }
  const payload = JSON.parse(fromBase64url(encoded)) as {
    uid: string;
    redirectUri: string;
    appUrl: string;
    issuedAt: string;
  };
  // Security (M5): reject expired state to prevent replay.
  const issuedAtMs = Date.parse(payload.issuedAt || "");
  if (!Number.isFinite(issuedAtMs) || Date.now() - issuedAtMs > stateMaxAgeMs()) {
    throw new Error("Salla OAuth state has expired. Please restart the connection.");
  }
  return payload;
}

function firstText(...values: unknown[]) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value).trim();
  }
  return "";
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const normalized = value.replace(/[^\d.-]/g, "");
    const n = Number(normalized);
    return Number.isFinite(n) ? n : undefined;
  }

  const record = asRecord(value);
  if (Object.keys(record).length) {
    return numericValue(record.amount ?? record.value ?? record.total ?? record.price);
  }

  return undefined;
}

function optionalNumberValue(...values: unknown[]) {
  for (const value of values) {
    const n = numericValue(value);
    if (n !== undefined) return n;
  }
  return undefined;
}

function asArray(value: unknown): Record<string, any>[] {
  if (!Array.isArray(value)) return [];
  return value.map(asRecord);
}

function truncate(value: string, max: number) {
  return value.length > max ? value.slice(0, max) : value;
}

function safeEquals(left: string, right: string) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function bodyHmac(rawBody: Buffer, secret: string) {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

function cleanSignature(value?: string) {
  return String(value || "").trim().replace(/^sha256=/i, "");
}

// Salla splits the buyer number into `mobile` (551496683) and `mobile_code`
// ("+966"); join them so the country code is never dropped.
function joinCountryCode(code: unknown, number: unknown) {
  const num = String(number ?? "").trim();
  if (!num || num.startsWith("+")) return num;
  const dialCode = String(code ?? "").trim();
  return dialCode ? `${dialCode}${num}` : num;
}

function dateOnly(value: unknown, fallback = new Date()) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = value ? new Date(String(value)) : fallback;
  const safeDate = Number.isNaN(parsed.getTime()) ? fallback : parsed;
  return safeDate.toISOString().slice(0, 10);
}

function classifyItemType(sku: string, tags: string[], explicitType = ""): StoreItemType {
  const upperSku = sku.toUpperCase();
  const haystack = [sku, explicitType, ...tags].join(" ").toLowerCase();

  if (upperSku.startsWith("SALE-") || haystack.includes("sale_only")) return "sale_only";
  if (upperSku.startsWith("INSTALL-") || haystack.includes("install_maintenance") || haystack.includes("installation")) {
    return "install_maintenance";
  }
  if (upperSku.startsWith("EXT-") || haystack.includes("external_maintenance")) return "external_maintenance";
  if (upperSku.startsWith("MAINT-") || haystack.includes("maintenance_existing") || haystack.includes("maintenance")) {
    return "maintenance_existing";
  }
  return "needs_review";
}

function collectTags(item: Record<string, any>) {
  return [
    ...asArray(item.tags).map((tag) => firstText(tag.name, tag.title, tag.slug, tag.value)),
    ...asArray(asRecord(item.product).tags).map((tag) => firstText(tag.name, tag.title, tag.slug, tag.value)),
  ].filter(Boolean);
}

function readRedirectUri(req: Request) {
  if (process.env.SALLA_REDIRECT_URI) return process.env.SALLA_REDIRECT_URI;
  return `${req.protocol}://${req.get("host")}${SALLA_CALLBACK_PATH}`;
}

function readAppUrl(req: Request) {
  if (process.env.APP_URL) return process.env.APP_URL;
  return `${req.protocol}://${req.get("host")}`;
}

function readWebhookUrl(req: Request) {
  return `${readAppUrl(req)}${SALLA_APP_WEBHOOK_PATH}`;
}

function expiresAt(expiresIn?: number) {
  if (!expiresIn || !Number.isFinite(expiresIn)) return null;
  return new Date(Date.now() + expiresIn * 1000).toISOString();
}

function expiresAtFromUnixOrSeconds(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  if (parsed > 2_000_000_000) return new Date(parsed).toISOString();
  if (parsed > 1_000_000_000) return new Date(parsed * 1000).toISOString();
  return new Date(Date.now() + parsed * 1000).toISOString();
}

async function readIntegration(uid: string): Promise<SallaIntegrationRecord | null> {
  if (usingSupabaseAdapter()) {
    const store = await readLocalIntegrationStore();
    return store[uid] || null;
  }
  const snap = await adminDb.collection("settings").doc(uid).get();
  return snap.exists ? fromSettingsShape(snap.data()) : null;
}

async function writeIntegration(uid: string, data: Partial<SallaIntegrationRecord>) {
  const now = nowIso();
  if (usingSupabaseAdapter()) {
    await withLocalIntegrationWriteLock(async () => {
      const store = await readLocalIntegrationStore();
      const previous = store[uid] || {
        provider: "salla" as const,
        createdBy: uid,
        status: configured() ? "ready_to_connect" : "not_configured",
        createdAt: now,
      };
      store[uid] = {
        ...previous,
        ...data,
        provider: "salla",
        createdBy: uid,
        updatedAt: now,
        createdAt: previous.createdAt || data.createdAt || now,
      };
      await writeLocalIntegrationStore(store);
    });
    return;
  }
  await adminDb.collection("settings").doc(uid).set({
    createdBy: uid,
    updatedAt: now,
    createdAt: data.createdAt || now,
    ...toSettingsShape({
      provider: "salla",
      updatedAt: now,
      createdAt: data.createdAt || now,
      ...data,
    }),
  }, { merge: true });
}

function verifySallaAppWebhook(req: Request & { rawBody?: Buffer }) {
  const secret = sallaAppWebhookSecret();
  if (!secret) {
    const err = new Error("SALLA_APP_WEBHOOK_SECRET is missing.") as Error & { status?: number };
    err.status = 503;
    throw err;
  }

  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  const signature = cleanSignature(req.get("x-salla-signature") || req.get("x-golden-signature"));
  const expected = bodyHmac(rawBody, secret);
  if (signature && safeEquals(signature, expected)) {
    return { mode: "signature" as const, rawBody };
  }

  const authorization = String(req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const sharedSecret = String(req.get("x-golden-webhook-secret") || authorization || "");
  if (sharedSecret && safeEquals(sharedSecret, secret)) {
    return { mode: "token" as const, rawBody };
  }

  const err = new Error("Invalid or missing Salla app webhook signature.") as Error & { status?: number };
  err.status = 401;
  throw err;
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(minimum, Math.min(maximum, Math.trunc(parsed)))
    : fallback;
}

function sallaRequestTimeoutMs() {
  return boundedInteger(process.env.SALLA_FETCH_TIMEOUT_MS, DEFAULT_SALLA_REQUEST_TIMEOUT_MS, 1_000, 60_000);
}

function sallaGetMaxRetries() {
  return boundedInteger(process.env.SALLA_FETCH_MAX_RETRIES, 2, 0, 4);
}

function sallaRetryBaseDelayMs() {
  return boundedInteger(process.env.SALLA_FETCH_RETRY_BASE_DELAY_MS, 500, 0, 30_000);
}

function sallaRetryMaxDelayMs() {
  return boundedInteger(process.env.SALLA_FETCH_RETRY_MAX_DELAY_MS, 30_000, 0, 60_000);
}

function parseRetryAfterMs(value: string | null) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : null;
}

function sallaResponseMessage(body: unknown, status: number) {
  const record = asRecord(body);
  const error = asRecord(record.error);
  const message = firstText(record.error_description, error.message, record.message);
  return message ? truncate(message, 500) : `Salla request failed (${status}).`;
}

function isTransientSallaError(error: unknown) {
  return error instanceof SallaRequestError && error.transient;
}

function isUnknownRefreshOutcome(error: unknown) {
  return error instanceof SallaRequestError && error.outcomeUnknown;
}

function isSallaAuthenticationRequired(error: unknown) {
  if (isUnknownRefreshOutcome(error)) return true;
  if (error instanceof SallaRequestError && error.status === 401) return true;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    message.includes("invalid_grant") ||
    message.includes("refresh token is missing") ||
    message.includes("salla is not connected") ||
    message.includes("salla is not linked")
  );
}

function statusAfterSyncFailure(error: unknown): SallaIntegrationRecord["status"] {
  // A failed sync is diagnostic state, not a permanent connection latch. Only
  // explicit authentication failures require re-authorization.
  return isSallaAuthenticationRequired(error) ? "error" : "connected";
}

function syncFailureMessage(error: unknown, fallback: string) {
  if (isUnknownRefreshOutcome(error)) return REFRESH_OUTCOME_UNKNOWN_MESSAGE;
  return error instanceof Error ? error.message : fallback;
}

async function waitForRetry(milliseconds: number) {
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function requestSallaJson<T = Record<string, unknown>>(
  input: string | URL,
  init: RequestInit = {},
  options: SallaRequestOptions = {},
): Promise<T> {
  const method = String(init.method || "GET").toUpperCase();
  const retryable = options.retryable ?? method === "GET";
  const maxRetries = retryable
    ? boundedInteger(options.maxRetries, sallaGetMaxRetries(), 0, 4)
    : 0;
  const timeoutMs = options.timeoutMs ?? sallaRequestTimeoutMs();

  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController();
    let timedOut = false;
    let detachAbort: (() => void) | null = null;
    if (init.signal) {
      const forwardAbort = () => controller.abort(init.signal?.reason);
      if (init.signal.aborted) forwardAbort();
      else {
        init.signal.addEventListener("abort", forwardAbort, { once: true });
        detachAbort = () => init.signal?.removeEventListener("abort", forwardAbort);
      }
    }
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetch(input, { ...init, signal: controller.signal });
      const body = await response.json().catch(() => ({}));
      if (response.ok) return body as T;

      const transient = TRANSIENT_SALLA_STATUSES.has(response.status);
      if (retryable && transient && attempt < maxRetries) {
        const retryAfter = parseRetryAfterMs(response.headers.get("retry-after"));
        const backoff = sallaRetryBaseDelayMs() * 2 ** attempt;
        await waitForRetry(Math.min(retryAfter ?? backoff, sallaRetryMaxDelayMs()));
        continue;
      }

      throw new SallaRequestError(sallaResponseMessage(body, response.status), {
        status: response.status,
        transient,
      });
    } catch (error) {
      if (error instanceof SallaRequestError) throw error;
      const externallyAborted = Boolean(init.signal?.aborted);
      const transient = timedOut || !externallyAborted;
      if (retryable && transient && attempt < maxRetries) {
        const backoff = Math.min(sallaRetryBaseDelayMs() * 2 ** attempt, sallaRetryMaxDelayMs());
        await waitForRetry(backoff);
        continue;
      }
      throw new SallaRequestError(
        timedOut ? `Salla request timed out after ${timeoutMs}ms.` : "Salla request could not be completed.",
        {
          transient,
          outcomeUnknown: method !== "GET" && transient,
        },
      );
    } finally {
      clearTimeout(timer);
      detachAbort?.();
    }
  }
}

async function exchangeToken(params: URLSearchParams) {
  // OAuth authorization codes and refresh tokens are single-use. Retrying a
  // POST after a lost response can reuse the grant and revoke the whole Salla
  // session, so token exchange gets a timeout but never an automatic retry.
  const body = await requestSallaJson<SallaTokenResponse>(SALLA_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: params.toString(),
  }, { retryable: false });
  if (!firstText(body.access_token)) {
    throw new SallaRequestError("Salla token response did not include an access token.");
  }
  return body;
}

function unwrapSallaData(value: unknown) {
  const body = asRecord(value);
  const data = asRecord(body.data);
  return Object.keys(data).length ? data : body;
}

function normalizeStorefrontUrl(value: unknown) {
  const raw = firstText(value);
  if (!raw) return null;
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.protocol = "https:";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function extractMerchantProfile(userInfo: unknown, storeInfo: unknown): SallaMerchantProfile {
  const userData = unwrapSallaData(userInfo);
  const merchant = asRecord(userData.merchant);
  const store = unwrapSallaData(storeInfo);
  return {
    merchantId: firstText(store.id, merchant.id, userData.merchant_id) || null,
    storeName: firstText(store.name, merchant.name, merchant.store_name, merchant.username) || null,
    storeUrl: normalizeStorefrontUrl(firstText(store.domain, merchant.domain, merchant.url, merchant.permalink)),
  };
}

function merchantProfilePatch(profile: SallaMerchantProfile, fallbackMerchantId?: string | null) {
  const patch: Partial<SallaIntegrationRecord> = {};
  const merchantId = profile.merchantId || fallbackMerchantId || null;
  if (merchantId) patch.merchant_id = merchantId;
  if (profile.storeName) patch.store_name = profile.storeName;
  if (profile.storeUrl) patch.store_url = profile.storeUrl;
  return patch;
}

async function fetchMerchantProfile(token: string) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  const [userInfo, storeInfo] = await Promise.allSettled([
    requestSallaJson(SALLA_USERINFO_URL, { headers }),
    requestSallaJson(SALLA_STOREINFO_URL, { headers }),
  ]);
  if (userInfo.status === "rejected" && storeInfo.status === "rejected") {
    throw userInfo.reason;
  }
  return extractMerchantProfile(
    userInfo.status === "fulfilled" ? userInfo.value : {},
    storeInfo.status === "fulfilled" ? storeInfo.value : {},
  );
}

function accessTokenStillValid(integration: SallaIntegrationRecord) {
  const expiry = integration.expires_at ? Date.parse(integration.expires_at) : NaN;
  return Number.isFinite(expiry)
    ? expiry - Date.now() > 120_000 && Boolean(integration.access_token)
    : Boolean(integration.access_token);
}

async function withOwnerRefreshLock<T>(uid: string, task: () => Promise<T>): Promise<T> {
  const previous = refreshLocks.get(uid) || Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  refreshLocks.set(uid, run);
  try {
    return await run;
  } finally {
    if (refreshLocks.get(uid) === run) refreshLocks.delete(uid);
  }
}

async function rotateAccessTokenLocked(uid: string, integration: SallaIntegrationRecord) {
  if (!integration.refresh_token) throw new Error("Salla refresh token is missing.");
  let token: SallaTokenResponse;
  try {
    token = await exchangeToken(new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: integration.refresh_token,
      client_id: clientId(),
      client_secret: clientSecret(),
    }));
  } catch (error) {
    if (isUnknownRefreshOutcome(error)) {
      // The single-use refresh grant may have reached Salla even though its
      // response was lost. Quarantine it so no later request can reuse it and
      // revoke the session.
      await writeIntegration(uid, {
        status: "error",
        refresh_token: null,
        last_sync_error: REFRESH_OUTCOME_UNKNOWN_MESSAGE,
      });
    }
    throw error;
  }

  await writeIntegration(uid, {
    status: "connected",
    access_token: token.access_token,
    // Never retain a refresh token that has just been consumed. Salla rotates
    // it on every successful refresh; a missing replacement requires a later
    // re-authorization instead of unsafe token reuse.
    refresh_token: firstText(token.refresh_token) || null,
    expires_at: expiresAt(token.expires_in),
    scope: token.scope || integration.scope,
    token_type: token.token_type || integration.token_type || "Bearer",
    last_sync_error: null,
  });

  // Backfill canonical store metadata for records created by older builds.
  // Token persistence above is deliberately completed first so a slow profile
  // request can never lose the newly rotated single-use credential pair.
  const profile = await fetchMerchantProfile(token.access_token).catch(() => null);
  if (profile) {
    const profilePatch = merchantProfilePatch(profile);
    if (Object.keys(profilePatch).length) {
      await writeIntegration(uid, profilePatch).catch(() => undefined);
    }
  }
  return token.access_token;
}

async function ensureFreshAccessToken(uid: string, integration: SallaIntegrationRecord) {
  if (accessTokenStillValid(integration) && integration.access_token) return integration.access_token;
  return withOwnerRefreshLock(uid, async () => {
    const latest = await readIntegration(uid);
    if (!latest) throw new Error("Salla is not linked for this CRM user.");
    if (accessTokenStillValid(latest) && latest.access_token) return latest.access_token;
    return rotateAccessTokenLocked(uid, latest);
  });
}

async function refreshAfterUnauthorized(uid: string, failedAccessToken: string) {
  return withOwnerRefreshLock(uid, async () => {
    const latest = await readIntegration(uid);
    if (!latest) throw new Error("Salla is not linked for this CRM user.");
    if (latest.access_token && latest.access_token !== failedAccessToken && accessTokenStillValid(latest)) {
      return latest.access_token;
    }
    return rotateAccessTokenLocked(uid, latest);
  });
}

async function authorizedSallaGet<T = Record<string, unknown>>(
  session: SallaAuthorizedSession,
  input: string | URL,
): Promise<T> {
  const request = (accessToken: string) => requestSallaJson<T>(input, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  try {
    return await request(session.accessToken);
  } catch (error) {
    if (!(error instanceof SallaRequestError) || error.status !== 401) throw error;
    session.accessToken = await refreshAfterUnauthorized(session.uid, session.accessToken);
    return request(session.accessToken);
  }
}

async function fetchOrdersPage(session: SallaAuthorizedSession, page: number) {
  const url = new URL(`${SALLA_API_BASE}/orders`);
  url.searchParams.set("page", String(page));
  url.searchParams.set("per_page", String(pageSize()));
  return authorizedSallaGet(session, url);
}

async function fetchProductsPage(session: SallaAuthorizedSession, page: number) {
  const url = new URL(`${SALLA_API_BASE}/products`);
  url.searchParams.set("page", String(page));
  url.searchParams.set("per_page", String(pageSize()));
  return authorizedSallaGet(session, url);
}

function productDocId(uid: string, remoteProductId: string) {
  const hash = crypto.createHash("sha1").update(`${uid}:salla:${remoteProductId}`).digest("hex").slice(0, 24);
  return `prod_salla_${hash}`;
}

function firstImageUrl(product: Record<string, any>) {
  const image = asRecord(product.image);
  const thumbnail = asRecord(product.thumbnail);
  const mainImage = asRecord(product.main_image);
  const images = asArray(product.images);
  return firstText(
    product.image_url,
    product.thumbnail_url,
    image.url,
    image.src,
    thumbnail.url,
    thumbnail.src,
    mainImage.url,
    mainImage.src,
    images[0]?.url,
    images[0]?.src,
  );
}

function mapSallaProduct(remoteProduct: Record<string, any>, syncedAt: string) {
  const productId = firstText(remoteProduct.id, remoteProduct.product_id, remoteProduct.uuid);
  if (!productId) return null;

  const price = asRecord(remoteProduct.price);
  const salePrice = asRecord(remoteProduct.sale_price);
  const regularPrice = asRecord(remoteProduct.regular_price);
  const category = asRecord(remoteProduct.category);
  const categories = asArray(remoteProduct.categories);
  const sku = truncate(firstText(remoteProduct.sku, remoteProduct.code, remoteProduct.product_code) || `SALLA-${productId}`, 80);
  const tags = [
    ...asArray(remoteProduct.tags).map((tag) => firstText(tag.name, tag.title, tag.slug, tag.value)),
    ...categories.map((item) => firstText(item.name, item.title, item.slug)),
  ].filter(Boolean);
  const maintenanceMonths = Number(
    remoteProduct.maintenance_months ||
    remoteProduct.interval_months ||
    asRecord(remoteProduct.metadata).maintenance_months ||
    process.env.STORE_WEBHOOK_DEFAULT_MAINTENANCE_MONTHS ||
    3,
  );

  return {
    remoteId: productId,
    data: {
      name: truncate(firstText(remoteProduct.name, remoteProduct.title) || `Salla product ${productId}`, 120),
      interval_months: Math.max(1, Number.isFinite(maintenanceMonths) ? maintenanceMonths : 3),
      category: truncate(firstText(category.name, categories[0]?.name, categories[0]?.title, remoteProduct.category_name), 80),
      sku,
      remind_text: firstText(remoteProduct.remind_text) || "",
      source: "salla",
      store_provider: "salla",
      store_product_id: productId,
      price: optionalNumberValue(remoteProduct.price, price.amount, regularPrice.amount) ?? null,
      sale_price: optionalNumberValue(remoteProduct.sale_price, salePrice.amount, remoteProduct.discounted_price) ?? null,
      currency: truncate(firstText(remoteProduct.currency, price.currency, salePrice.currency, regularPrice.currency, "SAR"), 12),
      image_url: truncate(firstImageUrl(remoteProduct), 500),
      stock_quantity: optionalNumberValue(remoteProduct.quantity, remoteProduct.stock_quantity, remoteProduct.available_quantity, remoteProduct.stock) ?? null,
      store_status: truncate(firstText(asRecord(remoteProduct.status).name, asRecord(remoteProduct.status).slug, remoteProduct.status, remoteProduct.is_available === false ? "unavailable" : "available"), 40),
      product_type: classifyItemType(sku, tags, firstText(remoteProduct.crm_type, remoteProduct.order_type)),
      last_synced_at: syncedAt,
    },
  };
}

function mapSallaOrder(remoteOrder: Record<string, any>): StoreWebhookOrder | null {
  const customer = asRecord(remoteOrder.customer);
  const shipping = asRecord(remoteOrder.shipping);
  const billing = asRecord(remoteOrder.billing);
  const items = asArray(
    remoteOrder.items ||
    remoteOrder.products ||
    remoteOrder.order_items ||
    asRecord(remoteOrder.details).items,
  ).map((item, index) => {
    const product = asRecord(item.product);
    const itemPrice = asRecord(item.price);
    const itemAmounts = asRecord(item.amounts);
    const itemTotal = asRecord(item.total);
    const productPrice = asRecord(product.price);
    const sku = firstText(item.sku, product.sku, item.product_sku) || `SALLA-${remoteOrder.id}-${index + 1}`;
    const tags = collectTags(item);
    const explicitType = firstText(item.crm_type, item.order_type, product.crm_type);
    const maintenanceMonths = Number(item.maintenance_months || product.maintenance_months || product.interval_months || process.env.STORE_WEBHOOK_DEFAULT_MAINTENANCE_MONTHS || 3);
    const quantity = Math.max(1, Number(item.quantity || item.qty || 1));
    const unitPrice = optionalNumberValue(
      item.unit_price,
      item.price,
      item.sale_price,
      item.amount,
      itemPrice.amount,
      itemAmounts.price,
      product.price,
      productPrice.amount,
    );
    const totalPrice = optionalNumberValue(
      item.total,
      item.total_price,
      itemAmounts.total,
      itemTotal.amount,
      unitPrice !== undefined ? unitPrice * quantity : undefined,
    );

    return {
      name: truncate(firstText(item.name, product.name, item.title) || "Salla item", 80),
      sku: truncate(sku, 80),
      quantity,
      unitPrice: unitPrice ?? null,
      totalPrice: totalPrice ?? null,
      currency: truncate(firstText(item.currency, itemPrice.currency, itemAmounts.currency, product.currency, productPrice.currency, "SAR"), 12),
      maintenanceMonths: Math.max(1, Number.isFinite(maintenanceMonths) ? maintenanceMonths : 3),
      orderType: classifyItemType(sku, tags, explicitType),
      tags,
    };
  });

  const phone = normalizePhoneDigits(
    firstText(
      joinCountryCode(customer.mobile_code, customer.mobile),
      customer.mobile,
      customer.phone,
      remoteOrder.mobile,
      remoteOrder.phone,
      joinCountryCode(shipping.mobile_code, shipping.mobile),
      shipping.mobile,
      shipping.phone,
      joinCountryCode(billing.mobile_code, billing.mobile),
      billing.mobile,
      billing.phone,
    ),
  );
  if (!phone) return null;

  const statusRecord = asRecord(remoteOrder.status);
  const orderId = firstText(remoteOrder.id, remoteOrder.order_id, remoteOrder.reference_id);
  if (!orderId) return null;
  const amounts = asRecord(remoteOrder.amounts);

  return {
    provider: "salla",
    eventType: "salla.api.sync",
    eventId: `salla:sync:${orderId}:${firstText(remoteOrder.updated_at, remoteOrder.created_at, nowIso())}`,
    orderId: truncate(orderId, 80),
    orderNumber: truncate(firstText(remoteOrder.reference_id, remoteOrder.number, orderId), 80),
    status: truncate(firstText(statusRecord.name, statusRecord.slug, remoteOrder.status, "new"), 40),
    customerName: truncate(
      firstText(customer.name, customer.full_name, shipping.name, billing.name) || "Salla customer",
      80,
    ),
    customerPhone: phone,
    customerCity: truncate(firstText(customer.city, shipping.city, billing.city), 80),
    orderDate: dateOnly(firstText(remoteOrder.created_at, remoteOrder.date)),
    scheduledDate: firstText(
      remoteOrder.installation_date,
      remoteOrder.appointment_date,
      shipping.delivery_date,
      asRecord(remoteOrder.metadata).installation_date,
    ) ? dateOnly(firstText(
      remoteOrder.installation_date,
      remoteOrder.appointment_date,
      shipping.delivery_date,
      asRecord(remoteOrder.metadata).installation_date,
    )) : undefined,
    scheduledTime: truncate(firstText(
      remoteOrder.installation_time,
      remoteOrder.appointment_time,
      shipping.delivery_time,
      asRecord(remoteOrder.metadata).installation_time,
      "10:00",
    ), 20),
    total: optionalNumberValue(
      remoteOrder.total,
      remoteOrder.amount,
      remoteOrder.total_amount,
      amounts.total,
      asRecord(amounts.total).amount,
    ),
    items: items.length ? items : [{
      name: "Salla order",
      sku: `SALLA-${orderId}`,
      quantity: 1,
      unitPrice: null,
      totalPrice: null,
      currency: "SAR",
      maintenanceMonths: 3,
      orderType: "needs_review",
      tags: [],
    }],
  };
}

function syncSummaryStatus(failed: number) {
  return failed > 0 ? "error" : "success";
}

function sameRemoteStamp(existing: unknown, incoming: string | null) {
  if (!incoming) return false;
  const left = String(existing || "");
  const right = String(incoming || "");
  return left === right || left.startsWith(right) || left.slice(0, 19) === right.slice(0, 19);
}

function normalizedOrderHasMoney(order: StoreWebhookOrder) {
  return (
    typeof order.total === "number" ||
    order.items.some((item) => typeof item.totalPrice === "number" || typeof item.unitPrice === "number")
  );
}

function existingOrderNeedsMoneyRefresh(order: Record<string, unknown>) {
  if (order.total === null || order.total === undefined) return true;
  const items = Array.isArray(order.items) ? order.items : [];
  return items.some((item) => {
    const record = asRecord(item);
    return record.total_price === null || record.total_price === undefined || record.unit_price === null || record.unit_price === undefined;
  });
}

export async function getSallaStatus(currentUid: string, req: Request) {
  const integration = await readIntegration(currentUid);
  const linked = Boolean(integration?.access_token || integration?.refresh_token);
  return {
    provider: "salla",
    storage_mode: usingSupabaseAdapter() ? "local_file" : "settings_collection",
    auth_mode: authMode(),
    configured: configured(),
    linked,
    status: integration?.status || (configured() ? "ready_to_connect" : "not_configured"),
    redirect_uri: readRedirectUri(req),
    webhook_url: readWebhookUrl(req),
    connect_supported: authMode() === "custom",
    webhook_secret_configured: Boolean(sallaAppWebhookSecret()),
    owner_uid_configured: Boolean(sallaAppOwnerUid()),
    scopes: defaultScopes(),
    sync_schedule: syncSchedule(),
    sync_enabled: syncEnabled(),
    customer_sync_interval_minutes: customerSyncIntervalMinutes(),
    store_name: integration?.store_name || null,
    store_url: normalizeStorefrontUrl(integration?.store_url),
    merchant_id: integration?.merchant_id || null,
    expires_at: integration?.expires_at || null,
    has_refresh_token: Boolean(integration?.refresh_token),
    last_authorized_at: integration?.last_authorized_at || null,
    last_event_at: integration?.last_event_at || null,
    last_event_type: integration?.last_event_type || null,
    last_sync_at: integration?.last_sync_at || null,
    last_sync_status: integration?.last_sync_status || "idle",
    last_sync_count: integration?.last_sync_count || 0,
    last_sync_error: integration?.last_sync_error || null,
    last_product_sync_at: integration?.last_product_sync_at || null,
    last_product_sync_count: integration?.last_product_sync_count || 0,
    last_product_sync_error: integration?.last_product_sync_error || null,
    last_customer_sync_at: integration?.last_customer_sync_at || null,
    last_customer_sync_status: integration?.last_customer_sync_status || "idle",
    last_customer_sync_count: integration?.last_customer_sync_count || 0,
    last_customer_sync_error: integration?.last_customer_sync_error || null,
    last_customer_sync_complete: integration?.last_customer_sync_complete === true,
  };
}

export async function getSallaConnectUrl(currentUid: string, req: Request) {
  if (authMode() === "easy") {
    throw new Error("This Salla app uses Easy Mode. Add the app webhook URL in Salla Partners and approve the app installation instead of using a callback connect button.");
  }
  if (!configured()) {
    throw new Error("SALLA_CLIENT_ID and SALLA_CLIENT_SECRET are required before connecting Salla.");
  }

  const redirectUri = readRedirectUri(req);
  const appUrl = readAppUrl(req);
  const state = signState({
    uid: currentUid,
    redirectUri,
    appUrl,
    issuedAt: nowIso(),
  });

  const url = new URL(SALLA_AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId());
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", defaultScopes());
  url.searchParams.set("state", state);

  return {
    url: url.toString(),
    redirect_uri: redirectUri,
    scopes: defaultScopes(),
  };
}

function htmlEscape(value: string) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function htmlRedirect(target: string, message: string) {
  // Security (M2): HTML-encode every interpolated value to prevent reflected
  // content injection / XSS in the OAuth callback page. The previous inline
  // <script> redirect is dropped — it would be blocked by the hardened CSP
  // (no 'unsafe-inline' scripts), and meta refresh + link redirect safely.
  const safeTarget = htmlEscape(target);
  const safeMessage = htmlEscape(message);
  return `<!doctype html><html lang="ar"><head><meta charset="utf-8"><title>Breexe Pro CRM</title><meta http-equiv="refresh" content="0;url=${safeTarget}"></head><body style="font-family:Arial,sans-serif;padding:24px;direction:rtl"><p>${safeMessage}</p><p><a href="${safeTarget}">العودة إلى النظام</a></p></body></html>`;
}

export async function handleSallaCallback(req: Request) {
  if (authMode() === "easy") {
    const target = `${readAppUrl(req)}/?salla=waiting_webhook`;
    return {
      status: 409,
      html: htmlRedirect(
        target,
        "هذا التطبيق يعمل عبر Salla Easy Mode. أكمل تثبيت التطبيق من سلة وانتظر حدث app.store.authorize عبر Webhook التطبيق.",
      ),
    };
  }

  const error = firstText(req.query.error, req.query.error_description);
  const stateValue = firstText(req.query.state);
  const code = firstText(req.query.code);
  const fallbackTarget = `${readAppUrl(req)}/?salla=error`;

  try {
    if (error) {
      return {
        status: 400,
        html: htmlRedirect(`${fallbackTarget}&reason=oauth_denied`, `تعذر ربط سلة: ${error}`),
      };
    }
    if (!code || !stateValue) {
      return {
        status: 400,
        html: htmlRedirect(`${fallbackTarget}&reason=missing_code`, "تعذر ربط سلة: بيانات التفويض ناقصة."),
      };
    }
    if (!configured()) {
      return {
        status: 503,
        html: htmlRedirect(`${fallbackTarget}&reason=missing_config`, "تعذر ربط سلة: مفاتيح التطبيق غير مضبوطة."),
      };
    }

    const state = verifyState(stateValue);
    const token = await exchangeToken(new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId(),
      client_secret: clientSecret(),
      redirect_uri: state.redirectUri,
    }));
    // Persist the one-time authorization grant before any metadata request.
    // A store-info outage must never force the merchant to authorize again.
    await writeIntegration(state.uid, {
      status: "connected",
      access_token: token.access_token,
      refresh_token: token.refresh_token || null,
      expires_at: expiresAt(token.expires_in),
      scope: token.scope || defaultScopes(),
      token_type: token.token_type || "Bearer",
      last_sync_status: "idle",
      last_sync_error: null,
    });

    const profile = await fetchMerchantProfile(token.access_token).catch(() => null);
    if (profile) {
      const profilePatch = merchantProfilePatch(profile);
      if (Object.keys(profilePatch).length) {
        await writeIntegration(state.uid, profilePatch).catch(() => undefined);
      }
    }

    return {
      status: 200,
      html: htmlRedirect(`${state.appUrl}/?salla=connected`, "تم ربط سلة بنجاح. سيتم إعادتك إلى النظام."),
    };
  } catch (callbackError) {
    const message = callbackError instanceof Error ? callbackError.message : "تعذر إكمال ربط سلة.";
    return {
      status: 500,
      html: htmlRedirect(`${fallbackTarget}&reason=callback_failed`, message),
    };
  }
}

export async function handleSallaAppWebhook(req: Request & { rawBody?: Buffer }) {
  verifySallaAppWebhook(req);

  const body = asRecord(req.body);
  const event = firstText(body.event, body.type);
  const merchantId = firstText(body.merchant, body.merchant_id);
  const occurredAt = firstText(body.created_at, body.updated_at) || nowIso();
  const uid = sallaAppOwnerUid();

  // Persistent audit trail of every accepted (signature-passed) Salla event,
  // so we can reconstruct exactly what arrived from the merchant. Logged AFTER
  // verifySallaAppWebhook so we never log unverified payloads.
  if (process.env.NODE_ENV !== "test") {
    try {
      const line = JSON.stringify({
        at: nowIso(),
        event: event || "unknown",
        merchant: merchantId || null,
        has_access_token: Boolean(firstText(asRecord(body.data).access_token)),
        data_keys: Object.keys(asRecord(body.data)).slice(0, 30),
        body_keys: Object.keys(body).slice(0, 30),
      }) + "\n";
      const fsync = await import("fs");
      fsync.appendFileSync(".runtime/salla-webhook.log", line, "utf8");
    } catch {
      // Logging best-effort; never fail the webhook handler over a log write.
    }
  }

  if (!uid) {
    throw new Error("SALLA_APP_OWNER_UID is required before receiving app authorization events.");
  }

  await writeIntegration(uid, {
    last_event_at: occurredAt,
    last_event_type: event || "unknown",
  });

  if (event === "app.store.authorize") {
    const data = asRecord(body.data);
    const accessToken = firstText(data.access_token);
    if (!accessToken) {
      throw new Error("Salla app authorization payload is missing access_token.");
    }

    const refreshToken = firstText(data.refresh_token) || null;
    // Easy Mode delivers the only durable copy of the authorization bundle in
    // this webhook. Save it before making any outbound metadata request.
    await writeIntegration(uid, {
      status: "connected",
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: expiresAtFromUnixOrSeconds(data.expires),
      scope: firstText(data.scope) || defaultScopes(),
      token_type: firstText(data.token_type) || "bearer",
      last_authorized_at: occurredAt,
      last_sync_status: "idle",
      last_sync_error: null,
    });

    const profile = await fetchMerchantProfile(accessToken).catch(() => null);
    const profilePatch = merchantProfilePatch(
      profile || { merchantId: null, storeName: null, storeUrl: null },
      merchantId,
    );
    if (Object.keys(profilePatch).length) {
      await writeIntegration(uid, profilePatch).catch(() => undefined);
    }

    return {
      success: true,
      event,
      owner_uid: uid,
      merchant_id: profile?.merchantId || merchantId || null,
      store_name: profile?.storeName || null,
      linked: true,
    };
  }

  if (event === "app.uninstalled") {
    await writeIntegration(uid, {
      status: configured() ? "ready_to_connect" : "not_configured",
      access_token: null,
      refresh_token: null,
      expires_at: null,
      last_sync_error: null,
    });
    return { success: true, event, owner_uid: uid, linked: false };
  }

  // Salla pushes order.* lifecycle events to the app webhook URL. Forward
  // them through the shared store-webhook normalizer so they land in
  // store_orders alongside the records Salla sync imports later.
  if (event === "order.created" || event === "order.updated" || event === "order.refunded" || event === "order.cancelled") {
    try {
      const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body ?? ""));
      const order = normalizeStorePayload(req, rawBody);
      const imported = await importStoreOrderForUser(uid, order);
      return {
        success: true,
        event,
        owner_uid: uid,
        order_id: order.orderId,
        order_number: order.orderNumber,
        imported,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await writeIntegration(uid, { last_sync_error: message });
      return { success: false, event, owner_uid: uid, error: message };
    }
  }

  // Product lifecycle events: log only for now — the CRM products table is
  // owner-curated; we don't auto-overwrite it from Salla.
  if (event === "product.created" || event === "product.updated" || event === "product.deleted") {
    const data = asRecord(body.data);
    const productId = firstText(data.id, data.uuid) || null;
    const sync = await syncSallaProductsForUser(uid).catch((error) => ({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }));
    return {
      success: Boolean((sync as { success?: boolean }).success),
      event,
      owner_uid: uid,
      product_id: productId,
      product_name: firstText(data.name) || null,
      sync,
    };
  }

  return {
    success: true,
    event: event || "unknown",
    owner_uid: uid,
    ignored: true,
  };
}

export async function syncSallaOrdersForUser(currentUid: string): Promise<SyncResult> {
  if (!configured()) throw new Error("Salla integration is not configured on the server.");

  const integration = await readIntegration(currentUid);
  if (!integration) throw new Error("Salla is not linked for this CRM user.");
  if (integration.status !== "connected" || (!integration.access_token && !integration.refresh_token)) {
    throw new Error("Salla is not connected. Reinstall the Salla app or start the Salla connection again, then run sync.");
  }

  const importedAt = nowIso();
  const existingOrdersSnap = await adminDb
    .collection("store_orders")
    .where("createdBy", "==", currentUid)
    .limit(500)
    .get();
  const existingOrders = new Map<string, Record<string, any>>(
    existingOrdersSnap.docs.map((doc: any) => [String(doc.id), doc.data() || {}] as [string, Record<string, any>]),
  );
  const seen = new Set<string>();
  let imported = 0;
  let updated = 0;
  let failed = 0;
  let fetched = 0;
  let pages = 0;
  let lastRemoteUpdate = integration.last_remote_update_at || null;
  let firstFailureMessage: string | null = null;

  try {
    const token = await ensureFreshAccessToken(currentUid, integration);
    const session: SallaAuthorizedSession = { uid: currentUid, accessToken: token };
    for (let page = 1; page <= maxSyncPages(); page += 1) {
      const payload = await fetchOrdersPage(session, page);
      const orders = asArray(payload.data || payload.orders || payload.items);
      if (!orders.length) break;
      pages += 1;
      fetched += orders.length;

      for (const remoteOrder of orders) {
        const normalized = mapSallaOrder(remoteOrder);
        if (!normalized) {
          failed += 1;
          continue;
        }

        const dedupeKey = `${normalized.provider}:${normalized.orderId}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        const orderDocId = getStoreOrderDocId(currentUid, normalized.provider, normalized.orderId);
        const existing = existingOrders.get(orderDocId);
        const remoteUpdatedAt =
          firstText(remoteOrder.updated_at, remoteOrder.created_at, remoteOrder.date, normalized.orderDate) || null;

        const shouldRefreshMoney =
          existing &&
          normalizedOrderHasMoney(normalized) &&
          existingOrderNeedsMoneyRefresh(existing as Record<string, unknown>);

        if (existing && sameRemoteStamp((existing as Record<string, unknown>).last_event_at, remoteUpdatedAt) && !shouldRefreshMoney) {
          updated += 1;
          lastRemoteUpdate = remoteUpdatedAt || lastRemoteUpdate;
          continue;
        }

        try {
          await importStoreOrderForUser(currentUid, normalized, {
            source: "salla",
            provider: "salla",
            order_date: normalized.orderDate,
            last_event_at: remoteUpdatedAt,
          });
          if (existing) updated += 1;
          else imported += 1;
          lastRemoteUpdate = remoteUpdatedAt || lastRemoteUpdate;
        } catch (orderImportError) {
          failed += 1;
          if (!firstFailureMessage) {
            firstFailureMessage =
              orderImportError instanceof Error
                ? orderImportError.message
                : "Unknown Salla order import failure.";
          }
        }
      }

      const pagination = asRecord(payload.pagination);
      const totalPages = Number(pagination.totalPages || pagination.total_pages || pagination.last_page || 0);
      if (totalPages > 0) {
        if (page >= totalPages) break;
      } else if (orders.length < pageSize()) break;
    }

    await writeIntegration(currentUid, {
      status: "connected",
      last_sync_at: importedAt,
      last_sync_status: syncSummaryStatus(failed),
      last_sync_count: imported + updated,
      last_sync_error: failed
        ? `${failed} orders could not be imported.${firstFailureMessage ? ` First error: ${firstFailureMessage}` : ""}`
        : null,
      last_remote_update_at: lastRemoteUpdate,
    });

    return {
      success: failed === 0,
      imported,
      updated,
      failed,
      pages,
      fetched,
      last_sync_at: importedAt,
      last_error: failed
        ? `${failed} orders could not be imported.${firstFailureMessage ? ` First error: ${firstFailureMessage}` : ""}`
        : null,
    };
  } catch (syncError) {
    const message = syncFailureMessage(syncError, "Salla sync failed.");
    await writeIntegration(currentUid, {
      status: statusAfterSyncFailure(syncError),
      last_sync_at: importedAt,
      last_sync_status: "error",
      last_sync_count: imported + updated,
      last_sync_error: message,
    });
    throw syncError;
  }
}

export async function syncSallaProductsForUser(currentUid: string): Promise<SyncResult> {
  if (!configured()) throw new Error("Salla integration is not configured on the server.");

  const integration = await readIntegration(currentUid);
  if (!integration) throw new Error("Salla is not linked for this CRM user.");
  if (integration.status !== "connected" || (!integration.access_token && !integration.refresh_token)) {
    throw new Error("Salla is not connected. Reinstall the Salla app or start the Salla connection again, then run sync.");
  }

  const syncedAt = nowIso();
  const existingProductsSnap = await adminDb
    .collection("products")
    .where("createdBy", "==", currentUid)
    .limit(1000)
    .get();
  const existingByRemoteId = new Map<string, { id: string; data: Record<string, any> }>();
  const existingBySku = new Map<string, { id: string; data: Record<string, any> }>();
  for (const doc of existingProductsSnap.docs as Array<{ id: string; data: () => Record<string, any> }>) {
    const data = doc.data() || {};
    const remoteId = firstText(data.store_product_id);
    const sku = firstText(data.sku).toLowerCase();
    if (remoteId) existingByRemoteId.set(remoteId, { id: doc.id, data });
    if (sku && !existingBySku.has(sku)) existingBySku.set(sku, { id: doc.id, data });
  }

  let imported = 0;
  let updated = 0;
  let failed = 0;
  let fetched = 0;
  let pages = 0;
  let firstFailureMessage: string | null = null;

  try {
    const token = await ensureFreshAccessToken(currentUid, integration);
    const session: SallaAuthorizedSession = { uid: currentUid, accessToken: token };
    for (let page = 1; page <= maxSyncPages(); page += 1) {
      const payload = await fetchProductsPage(session, page);
      const products = asArray(payload.data || payload.products || payload.items);
      if (!products.length) break;
      pages += 1;
      fetched += products.length;

      for (const remoteProduct of products) {
        const mapped = mapSallaProduct(remoteProduct, syncedAt);
        if (!mapped) {
          failed += 1;
          continue;
        }

        try {
          const skuKey = firstText(mapped.data.sku).toLowerCase();
          const existing = existingByRemoteId.get(mapped.remoteId) || existingBySku.get(skuKey);
          const docId = existing?.id || productDocId(currentUid, mapped.remoteId);
          await adminDb.collection("products").doc(docId).set({
            ...mapped.data,
            createdBy: currentUid,
            createdAt: existing?.data?.createdAt || existing?.data?.created_at || syncedAt,
            updatedAt: syncedAt,
          }, { merge: true });

          const nextEntry = { id: docId, data: { ...(existing?.data || {}), ...mapped.data } };
          existingByRemoteId.set(mapped.remoteId, nextEntry);
          if (skuKey) existingBySku.set(skuKey, nextEntry);
          if (existing) updated += 1;
          else imported += 1;
        } catch (productImportError) {
          failed += 1;
          if (!firstFailureMessage) {
            firstFailureMessage =
              productImportError instanceof Error
                ? productImportError.message
                : "Unknown Salla product import failure.";
          }
        }
      }

      const pagination = asRecord(payload.pagination);
      const totalPages = Number(pagination.totalPages || pagination.total_pages || pagination.last_page || 0);
      if (totalPages > 0) {
        if (page >= totalPages) break;
      } else if (products.length < pageSize()) break;
    }

    const errorMessage = failed
      ? `${failed} products could not be imported.${firstFailureMessage ? ` First error: ${firstFailureMessage}` : ""}`
      : null;
    await writeIntegration(currentUid, {
      status: "connected",
      last_product_sync_at: syncedAt,
      last_product_sync_count: imported + updated,
      last_product_sync_error: errorMessage,
    });

    return {
      success: failed === 0,
      imported,
      updated,
      failed,
      pages,
      fetched,
      last_sync_at: syncedAt,
      last_error: errorMessage,
    };
  } catch (syncError) {
    const message = syncFailureMessage(syncError, "Salla products sync failed.");
    await writeIntegration(currentUid, {
      status: statusAfterSyncFailure(syncError),
      last_product_sync_at: syncedAt,
      last_product_sync_count: imported + updated,
      last_product_sync_error: message,
    });
    throw syncError;
  }
}

async function fetchCustomersPage(session: SallaAuthorizedSession, page: number) {
  const url = new URL(`${SALLA_API_BASE}/customers`);
  url.searchParams.set("page", String(page));
  url.searchParams.set("per_page", String(customerPageSize()));
  return authorizedSallaGet(session, url);
}

type MappedSallaCustomer = {
  documentId: string;
  remoteId: string | null;
  name: string;
  phone: string;
  city: string;
};

function stableJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function mapSallaCustomer(currentUid: string, remoteCustomer: Record<string, any>): MappedSallaCustomer {
  const mobile = asRecord(remoteCustomer.mobile);
  const remoteId = firstText(remoteCustomer.id, remoteCustomer.customer_id, remoteCustomer.uuid) || null;
  const phone = normalizePhoneDigits(firstText(
    joinCountryCode(
      firstText(remoteCustomer.mobile_code, mobile.code, mobile.country_code),
      firstText(remoteCustomer.mobile, mobile.number, mobile.value),
    ),
    remoteCustomer.phone,
    remoteCustomer.phone_number,
    mobile.number,
    mobile.value,
  ));
  const combinedName = [firstText(remoteCustomer.first_name), firstText(remoteCustomer.last_name)]
    .filter(Boolean)
    .join(" ");
  const name = truncate(
    firstText(remoteCustomer.name, remoteCustomer.full_name, combinedName) || "Salla customer",
    120,
  );
  const cityRecord = asRecord(remoteCustomer.city);
  const city = truncate(firstText(remoteCustomer.city, cityRecord.name, cityRecord.title), 80);
  const email = firstText(remoteCustomer.email, remoteCustomer.email_address).toLowerCase();
  const fallbackIdentity = phone
    ? `phone:${phone}`
    : email
      ? `email:${email}`
      : `record:${crypto.createHash("sha256").update(stableJson(remoteCustomer)).digest("hex")}`;
  const identity = remoteId ? `id:${remoteId}` : fallbackIdentity;
  const hash = crypto.createHash("sha1").update(`${currentUid}:salla:${identity}`).digest("hex").slice(0, 24);

  return {
    documentId: `cust_salla_${hash}`,
    remoteId,
    name,
    phone,
    city,
  };
}

type IndexedSallaCustomer = { id: string; data: Record<string, any> };

type SallaCustomerIndexes = {
  byDocumentId: Map<string, IndexedSallaCustomer>;
  byRemoteId: Map<string, IndexedSallaCustomer>;
  legacyByPhone: Map<string, IndexedSallaCustomer>;
};

async function loadSallaCustomerIndexes(currentUid: string): Promise<SallaCustomerIndexes> {
  const snapshot = await adminDb
    .collection("customers")
    .where("createdBy", "==", currentUid)
    .limit(10_000)
    .get();
  const indexes: SallaCustomerIndexes = {
    byDocumentId: new Map(),
    byRemoteId: new Map(),
    legacyByPhone: new Map(),
  };

  for (const doc of snapshot.docs) {
    const data = doc.data() || {};
    const entry = { id: String(doc.id), data };
    indexes.byDocumentId.set(entry.id, entry);
    const remoteId = firstText(data.store_customer_id);
    const isSallaCustomer = data.store_provider === "salla" || data.source === "salla";
    if (remoteId && isSallaCustomer && !indexes.byRemoteId.has(remoteId)) {
      indexes.byRemoteId.set(remoteId, entry);
    }
    const legacyPhone = normalizePhoneDigits(data.phone);
    const isLegacySallaCustomer = !remoteId && isSallaCustomer;
    if (legacyPhone && isLegacySallaCustomer && !indexes.legacyByPhone.has(legacyPhone)) {
      indexes.legacyByPhone.set(legacyPhone, entry);
    }
  }
  return indexes;
}

function resolveSallaCustomerTarget(indexes: SallaCustomerIndexes, customer: MappedSallaCustomer) {
  const preferred = indexes.byDocumentId.get(customer.documentId);
  if (preferred) return { ...preferred, exists: true, claimedLegacyPhone: null as string | null };

  if (customer.remoteId) {
    const byRemoteId = indexes.byRemoteId.get(customer.remoteId);
    if (byRemoteId) return { ...byRemoteId, exists: true, claimedLegacyPhone: null as string | null };
  }

  // Older order-webhook customers may not have store_customer_id. Claim one
  // matching Salla row at most once, then bind it to the immutable remote id.
  if (customer.phone) {
    const legacy = indexes.legacyByPhone.get(customer.phone);
    if (legacy) return { ...legacy, exists: true, claimedLegacyPhone: customer.phone };
  }

  return {
    id: customer.documentId,
    data: {} as Record<string, any>,
    exists: false,
    claimedLegacyPhone: null as string | null,
  };
}

function updateSallaCustomerIndexes(
  indexes: SallaCustomerIndexes,
  target: ReturnType<typeof resolveSallaCustomerTarget>,
  customer: MappedSallaCustomer,
  data: Record<string, unknown>,
) {
  const entry = { id: target.id, data: { ...target.data, ...data } };
  indexes.byDocumentId.set(entry.id, entry);
  if (customer.remoteId) indexes.byRemoteId.set(customer.remoteId, entry);
  if (target.claimedLegacyPhone) indexes.legacyByPhone.delete(target.claimedLegacyPhone);
}

async function syncSallaCustomersForUserUnlocked(currentUid: string): Promise<SyncResult> {
  if (!configured()) throw new Error("Salla integration is not configured on the server.");

  const integration = await readIntegration(currentUid);
  if (!integration) throw new Error("Salla is not linked for this CRM user.");
  if (integration.status !== "connected" || (!integration.access_token && !integration.refresh_token)) {
    throw new Error("Salla is not connected.");
  }

  const syncedAt = nowIso();

  let imported = 0;
  let updated = 0;
  let failed = 0;
  let fetched = 0;
  let pages = 0;
  let firstFailureMessage: string | null = null;
  let partialMessage: string | null = null;
  let capReached = false;
  let expectedTotalPages = 0;
  let expectedTotalCustomers: number | null = null;
  let lastRequestedPage = 0;

  try {
    const token = await ensureFreshAccessToken(currentUid, integration);
    const session: SallaAuthorizedSession = { uid: currentUid, accessToken: token };
    const customerCollection = adminDb.collection("customers");
    const customerIndexes = await loadSallaCustomerIndexes(currentUid);
    const maximumPages = customerMaxSyncPages();
    const requestedPageSize = customerPageSize();
    for (let page = 1; page <= maximumPages; page += 1) {
      const payload = await fetchCustomersPage(session, page);
      lastRequestedPage = page;
      const pagination = asRecord(payload.pagination);
      const totalPages = Number(pagination.totalPages || pagination.total_pages || pagination.last_page || 0);
      if (Number.isFinite(totalPages) && totalPages > 0) {
        expectedTotalPages = Math.max(expectedTotalPages, Math.trunc(totalPages));
      }
      const totalValue = pagination.total;
      if (totalValue !== undefined && totalValue !== null && totalValue !== "") {
        const total = Number(totalValue);
        if (Number.isFinite(total) && total >= 0) {
          expectedTotalCustomers = Math.max(expectedTotalCustomers ?? 0, Math.trunc(total));
        }
      }
      const customers = asArray(payload.data || payload.customers || payload.items);
      if (!customers.length) {
        if (expectedTotalPages > page || (expectedTotalCustomers !== null && fetched < expectedTotalCustomers)) {
          partialMessage = `Salla returned an empty customer page at page ${page} before the advertised result set was complete (${fetched} of ${expectedTotalCustomers ?? "unknown"} customers, ${expectedTotalPages || "unknown"} pages).`;
        }
        break;
      }
      pages += 1;
      fetched += customers.length;

      for (const remoteCustomer of customers) {
        try {
          const mapped = mapSallaCustomer(currentUid, remoteCustomer);
          const target = resolveSallaCustomerTarget(customerIndexes, mapped);
          const customerData: Record<string, unknown> = {
            createdBy: currentUid,
            name: mapped.name,
            phone: mapped.phone,
            city: mapped.city,
            source: "salla",
            store_provider: "salla",
            store_customer_id: mapped.remoteId,
            updatedAt: syncedAt,
          };
          if (!target.exists) customerData.createdAt = syncedAt;

          await customerCollection.doc(target.id).set(customerData, { merge: true });
          updateSallaCustomerIndexes(customerIndexes, target, mapped, customerData);

          if (target.exists) updated += 1;
          else imported += 1;
        } catch (customerImportError) {
          failed += 1;
          if (!firstFailureMessage) {
            firstFailureMessage = customerImportError instanceof Error
              ? customerImportError.message
              : "Unknown Salla customer import failure.";
          }
        }
      }

      if (totalPages > 0) {
        if (page >= totalPages) break;
      } else if (customers.length < requestedPageSize) {
        break;
      }

      if (page >= maximumPages) {
        capReached = true;
        partialMessage = totalPages > page
          ? `Salla customer sync stopped at the configured page limit (${maximumPages} of ${totalPages} pages). Increase SALLA_CUSTOMER_SYNC_MAX_PAGES and run sync again.`
          : `Salla customer sync reached the configured page limit (${maximumPages}) before the final page could be confirmed. Increase SALLA_CUSTOMER_SYNC_MAX_PAGES and run sync again.`;
        break;
      }
    }

    if (!partialMessage && expectedTotalPages > 0 && lastRequestedPage < expectedTotalPages) {
      partialMessage = `Salla customer sync stopped after page ${lastRequestedPage} before all ${expectedTotalPages} advertised pages were fetched.`;
    }
    if (!partialMessage && expectedTotalCustomers !== null && fetched < expectedTotalCustomers) {
      partialMessage = `Salla customer sync fetched ${fetched} of ${expectedTotalCustomers} advertised customers.`;
    }

    const failureMessage = failed
      ? `${failed} customers could not be imported.${firstFailureMessage ? ` First error: ${firstFailureMessage}` : ""}`
      : null;
    const errorMessage = [failureMessage, partialMessage].filter(Boolean).join(" ") || null;
    const success = !errorMessage;

    await writeIntegration(currentUid, {
      status: "connected",
      last_customer_sync_at: syncedAt,
      last_customer_sync_status: success ? "success" : "failed",
      last_customer_sync_count: imported + updated,
      last_customer_sync_error: errorMessage,
      last_customer_sync_complete: success,
    });

    return {
      success,
      imported,
      updated,
      failed,
      fetched,
      pages,
      last_sync_at: syncedAt,
      last_error: errorMessage,
      partial: Boolean(partialMessage),
      cap_reached: capReached,
    };
  } catch (error) {
    const message = syncFailureMessage(error, "Salla customer sync failed.");
    await writeIntegration(currentUid, {
      status: statusAfterSyncFailure(error),
      last_customer_sync_at: syncedAt,
      last_customer_sync_status: "failed",
      last_customer_sync_count: imported + updated,
      last_customer_sync_error: message,
      last_customer_sync_complete: false,
    });
    const syncError = new Error(`Salla customer sync failed: ${message}`);
    (syncError as any).detail = {
      success: false,
      imported,
      updated,
      failed,
      fetched,
      pages,
      last_sync_at: syncedAt,
      last_error: message,
    };
    throw syncError;
  }
}

export async function syncSallaCustomersForUser(currentUid: string): Promise<SyncResult> {
  // Coalesce overlapping manual and scheduled backfills for the same owner.
  // The production topology is one Node process; multi-replica deployments
  // still need a distributed lease before sharing the same integration store.
  const existing = customerSyncLocks.get(currentUid);
  if (existing) return existing;

  const run = syncSallaCustomersForUserUnlocked(currentUid);
  customerSyncLocks.set(currentUid, run);
  try {
    return await run;
  } finally {
    if (customerSyncLocks.get(currentUid) === run) customerSyncLocks.delete(currentUid);
  }
}

function syncFailureResult(error: unknown): SyncResult {
  const message = error instanceof Error ? error.message : String(error);
  const detail = asRecord(asRecord(error).detail);
  const count = (field: string) => {
    const value = Number(detail[field]);
    return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
  };
  const imported = count("imported");
  const updated = count("updated");
  const fetched = count("fetched");
  return {
    success: false,
    imported,
    updated,
    failed: Math.max(1, count("failed")),
    pages: count("pages"),
    fetched,
    last_sync_at: firstText(detail.last_sync_at) || nowIso(),
    last_error: firstText(detail.last_error) || message,
    partial: Boolean(detail.partial) || fetched > 0 || imported + updated > 0,
    cap_reached: Boolean(detail.cap_reached),
  };
}

export async function syncSallaStoreForUser(
  currentUid: string,
  options: { customerMode?: "always" | "if_due" } = {},
): Promise<SyncResult & { orders: SyncResult; products: SyncResult; customers: SyncResult }> {
  const integration = options.customerMode === "if_due" ? await readIntegration(currentUid) : null;
  const customers = options.customerMode === "if_due" && !customerSyncIsDue(integration)
    ? {
        success: true,
        imported: 0,
        updated: 0,
        failed: 0,
        pages: 0,
        fetched: 0,
        last_sync_at: integration?.last_customer_sync_at || nowIso(),
        last_error: null,
        skipped: true,
      }
    : await syncSallaCustomersForUser(currentUid).catch(syncFailureResult);
  const products = await syncSallaProductsForUser(currentUid).catch(syncFailureResult);
  const orders = await syncSallaOrdersForUser(currentUid).catch(syncFailureResult);
  if (!products.success && !orders.success && !customers.success) {
    throw new Error(orders.last_error || products.last_error || customers.last_error || "Salla sync failed.");
  }
  return {
    ...orders,
    success: products.success && orders.success && customers.success,
    imported: orders.imported,
    updated: orders.updated,
    failed: orders.failed,
    fetched: orders.fetched,
    pages: orders.pages,
    last_sync_at: orders.last_sync_at,
    last_error: orders.last_error || products.last_error || customers.last_error || null,
    orders,
    products,
    customers,
  };
}

export async function syncAllLinkedSallaIntegrations() {
  if (!configured()) return { checked: 0, synced: 0, failed: 0 };
  if (usingSupabaseAdapter()) {
    const store = await readLocalIntegrationStore();
    // The JSON key is the authoritative owner identity. Older backups contain
    // records whose embedded createdBy drifted during an owner migration; using
    // that stale field makes the cron read a different (often error) record.
    const docs = Object.entries(store).filter(([, item]) => item?.status === "connected");
    let synced = 0;
    let failed = 0;
    for (const [ownerUid] of docs) {
      try {
        const result = await syncSallaStoreForUser(ownerUid, { customerMode: "if_due" });
        if (result.success) synced += 1;
        else failed += 1;
      } catch {
        failed += 1;
      }
    }
    return { checked: docs.length, synced, failed };
  }
  const snap = await adminDb
    .collection("settings")
    .where("salla_provider", "==", "salla")
    .where("salla_status", "==", "connected")
    .limit(100)
    .get();

  let synced = 0;
  let failed = 0;
  for (const doc of snap.docs) {
    const data = fromSettingsShape(doc.data()) as SallaIntegrationRecord | null;
    if (!data?.createdBy) continue;
    try {
      const result = await syncSallaStoreForUser(String(data.createdBy), { customerMode: "if_due" });
      if (result.success) synced += 1;
      else failed += 1;
    } catch {
      failed += 1;
    }
  }

  return { checked: snap.docs.length, synced, failed };
}

/** Internal, side-effect-free seams used by the Salla regression tests. */
export const __sallaTestables = {
  DEFAULT_SALLA_REQUEST_TIMEOUT_MS,
  authorizedSallaGet,
  customerMaxSyncPages,
  customerPageSize,
  customerSyncIntervalMinutes,
  customerSyncIsDue,
  defaultScopes,
  ensureFreshAccessToken,
  extractMerchantProfile,
  isTransientSallaError,
  normalizeStorefrontUrl,
  mapSallaCustomer,
  pageSize,
  readLocalIntegrationStore,
  requestSallaJson,
  statusAfterSyncFailure,
  syncFailureResult,
  writeIntegration,
  resetLocks() {
    refreshLocks.clear();
    customerSyncLocks.clear();
    localIntegrationWriteLock = Promise.resolve();
  },
};
