import type { WhatsAppStatus } from "./whatsapp";

/**
 * Campaign managers need delivery readiness, not credentials that can pair or
 * identify the provider account. Keep the full status for WhatsApp admins and
 * return a fresh redacted object for every other campaign operator.
 */
export function visibleWhatsAppStatus(
  status: WhatsAppStatus,
  canManageWhatsApp: boolean,
): WhatsAppStatus {
  if (canManageWhatsApp) return { ...status };
  const { qr: _qr, user: _user, ...campaignStatus } = status;
  return campaignStatus;
}
