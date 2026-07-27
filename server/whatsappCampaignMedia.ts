import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { inflateSync } from "node:zlib";
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

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(body: Buffer) {
  let value = 0xffffffff;
  for (const byte of body) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function pngDecodedBytes(width: number, height: number, bitsPerPixel: number, interlace: number) {
  if (interlace === 0) return height * (1 + Math.ceil(width * bitsPerPixel / 8));
  const passes = [
    [0, 0, 8, 8],
    [4, 0, 8, 8],
    [0, 4, 4, 8],
    [2, 0, 4, 4],
    [0, 2, 2, 4],
    [1, 0, 2, 2],
    [0, 1, 1, 2],
  ];
  return passes.reduce((total, [startX, startY, stepX, stepY]) => {
    const passWidth = width <= startX ? 0 : Math.ceil((width - startX) / stepX);
    const passHeight = height <= startY ? 0 : Math.ceil((height - startY) / stepY);
    return total + (passWidth && passHeight
      ? passHeight * (1 + Math.ceil(passWidth * bitsPerPixel / 8))
      : 0);
  }, 0);
}

function validPng(body: Buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (body.length < 45 || !body.subarray(0, 8).equals(signature)) return false;
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitsPerPixel = 0;
  let interlace = 0;
  let sawHeader = false;
  let sawPalette = false;
  let paletteRequired = false;
  let sawData = false;
  let sawEnd = false;
  const compressed: Buffer[] = [];
  while (offset + 12 <= body.length && !sawEnd) {
    const length = body.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (length > 5 * 1024 * 1024 || end > body.length) return false;
    const type = body.subarray(offset + 4, offset + 8);
    const name = type.toString("ascii");
    const data = body.subarray(offset + 8, offset + 8 + length);
    if (crc32(Buffer.concat([type, data])) !== body.readUInt32BE(offset + 8 + length)) return false;
    if (!sawHeader && name !== "IHDR") return false;
    if (name === "IHDR") {
      if (sawHeader || length !== 13) return false;
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      const colorType = data[9];
      const allowedDepths: Record<number, number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      const samples = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType as 0 | 2 | 3 | 4 | 6];
      interlace = data[12];
      if (
        !width || !height || width > 16_384 || height > 16_384
        || width * height > 40_000_000
        || !samples || !allowedDepths[colorType]?.includes(bitDepth)
        || data[10] !== 0 || data[11] !== 0 || ![0, 1].includes(interlace)
      ) return false;
      bitsPerPixel = samples * bitDepth;
      paletteRequired = colorType === 3;
      sawHeader = true;
    } else if (name === "PLTE") {
      if (!sawHeader || sawData || !length || length % 3 !== 0 || length > 768) return false;
      sawPalette = true;
    } else if (name === "IDAT") {
      if (!sawHeader || (paletteRequired && !sawPalette) || sawEnd || !length) return false;
      sawData = true;
      compressed.push(data);
    } else if (name === "IEND") {
      if (!sawData || length !== 0) return false;
      sawEnd = true;
    }
    offset = end;
  }
  if (!sawHeader || !sawData || !sawEnd || offset !== body.length) return false;
  try {
    const expected = pngDecodedBytes(width, height, bitsPerPixel, interlace);
    if (!expected || expected > 64 * 1024 * 1024) return false;
    return inflateSync(Buffer.concat(compressed), { maxOutputLength: expected }).length === expected;
  } catch {
    return false;
  }
}

function validJpeg(body: Buffer) {
  if (body.length < 20 || body[0] !== 0xff || body[1] !== 0xd8) return false;
  let offset = 2;
  let sawFrame = false;
  let sawScan = false;
  while (offset < body.length) {
    if (body[offset] !== 0xff) return false;
    const markerStart = offset;
    while (body[offset] === 0xff) offset += 1;
    if (offset >= body.length) return false;
    const marker = body[offset];
    offset += 1;
    if (marker === 0xd9) return sawFrame && sawScan && offset === body.length;
    if (marker === 0x00 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) return false;
    if (offset + 2 > body.length) return false;
    const length = body.readUInt16BE(offset);
    if (length < 2 || offset + length > body.length) return false;
    const segmentStart = offset + 2;
    const segmentEnd = offset + length;
    const frameMarker = (
      marker >= 0xc0 && marker <= 0xcf
      && ![0xc4, 0xc8, 0xcc].includes(marker)
    );
    if (frameMarker) {
      if (length < 8) return false;
      const precision = body[segmentStart];
      const height = body.readUInt16BE(segmentStart + 1);
      const width = body.readUInt16BE(segmentStart + 3);
      const components = body[segmentStart + 5];
      if (
        ![8, 12].includes(precision) || !width || !height
        || width > 16_384 || height > 16_384 || width * height > 40_000_000
        || components < 1 || components > 4 || length !== 8 + components * 3
      ) return false;
      sawFrame = true;
    }
    offset = segmentEnd;
    if (marker !== 0xda) continue;
    if (!sawFrame) return false;
    sawScan = true;
    while (offset < body.length) {
      if (body[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      let next = offset + 1;
      while (next < body.length && body[next] === 0xff) next += 1;
      if (next >= body.length) return false;
      const code = body[next];
      if (code === 0x00 || (code >= 0xd0 && code <= 0xd7)) {
        offset = next + 1;
        continue;
      }
      offset = markerStart === offset ? next : offset;
      break;
    }
  }
  return false;
}

type Mp4Box = { type: string; start: number; header: number; end: number };

function mp4Boxes(body: Buffer, start = 0, end = body.length): Mp4Box[] | null {
  const output: Mp4Box[] = [];
  let offset = start;
  while (offset < end) {
    if (offset + 8 > end) return null;
    let size = body.readUInt32BE(offset);
    const type = body.subarray(offset + 4, offset + 8).toString("ascii");
    let header = 8;
    if (!/^[A-Za-z0-9 ]{4}$/.test(type)) return null;
    if (size === 1) {
      if (offset + 16 > end) return null;
      const extended = body.readBigUInt64BE(offset + 8);
      if (extended > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      size = Number(extended);
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < header || offset + size > end) return null;
    output.push({ type, start: offset, header, end: offset + size });
    offset += size;
  }
  return offset === end ? output : null;
}

function children(body: Buffer, box: Mp4Box) {
  return mp4Boxes(body, box.start + box.header, box.end);
}

function validMp4(body: Buffer) {
  const top = mp4Boxes(body);
  if (!top || body.length < 64) return false;
  const ftyp = top.find((box) => box.type === "ftyp");
  const moov = top.find((box) => box.type === "moov");
  const mdat = top.find((box) => box.type === "mdat");
  if (!ftyp || !moov || !mdat || ftyp.end - ftyp.start < 16 || mdat.end - mdat.start <= mdat.header) {
    return false;
  }
  const majorBrand = body.subarray(ftyp.start + ftyp.header, ftyp.start + ftyp.header + 4).toString("ascii");
  if (!/^[A-Za-z0-9 ]{4}$/.test(majorBrand)) return false;
  const moovChildren = children(body, moov);
  if (!moovChildren?.some((box) => box.type === "mvhd")) return false;
  const tracks = moovChildren.filter((box) => box.type === "trak");
  return tracks.some((track) => {
    const trackChildren = children(body, track);
    const media = trackChildren?.find((box) => box.type === "mdia");
    if (!trackChildren?.some((box) => box.type === "tkhd") || !media) return false;
    const mediaChildren = children(body, media);
    const handler = mediaChildren?.find((box) => box.type === "hdlr");
    const mediaInfo = mediaChildren?.find((box) => box.type === "minf");
    if (
      !mediaChildren?.some((box) => box.type === "mdhd")
      || !handler || handler.end - handler.start < handler.header + 12
      || body.subarray(handler.start + handler.header + 8, handler.start + handler.header + 12).toString("ascii") !== "vide"
      || !mediaInfo
    ) return false;
    const mediaInfoChildren = children(body, mediaInfo);
    const sampleTable = mediaInfoChildren?.find((box) => box.type === "stbl");
    return Boolean(sampleTable && children(body, sampleTable)?.some((box) => box.type === "stsd"));
  });
}

function hasExpectedStructure(contentType: keyof typeof MEDIA_FORMATS, body: Buffer) {
  if (contentType === "image/jpeg") return validJpeg(body);
  if (contentType === "image/png") return validPng(body);
  return validMp4(body);
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
  if (!hasExpectedStructure(contentType, input.body)) {
    throw new Error("Campaign media is malformed or does not match its declared file type.");
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
