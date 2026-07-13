export const CALL_DISPOSITIONS = [
  "answered",
  "no_answer",
  "busy",
  "unreachable",
  "rejected",
  "after_hours",
  "blocked",
  "outgoing",
  "unknown",
] as const;

export type CallDisposition = (typeof CALL_DISPOSITIONS)[number];

export const AUTOMATION_DISPOSITIONS = new Set<CallDisposition>([
  "no_answer",
  "busy",
  "unreachable",
  "rejected",
  "after_hours",
]);

export type BusinessSchedule = {
  timezone: string;
  business_days: number[];
  business_open: string;
  business_close: string;
};

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
};

const STATUS_ALIASES: Record<string, CallDisposition> = {
  answered: "answered",
  answer: "answered",
  completed: "answered",
  complete: "answered",
  connected: "answered",
  success: "answered",
  noanswer: "no_answer",
  noreply: "no_answer",
  unanswered: "no_answer",
  timeout: "no_answer",
  notanswered: "no_answer",
  missed: "no_answer",
  busy: "busy",
  linebusy: "busy",
  unreachable: "unreachable",
  unavailable: "unreachable",
  outofcoverage: "unreachable",
  notreachable: "unreachable",
  poweredoff: "unreachable",
  switchedout: "unreachable",
  rejected: "rejected",
  declined: "rejected",
  refused: "rejected",
  canceled: "rejected",
  cancelled: "rejected",
  blocked: "blocked",
  blacklist: "blocked",
  outgoing: "outgoing",
  outbound: "outgoing",
  afterhours: "after_hours",
  closed: "after_hours",
};

export function normalizeDisposition(value: unknown, failureReason?: unknown): CallDisposition {
  const compact = (input: unknown) => String(input || "").toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]/g, "");
  const candidates = [compact(value), compact(failureReason)];
  for (const candidate of candidates) {
    if (STATUS_ALIASES[candidate]) return STATUS_ALIASES[candidate];
    if (/مشغول/.test(candidate)) return "busy";
    if (/مغلق|التغطية|متاح/.test(candidate)) return "unreachable";
    if (/رفض/.test(candidate)) return "rejected";
  }
  return "unknown";
}

function timeMinutes(value: string, fallback: string): number {
  const match = String(value || fallback).match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return timeMinutes(fallback, "00:00");
  return Math.min(23, Number(match[1])) * 60 + Math.min(59, Number(match[2]));
}

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const year = Number(values.year);
  const month = Number(values.month);
  const day = Number(values.day);
  return {
    year,
    month,
    day,
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

function addCalendarDays(parts: Pick<ZonedParts, "year" | "month" | "day">, days: number) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function zonedWallTimeToUtc(
  local: Pick<ZonedParts, "year" | "month" | "day" | "hour" | "minute">,
  timeZone: string,
): Date {
  const desired = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0);
  let candidate = new Date(desired);
  for (let i = 0; i < 2; i += 1) {
    const actual = zonedParts(candidate, timeZone);
    const actualWall = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, 0);
    candidate = new Date(candidate.getTime() + (desired - actualWall));
  }
  return candidate;
}

export function isBusinessOpen(schedule: BusinessSchedule, at = new Date()): boolean {
  const parts = zonedParts(at, schedule.timezone || "Asia/Riyadh");
  if (!schedule.business_days.includes(parts.weekday)) return false;
  const current = parts.hour * 60 + parts.minute;
  const opens = timeMinutes(schedule.business_open, "08:00");
  const closes = timeMinutes(schedule.business_close, "21:00");
  return current >= opens && current < closes;
}

export function nextBusinessOpen(schedule: BusinessSchedule, after = new Date()): Date {
  const timeZone = schedule.timezone || "Asia/Riyadh";
  const now = zonedParts(after, timeZone);
  const opensAt = timeMinutes(schedule.business_open, "08:00");
  const openHour = Math.floor(opensAt / 60);
  const openMinute = opensAt % 60;

  for (let offset = 0; offset <= 14; offset += 1) {
    const day = addCalendarDays(now, offset);
    const weekday = new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay();
    if (!schedule.business_days.includes(weekday)) continue;
    const candidate = zonedWallTimeToUtc({ ...day, hour: openHour, minute: openMinute }, timeZone);
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  return new Date(after.getTime() + 24 * 60 * 60_000);
}

export function companyMessage(template: string, companyName: string): string {
  return String(template || "").replaceAll("{اسم الشركة}", companyName).trim();
}
