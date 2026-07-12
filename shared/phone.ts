export type NormalizedPhone = {
  digits: string;
  e164: string;
  tail: string;
  valid: boolean;
};

/**
 * Canonical phone representation used across calls, WhatsApp, Salla and CRM.
 * Saudi local mobile formats are promoted to country code 966; genuine
 * international numbers are otherwise preserved as bare digits.
 */
export function normalizePhone(value: unknown): NormalizedPhone {
  let digits = String(value ?? "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = `966${digits.slice(1)}`;
  if (digits.length === 9 && digits.startsWith("5")) digits = `966${digits}`;

  const valid = /^\d{10,15}$/.test(digits);
  return {
    digits,
    e164: valid ? `+${digits}` : "",
    tail: digits.slice(-9),
    valid,
  };
}

export function normalizePhoneDigits(value: unknown): string {
  return normalizePhone(value).digits;
}

export function requirePhoneDigits(value: unknown): string {
  const phone = normalizePhone(value);
  if (!phone.valid) throw new Error("Invalid phone number.");
  return phone.digits;
}

export function phoneTail(value: unknown): string {
  return normalizePhone(value).tail;
}

export function phonesMatch(left: unknown, right: unknown): boolean {
  const a = normalizePhone(left);
  const b = normalizePhone(right);
  return Boolean(a.tail && b.tail && a.tail === b.tail);
}
