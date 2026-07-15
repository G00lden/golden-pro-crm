import { AsyncLocalStorage } from "node:async_hooks";
import { timingSafeEqual } from "node:crypto";

export type OutboundMode = "dry_run" | "allowlist" | "code" | "production";

export type OutboundDecision = {
  allowed: boolean;
  dryRun: boolean;
  mode: OutboundMode;
  reason?: string;
  normalizedPhone?: string;
};

export type DryRunSendResult = {
  jid: string;
  messageId: null;
  provider: "web" | "cloud_api";
  dryRun: true;
  blocked: true;
  reason: string;
};

export type OutboundSendOptions = {
  confirmationCode?: string;
  /** Server-created, single-request exception for the dedicated admin test route. */
  oneTimeTestPhone?: string;
};

const outboundContext = new AsyncLocalStorage<OutboundSendOptions>();

export function runWithOutboundCode<T>(confirmationCode: string | undefined, callback: () => T) {
  return outboundContext.run({ confirmationCode }, callback);
}

export function normalizeOutboundPhone(phone: string) {
  let digits = String(phone || "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = `966${digits.slice(1)}`;
  if (digits.length === 9 && digits.startsWith("5")) digits = `966${digits}`;
  return digits;
}

export function outboundMode(): OutboundMode {
  const mode = String(process.env.OUTBOUND_MODE || "dry_run").toLowerCase();
  if (mode === "production" || mode === "allowlist" || mode === "code") return mode;
  return "dry_run";
}

export function outboundSafetyStatus() {
  const mode = outboundMode();
  const allowlist = allowedPhones();
  const launchApproved = process.env.OFFICIAL_LAUNCH_APPROVED === "true";

  return {
    mode,
    launchApproved,
    enabled: mode === "code" || mode === "allowlist" || (mode === "production" && launchApproved),
    requiresCode: mode === "code" || Boolean(process.env.OUTBOUND_CONFIRM_CODE),
    codeConfigured: Boolean(process.env.OUTBOUND_CONFIRM_CODE),
    allowlistCount: allowlist.size,
    dryRun: mode === "dry_run" || (mode === "production" && !launchApproved),
    updatedAt: new Date().toISOString(),
  };
}

export function allowedPhones() {
  return new Set(
    String(process.env.OUTBOUND_TEST_PHONE_ALLOWLIST || "")
      .split(/[,\s]+/)
      .map(normalizeOutboundPhone)
      .filter(Boolean),
  );
}

function codeMatches(confirmationCode?: string) {
  const expected = process.env.OUTBOUND_CONFIRM_CODE || "";
  if (!expected) return true;
  // Security (L1): constant-time comparison so the confirmation code cannot
  // be recovered via response timing.
  const provided = String(confirmationCode || "").trim();
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

export function decideOutbound(phone: string, options: OutboundSendOptions = {}): OutboundDecision {
  const mode = outboundMode();
  const confirmationCode = options.confirmationCode ?? outboundContext.getStore()?.confirmationCode;
  const normalizedPhone = normalizeOutboundPhone(phone);

  if (!/^\d{10,15}$/.test(normalizedPhone)) {
    return {
      allowed: false,
      dryRun: true,
      mode,
      normalizedPhone,
      reason: "Invalid outbound phone number.",
    };
  }

  if (mode === "dry_run") {
    return {
      allowed: false,
      dryRun: true,
      mode,
      normalizedPhone,
      reason: "Outbound messages are in dry-run mode. No real customer message was sent.",
    };
  }

  if (mode === "code") {
    if (!process.env.OUTBOUND_CONFIRM_CODE || !codeMatches(confirmationCode)) {
      return {
        allowed: false,
        dryRun: true,
        mode,
        normalizedPhone,
        reason: "Outbound confirmation code is required.",
      };
    }
    return { allowed: true, dryRun: false, mode, normalizedPhone };
  }

  if (!codeMatches(confirmationCode)) {
    return {
      allowed: false,
      dryRun: true,
      mode,
      normalizedPhone,
      reason: "Outbound confirmation code is required.",
    };
  }

  if (mode === "allowlist") {
    const allowlist = allowedPhones();
    const oneTimeTestPhone = normalizeOutboundPhone(options.oneTimeTestPhone || "");
    if (allowlist.has(normalizedPhone) || (oneTimeTestPhone && oneTimeTestPhone === normalizedPhone)) {
      return { allowed: true, dryRun: false, mode, normalizedPhone };
    }
    return {
      allowed: false,
      dryRun: true,
      mode,
      normalizedPhone,
      reason: "Recipient is not in OUTBOUND_TEST_PHONE_ALLOWLIST.",
    };
  }

  if (process.env.OFFICIAL_LAUNCH_APPROVED !== "true") {
    return {
      allowed: false,
      dryRun: true,
      mode,
      normalizedPhone,
      reason: "Production outbound is blocked until OFFICIAL_LAUNCH_APPROVED=true.",
    };
  }

  return { allowed: true, dryRun: false, mode, normalizedPhone };
}

export function dryRunSendResult(
  phone: string,
  provider: "web" | "cloud_api",
  reason = "Outbound message blocked by safety policy.",
): DryRunSendResult {
  const normalizedPhone = normalizeOutboundPhone(phone);
  return {
    jid: `${normalizedPhone || "dry-run"}@s.whatsapp.net`,
    messageId: null,
    provider,
    dryRun: true,
    blocked: true,
    reason,
  };
}

export function isDryRunSendResult(value: unknown): value is DryRunSendResult {
  return Boolean(value && typeof value === "object" && (value as DryRunSendResult).dryRun === true);
}
