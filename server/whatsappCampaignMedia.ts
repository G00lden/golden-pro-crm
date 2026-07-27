import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CampaignMediaType } from "./whatsappCampaignOffer";

export const CAMPAIGN_MEDIA_PUBLIC_PATH = "/public/whatsapp-campaign-media";

const MEDIA_FORMATS = {
  "image/jpeg": { type: "image", extension: ".jpg", maxBytes: 5 * 1024 * 1024 },
  "image/png": { type: "image", extension: ".png", maxBytes: 5 * 1024 * 1024 },
  "video/mp4": { type: "video", extension: ".mp4", maxBytes: 16 * 1024 * 1024 },
} as const;

function mediaDirectory() {
  const databasePath = path.resolve(
    process.env.DB_PATH || path.join(process.cwd(), "data", "golden-crm.db"),
  );
  return path.resolve(
    process.env.WHATSAPP_CAMPAIGN_MEDIA_DIR
      || path.join(path.dirname(databasePath), "whatsapp-campaign-media"),
  );
}

function hasExpectedSignature(contentType: keyof typeof MEDIA_FORMATS, body: Buffer) {
  if (contentType === "image/jpeg") {
    return body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff;
  }
  if (contentType === "image/png") {
    return body.length >= 8
      && body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  return body.length >= 12 && body.subarray(4, 8).toString("ascii") === "ftyp";
}

function httpsBaseUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PUBLIC_BASE_URL must be a valid public HTTPS URL before media upload.");
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) {
    throw new Error("PUBLIC_BASE_URL must be a public HTTPS URL without embedded credentials.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url;
}

export function saveWhatsAppCampaignMedia(input: {
  contentType: string;
  body: Buffer;
  publicBaseUrl: string;
}): {
  type: CampaignMediaType;
  url: string;
  bytes: number;
  contentType: keyof typeof MEDIA_FORMATS;
} {
  const contentType = input.contentType.toLowerCase().split(";")[0].trim() as keyof typeof MEDIA_FORMATS;
  const format = MEDIA_FORMATS[contentType];
  if (!format) throw new Error("Only JPEG, PNG, and MP4 campaign media is accepted.");
  if (!Buffer.isBuffer(input.body) || input.body.length === 0) {
    throw new Error("Campaign media file is empty.");
  }
  if (input.body.length > format.maxBytes) {
    throw new Error(
      format.type === "video"
        ? "Campaign video exceeds the 16 MB limit."
        : "Campaign image exceeds the 5 MB limit.",
    );
  }
  if (!hasExpectedSignature(contentType, input.body)) {
    throw new Error("Campaign media content does not match its declared file type.");
  }
  const base = httpsBaseUrl(input.publicBaseUrl);
  const directory = mediaDirectory();
  fs.mkdirSync(directory, { recursive: true });
  const filename = `${crypto.randomBytes(24).toString("hex")}${format.extension}`;
  fs.writeFileSync(path.join(directory, filename), input.body, { flag: "wx", mode: 0o640 });
  return {
    type: format.type,
    url: `${base.href.replace(/\/+$/, "")}${CAMPAIGN_MEDIA_PUBLIC_PATH}/${filename}`,
    bytes: input.body.length,
    contentType,
  };
}

export function whatsappCampaignMediaFile(filename: string) {
  if (!/^[a-f0-9]{48}\.(?:jpg|png|mp4)$/.test(filename)) return null;
  const directory = mediaDirectory();
  const filePath = path.resolve(directory, filename);
  if (path.dirname(filePath) !== directory) return null;
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
  } catch {
    return null;
  }
  const extension = path.extname(filename);
  const contentType = extension === ".mp4"
    ? "video/mp4"
    : extension === ".png"
      ? "image/png"
      : "image/jpeg";
  return { filePath, contentType };
}
