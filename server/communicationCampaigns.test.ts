import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { createCommunicationCampaignStore } from "./communicationCampaigns";
import { createCommunicationJobStore } from "./communicationJobs";
import { createCommunicationPreferenceStore } from "./communicationPreferences";

process.env.WHATSAPP_CAMPAIGN_ORDER_URL_PREFIX = "https://goldenksa.store/";

function system() {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE customers (
      id TEXT PRIMARY KEY, owner_uid TEXT, name TEXT, phone TEXT, city TEXT,
      source TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE communication_preferences (
      owner_uid TEXT, phone TEXT, channel TEXT, purpose TEXT, status TEXT,
      source TEXT, evidence TEXT, captured_at TEXT, created_at TEXT, updated_at TEXT,
      PRIMARY KEY(owner_uid, phone, channel, purpose)
    );
    CREATE TABLE communication_suppressions (
      id TEXT PRIMARY KEY, owner_uid TEXT, phone TEXT, channel TEXT, reason TEXT,
      source TEXT, active INTEGER, created_at TEXT, lifted_at TEXT, updated_at TEXT
    );
    CREATE UNIQUE INDEX active_suppression
      ON communication_suppressions(owner_uid, phone, channel) WHERE active = 1;
    CREATE TABLE communication_campaigns (
      id TEXT PRIMARY KEY, owner_uid TEXT, name TEXT, channel TEXT, template_name TEXT,
      status TEXT, audience_filter TEXT, template_vars TEXT, scheduled_at TEXT,
      media_type TEXT, media_url TEXT, order_url TEXT,
      rate_limit_per_minute INTEGER, frequency_cap_days INTEGER, created_by TEXT,
      started_at TEXT, completed_at TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE communication_campaign_recipients (
      id TEXT PRIMARY KEY, campaign_id TEXT, owner_uid TEXT, customer_id TEXT,
      phone TEXT, status TEXT, skip_reason TEXT, job_id TEXT, provider_message_id TEXT,
      sent_at TEXT, created_at TEXT, updated_at TEXT, UNIQUE(campaign_id, phone)
    );
    CREATE TABLE communication_campaign_audience (
      id TEXT PRIMARY KEY, campaign_id TEXT, owner_uid TEXT, phone TEXT, name TEXT,
      created_at TEXT, UNIQUE(campaign_id, phone)
    );
    CREATE TABLE communication_jobs (
      id TEXT PRIMARY KEY, owner_uid TEXT NOT NULL, event_key TEXT NOT NULL,
      kind TEXT NOT NULL, channel TEXT NOT NULL, recipient_phone TEXT NOT NULL,
      template_name TEXT, payload TEXT NOT NULL, role TEXT, call_id TEXT,
      campaign_id TEXT, campaign_recipient_id TEXT, status TEXT NOT NULL,
      attempts INTEGER NOT NULL, max_attempts INTEGER NOT NULL,
      available_at TEXT NOT NULL, lease_until TEXT, last_error TEXT,
      provider_message_id TEXT, expires_at TEXT, sent_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(owner_uid, event_key)
    );
  `);
  const preferences = createCommunicationPreferenceStore(database);
  const jobs = createCommunicationJobStore(database);
  const campaigns = createCommunicationCampaignStore(database, preferences, jobs);
  return { database, preferences, jobs, campaigns };
}

function customer(database: Database.Database, id: string, phone: string, city = "الرياض") {
  database.prepare(
    "INSERT INTO customers (id, owner_uid, name, phone, city, source) VALUES (?, 'o1', ?, ?, ?, 'manual')",
  ).run(id, `Customer ${id}`, phone, city);
}

test("campaign preview excludes missing consent and active suppressions", () => {
  const { database, preferences, campaigns } = system();
  customer(database, "c1", "0501234567");
  customer(database, "c2", "0501234568");
  customer(database, "c3", "0501234569");
  preferences.setPreference({ ownerUid: "o1", phone: "0501234567", status: "granted", evidence: "form" });
  preferences.setPreference({ ownerUid: "o1", phone: "0501234568", status: "granted", evidence: "form" });
  preferences.suppress({ ownerUid: "o1", phone: "0501234568", evidence: "STOP" });

  const campaign = campaigns.create({
    ownerUid: "o1",
    name: "Riyadh offer",
    templateName: "general_reminder",
    audienceFilter: { allCustomers: true },
    templateVars: { message: "Offer" },
  });
  const preview = campaigns.preview("o1", campaign.id)!;
  assert.equal(preview.audience, 3);
  assert.equal(preview.eligible, 1);
  assert.deepEqual(preview.excluded, { suppressed: 1, consent_missing: 1 });

  const launched = campaigns.launch("o1", campaign.id)!;
  assert.equal(launched.status, "running");
  assert.equal(launched.stats.queued, 1);
  assert.equal(launched.stats.skipped, 2);
  database.close();
});

test("consent is checked again immediately before a queued campaign send", () => {
  const { database, preferences, jobs, campaigns } = system();
  customer(database, "c1", "0501234567");
  preferences.setPreference({ ownerUid: "o1", phone: "0501234567", status: "granted", evidence: "form" });
  const campaign = campaigns.create({
    ownerUid: "o1",
    name: "Safe campaign",
    templateName: "general_reminder",
    audienceFilter: { allCustomers: true },
  });
  campaigns.launch("o1", campaign.id);
  const job = jobs.claimNext()!;
  assert.deepEqual(campaigns.guardJob(job), { action: "send" });
  preferences.suppress({ ownerUid: "o1", phone: job.recipient_phone, evidence: "STOP" });
  assert.deepEqual(campaigns.guardJob(job), { action: "block", reason: "suppressed" });
  database.close();
});

test("paused campaigns defer work and scheduled campaigns activate when due", () => {
  const { database, preferences, jobs, campaigns } = system();
  customer(database, "c1", "0501234567");
  preferences.setPreference({ ownerUid: "o1", phone: "0501234567", status: "granted", evidence: "form" });
  const campaign = campaigns.create({
    ownerUid: "o1",
    name: "Scheduled",
    templateName: "general_reminder",
    audienceFilter: { allCustomers: true },
  });
  const scheduled = campaigns.launch("o1", campaign.id, new Date(Date.now() + 60_000).toISOString())!;
  assert.equal(scheduled.status, "scheduled");
  assert.equal(jobs.claimNext(), null);
  database.prepare("UPDATE communication_campaigns SET scheduled_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 1_000).toISOString(), campaign.id);
  campaigns.activateDue();
  const job = jobs.claimNext()!;
  campaigns.setStatus("o1", campaign.id, "paused");
  assert.deepEqual(campaigns.guardJob(job), { action: "defer", reason: "campaign_paused" });
  database.close();
});

test("delivered and read campaign receipts still enforce the frequency cap", () => {
  const { database, preferences, campaigns } = system();
  customer(database, "c1", "0501234567");
  preferences.setPreference({ ownerUid: "o1", phone: "0501234567", status: "granted", evidence: "form" });
  database.prepare(
    `INSERT INTO communication_campaign_recipients
      (id, campaign_id, owner_uid, customer_id, phone, status, sent_at, created_at, updated_at)
     VALUES ('old-recipient', 'old-campaign', 'o1', 'c1', '966501234567', 'read', ?, ?, ?)`,
  ).run(new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
  const campaign = campaigns.create({
    ownerUid: "o1",
    name: "Frequency protected",
    templateName: "general_reminder",
    audienceFilter: { allCustomers: true },
    frequencyCapDays: 7,
  });
  const preview = campaigns.preview("o1", campaign.id)!;
  assert.equal(preview.eligible, 0);
  assert.deepEqual(preview.excluded, { frequency_cap: 1 });
  database.close();
});

test("a queued recipient reserves the frequency cap across concurrent campaigns", () => {
  const { database, preferences, campaigns } = system();
  customer(database, "c1", "0501234567");
  preferences.setPreference({ ownerUid: "o1", phone: "0501234567", status: "granted", evidence: "form" });
  const first = campaigns.create({
    ownerUid: "o1",
    name: "First queued campaign",
    templateName: "general_reminder",
    audienceFilter: { allCustomers: true },
    frequencyCapDays: 7,
  });
  const second = campaigns.create({
    ownerUid: "o1",
    name: "Second concurrent campaign",
    templateName: "general_reminder",
    audienceFilter: { allCustomers: true },
    frequencyCapDays: 7,
  });

  campaigns.launch("o1", first.id);
  const preview = campaigns.preview("o1", second.id)!;
  assert.equal(preview.eligible, 0);
  assert.deepEqual(preview.excluded, { frequency_cap: 1 });
  const launched = campaigns.launch("o1", second.id)!;
  assert.equal(launched.stats.queued, 0);
  assert.equal(launched.stats.skipped, 1);
  database.close();
});

test("media campaigns queue a Meta header plus fixed order, filter, and booking buttons", () => {
  const { database, preferences, jobs, campaigns } = system();
  customer(database, "c1", "0501234567");
  preferences.setPreference({ ownerUid: "o1", phone: "0501234567", status: "granted", evidence: "form" });
  const campaign = campaigns.create({
    ownerUid: "o1",
    name: "Filter image offer",
    templateName: "campaign_offer_image",
    audienceFilter: { allCustomers: true },
    templateVars: { offer_text: "عرض خاص على الفلاتر" },
    media: { type: "image", url: "https://cdn.example.test/filter-offer.jpg" },
    orderUrl: "https://goldenksa.store/products/filter-kit",
  });
  assert.deepEqual(campaign.media, {
    type: "image",
    url: "https://cdn.example.test/filter-offer.jpg",
  });

  const launched = campaigns.launch("o1", campaign.id)!;
  assert.equal(launched.stats.queued, 1);
  const job = jobs.claimNext()!;
  const options = job.payload.templateOptions as Record<string, any>;
  assert.deepEqual(options.header, {
    type: "image",
    link: "https://cdn.example.test/filter-offer.jpg",
  });
  assert.deepEqual(options.buttons, [
    { type: "url", index: 0, text: "products/filter-kit" },
    { type: "quick_reply", index: 1, payload: `campaign:change_filters:${campaign.id}` },
    { type: "quick_reply", index: 2, payload: `campaign:book_appointment:${campaign.id}` },
  ]);
  database.close();
});

test("an imported audience records one consent source and queues up to the campaign limit", () => {
  const { database, campaigns } = system();
  const campaign = campaigns.create({
    ownerUid: "o1",
    name: "Imported summer offer",
    templateName: "campaign_offer_text_reminder",
    audienceFilter: { importedAudience: true },
    audienceMembers: [
      { phone: "0501234567", name: "يعقوب" },
      { phone: "966501234568", name: "أحمد" },
      { phone: "0501234567", name: "مكرر" },
    ],
    audienceConsent: {
      granted: true,
      evidence: "Documented website opt-in 2026-07-28",
      source: "campaign_import",
    },
    templateVars: { offer_text: "خصم خاص هذا الأسبوع" },
    orderUrl: "https://goldenksa.store/offers/summer",
  });
  const preview = campaigns.preview("o1", campaign.id)!;
  assert.equal(preview.audience, 2);
  assert.equal(preview.eligible, 2);
  const audienceCount = database.prepare(
    "SELECT COUNT(*) AS count FROM communication_campaign_audience WHERE campaign_id=?",
  ).get(campaign.id) as { count: number };
  assert.equal(audienceCount.count, 2);
  const preferenceCount = database.prepare(
    "SELECT COUNT(*) AS count FROM communication_preferences WHERE source='campaign_import'",
  ).get() as { count: number };
  assert.equal(preferenceCount.count, 2);
  const launched = campaigns.launch("o1", campaign.id)!;
  assert.equal(launched.stats.queued, 2);
  database.close();
});

test("remind-after-week is durable, idempotent, and rechecks opt-out before sending", () => {
  const { database, preferences, jobs, campaigns } = system();
  const campaign = campaigns.create({
    ownerUid: "o1",
    name: "Reminder offer",
    templateName: "campaign_offer_image_reminder",
    audienceFilter: { importedAudience: true },
    audienceMembers: [{ phone: "0501234567", name: "يعقوب" }],
    audienceConsent: {
      granted: true,
      evidence: "WhatsApp opt-in",
    },
    templateVars: { offer_text: "عرض خاص" },
    media: { type: "image", url: "https://cdn.example.test/offer.jpg" },
    orderUrl: "https://goldenksa.store/offers/filter",
  });
  database.prepare("UPDATE communication_campaigns SET status='completed' WHERE id=?").run(campaign.id);
  const now = new Date("2026-07-28T12:00:00.000Z");
  const first = campaigns.scheduleWeekFollowup("o1", campaign.id, "0501234567", now);
  const second = campaigns.scheduleWeekFollowup("o1", campaign.id, "0501234567", now);
  assert.equal(first.scheduled, true);
  assert.equal(first.created, true);
  assert.equal(first.dueAt, "2026-08-04T12:00:00.000Z");
  assert.equal(second.scheduled, true);
  assert.equal(second.created, false);
  const followupCount = database.prepare(
    "SELECT COUNT(*) AS count FROM communication_jobs WHERE kind='whatsapp_campaign_followup'",
  ).get() as { count: number };
  assert.equal(followupCount.count, 1);
  database.prepare(
    "UPDATE communication_jobs SET available_at=?, expires_at=? WHERE id=?",
  ).run(
    new Date(Date.now() - 1_000).toISOString(),
    new Date(Date.now() + 60_000).toISOString(),
    first.jobId,
  );
  const job = jobs.claimNext()!;
  assert.equal(job.kind, "whatsapp_campaign_followup");
  assert.deepEqual(campaigns.guardJob(job), { action: "send" });
  database.prepare(
    "UPDATE communication_jobs SET status='sent', lease_until=NULL WHERE id=?",
  ).run(first.jobId);
  const repeat = campaigns.scheduleWeekFollowup(
    "o1",
    campaign.id,
    "0501234567",
    new Date("2026-08-04T12:00:00.000Z"),
  );
  assert.equal(repeat.scheduled, true);
  assert.equal(repeat.created, true);
  assert.equal(repeat.dueAt, "2026-08-11T12:00:00.000Z");
  const repeatedFollowupCount = database.prepare(
    "SELECT COUNT(*) AS count FROM communication_jobs WHERE kind='whatsapp_campaign_followup'",
  ).get() as { count: number };
  assert.equal(repeatedFollowupCount.count, 2);
  database.prepare(
    "UPDATE communication_jobs SET available_at=?, expires_at=? WHERE id=?",
  ).run(
    new Date(Date.now() - 1_000).toISOString(),
    new Date(Date.now() + 60_000).toISOString(),
    repeat.jobId,
  );
  const repeatedJob = jobs.claimNext()!;
  assert.equal(repeatedJob.id, repeat.jobId);
  preferences.suppress({ ownerUid: "o1", phone: "0501234567", evidence: "campaign opt-out" });
  assert.deepEqual(campaigns.guardJob(repeatedJob), { action: "block", reason: "suppressed" });
  database.close();
});
