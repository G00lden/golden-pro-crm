import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { createCommunicationCampaignStore } from "./communicationCampaigns";
import { createCommunicationJobStore } from "./communicationJobs";
import { createCommunicationPreferenceStore } from "./communicationPreferences";

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
      rate_limit_per_minute INTEGER, frequency_cap_days INTEGER, created_by TEXT,
      started_at TEXT, completed_at TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE communication_campaign_recipients (
      id TEXT PRIMARY KEY, campaign_id TEXT, owner_uid TEXT, customer_id TEXT,
      phone TEXT, status TEXT, skip_reason TEXT, job_id TEXT, provider_message_id TEXT,
      sent_at TEXT, created_at TEXT, updated_at TEXT, UNIQUE(campaign_id, phone)
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
