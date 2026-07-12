import { handleGatewayEvent } from "./gateway";

export type InboundMessageSource = "whatsapp_web" | "whatsapp_cloud" | "sms_gateway";

/** One entry point for department digits, agent acknowledgements and future intents. */
export async function routeInboundConversation(input: {
  ownerUid: string;
  fromPhone: string;
  text: string;
  source: InboundMessageSource;
}) {
  return handleGatewayEvent(input.ownerUid, {
    type: "sms_in",
    from: input.fromPhone,
    text: input.text,
    to: input.source,
  });
}
