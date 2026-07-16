import crypto from "node:crypto";
import db from "./db";
import { normalizePhoneDigits } from "../shared/phone";

type GoogleIntegrationRow = {
  id: string;
  owner_uid: string;
  user_uid: string;
  email: string;
  display_name: string;
  access_token_ciphertext: string;
  refresh_token_ciphertext: string;
  token_expires_at: string | null;
  scope: string;
  status: string;
  last_error: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
};

type GoogleTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
};

function nowIso(date = new Date()) {
  return date.toISOString();
}

function newId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`;
}

function encryptionKey() {
  const source = String(
    process.env.GOOGLE_CONTACTS_ENCRYPTION_KEY ||
    process.env.MOBILE_DATA_ENCRYPTION_KEY ||
    process.env.GATEWAY_DEVICE_HMAC_SECRET ||
    "",
  ).trim();
  return source ? crypto.createHash("sha256").update(source).digest() : null;
}

function encrypt(value: string) {
  const key = encryptionKey();
  if (!key || !value) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64url")).join(".");
}

function decrypt(value: string | null | undefined) {
  const key = encryptionKey();
  if (!key || !value) return "";
  try {
    const [iv, tag, ciphertext] = value.split(".").map((part) => Buffer.from(part, "base64url"));
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

function configuration(baseUrl?: string) {
  const clientId = String(process.env.GOOGLE_CONTACTS_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.GOOGLE_CONTACTS_CLIENT_SECRET || "").trim();
  const redirectUri = String(process.env.GOOGLE_CONTACTS_REDIRECT_URI || "").trim()
    || (baseUrl ? `${baseUrl.replace(/\/$/, "")}/api/integrations/google-contacts/callback` : "");
  const missing = [
    !clientId ? "GOOGLE_CONTACTS_CLIENT_ID" : "",
    !clientSecret ? "GOOGLE_CONTACTS_CLIENT_SECRET" : "",
    !encryptionKey() ? "GOOGLE_CONTACTS_ENCRYPTION_KEY" : "",
    !redirectUri ? "GOOGLE_CONTACTS_REDIRECT_URI" : "",
  ].filter(Boolean);
  return { clientId, clientSecret, redirectUri, configured: missing.length === 0, missing };
}

function row(ownerUid: string, userUid: string) {
  return db.prepare(
    "SELECT * FROM google_contact_integrations WHERE owner_uid = ? AND user_uid = ? LIMIT 1",
  ).get(ownerUid, userUid) as GoogleIntegrationRow | undefined;
}

function audit(ownerUid: string, actorUid: string, action: string, summary: string, after?: unknown) {
  db.prepare(
    `INSERT INTO audit_logs
      (id, owner_uid, actor_uid, action, entity_type, entity_id, summary, after_data, created_at)
     VALUES (?, ?, ?, ?, 'google_contacts', ?, ?, ?, ?)`,
  ).run(newId("audit"), ownerUid, actorUid, action, actorUid, summary, after ? JSON.stringify(after) : null, nowIso());
}

export function googleContactsStatus(ownerUid: string, userUid: string, baseUrl?: string) {
  const config = configuration(baseUrl);
  const integration = row(ownerUid, userUid);
  return {
    configured: config.configured,
    missing: config.missing,
    connected: integration?.status === "connected" && Boolean(decrypt(integration.refresh_token_ciphertext) || decrypt(integration.access_token_ciphertext)),
    email: integration?.email || "",
    displayName: integration?.display_name || "",
    status: integration?.status || "disconnected",
    lastError: integration?.last_error || "",
    lastSyncedAt: integration?.last_synced_at || null,
    updatedAt: integration?.updated_at || null,
  };
}

export function beginGoogleContactsOAuth(input: {
  ownerUid: string;
  userUid: string;
  baseUrl: string;
  returnUrl?: string;
}) {
  const config = configuration(input.baseUrl);
  if (!config.configured) {
    throw new Error(`إعداد Google Contacts غير مكتمل: ${config.missing.join(", ")}`);
  }
  const state = crypto.randomBytes(32).toString("base64url");
  const stateHash = crypto.createHash("sha256").update(state).digest("hex");
  const expiresAt = nowIso(new Date(Date.now() + 10 * 60_000));
  const safeReturn = String(input.returnUrl || "/?section=callSystem&callTab=contacts");
  db.prepare(
    `INSERT INTO google_contact_oauth_states
      (state_hash, owner_uid, user_uid, return_url, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(stateHash, input.ownerUid, input.userUid, safeReturn.startsWith("/") ? safeReturn : "/?section=callSystem&callTab=contacts", expiresAt, nowIso());

  const query = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    scope: "openid email profile https://www.googleapis.com/auth/contacts",
    state,
  });
  return { url: `https://accounts.google.com/o/oauth2/v2/auth?${query}`, expiresAt };
}

async function responseJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(String(parsed.error_description || parsed.error?.message || parsed.error || `Google HTTP ${response.status}`));
  }
  return parsed as T;
}

async function exchangeToken(config: ReturnType<typeof configuration>, body: URLSearchParams) {
  return responseJson<GoogleTokenResponse>(await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  }));
}

export async function completeGoogleContactsOAuth(input: { state: string; code: string; baseUrl: string }) {
  const stateHash = crypto.createHash("sha256").update(input.state).digest("hex");
  const state = db.prepare(
    `SELECT * FROM google_contact_oauth_states
     WHERE state_hash = ? AND used_at IS NULL AND expires_at > ? LIMIT 1`,
  ).get(stateHash, nowIso()) as { owner_uid: string; user_uid: string; return_url: string } | undefined;
  if (!state) throw new Error("انتهت صلاحية طلب ربط Google أو تم استخدامه مسبقًا.");

  const config = configuration(input.baseUrl);
  if (!config.configured) throw new Error(`إعداد Google Contacts غير مكتمل: ${config.missing.join(", ")}`);
  const token = await exchangeToken(config, new URLSearchParams({
    code: input.code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: "authorization_code",
  }));
  if (!token.access_token) throw new Error(token.error_description || "لم يعُد Google برمز وصول.");

  const profile = await responseJson<{ email?: string; name?: string }>(await fetch(
    "https://www.googleapis.com/oauth2/v2/userinfo",
    { headers: { Authorization: `Bearer ${token.access_token}` } },
  ));
  const existing = row(state.owner_uid, state.user_uid);
  const refreshToken = token.refresh_token || decrypt(existing?.refresh_token_ciphertext);
  if (!refreshToken) throw new Error("لم يعُد Google برمز تحديث. ألغِ وصول BreeXe من حساب Google ثم أعد الربط.");
  const updatedAt = nowIso();
  db.prepare(
    `INSERT INTO google_contact_integrations
      (id, owner_uid, user_uid, email, display_name, access_token_ciphertext,
       refresh_token_ciphertext, token_expires_at, scope, status, last_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'connected', NULL, ?, ?)
     ON CONFLICT(owner_uid, user_uid) DO UPDATE SET
       email = excluded.email,
       display_name = excluded.display_name,
       access_token_ciphertext = excluded.access_token_ciphertext,
       refresh_token_ciphertext = excluded.refresh_token_ciphertext,
       token_expires_at = excluded.token_expires_at,
       scope = excluded.scope,
       status = 'connected', last_error = NULL, updated_at = excluded.updated_at`,
  ).run(
    existing?.id || newId("gci"), state.owner_uid, state.user_uid,
    profile.email || "", profile.name || "", encrypt(token.access_token), encrypt(refreshToken),
    nowIso(new Date(Date.now() + Math.max(60, Number(token.expires_in || 3600)) * 1000)), token.scope || "",
    existing?.created_at || updatedAt, updatedAt,
  );
  db.prepare("UPDATE google_contact_oauth_states SET used_at = ? WHERE state_hash = ?").run(updatedAt, stateHash);
  audit(state.owner_uid, state.user_uid, "contacts.google.connected", "تم ربط Google Contacts", { email: profile.email || "" });
  return { returnUrl: state.return_url, ownerUid: state.owner_uid, userUid: state.user_uid };
}

export function disconnectGoogleContacts(ownerUid: string, userUid: string) {
  const integration = row(ownerUid, userUid);
  if (!integration) return false;
  db.prepare(
    `UPDATE google_contact_integrations SET status = 'disconnected', access_token_ciphertext = '',
     refresh_token_ciphertext = '', token_expires_at = NULL, last_error = NULL, updated_at = ?
     WHERE owner_uid = ? AND user_uid = ?`,
  ).run(nowIso(), ownerUid, userUid);
  audit(ownerUid, userUid, "contacts.google.disconnected", "تم فصل Google Contacts");
  return true;
}

async function accessToken(ownerUid: string, userUid: string, baseUrl?: string) {
  const integration = row(ownerUid, userUid);
  if (!integration || integration.status !== "connected") throw new Error("Google Contacts غير مربوط لهذا الموظف.");
  const current = decrypt(integration.access_token_ciphertext);
  const expiresAt = Date.parse(integration.token_expires_at || "");
  if (current && Number.isFinite(expiresAt) && expiresAt > Date.now() + 60_000) return current;

  const refreshToken = decrypt(integration.refresh_token_ciphertext);
  if (!refreshToken) throw new Error("رمز تحديث Google غير متوفر. أعد ربط الحساب.");
  const config = configuration(baseUrl);
  if (!config.configured) throw new Error(`إعداد Google Contacts غير مكتمل: ${config.missing.join(", ")}`);
  const token = await exchangeToken(config, new URLSearchParams({
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "refresh_token",
  }));
  if (!token.access_token) throw new Error(token.error_description || "تعذر تحديث رمز Google.");
  db.prepare(
    `UPDATE google_contact_integrations SET access_token_ciphertext = ?, token_expires_at = ?,
     scope = COALESCE(NULLIF(?, ''), scope), status = 'connected', last_error = NULL, updated_at = ?
     WHERE owner_uid = ? AND user_uid = ?`,
  ).run(
    encrypt(token.access_token),
    nowIso(new Date(Date.now() + Math.max(60, Number(token.expires_in || 3600)) * 1000)),
    token.scope || "", nowIso(), ownerUid, userUid,
  );
  return token.access_token;
}

function personPayload(customer: Record<string, unknown>, etag?: string) {
  const name = String(customer.name || "").trim();
  const phone = normalizePhoneDigits(String(customer.phone || ""));
  const company = String(customer.company || "").trim();
  const payload: Record<string, unknown> = {
    names: [{ displayName: name, givenName: name }],
    phoneNumbers: [{ value: phone.startsWith("+") ? phone : `+${phone}`, type: "mobile" }],
    userDefined: [{ key: "BreeXe CRM ID", value: String(customer.id || "") }],
  };
  if (company) payload.organizations = [{ name: company, type: "work" }];
  if (etag) payload.etag = etag;
  return payload;
}

export async function syncGoogleCustomer(input: {
  ownerUid: string;
  userUid: string;
  customerId: string;
  baseUrl?: string;
}) {
  const customer = db.prepare(
    `SELECT id, name, phone, company, contact_needs_name FROM customers
     WHERE owner_uid = ? AND id = ? LIMIT 1`,
  ).get(input.ownerUid, input.customerId) as Record<string, unknown> | undefined;
  if (!customer) throw new Error("جهة الاتصال غير موجودة في CRM.");
  if (Number(customer.contact_needs_name || 0) === 1 || !String(customer.name || "").trim()) {
    return { synced: false, reason: "needs_name" };
  }
  const phone = normalizePhoneDigits(String(customer.phone || ""));
  if (!/^\d{8,15}$/.test(phone)) return { synced: false, reason: "invalid_phone" };

  const integration = row(input.ownerUid, input.userUid);
  if (!integration || integration.status !== "connected") return { synced: false, reason: "not_connected" };
  const token = await accessToken(input.ownerUid, input.userUid, input.baseUrl);
  const link = db.prepare(
    `SELECT * FROM google_contact_links WHERE owner_uid = ? AND user_uid = ? AND customer_id = ? LIMIT 1`,
  ).get(input.ownerUid, input.userUid, input.customerId) as Record<string, unknown> | undefined;

  let resourceName = String(link?.resource_name || "");
  let etag = String(link?.etag || "");
  try {
    let result: { resourceName?: string; etag?: string; metadata?: unknown };
    if (resourceName) {
      const current = await responseJson<{ resourceName?: string; etag?: string; metadata?: unknown }>(await fetch(
        `https://people.googleapis.com/v1/${encodeURI(resourceName)}?personFields=names,phoneNumbers,organizations,metadata,userDefined`,
        { headers: { Authorization: `Bearer ${token}` } },
      ));
      result = await responseJson(await fetch(
        `https://people.googleapis.com/v1/${encodeURI(resourceName)}:updateContact?updatePersonFields=names,phoneNumbers,organizations,userDefined&personFields=names,phoneNumbers,organizations,metadata,userDefined`,
        {
          method: "PATCH",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(personPayload(customer, current.etag)),
        },
      ));
    } else {
      result = await responseJson(await fetch(
        "https://people.googleapis.com/v1/people:createContact?personFields=names,phoneNumbers,organizations,metadata,userDefined",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(personPayload(customer)),
        },
      ));
    }
    resourceName = String(result.resourceName || resourceName);
    etag = String(result.etag || etag);
    const syncedAt = nowIso();
    db.prepare(
      `INSERT INTO google_contact_links
        (id, owner_uid, user_uid, customer_id, resource_name, etag, status, last_error, last_synced_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'synced', NULL, ?, ?, ?)
       ON CONFLICT(owner_uid, user_uid, customer_id) DO UPDATE SET
         resource_name = excluded.resource_name, etag = excluded.etag, status = 'synced',
         last_error = NULL, last_synced_at = excluded.last_synced_at, updated_at = excluded.updated_at`,
    ).run(
      link?.id || newId("gcl"), input.ownerUid, input.userUid, input.customerId,
      resourceName, etag, syncedAt, String(link?.created_at || syncedAt), syncedAt,
    );
    db.prepare(
      "UPDATE google_contact_integrations SET last_synced_at = ?, last_error = NULL, updated_at = ? WHERE owner_uid = ? AND user_uid = ?",
    ).run(syncedAt, syncedAt, input.ownerUid, input.userUid);
    return { synced: true, resourceName, etag, syncedAt };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failedAt = nowIso();
    db.prepare(
      `INSERT INTO google_contact_links
        (id, owner_uid, user_uid, customer_id, resource_name, etag, status, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'failed', ?, ?, ?)
       ON CONFLICT(owner_uid, user_uid, customer_id) DO UPDATE SET
         status = 'failed', last_error = excluded.last_error, updated_at = excluded.updated_at`,
    ).run(
      link?.id || newId("gcl"), input.ownerUid, input.userUid, input.customerId,
      resourceName, etag, message.slice(0, 2000), String(link?.created_at || failedAt), failedAt,
    );
    db.prepare(
      "UPDATE google_contact_integrations SET last_error = ?, updated_at = ? WHERE owner_uid = ? AND user_uid = ?",
    ).run(message.slice(0, 2000), failedAt, input.ownerUid, input.userUid);
    throw error;
  }
}

export async function syncNamedGoogleContacts(input: {
  ownerUid: string;
  userUid: string;
  baseUrl?: string;
  limit?: number;
}) {
  const contacts = db.prepare(
    `SELECT id FROM customers WHERE owner_uid = ? AND contact_needs_name = 0
     AND TRIM(name) <> '' AND TRIM(phone) <> '' ORDER BY updated_at DESC LIMIT ?`,
  ).all(input.ownerUid, Math.max(1, Math.min(500, input.limit || 100))) as Array<{ id: string }>;
  let synced = 0;
  const failed: Array<{ id: string; error: string }> = [];
  for (const contact of contacts) {
    try {
      const result = await syncGoogleCustomer({ ...input, customerId: contact.id });
      if (result.synced) synced += 1;
    } catch (error) {
      failed.push({ id: contact.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  audit(input.ownerUid, input.userUid, "contacts.google.sync", "مزامنة جهات اتصال CRM إلى Google", {
    total: contacts.length, synced, failed: failed.length,
  });
  return { total: contacts.length, synced, failed };
}
