import crypto from "node:crypto";
import path from "node:path";
import { writeFileSync } from "node:fs";
import { allowedPhones } from "../server/outboundSafety";
import { maintenanceOtpMode } from "../server/maintenanceOtpSafety";
import {
  consumeMaintenanceVerification,
  requestMaintenancePhoneVerification,
  verifyMaintenancePhone,
} from "../server/maintenancePortalExperience";
import { adminDb } from "../server/firebaseAdmin";

if (process.env.NODE_ENV !== "production") throw new Error("Maintenance OTP canary must run in the production runtime.");
if (maintenanceOtpMode() !== "allowlist") throw new Error("Maintenance OTP canary requires allowlist mode.");
const ownerUid = String(
  process.env.MAINTENANCE_REQUEST_OWNER_UID
  || process.env.PUBLIC_LEADS_OWNER_UID
  || process.env.STORE_WEBHOOK_OWNER_UID
  || "",
).trim();
if (!ownerUid) throw new Error("Maintenance owner UID is missing.");
const phones = [...allowedPhones()];
if (phones.length !== 1) throw new Error("Maintenance OTP canary requires exactly one allowlisted phone.");
const phone = phones[0];
const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
process.env.MAINTENANCE_INTERNAL_CANARY = "true";

const requested = await requestMaintenancePhoneVerification(ownerUid, phone, { canaryCode: code });
const confirmed = await verifyMaintenancePhone(ownerUid, requested.verification_id, phone, code);
await consumeMaintenanceVerification(ownerUid, requested.verification_id, confirmed.verification_token, phone);
const record = (await adminDb.collection("maintenance_phone_verifications").doc(requested.verification_id).get()).data() || {};
const timestamp = new Date().toISOString();
const safeStamp = timestamp.replace(/[:.]/g, "-");
const reportPath = path.resolve(
  process.env.MAINTENANCE_OTP_CANARY_REPORT
  || `/app/.runtime/maintenance-otp-canary-${safeStamp}.json`,
);
if (!reportPath.startsWith("/app/.runtime/maintenance-otp-canary-") || !reportPath.endsWith(".json")) {
  throw new Error("Maintenance OTP canary report path is unsafe.");
}
const report = {
  success: record.status === "consumed" && Boolean(record.provider_message_id),
  canary_at: timestamp,
  template: String(process.env.MAINTENANCE_WHATSAPP_OTP_TEMPLATE || ""),
  language: String(process.env.MAINTENANCE_WHATSAPP_OTP_LANGUAGE || "ar"),
  provider_message_accepted: Boolean(record.provider_message_id),
  code_verified: Boolean(record.verified_at),
  verification_consumed: record.status === "consumed",
  phone_redacted: true,
  code_redacted: true,
};
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
console.log(JSON.stringify({ success: report.success, canaryAt: timestamp, reportPath, providerMessageAccepted: report.provider_message_accepted, codeVerified: report.code_verified, verificationConsumed: report.verification_consumed }));
if (!report.success) process.exitCode = 1;
