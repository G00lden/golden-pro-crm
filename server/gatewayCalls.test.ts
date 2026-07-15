import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("Android calls create CRM contacts, queue WhatsApp and remain idempotent", async () => {
  const dbPath = path.join(os.tmpdir(), `golden-gateway-calls-${process.pid}-${Date.now()}.db`);
  process.env.DB_PATH = dbPath;
  process.env.GATEWAY_REPLY_COOLDOWN_MIN = "10";
  let openedDb: { close: () => void } | null = null;

  try {
    const [{ default: db }, gateway] = await Promise.all([
      import("./db"),
      import("./gateway"),
    ]);
    openedDb = db;
    const ownerUid = "gateway-call-owner";
    const deviceId = "gateway-call-device";
    const simKey = "s".repeat(43);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO gateway_devices (id, owner_uid, name, company_number, token_hash, work_sim_key, created_at)
       VALUES (?, ?, 'Work phone', '+966532914371', 'hash', ?, ?)`,
    ).run(deviceId, ownerUid, simKey, now);
    db.prepare(
      `INSERT INTO mobile_device_sims
        (id, owner_uid, device_id, sim_key, slot_index, active, created_at, updated_at)
       VALUES ('gateway-call-sim', ?, ?, ?, 0, 1, ?, ?)`,
    ).run(ownerUid, deviceId, simKey, now, now);
    db.prepare(
      `INSERT INTO call_reply_policies
        (owner_uid, enabled, mode, selected_device_id, selected_sim_key, unifonic_enabled, version)
       VALUES (?, 1, 'all', ?, ?, 1, 1)`,
    ).run(ownerUid, deviceId, simKey);

    const answered = await gateway.handleGatewayEvent(ownerUid, {
      id: "android-calllog-101",
      eventId: "android-calllog-101",
      callSid: "android-calllog-101",
      type: "answered",
      disposition: "answered",
      from: "+966500001111",
      to: "+966532914371",
      occurredAt: "2026-07-15T08:00:00.000Z",
      durationSeconds: 42,
      source: "android",
      deviceId,
      simKey,
    });
    assert.equal(answered.disposition, "answered");
    assert.equal(answered.queued, true);

    const call = db.prepare("SELECT * FROM call_logs WHERE call_sid = ?").get("android-calllog-101") as Record<string, unknown>;
    assert.equal(call.status, "answered");
    assert.equal(call.duration_sec, 42);
    assert.ok(call.customer_id);
    const customerCount = db.prepare("SELECT COUNT(*) AS count FROM customers WHERE owner_uid = ?")
      .get(ownerUid) as { count: number };
    assert.equal(customerCount.count, 1);

    const answeredJob = db.prepare("SELECT * FROM communication_jobs WHERE call_id = ?").get(call.id) as Record<string, unknown>;
    assert.equal(answeredJob.template_name, "call_answered_customer");
    assert.equal(answeredJob.channel, "whatsapp");

    const duplicate = await gateway.handleGatewayEvent(ownerUid, {
      type: "answered",
      disposition: "answered",
      eventId: "android-calllog-101",
      from: "+966500001111",
    });
    assert.equal(duplicate.duplicate, true);
    const callCount = db.prepare("SELECT COUNT(*) AS count FROM call_logs WHERE owner_uid = ?")
      .get(ownerUid) as { count: number };
    assert.equal(callCount.count, 1);

    const missed = await gateway.handleGatewayEvent(ownerUid, {
      type: "no_answer",
      disposition: "no_answer",
      eventId: "android-calllog-102",
      from: "+966500002222",
      to: "+966532914371",
      source: "android",
      deviceId,
      simKey,
    });
    assert.equal(missed.disposition, "no_answer");
    assert.equal(missed.queued, true);
    const missedJob = db.prepare(
      "SELECT template_name FROM communication_jobs WHERE event_key LIKE 'missed-call:%:customer' ORDER BY created_at DESC LIMIT 1",
    ).get() as { template_name: string };
    assert.equal(missedJob.template_name, "general_reminder");

    const contacts = gateway.listPendingContacts(ownerUid, 100) as Array<{ id: string; phone: string }>;
    assert.equal(contacts.length, 2);
    assert.equal(contacts[0].phone.startsWith("+9665"), true);
    assert.equal(gateway.ackContacts(ownerUid, contacts.map((contact) => contact.id)), 2);
    assert.equal(gateway.listPendingContacts(ownerUid, 100).length, 0);
  } finally {
    openedDb?.close();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
  }
});
