import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {
  TIKTOK_ATTRIBUTION_SCHEMA_SQL,
  claimNextAttributionEvent,
  enqueueAttributionEvent,
  markAttributionEventSent,
  normalizeSaudiPhone,
  parseAttributionReference,
  sha256Phone,
  upsertAttributionSession,
} from "./tiktokAttributionStorage";

function memoryDatabase() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(TIKTOK_ATTRIBUTION_SCHEMA_SQL);
  return database;
}

test("a consented click is stored once and preserves its first TikTok identifiers", () => {
  const database = memoryDatabase();
  const first = upsertAttributionSession(database, {
    reference: "0123456789ABCDEF",
    ownerUid: "owner-a",
    ttclid: "first-click-id",
    landingPath: "/landing-ac",
    clientIp: "203.0.113.4",
    userAgent: "test-browser",
    now: "2026-07-21T10:00:00.000Z",
  });
  const second = upsertAttributionSession(database, {
    reference: "0123456789ABCDEF",
    ownerUid: "owner-a",
    ttclid: "replacement-must-not-win",
    landingPath: "/landing-ac",
    now: "2026-07-21T10:01:00.000Z",
  });
  assert.equal(first.ttclid, "first-click-id");
  assert.equal(second.ttclid, "first-click-id");
  assert.equal(second.client_ip, "203.0.113.4");
  assert.equal(second.last_seen_at, "2026-07-21T10:01:00.000Z");
  database.close();
});

test("WhatsApp references are strict and phone matching uses SHA-256 E.164", () => {
  assert.equal(parseAttributionReference("أرغب بعرض سعر\n\nمرجع الطلب:\n0123456789ABCDEF"), "0123456789ABCDEF");
  assert.equal(parseAttributionReference("مرجع الطلب: short"), null);
  assert.equal(normalizeSaudiPhone("055 123 4567"), "+966551234567");
  assert.match(sha256Phone("055 123 4567") || "", /^[a-f0-9]{64}$/);
});

test("the event outbox is idempotent, leased once, and records delivery", () => {
  const database = memoryDatabase();
  upsertAttributionSession(database, {
    reference: "FEDCBA9876543210",
    ownerUid: "owner-a",
    ttclid: "click-123456",
    landingPath: "/landing-ac",
    now: "2026-07-21T10:00:00.000Z",
  });
  const input = {
    eventId: "wa-contact:message-one",
    ownerUid: "owner-a",
    reference: "FEDCBA9876543210",
    eventName: "Contact" as const,
    source: "whatsapp" as const,
    phone: "0551234567",
    occurredAt: "2026-07-21T10:01:00.000Z",
  };
  assert.equal(enqueueAttributionEvent(database, input).created, true);
  assert.equal(enqueueAttributionEvent(database, input).created, false);
  const claimed = claimNextAttributionEvent(database, "2026-07-21T10:02:00.000Z");
  assert.ok(claimed);
  assert.equal(claimed.event_name, "Contact");
  assert.equal(claimed.ttclid, "click-123456");
  assert.equal(claimNextAttributionEvent(database, "2026-07-21T10:02:00.000Z"), null);
  markAttributionEventSent(database, claimed.event_id, "request-ok", "2026-07-21T10:02:05.000Z");
  const stored = database.prepare("SELECT status, attempts, response_code FROM marketing_attribution_events").get() as Record<string, unknown>;
  assert.deepEqual(stored, { status: "sent", attempts: 1, response_code: "request-ok" });
  database.close();
});
