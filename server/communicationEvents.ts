import crypto from "node:crypto";
import type Database from "better-sqlite3";
import db from "./db";

function id() {
  return `evt_${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`;
}

function hash(payload: unknown) {
  return crypto.createHash("sha256").update(JSON.stringify(payload ?? null)).digest("hex");
}

export function createCommunicationEventStore(database: Database.Database) {
  const begin = (input: { ownerUid: string; provider: string; eventId: string; eventType?: string; payload?: unknown }) => {
    if (!input.eventId) return false;
    const result = database.prepare(
      `INSERT OR IGNORE INTO communication_events
       (id, owner_uid, provider, event_id, event_type, payload_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id(), input.ownerUid, input.provider, input.eventId, input.eventType || "", hash(input.payload), new Date().toISOString());
    return result.changes > 0;
  };

  const markProcessed = (ownerUid: string, provider: string, eventId: string) => {
    return database.prepare(
      "UPDATE communication_events SET processed_at = ? WHERE owner_uid = ? AND provider = ? AND event_id = ?",
    ).run(new Date().toISOString(), ownerUid, provider, eventId).changes > 0;
  };

  const release = (ownerUid: string, provider: string, eventId: string) => {
    return database.prepare(
      "DELETE FROM communication_events WHERE owner_uid = ? AND provider = ? AND event_id = ? AND processed_at IS NULL",
    ).run(ownerUid, provider, eventId).changes > 0;
  };

  return { begin, markProcessed, release };
}

export const communicationEventStore = createCommunicationEventStore(db);
