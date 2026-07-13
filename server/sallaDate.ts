export const DEFAULT_SALLA_TIMEZONE = "Asia/Riyadh";

export type ParsedSallaDate = {
  createdAt: string;
  orderDate: string;
  timezone: string;
};

type DateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
};

function text(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)
    ? value as Record<string, unknown>
    : {};
}

function validTimezone(value: unknown, fallback: string) {
  const timezone = text(value) || fallback;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
    return timezone;
  } catch {
    return null;
  }
}

function partsInTimezone(timestamp: number, timezone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const values = Object.fromEntries(
    formatter.formatToParts(new Date(timestamp))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}

function validParts(parts: DateParts) {
  if (
    !Number.isInteger(parts.year) || parts.year < 1 || parts.year > 9999 ||
    !Number.isInteger(parts.month) || parts.month < 1 || parts.month > 12 ||
    !Number.isInteger(parts.day) || parts.day < 1 || parts.day > 31 ||
    !Number.isInteger(parts.hour) || parts.hour < 0 || parts.hour > 23 ||
    !Number.isInteger(parts.minute) || parts.minute < 0 || parts.minute > 59 ||
    !Number.isInteger(parts.second) || parts.second < 0 || parts.second > 59 ||
    !Number.isInteger(parts.millisecond) || parts.millisecond < 0 || parts.millisecond > 999
  ) return false;
  const check = new Date(Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond,
  ));
  return check.getUTCFullYear() === parts.year &&
    check.getUTCMonth() + 1 === parts.month &&
    check.getUTCDate() === parts.day &&
    check.getUTCHours() === parts.hour &&
    check.getUTCMinutes() === parts.minute &&
    check.getUTCSeconds() === parts.second;
}

function wallTimeToTimestamp(parts: DateParts, timezone: string) {
  if (!validParts(parts)) return null;
  const wallAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond,
  );
  let candidate = wallAsUtc;

  // Resolve the IANA offset at the target instant. A second pass handles zones
  // whose offset at the naive UTC instant differs from the local wall instant.
  for (let pass = 0; pass < 3; pass += 1) {
    const zoned = partsInTimezone(candidate, timezone);
    const candidateSecond = Math.floor(candidate / 1000) * 1000;
    const offset = Date.UTC(
      zoned.year,
      zoned.month - 1,
      zoned.day,
      zoned.hour,
      zoned.minute,
      zoned.second,
    ) - candidateSecond;
    const next = wallAsUtc - offset;
    if (next === candidate) break;
    candidate = next;
  }

  const roundTrip = partsInTimezone(candidate, timezone);
  if (
    roundTrip.year !== parts.year ||
    roundTrip.month !== parts.month ||
    roundTrip.day !== parts.day ||
    roundTrip.hour !== parts.hour ||
    roundTrip.minute !== parts.minute ||
    roundTrip.second !== parts.second
  ) return null;
  return candidate;
}

function localDateTimeParts(value: string): DateParts | null {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2})(?::(\d{2}))?(?::(\d{2}))?(?:\.(\d{1,9}))?)?$/,
  );
  if (!match) return null;
  const fraction = String(match[7] || "").padEnd(3, "0").slice(0, 3);
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4] || 0),
    minute: Number(match[5] || 0),
    second: Number(match[6] || 0),
    millisecond: Number(fraction || 0),
  };
}

function orderDateAt(timestamp: number, timezone: string) {
  const parts = partsInTimezone(timestamp, timezone);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function parsed(timestamp: number, timezone: string): ParsedSallaDate | null {
  const date = new Date(timestamp);
  if (!Number.isFinite(timestamp) || Number.isNaN(date.getTime())) return null;
  return {
    createdAt: date.toISOString(),
    orderDate: orderDateAt(timestamp, timezone),
    timezone,
  };
}

/**
 * Parses Salla's date contract without inventing a current timestamp.
 *
 * Salla commonly returns `{ date: "YYYY-MM-DD HH:mm:ss.uuuuuu", timezone:
 * "Asia/Riyadh" }`, while older payloads may contain ISO text or epoch
 * seconds/milliseconds. Invalid or incomplete values return `null`.
 */
export function parseSallaDate(
  value: unknown,
  fallbackTimezone = DEFAULT_SALLA_TIMEZONE,
): ParsedSallaDate | null {
  if (value instanceof Date) {
    const timezone = validTimezone(undefined, fallbackTimezone);
    return timezone ? parsed(value.getTime(), timezone) : null;
  }

  const source = record(value);
  const timezone = validTimezone(
    source.timezone ?? source.time_zone ?? source.zone,
    fallbackTimezone,
  );
  if (!timezone) return null;

  const raw = Object.keys(source).length
    ? source.date ?? source.datetime ?? source.value ?? source.timestamp ?? source.time
    : value;
  if (raw !== value && raw && typeof raw === "object") {
    return parseSallaDate(raw, timezone);
  }

  if (typeof raw === "number" && Number.isFinite(raw)) {
    const timestamp = Math.abs(raw) < 100_000_000_000 ? raw * 1000 : raw;
    return parsed(timestamp, timezone);
  }

  const rawText = text(raw);
  if (!rawText) return null;
  if (/^-?\d+(?:\.\d+)?$/.test(rawText)) {
    const numeric = Number(rawText);
    const timestamp = Math.abs(numeric) < 100_000_000_000 ? numeric * 1000 : numeric;
    return parsed(timestamp, timezone);
  }

  const wallParts = localDateTimeParts(rawText);
  if (wallParts) {
    const timestamp = wallTimeToTimestamp(wallParts, timezone);
    return timestamp === null ? null : parsed(timestamp, timezone);
  }

  const timestamp = Date.parse(rawText);
  return Number.isNaN(timestamp) ? null : parsed(timestamp, timezone);
}

export function firstSallaDate(
  values: unknown[],
  fallbackTimezone = DEFAULT_SALLA_TIMEZONE,
) {
  for (const value of values) {
    const valueTimezone = text(record(value).timezone ?? record(value).time_zone ?? record(value).zone);
    const result = parseSallaDate(value, valueTimezone || fallbackTimezone);
    if (result) return result;
  }
  return null;
}
