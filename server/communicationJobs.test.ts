import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { createCommunicationJobStore, retryDelayMs } from "./communicationJobs";

function memoryStore() {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE communication_jobs (
      id TEXT PRIMARY KEY, owner_uid TEXT NOT NULL, event_key TEXT NOT NULL,
      kind TEXT NOT NULL, channel TEXT NOT NULL, recipient_phone TEXT NOT NULL,
      template_name TEXT, payload TEXT NOT NULL, role TEXT, call_id TEXT,
      status TEXT NOT NULL, attempts INTEGER NOT NULL, max_attempts INTEGER NOT NULL,
      available_at TEXT NOT NULL, lease_until TEXT, last_error TEXT,
      provider_message_id TEXT, expires_at TEXT, sent_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(owner_uid, event_key)
    );
  `);
  return { database, store: createCommunicationJobStore(database) };
}

test("enqueue is idempotent per owner and event key", () => {
  const { database, store } = memoryStore();
  const first = store.enqueue({ ownerUid: "o1", eventKey: "call:1:customer", recipientPhone: "0501234567", templateName: "missed_call_customer" });
  const second = store.enqueue({ ownerUid: "o1", eventKey: "call:1:customer", recipientPhone: "0509999999", templateName: "missed_call_customer" });
  assert.equal(first.id, second.id);
  assert.equal(second.recipient_phone, "966501234567");
  assert.equal((database.prepare("select count(*) n from communication_jobs").get() as { n: number }).n, 1);
  database.close();
});

test("a claimed job is leased and cannot be claimed twice", () => {
  const { database, store } = memoryStore();
  store.enqueue({ ownerUid: "o1", eventKey: "event", recipientPhone: "+966501234567", templateName: "missed_call_customer" });
  const claimed = store.claimNext();
  assert.equal(claimed?.status, "processing");
  assert.equal(claimed?.attempts, 1);
  assert.equal(store.claimNext(), null);
  database.close();
});

test("failures retry with backoff and stop at max attempts", () => {
  const { database, store } = memoryStore();
  const job = store.enqueue({ ownerUid: "o1", eventKey: "event", recipientPhone: "+966501234567", templateName: "missed_call_customer", maxAttempts: 1 });
  store.claimNext();
  const failed = store.markFailed(job.id, new Error("provider unavailable"));
  assert.equal(failed?.status, "failed");
  assert.match(failed?.last_error || "", /provider unavailable/);
  assert.equal(retryDelayMs(1), 30_000);
  assert.equal(retryDelayMs(20), 15 * 60_000);
  database.close();
});

test("queue visibility is isolated by owner and exposes actionable totals", () => {
  const { database, store } = memoryStore();
  store.enqueue({ ownerUid: "owner-a", eventKey: "a-1", recipientPhone: "0501234567", templateName: "missed_call_customer" });
  store.enqueue({ ownerUid: "owner-b", eventKey: "b-1", recipientPhone: "0501234568", templateName: "missed_call_customer" });

  assert.equal(store.listRecent("owner-a").length, 1);
  assert.equal(store.listRecent("owner-a")[0].owner_uid, "owner-a");
  assert.deepEqual(store.summary("owner-a"), {
    pending: 1,
    processing: 0,
    retry: 0,
    sent: 0,
    failed: 0,
    blocked: 0,
    expired: 0,
    waiting: 1,
    attention: 0,
    total: 1,
  });
  database.close();
});
