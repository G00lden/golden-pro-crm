import { appendFileSync, mkdirSync } from "fs";
import path from "path";

type LogLevel = "info" | "warn" | "error";

const SENSITIVE_KEY = /(authorization|token|secret|password|cookie|api[_-]?key|otp|phone|mobile|whatsapp|recipient|customer_phone)/i;
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const PHONE_PATTERN = /(?<!\d)(?:\+?\d[\s-]?){9,15}(?!\d)/g;

function redactedString(value: string) {
  return value
    .replace(BEARER_PATTERN, "Bearer [redacted]")
    .replace(PHONE_PATTERN, "[redacted-phone]");
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[redacted-depth]";
  if (typeof value === "string") return redactedString(value);
  if (typeof value === "number" || typeof value === "boolean" || value == null) return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactedString(value.message),
      stack: value.stack ? redactedString(value.stack) : undefined,
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redactValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 80)) {
      output[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redactValue(child, depth + 1);
    }
    return output;
  }
  return String(value);
}

export function logEvent(level: LogLevel, event: string, details: Record<string, unknown> = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    details: redactValue(details),
  };
  const line = JSON.stringify(entry);

  try {
    const filePath = process.env.STRUCTURED_LOG_FILE || path.join(process.cwd(), "logs", "server-errors.log");
    mkdirSync(path.dirname(filePath), { recursive: true });
    appendFileSync(filePath, `${line}\n`, "utf8");
  } catch {
    // Logging must never break request handling.
  }

  const writer = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  writer(line);
}

export function logError(event: string, error: unknown, details: Record<string, unknown> = {}) {
  logEvent("error", event, {
    ...details,
    error: redactValue(error),
  });
}
