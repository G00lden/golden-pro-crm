import { useEffect, useMemo, useState, type ReactNode } from "react";
import { getConsent, onConsentChange } from "../consent";
import {
  buildPublicContactHref,
  buildTrackedWhatsAppHref,
  publicContactPhone,
} from "../publicContact";
import { attributionReference, captureUtm, tiktokFirstPartyCookie } from "../track";

export function PublicContactLink({
  channel,
  whatsappText,
  className,
  onClick,
  children,
  ariaLabel,
}: {
  channel: "whatsapp" | "call";
  whatsappText?: string;
  className?: string;
  onClick?: () => void;
  children: ReactNode;
  ariaLabel?: string;
}) {
  const [consent, setConsent] = useState(getConsent);
  useEffect(() => onConsentChange(setConsent), []);
  const href = useMemo(() => {
    const fallback = buildPublicContactHref(channel, publicContactPhone, whatsappText);
    if (channel !== "whatsapp" || consent !== "granted" || typeof window === "undefined") return fallback;
    const reference = attributionReference();
    if (!reference) return fallback;
    const utm = captureUtm();
    return buildTrackedWhatsAppHref({
      phone: publicContactPhone,
      message: whatsappText,
      reference,
      page: window.location.pathname,
      ttclid: utm.ttclid,
      ttp: tiktokFirstPartyCookie(),
      utmSource: utm.utm_source,
      utmMedium: utm.utm_medium,
      utmCampaign: utm.utm_campaign,
      utmContent: utm.utm_content,
      utmTerm: utm.utm_term,
    }) || fallback;
  }, [channel, consent, whatsappText]);
  if (!href) {
    return (
      <span
        className={className}
        role="link"
        aria-disabled="true"
        aria-label={`${ariaLabel || (channel === "whatsapp" ? "واتساب" : "اتصال")} — رقم التواصل غير مهيأ`}
        title="رقم التواصل غير مهيأ"
        style={{ opacity: 0.55, cursor: "not-allowed", pointerEvents: "none" }}
      >
        {children}
      </span>
    );
  }

  return (
    <a
      className={className}
      href={href}
      aria-label={ariaLabel}
      target={channel === "whatsapp" ? "_blank" : undefined}
      rel={channel === "whatsapp" ? "noopener noreferrer" : undefined}
      onClick={onClick}
    >
      {children}
    </a>
  );
}
