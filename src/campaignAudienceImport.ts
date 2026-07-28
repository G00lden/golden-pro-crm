import { normalizePhoneDigits } from "../shared/phone";

export type CampaignAudienceMember = {
  phone: string;
  name?: string;
};

export type CampaignAudienceImportResult = {
  members: CampaignAudienceMember[];
  invalid: number;
  duplicates: number;
  overflow: number;
};

const PHONE_HEADERS = new Set([
  "phone",
  "mobile",
  "whatsapp",
  "رقم",
  "رقم الجوال",
  "الجوال",
  "الهاتف",
]);

const NAME_HEADERS = new Set([
  "name",
  "customer",
  "customer name",
  "الاسم",
  "اسم العميل",
]);

function normalizeHeader(value: string) {
  return value.replace(/^\uFEFF/, "").trim().toLocaleLowerCase("ar");
}

function delimiterFor(line: string) {
  const candidates = [",", "\t", ";"] as const;
  return candidates.reduce((best, candidate) => (
    line.split(candidate).length > line.split(best).length ? candidate : best
  ), candidates[0]);
}

function parseDelimitedLine(line: string, delimiter: string) {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === "\"") {
      if (quoted && line[index + 1] === "\"") {
        cell += "\"";
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (character === delimiter && !quoted) {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += character;
  }
  cells.push(cell.trim());
  return cells;
}

export function parseCampaignAudience(
  value: string,
  limit = 10_000,
): CampaignAudienceImportResult {
  const lines = String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return { members: [], invalid: 0, duplicates: 0, overflow: 0 };

  const delimiter = delimiterFor(lines[0]);
  const first = parseDelimitedLine(lines[0], delimiter);
  const normalizedFirst = first.map(normalizeHeader);
  const phoneHeaderIndex = normalizedFirst.findIndex((cell) => PHONE_HEADERS.has(cell));
  const nameHeaderIndex = normalizedFirst.findIndex((cell) => NAME_HEADERS.has(cell));
  const hasHeader = phoneHeaderIndex >= 0;
  const phoneIndex = hasHeader ? phoneHeaderIndex : 0;
  const nameIndex = hasHeader ? nameHeaderIndex : 1;
  const members: CampaignAudienceMember[] = [];
  const seen = new Set<string>();
  let invalid = 0;
  let duplicates = 0;
  let overflow = 0;

  for (const line of lines.slice(hasHeader ? 1 : 0)) {
    const cells = parseDelimitedLine(line, delimiter);
    const phone = normalizePhoneDigits(cells[phoneIndex] || "");
    if (!/^\d{10,15}$/.test(phone)) {
      invalid += 1;
      continue;
    }
    if (seen.has(phone)) {
      duplicates += 1;
      continue;
    }
    seen.add(phone);
    if (members.length >= limit) {
      overflow += 1;
      continue;
    }
    const name = String(cells[nameIndex] || "").trim().slice(0, 160);
    members.push({ phone, ...(name ? { name } : {}) });
  }
  return { members, invalid, duplicates, overflow };
}
