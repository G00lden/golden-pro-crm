import crypto from "node:crypto";
import type Database from "better-sqlite3";
import db from "./db";
import { normalizePhoneDigits } from "../shared/phone";

export type PreferenceStatus = "granted" | "withdrawn" | "unknown";
export type CommunicationChannel = "whatsapp" | "sms";

function nowIso() {
  return new Date().toISOString();
}

function normalizeKeyword(text: string) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[إأآ]/g, "ا")
    .replace(/[ًٌٍَُِّْـ]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const OPT_OUT_KEYWORDS = new Set([
  "الغاء",
  "ايقاف",
  "توقف",
  "قف",
  "لا ترسل",
  "لا ترسلوا",
  "وقف الرسائل",
  "الغاء الاشتراك",
  "stop",
  "unsubscribe",
  "cancel",
]);

export function isOptOutText(text: string): boolean {
  return OPT_OUT_KEYWORDS.has(normalizeKeyword(text));
}

export function createCommunicationPreferenceStore(database: Database.Database) {
  const setPreference = (input: {
    ownerUid: string;
    phone: string;
    channel?: CommunicationChannel;
    purpose?: "marketing";
    status: PreferenceStatus;
    source?: string;
    evidence?: string;
  }) => {
    const phone = normalizePhoneDigits(input.phone);
    if (!/^\d{10,15}$/.test(phone)) throw new Error("Invalid preference phone.");
    const now = nowIso();
    database.prepare(
      `INSERT INTO communication_preferences
        (owner_uid, phone, channel, purpose, status, source, evidence, captured_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_uid, phone, channel, purpose) DO UPDATE SET
         status = excluded.status, source = excluded.source,
         evidence = excluded.evidence, captured_at = excluded.captured_at,
         updated_at = excluded.updated_at`,
    ).run(
      input.ownerUid,
      phone,
      input.channel || "whatsapp",
      input.purpose || "marketing",
      input.status,
      input.source || "manual",
      String(input.evidence || "").slice(0, 1000),
      now,
      now,
      now,
    );
    return getPreference(input.ownerUid, phone, input.channel, input.purpose);
  };

  const getPreference = (
    ownerUid: string,
    phoneInput: string,
    channel: CommunicationChannel = "whatsapp",
    purpose = "marketing",
  ) => {
    const phone = normalizePhoneDigits(phoneInput);
    return database.prepare(
      `SELECT * FROM communication_preferences
       WHERE owner_uid = ? AND phone = ? AND channel = ? AND purpose = ?`,
    ).get(ownerUid, phone, channel, purpose) as Record<string, unknown> | undefined;
  };

  const suppress = (input: {
    ownerUid: string;
    phone: string;
    channel?: CommunicationChannel;
    reason?: string;
    source?: string;
    evidence?: string;
  }) => database.transaction(() => {
    const phone = normalizePhoneDigits(input.phone);
    const channel = input.channel || "whatsapp";
    const existing = database.prepare(
      `SELECT * FROM communication_suppressions
       WHERE owner_uid = ? AND phone = ? AND channel = ? AND active = 1`,
    ).get(input.ownerUid, phone, channel) as Record<string, unknown> | undefined;
    if (!existing) {
      const now = nowIso();
      database.prepare(
        `INSERT INTO communication_suppressions
          (id, owner_uid, phone, channel, reason, source, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).run(
        `supp_${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`,
        input.ownerUid,
        phone,
        channel,
        input.reason || "opt_out",
        input.source || "inbound",
        now,
        now,
      );
    }
    setPreference({
      ownerUid: input.ownerUid,
      phone,
      channel,
      status: "withdrawn",
      source: input.source || "inbound",
      evidence: input.evidence || input.reason || "opt_out",
    });
    return isSuppressed(input.ownerUid, phone, channel);
  })();

  const isSuppressed = (
    ownerUid: string,
    phoneInput: string,
    channel: CommunicationChannel = "whatsapp",
  ) => {
    const phone = normalizePhoneDigits(phoneInput);
    return Boolean(database.prepare(
      `SELECT 1 FROM communication_suppressions
       WHERE owner_uid = ? AND phone = ? AND channel = ? AND active = 1`,
    ).get(ownerUid, phone, channel));
  };

  const liftSuppression = (
    ownerUid: string,
    phoneInput: string,
    channel: CommunicationChannel = "whatsapp",
  ) => {
    const phone = normalizePhoneDigits(phoneInput);
    const now = nowIso();
    return database.prepare(
      `UPDATE communication_suppressions SET active = 0, lifted_at = ?, updated_at = ?
       WHERE owner_uid = ? AND phone = ? AND channel = ? AND active = 1`,
    ).run(now, now, ownerUid, phone, channel).changes;
  };

  const marketingEligibility = (
    ownerUid: string,
    phoneInput: string,
    channel: CommunicationChannel = "whatsapp",
  ): { eligible: boolean; reason?: "invalid_phone" | "suppressed" | "consent_missing" } => {
    const phone = normalizePhoneDigits(phoneInput);
    if (!/^\d{10,15}$/.test(phone)) return { eligible: false, reason: "invalid_phone" };
    if (isSuppressed(ownerUid, phone, channel)) return { eligible: false, reason: "suppressed" };
    const preference = getPreference(ownerUid, phone, channel, "marketing");
    if (preference?.status !== "granted") return { eligible: false, reason: "consent_missing" };
    return { eligible: true };
  };

  const listSuppressions = (ownerUid: string, limit = 100) => database.prepare(
    `SELECT * FROM communication_suppressions
     WHERE owner_uid = ? AND active = 1 ORDER BY created_at DESC LIMIT ?`,
  ).all(ownerUid, Math.max(1, Math.min(500, limit))) as Array<Record<string, unknown>>;

  return {
    setPreference,
    getPreference,
    suppress,
    isSuppressed,
    liftSuppression,
    marketingEligibility,
    listSuppressions,
  };
}

export const communicationPreferenceStore = createCommunicationPreferenceStore(db);

export function captureInboundOptOut(input: {
  ownerUid: string;
  phone: string;
  text: string;
  channel?: CommunicationChannel;
  source: string;
}) {
  if (!isOptOutText(input.text)) return null;
  for (const channel of ["whatsapp", "sms"] as const) {
    communicationPreferenceStore.suppress({
      ownerUid: input.ownerUid,
      phone: input.phone,
      channel,
      reason: "customer_opt_out",
      source: input.source,
      evidence: input.text,
    });
  }
  return { handled: true, kind: "marketing_opt_out", suppressed: true, channels: ["whatsapp", "sms"] };
}
