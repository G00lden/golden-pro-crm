import { z } from "zod";
import { addCalendarMonths } from "../shared/date";

const RIYADH_UTC_OFFSET = "+03:00";

export function isCalendarDate(value: string) {
  try {
    addCalendarMonths(value, 0);
    return true;
  } catch {
    return false;
  }
}
export const maintenanceCalendarDate = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "أدخل التاريخ بصيغة صحيحة.")
  .refine(isCalendarDate, "التاريخ المحدد غير موجود في التقويم.");

export function maintenanceMinimumLeadHours(env: NodeJS.ProcessEnv = process.env) {
  const parsed = Number(env.MAINTENANCE_MIN_LEAD_HOURS);
  if (!Number.isFinite(parsed) || parsed < 0) return 2;
  return Math.min(168, parsed);
}

function scheduledAt(date: string, time?: string) {
  const clock = time || "23:59";
  const value = Date.parse(`${date}T${clock}:00${RIYADH_UTC_OFFSET}`);
  if (!Number.isFinite(value)) {
    throw Object.assign(new Error("التاريخ أو الوقت المحدد غير صالح."), { status: 400 });
  }
  return value;
}

/**
 * Enforces the operational lead-time in Riyadh. Date-only customer preferences
 * use the end of that day so a same-day preference remains possible while an
 * already elapsed day is always rejected.
 */
export function assertMaintenanceLeadTime(
  date: string,
  time?: string,
  options: { env?: NodeJS.ProcessEnv; nowMs?: number } = {},
) {
  const leadHours = maintenanceMinimumLeadHours(options.env);
  const minimum = (options.nowMs ?? Date.now()) + leadHours * 60 * 60_000;
  if (scheduledAt(date, time) < minimum) {
    throw Object.assign(
      new Error(`اختر موعدًا بعد ${leadHours.toLocaleString("ar-SA")} ساعة على الأقل.`),
      { status: 400 },
    );
  }
}
