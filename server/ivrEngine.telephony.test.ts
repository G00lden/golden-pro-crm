import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const tempDir = mkdtempSync(path.join(tmpdir(), "golden-crm-telephony-"));
process.env.DB_PATH = path.join(tempDir, "telephony-test.db");
process.env.PUBLIC_BASE_URL = "https://crm.example.com";
process.env.TELEPHONY_WEBHOOK_SECRET = "test-webhook-secret";

const {
  buildGreeting,
  createDepartment,
  getCallBySid,
  getTelephonyReadiness,
  pickAgentRoundRobin,
  upsertTelephonyConfig,
} = await import("./ivrEngine");
const { default: db } = await import("./db");

after(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

test("disabled IVR returns a polite announcement without recording or routing the call", () => {
  const ownerUid = "disabled-owner";
  upsertTelephonyConfig(ownerUid, { enabled: false, main_number: "966533971168" });

  const instructions = buildGreeting(
    ownerUid,
    { callSid: "disabled-call", from: "+966500000001", to: "+966533971168", raw: {} },
    "https://crm.example.com",
  );

  assert.deepEqual(instructions.map((instruction) => instruction.action), ["say", "hangup"]);
  assert.equal(getCallBySid("disabled-call"), null);
});

test("round-robin never falls back to an inactive specialist", () => {
  const department = createDepartment("inactive-owner", {
    digit: "1",
    name: "المبيعات",
    agents: [{ name: "موظف متوقف", phone: "966500000002", active: false }],
  });

  assert.equal(pickAgentRoundRobin(department), null);
});

test("round-robin ignores an active specialist with an invalid phone", () => {
  const department = createDepartment("invalid-phone-owner", {
    digit: "2",
    name: "الصيانة",
    agents: [{ name: "رقم ناقص", phone: "123", active: true }],
  });

  assert.equal(pickAgentRoundRobin(department), null);
});

test("readiness is true only when the real call path is complete", () => {
  const ownerUid = "ready-owner";
  upsertTelephonyConfig(ownerUid, { enabled: true, main_number: "966533971168" });
  createDepartment(ownerUid, {
    digit: "1",
    name: "المبيعات",
    agents: [{ name: "أحمد", phone: "0550000003", active: true }],
  });

  const readiness = getTelephonyReadiness(ownerUid);

  assert.equal(readiness.ready, true);
  assert.equal(readiness.active_departments, 1);
  assert.equal(readiness.reachable_agents, 1);
  assert.deepEqual(readiness.uncovered_departments, []);
  assert.equal(readiness.ivr_webhook_url, "https://crm.example.com/webhooks/telephony/ivr");
});

test("readiness rejects a LAN callback URL even when departments are configured", () => {
  const previous = process.env.PUBLIC_BASE_URL;
  process.env.PUBLIC_BASE_URL = "http://192.168.8.122";
  try {
    const readiness = getTelephonyReadiness("ready-owner");
    assert.equal(readiness.ready, false);
    assert.equal(readiness.checks.find((check) => check.id === "public_url")?.ready, false);
  } finally {
    process.env.PUBLIC_BASE_URL = previous;
  }
});
