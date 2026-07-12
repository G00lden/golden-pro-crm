import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { createCommunicationEventStore } from "./communicationEvents";

function store() {
  const database = new Database(":memory:");
  database.exec(`CREATE TABLE communication_events (
    id TEXT PRIMARY KEY, owner_uid TEXT NOT NULL, provider TEXT NOT NULL,
    event_id TEXT NOT NULL, event_type TEXT, payload_hash TEXT, processed_at TEXT,
    created_at TEXT, UNIQUE(owner_uid, provider, event_id)
  )`);
  return { database, events: createCommunicationEventStore(database) };
}

test("provider retries are claimed once", () => {
  const { database, events } = store();
  assert.equal(events.begin({ ownerUid: "o1", provider: "meta", eventId: "wamid.1", payload: { a: 1 } }), true);
  assert.equal(events.begin({ ownerUid: "o1", provider: "meta", eventId: "wamid.1", payload: { a: 2 } }), false);
  assert.equal(events.markProcessed("o1", "meta", "wamid.1"), true);
  database.close();
});

test("an unprocessed claim can be released for a controlled retry", () => {
  const { database, events } = store();
  events.begin({ ownerUid: "o1", provider: "meta", eventId: "wamid.2" });
  assert.equal(events.release("o1", "meta", "wamid.2"), true);
  assert.equal(events.begin({ ownerUid: "o1", provider: "meta", eventId: "wamid.2" }), true);
  database.close();
});
