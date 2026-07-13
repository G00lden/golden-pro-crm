export function normalizePublicContactPhone(value?: string | null) {
  const compact = String(value || "").trim().replace(/[\s().-]/g, "");
  const international = compact.startsWith("00") ? `+${compact.slice(2)}` : compact;
  const normalized = international.startsWith("+")
    ? international
    : international.startsWith("0")
      ? ""
      : international
        ? `+${international}`
        : "";
  return /^\+[1-9]\d{7,14}$/.test(normalized) ? normalized : null;
}

export function buildPublicContactHref(
  channel: "whatsapp" | "call",
  value?: string | null,
  whatsappText = "",
) {
  const phone = normalizePublicContactPhone(value);
  if (!phone) return null;
  if (channel === "call") return `tel:${phone}`;
  const digits = phone.slice(1);
  return `https://wa.me/${digits}${whatsappText ? `?text=${encodeURIComponent(whatsappText)}` : ""}`;
}

const publicContactPhoneSetting = typeof import.meta.env === "object"
  ? import.meta.env.VITE_PUBLIC_CONTACT_PHONE
  : undefined;

export const publicContactPhone = normalizePublicContactPhone(publicContactPhoneSetting);
