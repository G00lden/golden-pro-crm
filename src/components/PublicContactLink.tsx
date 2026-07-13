import type { ReactNode } from "react";
import { buildPublicContactHref, publicContactPhone } from "../publicContact";

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
  const href = buildPublicContactHref(channel, publicContactPhone, whatsappText);
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
