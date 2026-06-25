/**
 * Wires WhatsApp (Baileys) call/message events to the routing engine.
 *
 * Kept separate so whatsapp.ts stays free of any dependency on the gateway
 * engine (this module imports both and breaks the cycle).
 *
 * - Unanswered WhatsApp call → missed-call flow → WhatsApp reply to the caller.
 * - Inbound WhatsApp text → recorded + routed (e.g. caller replies a digit).
 */
import { recordWhatsAppMessage, whatsappService } from "./whatsapp";
import { handleGatewayEvent } from "./gateway";
import { logError, logEvent } from "./logger";

let initialized = false;

export function initWhatsAppAutoReply(ownerUid: () => string) {
  if (initialized) return;
  initialized = true;

  whatsappService.onIncomingCall(async (fromPhone) => {
    try {
      logEvent("info", "whatsapp.incoming_call_missed", { from: fromPhone });
      await handleGatewayEvent(ownerUid(), { type: "missed_call", from: fromPhone, to: "whatsapp" });
    } catch (err) {
      logError("whatsapp.incoming_call_handler_failed", err);
    }
  });

  whatsappService.onInboundMessage(async (fromPhone, text) => {
    try {
      recordWhatsAppMessage({
        type: "received",
        provider: "web",
        direction: "inbound",
        from_phone: fromPhone,
        message: text,
        status: "delivered",
        owner_uid: ownerUid(),
        metadata: { channel: "whatsapp", source: "baileys" },
      });
      await handleGatewayEvent(ownerUid(), { type: "sms_in", from: fromPhone, text });
    } catch (err) {
      logError("whatsapp.inbound_message_handler_failed", err);
    }
  });
}
