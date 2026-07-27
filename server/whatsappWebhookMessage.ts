export type WhatsAppWebhookMessage = {
  from?: string;
  id?: string;
  timestamp?: string;
  text?: { body?: string };
  button?: { text?: string; payload?: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string };
  };
  type?: string;
};

export function whatsappInboundContent(message: WhatsAppWebhookMessage) {
  const actionId = String(
    message?.button?.payload
      || message?.interactive?.button_reply?.id
      || message?.interactive?.list_reply?.id
      || "",
  ).trim();
  const text = String(
    message?.text?.body
      || message?.button?.text
      || message?.interactive?.button_reply?.title
      || message?.interactive?.list_reply?.title
      || actionId,
  ).trim();
  return {
    text,
    routeText: actionId || text,
    actionId: actionId || null,
  };
}
