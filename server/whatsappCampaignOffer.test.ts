import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildCampaignCloudTemplateOptions,
  campaignOrderButtonSuffix,
} from "./whatsappCampaignOffer";
import {
  saveWhatsAppCampaignMedia,
  whatsappCampaignMediaFile,
} from "./whatsappCampaignMedia";
import { whatsappInboundContent } from "./whatsappWebhookMessage";

test("campaign order buttons are restricted to the approved Meta URL prefix", (t) => {
  const original = process.env.WHATSAPP_CAMPAIGN_ORDER_URL_PREFIX;
  t.after(() => {
    if (original === undefined) delete process.env.WHATSAPP_CAMPAIGN_ORDER_URL_PREFIX;
    else process.env.WHATSAPP_CAMPAIGN_ORDER_URL_PREFIX = original;
  });
  process.env.WHATSAPP_CAMPAIGN_ORDER_URL_PREFIX = "https://goldenksa.store/";

  assert.equal(
    campaignOrderButtonSuffix("https://goldenksa.store/products/filter", "camp_1"),
    "products/filter",
  );
  assert.throws(
    () => campaignOrderButtonSuffix("https://example.test/phishing", "camp_1"),
    /approved prefix/,
  );
  const options = buildCampaignCloudTemplateOptions({
    campaignId: "camp_1",
    media: { type: "video", url: "https://cdn.example.test/offer.mp4" },
    orderUrl: "https://goldenksa.store/offers/filter",
  });
  assert.equal(options.header?.type, "video");
  assert.equal(options.buttons?.[2].type, "quick_reply");
});

test("uploaded campaign media is opaque, public-addressable, and signature checked", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wa-campaign-media-"));
  const original = process.env.WHATSAPP_CAMPAIGN_MEDIA_DIR;
  t.after(() => {
    fs.rmSync(directory, { recursive: true, force: true });
    if (original === undefined) delete process.env.WHATSAPP_CAMPAIGN_MEDIA_DIR;
    else process.env.WHATSAPP_CAMPAIGN_MEDIA_DIR = original;
  });
  process.env.WHATSAPP_CAMPAIGN_MEDIA_DIR = directory;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from("test-image"),
  ]);
  const stored = saveWhatsAppCampaignMedia({
    contentType: "image/png",
    body: png,
    publicBaseUrl: "https://crm.example.test",
  });
  assert.equal(stored.type, "image");
  assert.match(stored.url, /^https:\/\/crm\.example\.test\/public\/whatsapp-campaign-media\/[a-f0-9]{48}\.png$/);
  const filename = new URL(stored.url).pathname.split("/").pop()!;
  assert.equal(whatsappCampaignMediaFile(filename)?.contentType, "image/png");
  assert.throws(
    () => saveWhatsAppCampaignMedia({
      contentType: "image/png",
      body: Buffer.from("not a png"),
      publicBaseUrl: "https://crm.example.test",
    }),
    /does not match/,
  );
});

test("Cloud template quick replies route by payload while keeping the Arabic title for the transcript", () => {
  assert.deepEqual(
    whatsappInboundContent({
      type: "button",
      button: {
        text: "غيّر الفلاتر",
        payload: "campaign:change_filters:camp_123456",
      },
    }),
    {
      text: "غيّر الفلاتر",
      routeText: "campaign:change_filters:camp_123456",
      actionId: "campaign:change_filters:camp_123456",
    },
  );
  assert.deepEqual(
    whatsappInboundContent({
      type: "interactive",
      interactive: {
        type: "button_reply",
        button_reply: {
          id: "campaign:book_appointment:camp_123456",
          title: "احجز موعد",
        },
      },
    }),
    {
      text: "احجز موعد",
      routeText: "campaign:book_appointment:camp_123456",
      actionId: "campaign:book_appointment:camp_123456",
    },
  );
});
