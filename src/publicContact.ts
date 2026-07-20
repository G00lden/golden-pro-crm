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

export function buildTrackedWhatsAppHref(input: {
  phone?: string | null;
  message?: string;
  reference: string;
  page: string;
  ttclid?: string;
  ttp?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
  timestamp?: string;
}) {
  const phone = normalizePublicContactPhone(input.phone);
  if (!phone || !/^[A-F0-9]{16}$/.test(input.reference)) return null;
  if (!input.page.startsWith("/") || /[?#\u0000-\u001f]/u.test(input.page)) return null;
  const params = new URLSearchParams({
    reference: input.reference,
    consent: "granted",
    message: String(input.message || "").slice(0, 600),
    page: input.page,
    ts: input.timestamp || new Date().toISOString(),
  });
  const optional = {
    ttclid: input.ttclid,
    ttp: input.ttp,
    utm_source: input.utmSource,
    utm_medium: input.utmMedium,
    utm_campaign: input.utmCampaign,
    utm_content: input.utmContent,
    utm_term: input.utmTerm,
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value) params.set(key, value);
  }
  return `/api/track/whatsapp?${params.toString()}`;
}

const publicContactPhoneSetting = typeof import.meta.env === "object"
  ? import.meta.env.VITE_PUBLIC_CONTACT_PHONE
  : undefined;

export const publicContactPhone = normalizePublicContactPhone(publicContactPhoneSetting);
