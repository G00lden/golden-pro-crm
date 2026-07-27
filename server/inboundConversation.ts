import { captureInboundOptOut } from "./communicationPreferences";
import { dispatchMessage, handleGatewayEvent } from "./gateway";
import { handleWhatsAppCommerceConversation } from "./whatsappCommerce";

export type InboundMessageSource = "whatsapp_web" | "whatsapp_cloud" | "sms_gateway";

/** One entry point for department digits, agent acknowledgements and future intents. */
export async function routeInboundConversation(input: {
  ownerUid: string;
  fromPhone: string;
  text: string;
  source: InboundMessageSource;
}) {
  if (input.source.startsWith("whatsapp_")) {
    const optOut = captureInboundOptOut({
      ownerUid: input.ownerUid,
      phone: input.fromPhone,
      text: input.text,
      channel: "whatsapp",
      source: input.source,
    });
    if (optOut) return optOut;

    const commerce = await handleWhatsAppCommerceConversation({
      ownerUid: input.ownerUid,
      fromPhone: input.fromPhone,
      text: input.text,
    });
    if (commerce.handled && commerce.reply) {
      const dispatched = await dispatchMessage(
        input.ownerUid,
        input.fromPhone,
        commerce.reply,
        { role: "customer", allowSmsFallback: false },
      );
      const { reply: _privateReply, ...summary } = commerce;
      return {
        ...summary,
        dispatched: {
          channel: dispatched.channel,
          accepted: dispatched.accepted,
          status: dispatched.status,
        },
      };
    }
    if (commerce.handled) return commerce;
  }

  return handleGatewayEvent(input.ownerUid, {
    type: "sms_in",
    from: input.fromPhone,
    text: input.text,
    to: input.source,
  });
}
