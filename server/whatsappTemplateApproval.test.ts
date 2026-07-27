import assert from "node:assert/strict";
import test from "node:test";
import { buildCampaignCloudTemplateOptions } from "./whatsappCampaignOffer";
import { validateMetaTemplateApproval } from "./whatsappTemplateApproval";

process.env.WHATSAPP_CAMPAIGN_ORDER_URL_PREFIX = "https://goldenksa.store/";

function approvedImageTemplate() {
  return {
    name: "campaign_offer_image_ar",
    status: "APPROVED",
    language: "ar",
    components: [
      { type: "HEADER", format: "IMAGE" },
      { type: "BODY", text: "مرحبًا {{1}}\n{{2}}" },
      {
        type: "BUTTONS",
        buttons: [
          { type: "URL", text: "اطلب الآن", url: "https://goldenksa.store/{{1}}" },
          { type: "QUICK_REPLY", text: "غيّر الفلاتر" },
          { type: "QUICK_REPLY", text: "احجز موعد" },
        ],
      },
    ],
  };
}

const options = buildCampaignCloudTemplateOptions({
  campaignId: "camp_123456",
  media: { type: "image", url: "https://crm.example.test/media.png" },
  orderUrl: "https://goldenksa.store/products/filter",
});

test("Meta campaign template approval requires exact status, shape, language, and buttons", () => {
  assert.deepEqual(
    validateMetaTemplateApproval({
      record: approvedImageTemplate(),
      mappedName: "campaign_offer_image_ar",
      language: "ar",
      logicalTemplate: "campaign_offer_image",
      templateOptions: options,
    }),
    { ready: true },
  );

  for (const [mutate, expected] of [
    [(record: any) => { record.status = "PENDING"; }, /not APPROVED/],
    [(record: any) => { record.components[0].format = "VIDEO"; }, /header must be image/],
    [(record: any) => { record.components[1].text = "مرحبًا {{1}}"; }, /2 ordered placeholder/],
    [(record: any) => { record.components[1].text = "{{1}} {{1}} {{2}}"; }, /2 ordered placeholder/],
    [(record: any) => { record.components[2].buttons[0].url = "https://evil.example/{{1}}"; }, /URL button/],
    [(record: any) => { record.components[2].buttons[2].text = "Other"; }, /wrong title/],
  ] as Array<[(record: any) => void, RegExp]>) {
    const record = approvedImageTemplate();
    mutate(record);
    const result = validateMetaTemplateApproval({
      record,
      mappedName: "campaign_offer_image_ar",
      language: "ar",
      logicalTemplate: "campaign_offer_image",
      templateOptions: options,
    });
    assert.equal(result.ready, false);
    assert.match(result.reason || "", expected);
  }
});
