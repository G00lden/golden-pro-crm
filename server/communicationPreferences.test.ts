import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { createCommunicationPreferenceStore, isOptOutText } from "./communicationPreferences";

function store() {
  const database = new Database(":memory:");
  database.exec(`
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
  `);
  return { database, preferences: createCommunicationPreferenceStore(database) };
}

test("opt-out keywords are exact and tolerate Arabic hamza variants", () => {
  assert.equal(isOptOutText("إلغاء"), true);
  assert.equal(isOptOutText("الغاء الاشتراك"), true);
  assert.equal(isOptOutText("STOP"), true);
  assert.equal(isOptOutText("إلغاء موعد الصيانة"), false);
});

test("marketing eligibility fails closed without explicit consent", () => {
  const { database, preferences } = store();
  assert.deepEqual(preferences.marketingEligibility("o1", "0501234567"), {
    eligible: false,
    reason: "consent_missing",
  });
  preferences.setPreference({ ownerUid: "o1", phone: "0501234567", status: "granted", evidence: "signed form" });
  assert.deepEqual(preferences.marketingEligibility("o1", "+966501234567"), { eligible: true });
  database.close();
});

test("suppression wins over consent and is idempotent", () => {
  const { database, preferences } = store();
  preferences.setPreference({ ownerUid: "o1", phone: "0501234567", status: "granted" });
  preferences.suppress({ ownerUid: "o1", phone: "0501234567", evidence: "STOP" });
  preferences.suppress({ ownerUid: "o1", phone: "+966501234567", evidence: "STOP" });
  assert.deepEqual(preferences.marketingEligibility("o1", "0501234567"), {
    eligible: false,
    reason: "suppressed",
  });
  assert.equal((database.prepare("SELECT COUNT(*) n FROM communication_suppressions").get() as { n: number }).n, 1);
  assert.equal(preferences.getPreference("o1", "0501234567")?.status, "withdrawn");
  database.close();
});
