function isLeapYear(year: number) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number) {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function parseIsoDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) throw new RangeError(`Invalid ISO date: ${value}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new RangeError(`Invalid ISO date: ${value}`);
  }
  return { year, month, day };
}

export function addCalendarMonths(value: string, months: number) {
  const { year, month, day } = parseIsoDate(value);
  const numericMonths = Number(months);
  if (!Number.isFinite(numericMonths)) throw new RangeError(`Invalid month delta: ${months}`);
  const delta = Math.trunc(numericMonths);
  const absoluteMonth = year * 12 + (month - 1) + delta;
  const targetYear = Math.floor(absoluteMonth / 12);
  const targetMonthIndex = ((absoluteMonth % 12) + 12) % 12;
  const targetMonth = targetMonthIndex + 1;
  if (targetYear < 1 || targetYear > 9999) throw new RangeError("Resulting date is out of range.");
  const targetDay = Math.min(day, daysInMonth(targetYear, targetMonth));
  return `${String(targetYear).padStart(4, "0")}-${String(targetMonth).padStart(2, "0")}-${String(targetDay).padStart(2, "0")}`;
}

export function addCalendarMonthsOr(value: string, months: number, fallback: string) {
  try {
    return addCalendarMonths(value, months);
  } catch {
    return addCalendarMonths(fallback, months);
  }
}
