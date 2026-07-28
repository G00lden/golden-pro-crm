import crypto from "node:crypto";
import type Database from "better-sqlite3";
import db from "./db";
import { communicationJobStore, type CommunicationJob } from "./communicationJobs";
import { communicationPreferenceStore } from "./communicationPreferences";
import { normalizePhoneDigits } from "../shared/phone";
import { listTemplateNames, type TemplateName } from "./whatsappTemplates";
import { advanceMessageStatus } from "./communicationStatus";
import {
  buildCampaignCloudTemplateOptions,
  campaignButtonPresetForTemplate,
  campaignContentTypeForTemplate,
  campaignOfferTemplateForMedia,
  isCampaignOfferTemplate,
  type CampaignOfferTemplateName,
  type CampaignMedia,
} from "./whatsappCampaignOffer";

export type CampaignStatus = "draft" | "scheduled" | "running" | "paused" | "completed" | "cancelled";
export type AudienceFilter = {
  allCustomers?: boolean;
  city?: string;
  source?: string;
  customerIds?: string[];
  importedAudience?: boolean;
};

export type ImportedAudienceMember = {
  phone: string;
  name?: string;
};

export type ImportedAudienceConsent = {
  granted: true;
  evidence: string;
  source?: string;
};

export type Campaign = {
  id: string;
  owner_uid: string;
  name: string;
  channel: "whatsapp";
  template_name: TemplateName;
  status: CampaignStatus;
  audience_filter: AudienceFilter;
  template_vars: Record<string, string | number>;
  media: CampaignMedia | null;
  order_url: string | null;
  scheduled_at: string | null;
  rate_limit_per_minute: number;
  frequency_cap_days: number;
  created_by: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

type PreferenceGate = {
  marketingEligibility(ownerUid: string, phone: string, channel?: "whatsapp" | "sms"): {
    eligible: boolean;
    reason?: "invalid_phone" | "suppressed" | "consent_missing";
  };
  setPreference(input: {
    ownerUid: string;
    phone: string;
    channel?: "whatsapp" | "sms";
    status: "granted" | "withdrawn";
    source?: string;
    evidence: string;
  }): unknown;
};

type JobQueue = {
  enqueue(input: {
    ownerUid: string;
    eventKey: string;
    recipientPhone: string;
    templateName: string;
    payload?: Record<string, unknown>;
    role?: string;
    kind?: string;
    channel?: string;
    maxAttempts?: number;
    expiresInMinutes?: number;
    availableAt?: string;
    campaignId?: string;
    campaignRecipientId?: string;
  }): CommunicationJob;
};

function nowIso() {
  return new Date().toISOString();
}

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`;
}

function safeJson<T>(value: unknown, fallback: T): T {
  if (value && typeof value === "object") return value as T;
  if (typeof value !== "string") return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as T : fallback;
  } catch {
    return fallback;
  }
}

function mapCampaign(value: Record<string, unknown> | undefined): Campaign | null {
  if (!value) return null;
  return {
    ...(value as unknown as Campaign),
    audience_filter: safeJson<AudienceFilter>(value.audience_filter, {}),
    template_vars: safeJson<Record<string, string | number>>(value.template_vars, {}),
    media: value.media_type && value.media_url
      ? { type: value.media_type as CampaignMedia["type"], url: String(value.media_url) }
      : null,
    order_url: value.order_url ? String(value.order_url) : null,
    rate_limit_per_minute: Number(value.rate_limit_per_minute || 30),
    frequency_cap_days: Number(value.frequency_cap_days || 7),
  };
}

export function createCommunicationCampaignStore(
  database: Database.Database,
  preferences: PreferenceGate,
  jobs: JobQueue,
) {
  const get = (ownerUid: string, campaignId: string) => mapCampaign(
    database.prepare(
      "SELECT * FROM communication_campaigns WHERE owner_uid = ? AND id = ?",
    ).get(ownerUid, campaignId) as Record<string, unknown> | undefined,
  );

  const stats = (ownerUid: string, campaignId: string) => {
    const rows = database.prepare(
      `SELECT status, COUNT(*) AS count FROM communication_campaign_recipients
       WHERE owner_uid = ? AND campaign_id = ? GROUP BY status`,
    ).all(ownerUid, campaignId) as Array<{ status: string; count: number }>;
    const counts: Record<string, number> = {};
    for (const item of rows) counts[item.status] = Number(item.count || 0);
    const followupRows = database.prepare(
      `SELECT status, COUNT(*) AS count FROM communication_jobs
       WHERE owner_uid = ? AND campaign_id = ? AND kind = 'whatsapp_campaign_followup'
       GROUP BY status`,
    ).all(ownerUid, campaignId) as Array<{ status: string; count: number }>;
    const followups: Record<string, number> = {};
    for (const item of followupRows) followups[item.status] = Number(item.count || 0);
    return {
      total: Object.values(counts).reduce((sum, count) => sum + count, 0),
      eligible: counts.eligible || 0,
      queued: counts.queued || 0,
      processing: counts.processing || 0,
      sent: counts.sent || 0,
      delivered: counts.delivered || 0,
      read: counts.read || 0,
      retry: counts.retry || 0,
      failed: counts.failed || 0,
      blocked: counts.blocked || 0,
      skipped: counts.skipped || 0,
      cancelled: counts.cancelled || 0,
      followups_scheduled:
        (followups.pending || 0)
        + (followups.retry || 0)
        + (followups.processing || 0),
      followups_sent: followups.sent || 0,
      followups_failed:
        (followups.failed || 0)
        + (followups.blocked || 0)
        + (followups.expired || 0),
    };
  };

  const withStats = (campaign: Campaign) => ({ ...campaign, stats: stats(campaign.owner_uid, campaign.id) });

  const list = (ownerUid: string, limit = 100) => {
    const rows = database.prepare(
      `SELECT * FROM communication_campaigns WHERE owner_uid = ?
       ORDER BY created_at DESC LIMIT ?`,
    ).all(ownerUid, Math.max(1, Math.min(500, limit))) as Array<Record<string, unknown>>;
    return rows.map(mapCampaign).filter((item): item is Campaign => Boolean(item)).map(withStats);
  };

  const create = (input: {
    ownerUid: string;
    name: string;
    templateName: TemplateName;
    audienceFilter: AudienceFilter;
    templateVars?: Record<string, string | number>;
    media?: CampaignMedia | null;
    orderUrl?: string | null;
    audienceMembers?: ImportedAudienceMember[];
    audienceConsent?: ImportedAudienceConsent;
    rateLimitPerMinute?: number;
    frequencyCapDays?: number;
    createdBy?: string;
  }) => {
    if (!listTemplateNames().includes(input.templateName)) {
      throw new Error("Campaign template is not supported.");
    }
    if (isCampaignOfferTemplate(input.templateName)) {
      const contentType = campaignContentTypeForTemplate(input.templateName);
      if (!input.orderUrl) {
        throw new Error("Interactive campaigns require an order URL.");
      }
      if (contentType === "text" && input.media) {
        throw new Error("Text campaign templates cannot include media.");
      }
      if (contentType !== "text" && !input.media) {
        throw new Error("Image and video campaigns require media.");
      }
      if (
        input.media
        && !input.templateName.endsWith("_reminder")
        && campaignOfferTemplateForMedia(input.media.type) !== input.templateName
      ) {
        throw new Error("Campaign media type does not match its approved Meta template.");
      }
      if (input.media && input.media.type !== contentType) {
        throw new Error("Campaign media type does not match its approved Meta template.");
      }
    } else if (input.templateName !== "general_reminder") {
      throw new Error("Campaigns require an approved campaign template.");
    }
    const importedMembers = new Map<string, ImportedAudienceMember>();
    for (const member of input.audienceMembers || []) {
      const phone = normalizePhoneDigits(member.phone);
      if (!/^\d{10,15}$/.test(phone)) {
        throw new Error(`Imported audience contains an invalid phone: ${String(member.phone).slice(0, 32)}`);
      }
      if (!importedMembers.has(phone)) {
        importedMembers.set(phone, {
          phone,
          name: String(member.name || "").trim().slice(0, 160),
        });
      }
    }
    if (importedMembers.size > 10_000) {
      throw new Error("Imported campaign audience cannot exceed 10,000 unique phone numbers.");
    }
    if (input.audienceFilter.importedAudience) {
      if (!importedMembers.size || !input.audienceConsent?.granted) {
        throw new Error("Imported audiences require phone numbers and documented marketing consent.");
      }
      if (String(input.audienceConsent.evidence || "").trim().length < 3) {
        throw new Error("Imported audience consent evidence is required.");
      }
    } else if (importedMembers.size) {
      throw new Error("Imported audience members require importedAudience=true.");
    }
    const campaignId = id("camp");
    const now = nowIso();
    database.transaction(() => {
      database.prepare(
        `INSERT INTO communication_campaigns
          (id, owner_uid, name, channel, template_name, status, audience_filter,
           template_vars, media_type, media_url, order_url, rate_limit_per_minute,
           frequency_cap_days, created_by, created_at, updated_at)
         VALUES (?, ?, ?, 'whatsapp', ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        campaignId,
        input.ownerUid,
        input.name.trim().slice(0, 160),
        input.templateName,
        JSON.stringify(input.audienceFilter || {}),
        JSON.stringify(input.templateVars || {}),
        input.media?.type || null,
        input.media?.url || null,
        input.orderUrl || null,
        Math.max(1, Math.min(120, input.rateLimitPerMinute ?? 30)),
        Math.max(1, Math.min(90, input.frequencyCapDays ?? 7)),
        input.createdBy || null,
        now,
        now,
      );
      const insertMember = database.prepare(
        `INSERT INTO communication_campaign_audience
          (id, campaign_id, owner_uid, phone, name, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const member of importedMembers.values()) {
        insertMember.run(
          id("caud"),
          campaignId,
          input.ownerUid,
          member.phone,
          member.name || null,
          now,
        );
        preferences.setPreference({
          ownerUid: input.ownerUid,
          phone: member.phone,
          channel: "whatsapp",
          status: "granted",
          source: input.audienceConsent?.source || "campaign_import",
          evidence: String(input.audienceConsent?.evidence || "").trim(),
        });
      }
    })();
    return withStats(get(input.ownerUid, campaignId)!);
  };

  const audience = (campaign: Campaign) => {
    const filter = campaign.audience_filter || {};
    const ids = Array.isArray(filter.customerIds)
      ? [...new Set(filter.customerIds.map(String).filter(Boolean))].slice(0, 1_000)
      : [];
    if (
      !filter.allCustomers
      && !filter.city
      && !filter.source
      && !ids.length
      && !filter.importedAudience
    ) return [];

    const output: Array<{
      id: string;
      name: string;
      phone: string;
      city?: string;
      source?: string;
    }> = [];
    if (filter.allCustomers || filter.city || filter.source || ids.length) {
      const conditions = ["owner_uid = ?", "phone IS NOT NULL", "TRIM(phone) <> ''"];
      const params: unknown[] = [campaign.owner_uid];
      if (filter.city) {
        conditions.push("city = ?");
        params.push(String(filter.city));
      }
      if (filter.source) {
        conditions.push("source = ?");
        params.push(String(filter.source));
      }
      if (ids.length) {
        conditions.push(`id IN (${ids.map(() => "?").join(",")})`);
        params.push(...ids);
      }
      output.push(...database.prepare(
        `SELECT id, name, phone, city, source FROM customers
         WHERE ${conditions.join(" AND ")} ORDER BY created_at ASC LIMIT 10000`,
      ).all(...params) as typeof output);
    }
    if (filter.importedAudience && output.length < 10_000) {
      const remaining = 10_000 - output.length;
      const imported = database.prepare(
        `SELECT id, COALESCE(name, '') AS name, phone, '' AS city, 'campaign_import' AS source
         FROM communication_campaign_audience
         WHERE owner_uid = ? AND campaign_id = ?
         ORDER BY created_at ASC LIMIT ?`,
      ).all(campaign.owner_uid, campaign.id, remaining) as typeof output;
      output.push(...imported);
    }
    return output.slice(0, 10_000);
  };

  const frequencyBlocked = (campaign: Campaign, phone: string) => {
    const cutoff = new Date(Date.now() - campaign.frequency_cap_days * 24 * 60 * 60_000).toISOString();
    return Boolean(database.prepare(
      `SELECT 1 FROM communication_campaign_recipients
       WHERE owner_uid = ? AND phone = ?
         AND (
           (status IN ('eligible','queued','processing','retry') AND created_at >= ?)
           OR (
             status IN ('sent','delivered','read')
             AND COALESCE(sent_at, created_at) >= ?
           )
         )
       LIMIT 1`,
    ).get(campaign.owner_uid, phone, cutoff, cutoff));
  };

  const assess = (campaign: Campaign) => {
    const seen = new Set<string>();
    return audience(campaign).map((customer) => {
      const phone = normalizePhoneDigits(customer.phone);
      let reason: string | undefined;
      const gate = preferences.marketingEligibility(campaign.owner_uid, phone, "whatsapp");
      if (!gate.eligible) reason = gate.reason;
      else if (seen.has(phone)) reason = "duplicate_phone";
      else if (frequencyBlocked(campaign, phone)) reason = "frequency_cap";
      seen.add(phone);
      return { customer, phone, eligible: !reason, reason };
    });
  };

  const preview = (ownerUid: string, campaignId: string) => {
    const campaign = get(ownerUid, campaignId);
    if (!campaign) return null;
    const assessed = assess(campaign);
    const excluded: Record<string, number> = {};
    for (const item of assessed) {
      if (item.reason) excluded[item.reason] = (excluded[item.reason] || 0) + 1;
    }
    return {
      campaign: withStats(campaign),
      audience: assessed.length,
      eligible: assessed.filter((item) => item.eligible).length,
      excluded,
      sample: assessed.slice(0, 20).map((item) => ({
        customer_id: item.customer.id,
        name: item.customer.name,
        phone: item.phone,
        eligible: item.eligible,
        reason: item.reason || null,
      })),
    };
  };

  const materialize = (campaign: Campaign) => database.transaction(() => {
    const assessed = assess(campaign);
    const rate = Math.max(1, campaign.rate_limit_per_minute);
    const deliveryWindowMinutes = Math.ceil(
      assessed.filter((item) => item.eligible).length / rate,
    );
    let queueIndex = 0;
    for (const item of assessed) {
      const recipientId = id("crec");
      const status = item.eligible ? "eligible" : "skipped";
      database.prepare(
        `INSERT OR IGNORE INTO communication_campaign_recipients
          (id, campaign_id, owner_uid, customer_id, phone, status, skip_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        recipientId,
        campaign.id,
        campaign.owner_uid,
        item.customer.id,
        item.phone,
        status,
        item.reason || null,
        nowIso(),
        nowIso(),
      );
      const recipient = database.prepare(
        "SELECT * FROM communication_campaign_recipients WHERE campaign_id = ? AND phone = ?",
      ).get(campaign.id, item.phone) as Record<string, unknown>;
      if (!item.eligible || recipient.status !== "eligible") continue;

      const availableAt = new Date(Date.now() + Math.floor(queueIndex * 60_000 / rate)).toISOString();
      queueIndex += 1;
      const vars = {
        ...campaign.template_vars,
        customer_name: item.customer.name || "عميلنا العزيز",
        customer_city: item.customer.city || "",
      };
      const templateOptions = isCampaignOfferTemplate(campaign.template_name)
        ? buildCampaignCloudTemplateOptions({
            campaignId: campaign.id,
            media: campaign.media,
            orderUrl: campaign.order_url!,
            templateName: campaign.template_name,
          })
        : undefined;
      const job = jobs.enqueue({
        ownerUid: campaign.owner_uid,
        eventKey: `campaign:${campaign.id}:${item.phone}`,
        recipientPhone: item.phone,
        templateName: campaign.template_name,
        payload: { vars, ...(templateOptions ? { templateOptions } : {}) },
        role: "customer",
        kind: "whatsapp_template",
        channel: "whatsapp",
        maxAttempts: 5,
        expiresInMinutes: deliveryWindowMinutes + 24 * 60,
        availableAt,
        campaignId: campaign.id,
        campaignRecipientId: String(recipient.id),
      });
      database.prepare(
        `UPDATE communication_campaign_recipients SET status = 'queued', job_id = ?, updated_at = ?
         WHERE id = ? AND status = 'eligible'`,
      ).run(job.id, nowIso(), recipient.id);
    }
    const now = nowIso();
    database.prepare(
      `UPDATE communication_campaigns SET status = 'running', scheduled_at = NULL,
       started_at = COALESCE(started_at, ?), updated_at = ?
       WHERE owner_uid = ? AND id = ? AND status IN ('draft','scheduled','paused')`,
    ).run(now, now, campaign.owner_uid, campaign.id);
    const current = withStats(get(campaign.owner_uid, campaign.id)!);
    if (current.stats.queued + current.stats.processing + current.stats.retry === 0) {
      const doneAt = nowIso();
      database.prepare(
        `UPDATE communication_campaigns SET status = 'completed', completed_at = ?, updated_at = ?
         WHERE owner_uid = ? AND id = ? AND status = 'running'`,
      ).run(doneAt, doneAt, campaign.owner_uid, campaign.id);
      return withStats(get(campaign.owner_uid, campaign.id)!);
    }
    return current;
  })();

  const launch = (ownerUid: string, campaignId: string, scheduledAt?: string | null) => {
    const campaign = get(ownerUid, campaignId);
    if (!campaign) return null;
    if (!["draft", "scheduled", "paused"].includes(campaign.status)) return withStats(campaign);
    const timestamp = scheduledAt ? Date.parse(scheduledAt) : NaN;
    if (Number.isFinite(timestamp) && timestamp > Date.now()) {
      const iso = new Date(timestamp).toISOString();
      database.prepare(
        `UPDATE communication_campaigns SET status = 'scheduled', scheduled_at = ?, updated_at = ?
         WHERE owner_uid = ? AND id = ?`,
      ).run(iso, nowIso(), ownerUid, campaignId);
      return withStats(get(ownerUid, campaignId)!);
    }
    return materialize(campaign);
  };

  const scheduleWeekFollowup = (
    ownerUid: string,
    campaignId: string,
    recipientPhone: string,
    requestedAt = new Date(),
  ) => {
    const campaign = get(ownerUid, campaignId);
    if (
      !campaign
      || !isCampaignOfferTemplate(campaign.template_name)
      || campaignButtonPresetForTemplate(campaign.template_name) !== "order_reminder"
    ) {
      return { scheduled: false as const, reason: "campaign_reminder_unavailable" };
    }
    if (campaign.status === "cancelled") {
      return { scheduled: false as const, reason: "campaign_cancelled" };
    }
    const phone = normalizePhoneDigits(recipientPhone);
    const gate = preferences.marketingEligibility(ownerUid, phone, "whatsapp");
    if (!gate.eligible) {
      return { scheduled: false as const, reason: gate.reason || "not_eligible" };
    }
    const recipient = database.prepare(
      `SELECT c.name
       FROM communication_campaign_recipients r
       LEFT JOIN customers c ON c.owner_uid = r.owner_uid AND c.id = r.customer_id
       WHERE r.owner_uid = ? AND r.campaign_id = ? AND r.phone = ?
       ORDER BY r.created_at DESC LIMIT 1`,
    ).get(ownerUid, campaignId, phone) as { name?: string } | undefined;
    const imported = database.prepare(
      `SELECT name FROM communication_campaign_audience
       WHERE owner_uid = ? AND campaign_id = ? AND phone = ? LIMIT 1`,
    ).get(ownerUid, campaignId, phone) as { name?: string } | undefined;
    const vars = {
      ...campaign.template_vars,
      customer_name: recipient?.name || imported?.name || "عميلنا العزيز",
    };
    const templateOptions = buildCampaignCloudTemplateOptions({
      campaignId,
      media: campaign.media,
      orderUrl: campaign.order_url!,
      templateName: campaign.template_name,
    });
    const active = database.prepare(
      `SELECT id, available_at FROM communication_jobs
       WHERE owner_uid = ? AND campaign_id = ? AND recipient_phone = ?
         AND kind = 'whatsapp_campaign_followup'
         AND status IN ('pending', 'retry', 'processing')
       ORDER BY created_at DESC LIMIT 1`,
    ).get(ownerUid, campaignId, phone) as {
      id?: string;
      available_at?: string;
    } | undefined;
    if (active?.id) {
      return {
        scheduled: true as const,
        created: false,
        dueAt: String(active.available_at || ""),
        jobId: active.id,
      };
    }
    const dueAt = new Date(requestedAt.getTime() + 7 * 24 * 60 * 60_000).toISOString();
    const requestDay = requestedAt.toISOString().slice(0, 10);
    const eventKey = `campaign-followup:${campaignId}:${phone}:${requestDay}`;
    const existing = database.prepare(
      "SELECT id FROM communication_jobs WHERE owner_uid = ? AND event_key = ? LIMIT 1",
    ).get(ownerUid, eventKey) as { id?: string } | undefined;
    const job = jobs.enqueue({
      ownerUid,
      eventKey,
      recipientPhone: phone,
      templateName: campaign.template_name,
      payload: {
        vars,
        templateOptions,
        campaignFollowup: true,
        requestedAt: requestedAt.toISOString(),
      },
      role: "customer",
      kind: "whatsapp_campaign_followup",
      channel: "whatsapp",
      maxAttempts: 5,
      expiresInMinutes: 8 * 24 * 60,
      availableAt: dueAt,
      campaignId,
    });
    return {
      scheduled: true as const,
      created: !existing?.id,
      dueAt: job.available_at,
      jobId: job.id,
    };
  };

  const setStatus = (ownerUid: string, campaignId: string, next: "paused" | "running" | "cancelled") => {
    const campaign = get(ownerUid, campaignId);
    if (!campaign) return null;
    if (next === "paused" && campaign.status !== "running") return withStats(campaign);
    if (next === "running" && campaign.status !== "paused") return withStats(campaign);
    const now = nowIso();
    database.prepare(
      "UPDATE communication_campaigns SET status = ?, updated_at = ? WHERE owner_uid = ? AND id = ?",
    ).run(next, now, ownerUid, campaignId);
    if (next === "cancelled") {
      database.prepare(
        `UPDATE communication_jobs SET status = 'blocked', last_error = 'campaign_cancelled',
         lease_until = NULL, updated_at = ? WHERE owner_uid = ? AND campaign_id = ?
         AND status IN ('pending','retry')`,
      ).run(now, ownerUid, campaignId);
      database.prepare(
        `UPDATE communication_campaign_recipients SET status = 'cancelled',
         skip_reason = 'campaign_cancelled', updated_at = ?
         WHERE owner_uid = ? AND campaign_id = ? AND status IN ('eligible','queued','retry')`,
      ).run(now, ownerUid, campaignId);
    }
    return withStats(get(ownerUid, campaignId)!);
  };

  const activateDue = () => {
    const due = database.prepare(
      `SELECT owner_uid, id FROM communication_campaigns
       WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ?
       ORDER BY scheduled_at ASC LIMIT 10`,
    ).all(nowIso()) as Array<{ owner_uid: string; id: string }>;
    return due.map((item) => launch(item.owner_uid, item.id));
  };

  const guardJob = (job: CommunicationJob) => {
    if (!job.campaign_id) return { action: "send" as const };
    const campaign = get(job.owner_uid, job.campaign_id);
    if (!campaign) return { action: "block" as const, reason: "campaign_missing" };
    if (job.kind === "whatsapp_campaign_followup" && job.payload.campaignFollowup === true) {
      if (campaign.status === "cancelled") {
        return { action: "block" as const, reason: "campaign_cancelled" };
      }
      const gate = preferences.marketingEligibility(job.owner_uid, job.recipient_phone, "whatsapp");
      if (!gate.eligible) {
        return { action: "block" as const, reason: gate.reason || "not_eligible" };
      }
      return { action: "send" as const };
    }
    if (campaign.status === "paused" || campaign.status === "scheduled") {
      return { action: "defer" as const, reason: `campaign_${campaign.status}` };
    }
    if (campaign.status !== "running") {
      return { action: "block" as const, reason: `campaign_${campaign.status}` };
    }
    const gate = preferences.marketingEligibility(job.owner_uid, job.recipient_phone, "whatsapp");
    if (!gate.eligible) return { action: "block" as const, reason: gate.reason || "not_eligible" };
    return { action: "send" as const };
  };

  const updateRecipient = (job: CommunicationJob, status: string, reason?: string | null, providerMessageId?: string | null) => {
    if (!job.campaign_recipient_id || !job.campaign_id) return;
    const now = nowIso();
    database.prepare(
      `UPDATE communication_campaign_recipients SET status = ?, skip_reason = ?,
       provider_message_id = COALESCE(?, provider_message_id),
       sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END, updated_at = ?
       WHERE owner_uid = ? AND campaign_id = ? AND id = ?`,
    ).run(status, reason || null, providerMessageId || null, status, now, now, job.owner_uid, job.campaign_id, job.campaign_recipient_id);
    const pending = database.prepare(
      `SELECT COUNT(*) AS count FROM communication_campaign_recipients
       WHERE owner_uid = ? AND campaign_id = ? AND status IN ('eligible','queued','retry','processing')`,
    ).get(job.owner_uid, job.campaign_id) as { count: number };
    if (Number(pending.count || 0) === 0) {
      database.prepare(
        `UPDATE communication_campaigns SET status = 'completed', completed_at = ?, updated_at = ?
         WHERE owner_uid = ? AND id = ? AND status = 'running'`,
      ).run(now, now, job.owner_uid, job.campaign_id);
    }
  };

  const updateDeliveryStatus = (providerMessageId: string, incomingStatus: string) => {
    const recipient = database.prepare(
      `SELECT id, status FROM communication_campaign_recipients
       WHERE provider_message_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(providerMessageId) as { id: string; status: string } | undefined;
    if (!recipient) return false;
    const status = advanceMessageStatus(recipient.status, incomingStatus);
    database.prepare(
      "UPDATE communication_campaign_recipients SET status = ?, updated_at = ? WHERE id = ?",
    ).run(status, nowIso(), recipient.id);
    return true;
  };

  return {
    create,
    get,
    list,
    stats,
    preview,
    launch,
    scheduleWeekFollowup,
    setStatus,
    activateDue,
    guardJob,
    updateRecipient,
    updateDeliveryStatus,
  };
}

export const communicationCampaignStore = createCommunicationCampaignStore(
  db,
  communicationPreferenceStore,
  communicationJobStore,
);
