import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("mobile devices preserve partial settings and reject personal or cross-device call data", async () => {
  const dbPath = path.join(os.tmpdir(), `golden-mobile-platform-${process.pid}-${Date.now()}.db`);
  process.env.DB_PATH = dbPath;
  let openedDb: { close: () => void } | null = null;
  try {
    const [{ default: db }, mobile] = await Promise.all([import("./db"), import("./mobilePlatform")]);
    openedDb = db;
    const ownerUid = "mobile-owner";
    const deviceId = "device-primary";
    const userUid = "employee-1";
    const workSimKey = "w".repeat(43);
    const personalSimKey = "p".repeat(43);
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO users (id, uid, name, password_hash, role, active)
       VALUES (?, ?, 'Employee', 'not-used', 'sales', 1)`,
    ).run(userUid, userUid);
    db.prepare(
      `INSERT INTO gateway_devices
        (id, owner_uid, name, company_number, token_hash, assigned_user_uid, branch_id,
         management_mode, work_sim_key, capabilities_json, created_at)
       VALUES (?, ?, 'Company phone', '+966500000000', 'hash', ?, 'riyadh',
         'company', ?, '{"callerId":true}', ?)`,
    ).run(deviceId, ownerUid, userUid, workSimKey, now);
    db.prepare(
      `INSERT INTO mobile_device_sims
        (id, owner_uid, device_id, sim_key, slot_index, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 1, ?, ?)`,
    ).run("sim-work", ownerUid, deviceId, workSimKey, now, now);

    const updated = mobile.updateMobileDevice(ownerUid, "admin-1", deviceId, { branchId: "jeddah" });
    assert.equal(updated.branch_id, "jeddah");
    assert.equal(updated.management_mode, "company");
    assert.equal(updated.assigned_user_uid, userUid);
    assert.equal(updated.work_sim_key, workSimKey);
    assert.deepEqual(updated.capabilities, { callerId: true });

    const dialCommand = mobile.createMobileCommand({
      ownerUid,
      actorUid: "admin-1",
      deviceId,
      type: "dial_request",
      payload: { phone: "0535848176", customerName: "Test customer" },
    });
    assert.equal(dialCommand.payload.workSimKey, workSimKey);
    assert.equal(dialCommand.payload.workSimSlotIndex, 0);
    assert.equal(dialCommand.payload.phone, "966535848176");
    db.prepare("UPDATE gateway_devices SET work_sim_key = NULL WHERE owner_uid = ? AND id = ?").run(ownerUid, deviceId);
    assert.throws(() => mobile.createMobileCommand({
      ownerUid,
      actorUid: "admin-1",
      deviceId,
      type: "dial_request",
      payload: { phone: "0535848176" },
    }), /شريحة العمل/);
    db.prepare("UPDATE gateway_devices SET work_sim_key = ? WHERE owner_uid = ? AND id = ?").run(workSimKey, ownerUid, deviceId);

    const device = { id: deviceId, owner_uid: ownerUid } as never;
    assert.equal(mobile.selectDeviceWorkSim(device, workSimKey).work_sim_key, workSimKey);
    assert.throws(() => mobile.selectDeviceWorkSim(device, personalSimKey), /غير موجودة/);
    const [personal] = await mobile.processMobileEventBatch(device, [{
      schemaVersion: 1,
      eventId: "personal-call-001",
      type: "answered",
      simKey: personalSimKey,
      occurredAt: now,
      payload: { from: "+966535848176", callSid: "private-call" },
    }]);
    assert.equal(personal.status, "ignored");
    const storedPersonal = db.prepare(
      "SELECT payload FROM mobile_events WHERE owner_uid = ? AND device_id = ? AND event_id = ?",
    ).get(ownerUid, deviceId, "personal-call-001") as { payload: string };
    assert.equal(storedPersonal.payload, "{}");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM call_logs WHERE owner_uid = ?").get(ownerUid) as { count: number }).count, 0);

    db.prepare(
      `INSERT INTO call_logs (id, owner_uid, call_sid, device_id, status, created_at, updated_at)
       VALUES ('other-call', ?, 'other-device-call', 'device-other', 'answered', ?, ?)`,
    ).run(ownerUid, now, now);
    const [crossDevice] = await mobile.processMobileEventBatch(device, [{
      schemaVersion: 1,
      eventId: "outcome-cross-001",
      type: "call_outcome",
      simKey: workSimKey,
      occurredAt: now,
      payload: { callSid: "other-device-call", outcome: "contacted" },
    }]);
    assert.equal(crossDevice.status, "failed");
    const untouched = db.prepare("SELECT outcome FROM call_logs WHERE id = 'other-call'").get() as { outcome: string | null };
    assert.equal(untouched.outcome, null);
  } finally {
    openedDb?.close();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
  }
});
