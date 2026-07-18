import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

function usage(message = "") {
  if (message) console.error(message);
  console.error(
    "Usage: node scripts/configure-google-contacts-env.mjs --credentials <oauth-client.json> " +
    "[--env .env.production] [--redirect-uri https://crm.example.com/api/integrations/google-contacts/callback]",
  );
  process.exit(2);
}

function args(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith("--")) usage(`Unknown argument: ${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) usage(`Missing value for ${name}`);
    result[name.slice(2)] = value;
    index += 1;
  }
  return result;
}

function parseEnv(content) {
  const values = new Map();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

function replaceOrAppend(content, key, value) {
  const escaped = String(value).replace(/\r?\n/g, "\\n");
  const line = `${key}=${escaped}`;
  const pattern = new RegExp(`^(?:export\\s+)?${key}\\s*=.*$`, "m");
  if (pattern.test(content)) return content.replace(pattern, line);
  return `${content.replace(/\s*$/, "")}\n${line}\n`;
}

const options = args(process.argv.slice(2));
if (!options.credentials) usage("--credentials is required");

const envPath = resolve(options.env || ".env.production");
const credentialsPath = resolve(options.credentials);
const credentials = JSON.parse(readFileSync(credentialsPath, "utf8"));
const oauth = credentials.web || {};
const clientId = String(oauth.client_id || "").trim();
const clientSecret = String(oauth.client_secret || "").trim();
if (!clientId || !clientSecret) {
  usage("The credentials file must contain a Google OAuth client of type Web application.");
}

let content = readFileSync(envPath, "utf8");
const existing = parseEnv(content);
const redirectUri = String(
  options["redirect-uri"] ||
  oauth.redirect_uris?.find((uri) => /\/api\/integrations\/google-contacts\/callback\/?$/.test(uri)) ||
  existing.get("GOOGLE_CONTACTS_REDIRECT_URI") ||
  "",
).trim();
if (!/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/api\/integrations\/google-contacts\/callback\/?$/.test(redirectUri)) {
  usage("A valid HTTPS --redirect-uri ending in /api/integrations/google-contacts/callback is required.");
}
const registeredRedirects = Array.isArray(oauth.redirect_uris) ? oauth.redirect_uris.map(String) : [];
if (!registeredRedirects.includes(redirectUri)) {
  usage(`The OAuth client must register this exact redirect URI: ${redirectUri}`);
}

const encryptionKey = String(existing.get("GOOGLE_CONTACTS_ENCRYPTION_KEY") || "").trim()
  || randomBytes(32).toString("hex");
for (const [key, value] of Object.entries({
  GOOGLE_CONTACTS_CLIENT_ID: clientId,
  GOOGLE_CONTACTS_CLIENT_SECRET: clientSecret,
  GOOGLE_CONTACTS_REDIRECT_URI: redirectUri,
  GOOGLE_CONTACTS_ENCRYPTION_KEY: encryptionKey,
})) {
  content = replaceOrAppend(content, key, value);
}

const temporaryPath = `${envPath}.${process.pid}.tmp`;
writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
renameSync(temporaryPath, envPath);
try { chmodSync(envPath, 0o600); } catch { /* Windows permissions are managed by ACLs. */ }

console.log(`Configured Google Contacts in ${basename(envPath)}.`);
console.log(`OAuth credentials source: ${basename(credentialsPath)}.`);
console.log(`Redirect URI: ${redirectUri}`);
console.log("Client secret and encryption key were not printed.");
