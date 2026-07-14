/**
 * Wires WhatsApp (Baileys) call/message events to the routing engine.
 *
 * Kept separate so whatsapp.ts stays free of any dependency on the gateway
 * engine (this module imports both and breaks the cycle).
 *
 * WhatsApp calls are intentionally ignored: cellular events come only from
 * Unifonic or the Android gateway. Inbound WhatsApp text is recorded and tied
 * back to the latest cellular follow-up task.
 */
import { recordWhatsAppMessage, whatsappService } from "./whatsapp";
import { drainCallActionQueue, handleCustomerWhatsAppReply } from "./callAutomation";
import { logError, logEvent } from "./logger";
import { findUnhandledCallForAgent, isAgentAck, markCallHandled } from "./ivrEngine";

let initialized = false;

export function initWhatsAppAutoReply(ownerUid: () => string) {
  if (initialized) return;
  initialized = true;

  whatsappService.onConnected(async () => {
    try {
      const result = await drainCallActionQueue(ownerUid(), 50, true);
      logEvent("info", "call.automation.queue_resumed", result);
    } catch (err) {
      logError("call.automation.queue_resume_failed", err);
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
      if (isAgentAck(text)) {
        const call = findUnhandledCallForAgent(ownerUid(), fromPhone);
        if (call?.id) markCallHandled(ownerUid(), String(call.id), "agent");
      } else {
        handleCustomerWhatsAppReply(ownerUid(), fromPhone, text);
      }
    } catch (err) {
      logError("whatsapp.inbound_message_handler_failed", err);
    }
  });
}
