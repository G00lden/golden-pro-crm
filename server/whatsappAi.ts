import crypto, { randomUUID } from "node:crypto";
import db from "./db";
import { logEvent } from "./logger";
import { phoneTail } from "../shared/phone";

export type WhatsAppAiIntent =
  | "payment_link"
  | "booking"
  | "order_status"
  | "human_handoff"
  | "menu"
  | "unknown";

export type WhatsAppAiDepartment = "sales" | "support" | "maintenance";

export type WhatsAppAiClassification = {
  attempted: boolean;
  status: "ok" | "disabled" | "not_configured" | "rate_limited" | "failed";
  intent: WhatsAppAiIntent;
  confidence?: number;
  orderNumber?: string;
  department?: WhatsAppAiDepartment;
  reason?: string;
};

type FetchLike = typeof fetch;

type WhatsAppAiDependencies = {
  fetchImpl?: FetchLike;
  now?: () => Date;
};

const ALLOWED_INTENTS = new Set<WhatsAppAiIntent>([
  "payment_link",
  "booking",
  "order_status",
  "human_handoff",
  "menu",
  "unknown",
]);
const ALLOWED_DEPARTMENTS = new Set<WhatsAppAiDepartment>([
  "sales",
  "support",
  "maintenance",
]);

function envTrue(value: unknown) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function modelName() {
  const value = String(process.env.DEEPSEEK_MODEL || "deepseek-v4-flash").trim();
  return /^deepseek-[a-z0-9._-]{2,80}$/i.test(value) ? value : "deepseek-v4-flash";
}

function baseUrl() {
  const configured = String(process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com")
    .trim()
    .replace(/\/+$/, "");
  try {
    const parsed = new URL(configured);
    if (parsed.protocol !== "https:" || parsed.hostname !== "api.deepseek.com") {
      return "https://api.deepseek.com";
    }
    return parsed.origin;
  } catch {
    return "https://api.deepseek.com";
  }
}

function apiKey() {
  return String(process.env.DEEPSEEK_API_KEY || "").trim();
}

function timeoutMs() {
  return clampNumber(process.env.WHATSAPP_AI_TIMEOUT_MS, 8_000, 1_000, 30_000);
}

function hourlyLimit() {
  return clampNumber(process.env.WHATSAPP_AI_MAX_REQUESTS_PER_PHONE_HOUR, 20, 1, 100);
}

function confidenceThreshold() {
  return clampNumber(process.env.WHATSAPP_AI_CONFIDENCE_THRESHOLD, 0.72, 0.5, 0.95);
}

function verificationMaxAgeHours() {
  return clampNumber(process.env.WHATSAPP_AI_VERIFICATION_MAX_AGE_HOURS, 24, 1, 168);
}

function safeMessage(value: string) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, 500);
}

function stableHash(...parts: string[]) {
  return crypto.createHash("sha256").update(parts.join("\0")).digest("hex");
}

function identityHash(ownerUid: string, phone: string) {
  return stableHash(ownerUid, phoneTail(phone));
}

function configurationHash() {
  return stableHash("deepseek", baseUrl(), modelName(), apiKey());
}

function isRateLimited(ownerUid: string, phoneHash: string, now: Date) {
  const since = new Date(now.getTime() - 60 * 60_000).toISOString();
  const count = Number((db.prepare(
    `SELECT COUNT(*) AS count
       FROM whatsapp_ai_intents
      WHERE owner_uid = ? AND phone_hash = ? AND created_at >= ?
        AND status IN ('ok', 'failed')`,
  ).get(ownerUid, phoneHash, since) as { count?: number } | undefined)?.count || 0);
  return count >= hourlyLimit();
}

function recordAttempt(input: {
  ownerUid: string;
  phoneHash: string;
  inputHash: string;
  model: string;
  configurationHash: string;
  intent: WhatsAppAiIntent;
  confidence?: number;
  status: WhatsAppAiClassification["status"];
  errorCode?: string;
  now: Date;
}) {
  db.prepare(
    `INSERT INTO whatsapp_ai_intents (
       id, owner_uid, phone_hash, input_hash, provider, model,
       configuration_hash, intent, confidence, status, error_code, created_at
     ) VALUES (?, ?, ?, ?, 'deepseek', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `wai_${randomUUID().replace(/-/g, "")}`,
    input.ownerUid,
    input.phoneHash,
    input.inputHash,
    input.model,
    input.configurationHash,
    input.intent,
    input.confidence ?? null,
    input.status,
    input.errorCode || null,
    input.now.toISOString(),
  );
  db.prepare("DELETE FROM whatsapp_ai_intents WHERE created_at < ?").run(
    new Date(input.now.getTime() - 30 * 24 * 60 * 60_000).toISOString(),
  );
}

function safeOrderNumber(value: unknown) {
  const candidate = String(value || "").trim();
  return /^[A-Za-z0-9_-]{2,60}$/.test(candidate) ? candidate : undefined;
}

function parseClassification(content: unknown): Omit<WhatsAppAiClassification, "attempted" | "status"> | null {
  if (typeof content !== "string" || !content.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const object = parsed as Record<string, unknown>;
  const requestedIntent = String(object.intent || "") as WhatsAppAiIntent;
  const confidence = clampNumber(object.confidence, 0, 0, 1);
  const intent = ALLOWED_INTENTS.has(requestedIntent) && confidence >= confidenceThreshold()
    ? requestedIntent
    : "unknown";
  const requestedDepartment = String(object.department || "") as WhatsAppAiDepartment;
  return {
    intent,
    confidence,
    orderNumber: safeOrderNumber(object.order_number),
    department: ALLOWED_DEPARTMENTS.has(requestedDepartment) ? requestedDepartment : undefined,
  };
}

function errorCode(error: unknown) {
  if (error instanceof DOMException && error.name === "AbortError") return "timeout";
  if (error instanceof Error && /^deepseek_http_\d+$/.test(error.message)) return error.message;
  if (error instanceof Error && error.message === "invalid_response") return "invalid_response";
  return "network_error";
}

export function whatsappAiReadiness(ownerUid?: string) {
  const enabled = envTrue(process.env.WHATSAPP_AI_ENABLED);
  const configured = Boolean(apiKey());
  const commerceEnabled = String(process.env.WHATSAPP_COMMERCE_ENABLED || "true").toLowerCase() !== "false";
  const provider = process.env.DATA_PROVIDER || process.env.DB_PROVIDER || "firebase";
  const storeSupported = provider === "sqlite";
  const prerequisitesReady = enabled && configured && commerceEnabled && storeSupported;
  const verifiedAfter = new Date(Date.now() - verificationMaxAgeHours() * 60 * 60_000).toISOString();
  const verified = prerequisitesReady && ownerUid
    ? db.prepare(
      `SELECT created_at
         FROM whatsapp_ai_intents
        WHERE owner_uid = ?
          AND provider = 'deepseek'
          AND model = ?
          AND configuration_hash = ?
          AND status = 'ok'
          AND created_at >= ?
        ORDER BY created_at DESC
        LIMIT 1`,
    ).get(ownerUid, modelName(), configurationHash(), verifiedAfter) as { created_at?: string } | undefined
    : undefined;
  return {
    provider: "deepseek" as const,
    enabled,
    configured,
    commerceEnabled,
    storeSupported,
    prerequisitesReady,
    verified: Boolean(verified?.created_at),
    verifiedAt: verified?.created_at,
    ready: prerequisitesReady && Boolean(verified?.created_at),
    model: modelName(),
  };
}

export async function classifyWhatsAppIntent(
  input: {
    ownerUid: string;
    phone: string;
    text: string;
  },
  dependencies: WhatsAppAiDependencies = {},
): Promise<WhatsAppAiClassification> {
  const readiness = whatsappAiReadiness();
  if (!readiness.enabled) {
    return { attempted: false, status: "disabled", intent: "unknown", reason: "ai_disabled" };
  }
  if (!readiness.configured) {
    return { attempted: false, status: "not_configured", intent: "unknown", reason: "api_key_missing" };
  }

  const now = (dependencies.now || (() => new Date()))();
  const message = safeMessage(input.text);
  if (!message) {
    return { attempted: false, status: "failed", intent: "unknown", reason: "empty_message" };
  }
  const phoneHash = identityHash(input.ownerUid, input.phone);
  const inputHash = stableHash(input.ownerUid, message);
  if (isRateLimited(input.ownerUid, phoneHash, now)) {
    recordAttempt({
      ownerUid: input.ownerUid,
      phoneHash,
      inputHash,
      model: readiness.model,
      configurationHash: configurationHash(),
      intent: "unknown",
      status: "rate_limited",
      errorCode: "hourly_limit",
      now,
    });
    logEvent("warn", "whatsapp.ai.rate_limited", { ownerUid: input.ownerUid });
    return {
      attempted: false,
      status: "rate_limited",
      intent: "unknown",
      reason: "hourly_limit",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  try {
    const response = await (dependencies.fetchImpl || fetch)(
      `${baseUrl()}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey()}`,
        },
        body: JSON.stringify({
          model: readiness.model,
          temperature: 0,
          max_tokens: 180,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: [
                "أنت مصنف نوايا لرسائل واتساب في متجر صيانة وتركيب.",
                "لا تجب على العميل ولا تنشئ رابطاً ولا تنفذ أي أداة.",
                "أعد JSON فقط بالمفاتيح: intent, confidence, order_number, department.",
                "intent واحد من payment_link, booking, order_status, human_handoff, menu, unknown.",
                "department واحد من sales, support, maintenance أو null.",
                "استخرج order_number فقط إذا كتبه العميل بوضوح، وإلا null.",
                "إذا كانت الرسالة غامضة استخدم unknown وثقة منخفضة.",
              ].join(" "),
            },
            { role: "user", content: message },
          ],
        }),
        signal: controller.signal,
      },
    );
    if (!response.ok) throw new Error(`deepseek_http_${response.status}`);
    const payload = await response.json() as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const classification = parseClassification(payload.choices?.[0]?.message?.content);
    if (!classification) throw new Error("invalid_response");
    recordAttempt({
      ownerUid: input.ownerUid,
      phoneHash,
      inputHash,
      model: readiness.model,
      configurationHash: configurationHash(),
      intent: classification.intent,
      confidence: classification.confidence,
      status: "ok",
      now,
    });
    logEvent("info", "whatsapp.ai.classified", {
      ownerUid: input.ownerUid,
      intent: classification.intent,
      confidence: classification.confidence,
      model: readiness.model,
    });
    return {
      attempted: true,
      status: "ok",
      ...classification,
    };
  } catch (error) {
    const code = errorCode(error);
    recordAttempt({
      ownerUid: input.ownerUid,
      phoneHash,
      inputHash,
      model: readiness.model,
      configurationHash: configurationHash(),
      intent: "unknown",
      status: "failed",
      errorCode: code,
      now,
    });
    logEvent("warn", "whatsapp.ai.failed", {
      ownerUid: input.ownerUid,
      errorCode: code,
      model: readiness.model,
    });
    return {
      attempted: true,
      status: "failed",
      intent: "unknown",
      reason: code,
    };
  } finally {
    clearTimeout(timer);
  }
}
