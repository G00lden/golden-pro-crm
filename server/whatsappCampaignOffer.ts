export const CAMPAIGN_OFFER_TEMPLATES = [
  "campaign_offer_image",
  "campaign_offer_video",
] as const;

export type CampaignOfferTemplateName = typeof CAMPAIGN_OFFER_TEMPLATES[number];
export type CampaignMediaType = "image" | "video";
export type CampaignMedia = {
  type: CampaignMediaType;
  url: string;
};

export type WhatsAppCloudTemplateButton =
  | { type: "url"; index: number; text: string }
  | { type: "quick_reply"; index: number; payload: string };

export type WhatsAppCloudTemplateOptions = {
  header?: {
    type: CampaignMediaType;
    link: string;
  };
  buttons?: WhatsAppCloudTemplateButton[];
};

export const CAMPAIGN_OFFER_BUTTONS = [
  { id: "order_now", title: "اطلب الآن", kind: "url" },
  { id: "change_filters", title: "غيّر الفلاتر", kind: "quick_reply" },
  { id: "book_appointment", title: "احجز موعد", kind: "quick_reply" },
] as const;

function httpsUrl(value: unknown, label: string) {
  const raw = String(value || "").trim();
  if (!raw || raw.length > 2_048) throw new Error(`${label} is required.`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) {
    throw new Error(`${label} must be a public HTTPS URL without embedded credentials.`);
  }
  return url;
}

export function campaignOfferTemplateForMedia(type: CampaignMediaType): CampaignOfferTemplateName {
  return type === "video" ? "campaign_offer_video" : "campaign_offer_image";
}

export function isCampaignOfferTemplate(value: unknown): value is CampaignOfferTemplateName {
  return CAMPAIGN_OFFER_TEMPLATES.includes(value as CampaignOfferTemplateName);
}

export function campaignOrderUrlPrefix() {
  const raw = String(process.env.WHATSAPP_CAMPAIGN_ORDER_URL_PREFIX || "").trim();
  if (!raw) {
    throw new Error(
      "WHATSAPP_CAMPAIGN_ORDER_URL_PREFIX is required for the approved Meta order button.",
    );
  }
  const prefix = httpsUrl(raw, "WhatsApp campaign order URL prefix");
  if (!prefix.pathname.endsWith("/")) {
    throw new Error("WHATSAPP_CAMPAIGN_ORDER_URL_PREFIX must end with '/'.");
  }
  return prefix;
}

export function campaignOrderButtonSuffix(orderUrl: string, campaignId: string) {
  const prefix = campaignOrderUrlPrefix();
  const target = httpsUrl(orderUrl, "Campaign order URL");
  if (!target.href.startsWith(prefix.href)) {
    throw new Error(
      `Campaign order URL must start with the approved prefix ${prefix.href}`,
    );
  }
  const suffix = target.href.slice(prefix.href.length);
  const value = suffix || `?utm_source=whatsapp&utm_medium=campaign&utm_campaign=${encodeURIComponent(campaignId)}`;
  if (value.length > 1_000) throw new Error("Campaign order URL suffix is too long.");
  return value;
}

export function buildCampaignCloudTemplateOptions(input: {
  campaignId: string;
  media: CampaignMedia;
  orderUrl: string;
}): WhatsAppCloudTemplateOptions {
  const mediaUrl = httpsUrl(input.media.url, "Campaign media URL");
  const actionPrefix = `campaign:`;
  return {
    header: {
      type: input.media.type,
      link: mediaUrl.href,
    },
    buttons: [
      {
        type: "url",
        index: 0,
        text: campaignOrderButtonSuffix(input.orderUrl, input.campaignId),
      },
      {
        type: "quick_reply",
        index: 1,
        payload: `${actionPrefix}change_filters:${input.campaignId}`,
      },
      {
        type: "quick_reply",
        index: 2,
        payload: `${actionPrefix}book_appointment:${input.campaignId}`,
      },
    ],
  };
}

export function sanitizeWhatsAppCloudTemplateOptions(
  value: unknown,
): WhatsAppCloudTemplateOptions | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const output: WhatsAppCloudTemplateOptions = {};
  if (source.header && typeof source.header === "object" && !Array.isArray(source.header)) {
    const header = source.header as Record<string, unknown>;
    const type = header.type === "video" ? "video" : header.type === "image" ? "image" : null;
    if (!type) throw new Error("Unsupported WhatsApp template header type.");
    output.header = {
      type,
      link: httpsUrl(header.link, "WhatsApp template media link").href,
    };
  }
  if (source.buttons !== undefined) {
    if (!Array.isArray(source.buttons) || source.buttons.length > 3) {
      throw new Error("WhatsApp templates support at most three configured buttons.");
    }
    const used = new Set<number>();
    output.buttons = source.buttons.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error("Invalid WhatsApp template button.");
      }
      const button = item as Record<string, unknown>;
      const index = Number(button.index);
      if (!Number.isInteger(index) || index < 0 || index > 2 || used.has(index)) {
        throw new Error("WhatsApp template button index must be unique and between 0 and 2.");
      }
      used.add(index);
      if (button.type === "url") {
        const text = String(button.text || "");
        if (!text || text.length > 1_000) throw new Error("Invalid WhatsApp URL button value.");
        return { type: "url" as const, index, text };
      }
      if (button.type === "quick_reply") {
        const payload = String(button.payload || "");
        if (!payload || payload.length > 256) throw new Error("Invalid WhatsApp quick-reply payload.");
        return { type: "quick_reply" as const, index, payload };
      }
      throw new Error("Unsupported WhatsApp template button type.");
    });
  }
  return output;
}
