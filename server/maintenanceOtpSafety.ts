import { allowedPhones, normalizeOutboundPhone } from "./outboundSafety";

export type MaintenanceOtpMode = "disabled" | "allowlist" | "production";

export function maintenanceOtpMode(env: NodeJS.ProcessEnv = process.env): MaintenanceOtpMode {
  const value = String(env.MAINTENANCE_WHATSAPP_OTP_MODE || "disabled").trim().toLowerCase();
  if (value === "allowlist" || value === "production") return value;
  return "disabled";
}

export function decideMaintenanceOtpOutbound(phone: string, env: NodeJS.ProcessEnv = process.env) {
  const mode = maintenanceOtpMode(env);
  const normalizedPhone = normalizeOutboundPhone(phone);
  if (!/^\d{10,15}$/.test(normalizedPhone)) {
    return { allowed: false, mode, normalizedPhone, reason: "Invalid WhatsApp phone number." } as const;
  }
  if (mode === "disabled") {
    return { allowed: false, mode, normalizedPhone, reason: "Maintenance WhatsApp verification is disabled." } as const;
  }
  if (mode === "allowlist") {
    const allowlist = env === process.env
      ? allowedPhones()
      : new Set(String(env.OUTBOUND_TEST_PHONE_ALLOWLIST || "").split(/[,\s]+/).map(normalizeOutboundPhone).filter(Boolean));
    if (!allowlist.has(normalizedPhone)) {
      return { allowed: false, mode, normalizedPhone, reason: "Phone is outside the maintenance OTP canary allowlist." } as const;
    }
    return { allowed: true, mode, normalizedPhone } as const;
  }
  if (env.MAINTENANCE_WHATSAPP_OTP_LAUNCH_APPROVED !== "true") {
    return { allowed: false, mode, normalizedPhone, reason: "Maintenance OTP production launch is not approved." } as const;
  }
  return { allowed: true, mode, normalizedPhone } as const;
}

export function maintenanceOtpStatus(env: NodeJS.ProcessEnv = process.env) {
  const mode = maintenanceOtpMode(env);
  return {
    mode,
    launchApproved: env.MAINTENANCE_WHATSAPP_OTP_LAUNCH_APPROVED === "true",
    templateConfigured: Boolean(String(env.MAINTENANCE_WHATSAPP_OTP_TEMPLATE || "").trim()),
    enabled: mode === "allowlist" || (mode === "production" && env.MAINTENANCE_WHATSAPP_OTP_LAUNCH_APPROVED === "true"),
  };
}
