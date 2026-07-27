import {
  CAMPAIGN_OFFER_BUTTONS,
  campaignOrderUrlPrefix,
  type WhatsAppCloudTemplateOptions,
} from "./whatsappCampaignOffer";
import { templateVariableNames, type TemplateName } from "./whatsappTemplates";

export type MetaTemplateRecord = {
  name?: unknown;
  status?: unknown;
  language?: unknown;
  components?: unknown;
};

export type TemplateApprovalResult = {
  ready: boolean;
  reason?: string;
};

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    : [];
}

function placeholderIndexes(text: unknown) {
  const values: number[] = [];
  for (const match of String(text || "").matchAll(/\{\{\s*(\d+)\s*\}\}/g)) {
    values.push(Number(match[1]));
  }
  return values;
}

export function validateMetaTemplateApproval(input: {
  record: MetaTemplateRecord;
  mappedName: string;
  language: string;
  logicalTemplate: TemplateName;
  templateOptions?: WhatsAppCloudTemplateOptions;
}): TemplateApprovalResult {
  if (String(input.record.name || "") !== input.mappedName) {
    return { ready: false, reason: "Meta returned a different template name." };
  }
  if (String(input.record.status || "").toUpperCase() !== "APPROVED") {
    return { ready: false, reason: "The Meta template is not APPROVED." };
  }
  if (String(input.record.language || "") !== input.language) {
    return { ready: false, reason: "The Meta template language does not match the configured language." };
  }
  const components = records(input.record.components);
  const body = components.find((item) => String(item.type || "").toUpperCase() === "BODY");
  const expectedVariables = templateVariableNames(input.logicalTemplate);
  const actualIndexes = placeholderIndexes(body?.text);
  if (
    expectedVariables.length !== actualIndexes.length
    || actualIndexes.some((value, index) => value !== index + 1)
  ) {
    return {
      ready: false,
      reason: `The Meta template body must contain ${expectedVariables.length} ordered placeholder(s).`,
    };
  }

  const expectedHeader = input.templateOptions?.header;
  if (expectedHeader) {
    const header = components.find((item) => String(item.type || "").toUpperCase() === "HEADER");
    if (String(header?.format || "").toUpperCase() !== expectedHeader.type.toUpperCase()) {
      return { ready: false, reason: `The Meta template header must be ${expectedHeader.type}.` };
    }
  }

  const expectedButtons = input.templateOptions?.buttons || [];
  if (expectedButtons.length) {
    const component = components.find((item) => String(item.type || "").toUpperCase() === "BUTTONS");
    const buttons = records(component?.buttons);
    if (buttons.length !== expectedButtons.length) {
      return { ready: false, reason: `The Meta template must contain exactly ${expectedButtons.length} buttons.` };
    }
    for (const expected of expectedButtons) {
      const actual = buttons[expected.index];
      const expectedType = expected.type === "url" ? "URL" : "QUICK_REPLY";
      if (String(actual?.type || "").toUpperCase() !== expectedType) {
        return { ready: false, reason: `Meta button ${expected.index} has the wrong type.` };
      }
      const expectedTitle = CAMPAIGN_OFFER_BUTTONS[expected.index]?.title;
      if (expectedTitle && String(actual?.text || "").trim() !== expectedTitle) {
        return { ready: false, reason: `Meta button ${expected.index} has the wrong title.` };
      }
      if (expected.type === "url") {
        const expectedUrl = `${campaignOrderUrlPrefix().href}{{1}}`;
        if (String(actual?.url || "") !== expectedUrl) {
          return { ready: false, reason: `The Meta URL button must use ${expectedUrl}` };
        }
      }
    }
  }
  return { ready: true };
}
