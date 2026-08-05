import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

function argument(name, fallback = "") {
  const prefix = "--" + name + "=";
  const match = process.argv.find(value => value.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function parseEnv(source) {
  const values = new Map();
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    values.set(match[1], value);
  }
  return values;
}

function replaceKey(source, key, value) {
  const escaped = key.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
  const pattern = new RegExp("^(?:export\\s+)?" + escaped + "\\s*=.*$", "m");
  const line = key + "=" + value;
  if (pattern.test(source)) return source.replace(pattern, line);
  return source.replace(/\s*$/, "") + "\n" + line + "\n";
}

const envPath = path.resolve(argument("env-file", ".env.production"));
if (!existsSync(envPath)) throw new Error("Environment file does not exist: " + envPath);
let source = readFileSync(envPath, "utf8");
const current = parseEnv(source);
let portalSecret = String(current.get("MAINTENANCE_PORTAL_SECRET") || "");
if (portalSecret.length < 32) portalSecret = randomBytes(48).toString("base64url");
let webhookVerifyToken = String(current.get("WHATSAPP_WEBHOOK_VERIFY_TOKEN") || "");
if (webhookVerifyToken.length < 24) webhookVerifyToken = randomBytes(32).toString("base64url");
let webhookSecret = String(current.get("WHATSAPP_WEBHOOK_SECRET") || "");
const appSecret = String(current.get("WHATSAPP_APP_SECRET") || "");
if (!appSecret && webhookSecret.length < 32) webhookSecret = randomBytes(48).toString("base64url");

const canaryId = argument("canary-id", String(current.get("MAINTENANCE_FIELDTECH_CANARY_EVIDENCE") || ""));
const canaryAt = argument("canary-at", String(current.get("MAINTENANCE_FIELDTECH_CANARY_AT") || ""));
if (!/^[A-Za-z0-9._:-]{8,200}$/.test(canaryId)) throw new Error("A safe --canary-id is required.");
const canaryTime = Date.parse(canaryAt);
if (!Number.isFinite(canaryTime) || canaryTime > Date.now() + 5 * 60_000 || canaryTime < Date.now() - 30 * 24 * 60 * 60_000) {
  throw new Error("--canary-at must be a valid recent ISO timestamp.");
}

source = replaceKey(source, "MAINTENANCE_PORTAL_SECRET", portalSecret);
source = replaceKey(source, "MAINTENANCE_FIELDTECH_CANARY_EVIDENCE", canaryId);
source = replaceKey(source, "MAINTENANCE_FIELDTECH_CANARY_AT", new Date(canaryTime).toISOString());
source = replaceKey(source, "MAINTENANCE_WHATSAPP_OTP_TEMPLATE", "breexe_maintenance_otp_ar");
source = replaceKey(source, "MAINTENANCE_WHATSAPP_OTP_LANGUAGE", "ar");
source = replaceKey(source, "MAINTENANCE_WHATSAPP_OTP_MODE", "allowlist");
source = replaceKey(source, "MAINTENANCE_WHATSAPP_OTP_LAUNCH_APPROVED", "false");
source = replaceKey(source, "MAINTENANCE_OTP_TTL_MINUTES", "10");
source = replaceKey(source, "MAINTENANCE_ATTACHMENT_DIR", ".runtime/maintenance-attachments");
source = replaceKey(source, "WHATSAPP_PROVIDER", "cloud_api");
source = replaceKey(source, "WHATSAPP_WEBHOOK_VERIFY_TOKEN", webhookVerifyToken);
if (!appSecret) source = replaceKey(source, "WHATSAPP_WEBHOOK_SECRET", webhookSecret);
const inactiveOutboundFeatures = [
  ["SALLA_CART_WHATSAPP_ENABLED", "WHATSAPP_CLOUD_TEMPLATE_ABANDONED_CART_SUPPORT"],
  ["SALLA_DELIVERY_REVIEW_ENABLED", "WHATSAPP_CLOUD_TEMPLATE_DELIVERY_REVIEW_REQUEST"],
  ["WHATSAPP_BOOKING_TECHNICIAN_NOTIFY_ENABLED", "WHATSAPP_CLOUD_TEMPLATE_TECHNICIAN_ASSIGNED"],
];
const disabledFeatures = [];
for (const [featureKey, templateKey] of inactiveOutboundFeatures) {
  if (!String(current.get(templateKey) || "").trim()) {
    source = replaceKey(source, featureKey, "false");
    disabledFeatures.push(featureKey);
  }
}
const temporary = envPath + ".maintenance.tmp";
writeFileSync(temporary, source, { encoding: "utf8", mode: 0o600 });
renameSync(temporary, envPath);
try { chmodSync(envPath, 0o600); } catch { /* Windows ACLs remain authoritative. */ }

const bundlePath = argument("export-bundle");
if (bundlePath) {
  const resolvedBundle = path.resolve(bundlePath);
  writeFileSync(
    resolvedBundle,
    [
      "MAINTENANCE_PORTAL_SECRET=" + portalSecret,
      "MAINTENANCE_FIELDTECH_CANARY_EVIDENCE=" + canaryId,
      "MAINTENANCE_FIELDTECH_CANARY_AT=" + new Date(canaryTime).toISOString(),
      "MAINTENANCE_WHATSAPP_OTP_TEMPLATE=breexe_maintenance_otp_ar",
      "MAINTENANCE_WHATSAPP_OTP_LANGUAGE=ar",
      "MAINTENANCE_WHATSAPP_OTP_MODE=allowlist",
      "MAINTENANCE_WHATSAPP_OTP_LAUNCH_APPROVED=false",
      "MAINTENANCE_OTP_TTL_MINUTES=10",
      "MAINTENANCE_ATTACHMENT_DIR=.runtime/maintenance-attachments",
      "WHATSAPP_PROVIDER=cloud_api",
      "WHATSAPP_WEBHOOK_VERIFY_TOKEN=" + webhookVerifyToken,
      ...(appSecret ? [] : ["WHATSAPP_WEBHOOK_SECRET=" + webhookSecret]),
      ...disabledFeatures.map(key => key + "=false"),
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o600 },
  );
  try { chmodSync(resolvedBundle, 0o600); } catch { /* Windows ACLs remain authoritative. */ }
}

console.log(JSON.stringify({
  success: true,
  portalSecretConfigured: portalSecret.length >= 32,
  portalSecretLength: portalSecret.length,
  canaryRecorded: true,
  canaryAt: new Date(canaryTime).toISOString(),
  maintenanceOtpMode: "allowlist",
  maintenanceOtpTemplateConfigured: true,
  inboundWebhookCredentialsConfigured: Boolean(webhookVerifyToken && (appSecret || webhookSecret)),
  disabledUnconfiguredOutboundFeatures: disabledFeatures,
  bundleCreated: Boolean(bundlePath),
}));
