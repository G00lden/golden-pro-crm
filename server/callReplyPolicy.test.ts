import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("call reply policy is fail-closed, SIM-scoped and supports specific/all-except/all", async () => {
  const dbPath = path.join(os.tmpdir(), `golden-call-policy-${process.pid}-${Date.now()}.db`);
  process.env.DB_PATH = dbPath;
  process.env.COMPANY_NAME = "BreeXe Test";
  let openedDb: { close: () => void } | null = null;
  try {
    const [{ default: db }, policy] = await Promise.all([import("./db"), import("./callReplyPolicy")]);
    openedDb = db;
    const owner = "policy-owner";
    const device = "device-1";
    const sim = "a".repeat(43);
    db.prepare(
      `INSERT INTO gateway_devices (id, owner_uid, name, company_number, token_hash, created_at)
       VALUES (?, ?, 'جوال العمل', '+966500000000', 'hash', ?)`,
    ).run(device, owner, new Date().toISOString());
    db.prepare(
      `INSERT INTO mobile_device_sims
        (id, owner_uid, device_id, sim_key, slot_index, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 1, ?, ?)`,
    ).run("sim-1", owner, device, sim, new Date().toISOString(), new Date().toISOString());

    assert.equal(policy.evaluateCallReplyRecipient(owner, "+966535848176").reason, "policy_disabled");
    const specific = policy.saveCallReplyPolicy(owner, "admin", {
      enabled: true,
      mode: "specific",
      selectedDeviceId: device,
      selectedSimKey: sim,
      version: 0,
      insideHoursMessage: "رسالة مخصصة داخل الدوام للاختبار.",
      afterHoursMessage: "رسالة مخصصة خارج الدوام للاختبار.",
      numbers: [{ phone: "0535848176", label: "رقم التجربة" }],
    });
    assert.equal(specific.version, 1);
    assert.equal(specific.insideHoursMessage, "رسالة مخصصة داخل الدوام للاختبار.");
    assert.equal(policy.evaluateCallReplyRecipient(owner, "+966535848176").allowed, true);
    assert.equal(policy.evaluateCallReplyRecipient(owner, "+966500000001").reason, "recipient_not_selected");
    const specificAudit = db.prepare(
      "SELECT before_data, after_data FROM audit_logs WHERE owner_uid = ? AND action = 'mobile.call_reply_policy.updated' ORDER BY created_at DESC LIMIT 1",
    ).get(owner) as { before_data: string; after_data: string };
    assert.equal(specificAudit.before_data.includes("966535848176"), false);
    assert.equal(specificAudit.after_data.includes("966535848176"), false);
    assert.equal(specificAudit.after_data.includes("0535848176"), false);
    assert.equal(JSON.parse(specificAudit.after_data).numberCount, 1);

    const allExcept = policy.saveCallReplyPolicy(owner, "admin", {
      enabled: true,
      mode: "all_except",
      selectedDeviceId: device,
      selectedSimKey: sim,
      version: 1,
      numbers: [{ phone: "+966535848176", label: "مستثنى" }],
    });
    assert.equal(allExcept.version, 2);
    assert.equal(allExcept.afterHoursMessage, "رسالة مخصصة خارج الدوام للاختبار.");
    assert.equal(policy.evaluateCallReplyRecipient(owner, "+966535848176").reason, "recipient_excluded");
    assert.equal(policy.evaluateCallReplyRecipient(owner, "+966500000001").allowed, true);

    assert.throws(() => policy.saveCallReplyPolicy(owner, "admin", {
      enabled: true, mode: "all", selectedDeviceId: device, selectedSimKey: sim, version: 2,
    }));
    const all = policy.saveCallReplyPolicy(owner, "admin", {
      enabled: true, mode: "all", selectedDeviceId: device, selectedSimKey: sim, version: 2,
      confirmationPhrase: "فتح الرد للجميع",
    });
    assert.equal(all.mode, "all");
    assert.equal(policy.evaluateCallReplySource(all, { source: "android", deviceId: device, simKey: sim }).allowed, true);
    assert.equal(policy.evaluateCallReplySource(all, { source: "android", deviceId: "personal-device", simKey: sim }).reason, "source_not_selected");
    assert.equal(policy.evaluateCallReplySource(all, { source: "unifonic" }).allowed, true);
    assert.equal(policy.evaluateCallReplySource(all, { source: "unknown-provider" }).reason, "unknown_source");
    const inHours = policy.renderCallReplyMessage("no_answer", new Date("2026-07-15T09:00:00.000Z"), all);
    const afterHours = policy.renderCallReplyMessage("after_hours", new Date("2026-07-16T20:00:00.000Z"), all);
    assert.equal(inHours, "رسالة مخصصة داخل الدوام للاختبار.");
    assert.equal(afterHours, "رسالة مخصصة خارج الدوام للاختبار.");
  } finally {
    openedDb?.close();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
  }
});
