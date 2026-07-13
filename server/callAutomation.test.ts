import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isBusinessOpen, nextBusinessOpen, normalizeDisposition } from "./callPolicy";
import { unifonicAdapter } from "./telephony/unifonicAdapter";

const schedule = {
  timezone: "Asia/Riyadh",
  business_days: [6, 0, 1, 2, 3, 4],
  business_open: "08:00",
  business_close: "21:00",
};

test("business schedule is Saturday-Thursday 08:00-21:00 Riyadh", () => {
  assert.equal(isBusinessOpen(schedule, new Date("2026-07-18T05:00:00.000Z")), true);
  assert.equal(isBusinessOpen(schedule, new Date("2026-07-16T17:59:00.000Z")), true);
  assert.equal(isBusinessOpen(schedule, new Date("2026-07-16T18:00:00.000Z")), false);
  assert.equal(isBusinessOpen(schedule, new Date("2026-07-17T09:00:00.000Z")), false);
  assert.equal(nextBusinessOpen(schedule, new Date("2026-07-17T09:00:00.000Z")).toISOString(), "2026-07-18T05:00:00.000Z");
});

test("provider statuses preserve actionable call dispositions", () => {
  assert.equal(normalizeDisposition("no-answer"), "no_answer");
  assert.equal(normalizeDisposition("failed", "out of coverage"), "unreachable");
  assert.equal(normalizeDisposition("declined"), "rejected");
  assert.equal(normalizeDisposition("completed"), "answered");
  assert.equal(normalizeDisposition("mystery"), "unknown");

  const parsed = unifonicAdapter.parseStatus({
    callSid: "unifonic-1",
    from: "+966500000001",
    to: "+966110000000",
    duration: 17,
    status: "FAILED",
    failureReason: "out of coverage",
    completedAt: "2026-07-13T12:00:00.000Z",
  }, {});
  assert.equal(parsed.status, "unreachable");
  assert.equal(parsed.occurredAt, "2026-07-13T12:00:00.000Z");
  assert.match(parsed.eventId || "", /^unifonic-1:FAILED:/);
});

test("missed call creates one task and durable dry-run actions without false sent flags", async () => {
  const dbPath = path.join(os.tmpdir(), `golden-call-test-${process.pid}-${Date.now()}.db`);
  process.env.DB_PATH = dbPath;
  process.env.OUTBOUND_MODE = "dry_run";
  process.env.COMPANY_NAME = "شركة الاختبار";
  let openedDb: { close: () => void } | null = null;
  try {
    const [{ default: db }, ivr, automation, gateway] = await Promise.all([
      import("./db"),
      import("./ivrEngine"),
      import("./callAutomation"),
      import("./gateway"),
    ]);
    openedDb = db;
    const ownerUid = "test-owner";
    const config = ivr.upsertTelephonyConfig(ownerUid, {
      company_name: "شركة الاختبار",
      business_days: [0, 1, 2, 3, 4, 5, 6],
      business_open: "00:00",
      business_close: "23:59",
      auto_reply_enabled: true,
    });
    const instructions = ivr.buildGreeting(ownerUid, {
      callSid: "test-call-1",
      from: "0500000000",
      to: "0110000000",
      raw: { callerId: "0500000000" },
    }, "https://crm.example.com");
    assert.deepEqual(instructions.map((instruction) => instruction.action), ["say", "hangup"]);
    const stored = ivr.getCallBySid("test-call-1");
    assert.ok(stored?.id);
    const call = { id: String(stored.id) };

    const repeated = automation.prepareCallAutomation(call.id, config);
    assert.equal(repeated.prepared, true);
    await automation.drainCallActionQueue(ownerUid);

    const taskCount = (db.prepare("SELECT COUNT(*) AS count FROM crm_tasks WHERE related_type = 'call' AND related_id = ?")
      .get(call.id) as { count: number }).count;
    const actions = db.prepare("SELECT status FROM call_action_runs WHERE call_id = ? ORDER BY action_key").all(call.id) as Array<{ status: string }>;
    const storedCall = db.prepare("SELECT wa_customer_notified, wa_agent_notified, action_state FROM call_logs WHERE id = ?")
      .get(call.id) as { wa_customer_notified: number; wa_agent_notified: number; action_state: string };
    assert.equal(taskCount, 1);
    assert.equal(actions.length, 1);
    assert.deepEqual(actions.map((row) => row.status), ["dry_run"]);
    assert.equal(storedCall.wa_customer_notified, 0);
    assert.equal(storedCall.wa_agent_notified, 0);
    assert.equal(storedCall.action_state, "dry_run");

    const androidEvent = {
      eventId: "android-calllog-99",
      type: "outgoing",
      from: "0500000099",
      to: "0500000000",
      disposition: "outgoing",
      occurredAt: "2026-07-13T12:00:00.000Z",
      durationSeconds: 20,
    };
    const androidFirst = await gateway.handleGatewayEvent(ownerUid, androidEvent);
    const androidDuplicate = await gateway.handleGatewayEvent(ownerUid, androidEvent);
    assert.equal(androidFirst.action, "logged_only");
    assert.equal(androidDuplicate.callId, androidFirst.callId);
    const androidCount = (db.prepare("SELECT COUNT(*) AS count FROM call_logs WHERE owner_uid = ? AND event_id = ?")
      .get(ownerUid, androidEvent.eventId) as { count: number }).count;
    assert.equal(androidCount, 1);
  } finally {
    openedDb?.close();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
  }
});
