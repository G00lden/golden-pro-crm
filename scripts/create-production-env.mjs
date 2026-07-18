import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnvFile, root } from "./env-utils.mjs";

const source = parseEnvFile(join(root, ".env"));
const target = join(root, ".env.production");
const domain = process.env.PRODUCTION_DOMAIN || source.PRODUCTION_DOMAIN || "crm.breexe-pro.com";
const hasWhatsAppCloudCredentials = Boolean(source.WHATSAPP_CLOUD_PHONE_NUMBER_ID && source.WHATSAPP_CLOUD_API_TOKEN);

function secret(name, bytes = 32) {
  return source[name] || randomBytes(bytes).toString("hex");
}

function keep(name, fallback = "") {
  return source[name] || fallback;
}

function requiredScopes(value) {
  return [...new Set(String(value || "").split(/\s+/).filter(Boolean).concat("customers.read"))].join(" ");
}

const values = {
  APP_ENV: "production",
  PORT: "8080",
  APP_TIMEZONE: keep("APP_TIMEZONE", "Asia/Riyadh"),
  APP_URL: `https://${domain}`,
  ENABLE_SECURITY_HEADERS: "true",
  OUTBOUND_MODE: keep("OUTBOUND_MODE", "code"),
  OUTBOUND_CONFIRM_CODE: keep("OUTBOUND_CONFIRM_CODE", "2232"),
  OFFICIAL_LAUNCH_APPROVED: keep("OFFICIAL_LAUNCH_APPROVED", "false"),
  OUTBOUND_TEST_PHONE_ALLOWLIST: keep("OUTBOUND_TEST_PHONE_ALLOWLIST"),
  API_RATE_LIMIT_WINDOW_MS: keep("API_RATE_LIMIT_WINDOW_MS", "60000"),
  API_RATE_LIMIT_MAX: keep("API_RATE_LIMIT_MAX", "240"),
  WEBHOOK_RATE_LIMIT_WINDOW_MS: keep("WEBHOOK_RATE_LIMIT_WINDOW_MS", "60000"),
  WEBHOOK_RATE_LIMIT_MAX: keep("WEBHOOK_RATE_LIMIT_MAX", "120"),

  ALLOW_LOCAL_AUTH: "false",
  VITE_LOCAL_AUTH: "false",

  DATA_PROVIDER: "supabase",
  VITE_DATA_PROVIDER: "supabase",
  SUPABASE_URL: keep("SUPABASE_URL"),
  SUPABASE_SERVICE_ROLE_KEY: keep("SUPABASE_SERVICE_ROLE_KEY") || keep("SUPABASE_SERVICE_KEY"),
  VITE_SUPABASE_URL: keep("VITE_SUPABASE_URL") || keep("SUPABASE_URL"),
  VITE_SUPABASE_PUBLISHABLE_KEY: keep("VITE_SUPABASE_PUBLISHABLE_KEY"),

  FIREBASE_SERVICE_ACCOUNT_PATH: keep("FIREBASE_SERVICE_ACCOUNT_PATH"),
  FIREBASE_SERVICE_ACCOUNT_JSON: keep("FIREBASE_SERVICE_ACCOUNT_JSON"),

  // Per-employee CRM -> Google -> Android contact sync. Keep the OAuth client
  // and token-encryption key in the private production environment so a future
  // regeneration does not silently disable Google Contacts.
  GOOGLE_CONTACTS_CLIENT_ID: keep("GOOGLE_CONTACTS_CLIENT_ID"),
  GOOGLE_CONTACTS_CLIENT_SECRET: keep("GOOGLE_CONTACTS_CLIENT_SECRET"),
  GOOGLE_CONTACTS_REDIRECT_URI: keep(
    "GOOGLE_CONTACTS_REDIRECT_URI",
    `https://${domain}/api/integrations/google-contacts/callback`,
  ),
  GOOGLE_CONTACTS_ENCRYPTION_KEY: secret("GOOGLE_CONTACTS_ENCRYPTION_KEY"),

  STORE_WEBHOOK_SECRET: secret("STORE_WEBHOOK_SECRET"),
  STORE_WEBHOOK_OWNER_UID: keep("STORE_WEBHOOK_OWNER_UID"),
  STORE_WEBHOOK_DEFAULT_MAINTENANCE_MONTHS: keep("STORE_WEBHOOK_DEFAULT_MAINTENANCE_MONTHS", "3"),
  STORE_WEBHOOK_CREATE_BOOKINGS: keep("STORE_WEBHOOK_CREATE_BOOKINGS", "true"),
  STORE_WEBHOOK_DEFAULT_TECHNICIAN_ID: keep("STORE_WEBHOOK_DEFAULT_TECHNICIAN_ID"),
  STORE_WEBHOOK_DEFAULT_TECHNICIAN_NAME: keep("STORE_WEBHOOK_DEFAULT_TECHNICIAN_NAME"),

  SALLA_AUTH_MODE: keep("SALLA_AUTH_MODE", "easy"),
  SALLA_CLIENT_ID: keep("SALLA_CLIENT_ID"),
  SALLA_CLIENT_SECRET: keep("SALLA_CLIENT_SECRET"),
  SALLA_REDIRECT_URI: `https://${domain}/api/integrations/salla/callback`,
  SALLA_SCOPES: requiredScopes(keep("SALLA_SCOPES", "offline_access orders.read_write products.read_write customers.read_write webhooks.read_write")),
  SALLA_SYNC_CRON_ENABLED: "true",
  SALLA_SYNC_CRON_SCHEDULE: keep("SALLA_SYNC_CRON_SCHEDULE", "*/15 * * * *"),
  SALLA_SYNC_MAX_PAGES: keep("SALLA_SYNC_MAX_PAGES", "200"),
  SALLA_SYNC_PAGE_SIZE: keep("SALLA_SYNC_PAGE_SIZE", "30"),
  SALLA_PRODUCT_SYNC_MAX_PAGES: keep("SALLA_PRODUCT_SYNC_MAX_PAGES", "200"),
  SALLA_CUSTOMER_SYNC_MAX_PAGES: keep("SALLA_CUSTOMER_SYNC_MAX_PAGES", "200"),
  SALLA_CUSTOMER_SYNC_PAGE_SIZE: keep("SALLA_CUSTOMER_SYNC_PAGE_SIZE", "60"),
  SALLA_CUSTOMER_SYNC_INTERVAL_MINUTES: keep("SALLA_CUSTOMER_SYNC_INTERVAL_MINUTES", "360"),
  SALLA_FETCH_TIMEOUT_MS: keep("SALLA_FETCH_TIMEOUT_MS", "15000"),
  SALLA_FETCH_MAX_RETRIES: keep("SALLA_FETCH_MAX_RETRIES", "2"),
  SALLA_FETCH_RETRY_BASE_DELAY_MS: keep("SALLA_FETCH_RETRY_BASE_DELAY_MS", "500"),
  SALLA_FETCH_RETRY_MAX_DELAY_MS: keep("SALLA_FETCH_RETRY_MAX_DELAY_MS", "30000"),
  SALLA_STATE_SECRET: secret("SALLA_STATE_SECRET"),
  SALLA_APP_WEBHOOK_SECRET: keep("SALLA_APP_WEBHOOK_SECRET") || secret("STORE_WEBHOOK_SECRET"),
  SALLA_APP_OWNER_UID: keep("SALLA_APP_OWNER_UID") || keep("STORE_WEBHOOK_OWNER_UID"),

  ENABLE_DAILY_CRON: "true",
  REMINDER_CRON_SCHEDULE: keep("REMINDER_CRON_SCHEDULE", "0 10 * * *"),
  REMINDER_RETRY_COOLDOWN_MINUTES: keep("REMINDER_RETRY_COOLDOWN_MINUTES", "30"),

  WHATSAPP_PROVIDER: keep("WHATSAPP_PROVIDER", hasWhatsAppCloudCredentials ? "cloud_api" : "web"),
  WA_SESSION_DIR: keep("WA_SESSION_DIR", ".wa-session"),
  WHATSAPP_CLOUD_API_VERSION: keep("WHATSAPP_CLOUD_API_VERSION", "v23.0"),
  WHATSAPP_CLOUD_PHONE_NUMBER_ID: keep("WHATSAPP_CLOUD_PHONE_NUMBER_ID"),
  WHATSAPP_CLOUD_API_TOKEN: keep("WHATSAPP_CLOUD_API_TOKEN"),
  WHATSAPP_CLOUD_TEMPLATE_NAME: keep("WHATSAPP_CLOUD_TEMPLATE_NAME"),
  WHATSAPP_CLOUD_TEMPLATE_LANGUAGE: keep("WHATSAPP_CLOUD_TEMPLATE_LANGUAGE", "ar"),

  CLOUDFLARE_ZONE_NAME: keep("CLOUDFLARE_ZONE_NAME", "breexe-pro.com"),
  CLOUDFLARE_RECORD_NAME: keep("CLOUDFLARE_RECORD_NAME", "crm"),
  CLOUDFLARE_RECORD_TYPE: keep("CLOUDFLARE_RECORD_TYPE", "A"),
  CLOUDFLARE_DNS_TARGET: keep("CLOUDFLARE_DNS_TARGET"),
  CLOUDFLARE_PROXIED: keep("CLOUDFLARE_PROXIED", "true"),
};

const lines = [
  "# Generated by npm run env:prod. Keep this file private.",
  ...Object.entries(values).map(([key, value]) => `${key}=${String(value ?? "").replace(/\r?\n/g, "\\n")}`),
  "",
];

if (existsSync(target) && !process.argv.includes("--force")) {
  console.error(".env.production already exists. Re-run with: node scripts/create-production-env.mjs --force");
  process.exit(1);
}

writeFileSync(target, lines.join("\n"), "utf8");
console.log(`Created ${target}`);
console.log(`Production domain: https://${domain}`);
