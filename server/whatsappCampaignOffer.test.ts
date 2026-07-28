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

test("text marketing campaigns use order, remind-week, and opt-out buttons", (t) => {
  const original = process.env.WHATSAPP_CAMPAIGN_ORDER_URL_PREFIX;
  t.after(() => {
    if (original === undefined) delete process.env.WHATSAPP_CAMPAIGN_ORDER_URL_PREFIX;
    else process.env.WHATSAPP_CAMPAIGN_ORDER_URL_PREFIX = original;
  });
  process.env.WHATSAPP_CAMPAIGN_ORDER_URL_PREFIX = "https://goldenksa.store/";
  const options = buildCampaignCloudTemplateOptions({
    campaignId: "camp_reminder",
    orderUrl: "https://goldenksa.store/offers/filter",
    templateName: "campaign_offer_text_reminder",
  });
  assert.equal(options.header, undefined);
  assert.deepEqual(options.buttons, [
    { type: "url", index: 0, text: "offers/filter" },
    { type: "quick_reply", index: 1, payload: "campaign:remind_week:camp_reminder" },
    { type: "quick_reply", index: 2, payload: "campaign:stop_marketing:camp_reminder" },
  ]);
});

function mp4Box(type: string, ...parts: Buffer[]) {
  const payload = Buffer.concat(parts);
  const output = Buffer.alloc(8 + payload.length);
  output.writeUInt32BE(output.length, 0);
  output.write(type, 4, 4, "ascii");
  payload.copy(output, 8);
  return output;
}

function structurallyValidMp4() {
  const ftyp = mp4Box("ftyp", Buffer.from("isom"), Buffer.alloc(4), Buffer.from("isommp42"));
  const sampleTable = mp4Box("stbl", mp4Box("stsd", Buffer.alloc(8)));
  const media = mp4Box(
    "mdia",
    mp4Box("mdhd", Buffer.alloc(20)),
    mp4Box("hdlr", Buffer.alloc(8), Buffer.from("vide"), Buffer.alloc(12)),
    mp4Box("minf", sampleTable),
  );
  const movie = mp4Box(
    "moov",
    mp4Box("mvhd", Buffer.alloc(20)),
    mp4Box("trak", mp4Box("tkhd", Buffer.alloc(20)), media),
  );
  return Buffer.concat([ftyp, movie, mp4Box("mdat", Buffer.from([1, 2, 3, 4]))]);
}

test("uploaded campaign media is opaque, public-addressable, and structurally validated", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wa-campaign-media-"));
  const original = process.env.WHATSAPP_CAMPAIGN_MEDIA_DIR;
  t.after(() => {
    fs.rmSync(directory, { recursive: true, force: true });
    if (original === undefined) delete process.env.WHATSAPP_CAMPAIGN_MEDIA_DIR;
    else process.env.WHATSAPP_CAMPAIGN_MEDIA_DIR = original;
  });
  process.env.WHATSAPP_CAMPAIGN_MEDIA_DIR = directory;
  const png = fs.readFileSync(new URL("../public/brand/icon-32.png", import.meta.url));
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
    /malformed|does not match/,
  );
  assert.throws(
    () => saveWhatsAppCampaignMedia({
      contentType: "image/png",
      body: Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from("signature-only payload"),
      ]),
      publicBaseUrl: "https://crm.example.test",
    }),
    /malformed/,
  );
  assert.equal(
    saveWhatsAppCampaignMedia({
      contentType: "video/mp4",
      body: structurallyValidMp4(),
      publicBaseUrl: "https://crm.example.test",
    }).type,
    "video",
  );
  assert.throws(
    () => saveWhatsAppCampaignMedia({
      contentType: "video/mp4",
      body: Buffer.concat([Buffer.alloc(4), Buffer.from("ftyp"), Buffer.alloc(20)]),
      publicBaseUrl: "https://crm.example.test",
    }),
    /malformed/,
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
  assert.deepEqual(
    whatsappInboundContent({
      type: "button",
      button: {
        text: "ذكّرني بعد أسبوع",
        payload: "campaign:remind_week:camp_123456",
      },
    }),
    {
      text: "ذكّرني بعد أسبوع",
      routeText: "campaign:remind_week:camp_123456",
      actionId: "campaign:remind_week:camp_123456",
    },
  );
});
