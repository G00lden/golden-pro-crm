import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const tempDir = mkdtempSync(path.join(tmpdir(), "golden-crm-telephony-"));
process.env.DB_PATH = path.join(tempDir, "telephony-test.db");
process.env.DATA_PROVIDER = "sqlite";
process.env.PUBLIC_BASE_URL = "https://crm.example.com";
process.env.TELEPHONY_WEBHOOK_SECRET = "test-webhook-secret";
process.env.WHATSAPP_OUTBOUND_MODE = "dry-run";

const {
  buildGreeting,
  beginTelephonyEvent,
  completeTelephonyEvent,
  createDepartment,
  getCallBySessionToken,
  getCallBySid,
  getTelephonyReadiness,
  findCustomerByPhoneRepository,
  handleCallStatus,
  handleDigit,
  listCalls,
  markCallHandled,
  pickAgentRoundRobin,
  recordCall,
  resolveTelephonyOwnerUid,
  runMissedCallFlow,
  updateCallBySid,
  upsertTelephonyConfig,
} = await import("./ivrEngine");
const { default: db } = await import("./db");

after(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

test("disabled IVR returns a polite announcement without recording or routing the call", () => {
  const ownerUid = "disabled-owner";
  upsertTelephonyConfig(ownerUid, { enabled: false, main_number: "966533971100" });

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

test("round-robin is fair and excludes a linked CRM user whose account is stopped", () => {
  const ownerUid = "active-user-owner";
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, uid, name, phone, email, password_hash, role, permissions, active, provider, workspace_owner_uid, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '', 'sales', '{}', ?, 'test', ?, ?, ?)`,
  ).run("usr_active", "agent-active", "نشط", "966500000021", "active@example.test", 1, ownerUid, now, now);
  db.prepare(
    `INSERT INTO users (id, uid, name, phone, email, password_hash, role, permissions, active, provider, workspace_owner_uid, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '', 'sales', '{}', ?, 'test', ?, ?, ?)`,
  ).run("usr_stopped", "agent-stopped", "متوقف", "966500000022", "stopped@example.test", 0, ownerUid, now, now);
  const department = createDepartment(ownerUid, {
    digit: "4",
    name: "المبيعات",
    agents: [
      { user_id: "agent-stopped", name: "متوقف", phone: "966500000022", active: true },
      { user_id: "agent-active", name: "نشط", phone: "966500000021", active: true },
      { name: "خارجي", phone: "966500000023", active: true },
    ],
  });

  const picks = [pickAgentRoundRobin(department), pickAgentRoundRobin(department), pickAgentRoundRobin(department)];
  assert.deepEqual(picks.map((agent) => agent?.phone), ["966500000021", "966500000023", "966500000021"]);
  assert.equal(picks.some((agent) => agent?.user_id === "agent-stopped"), false);
});

test("readiness is true only when the real call path is complete", () => {
  const ownerUid = "ready-owner";
  upsertTelephonyConfig(ownerUid, { enabled: true, main_number: "966533971101" });
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

test("changing the main number deactivates the old mapping and cannot steal another workspace number", () => {
  const firstOwner = "number-owner-a";
  const secondOwner = "number-owner-b";
  upsertTelephonyConfig(firstOwner, { main_number: "966500000071" });
  assert.equal(resolveTelephonyOwnerUid("+966500000071", "fallback"), firstOwner);

  upsertTelephonyConfig(firstOwner, { main_number: "966500000072" });
  assert.equal(resolveTelephonyOwnerUid("+966500000071", "fallback"), "fallback");
  assert.equal(resolveTelephonyOwnerUid("+966500000072", "fallback"), firstOwner);

  assert.throws(
    () => upsertTelephonyConfig(secondOwner, { main_number: "966500000072" }),
    (error: unknown) => (error as Error & { status?: number }).status === 409,
  );
  assert.equal(getTelephonyReadiness(secondOwner).checks.find((check) => check.id === "main_number")?.ready, false);
});

function sessionFromGreeting(ownerUid: string, from: string, to: string, providerCallSid = "") {
  const instructions = buildGreeting(
    ownerUid,
    { callSid: providerCallSid, from, to, raw: {} },
    "https://crm.example.com",
  );
  const gather = instructions[0];
  assert.equal(gather.action, "gather");
  if (gather.action !== "gather") throw new Error("Expected a gather instruction.");
  const token = decodeURIComponent(gather.responseUrl.split("/").at(-1) || "");
  const call = getCallBySessionToken(token);
  assert.ok(call);
  return { token, call, instructions };
}

test("two calls from the same phone create independent rows and opaque session tokens", () => {
  const ownerUid = "repeat-caller-owner";
  upsertTelephonyConfig(ownerUid, { enabled: true, main_number: "966533971102" });

  const first = sessionFromGreeting(ownerUid, "+966500000010", "+966533971168");
  const second = sessionFromGreeting(ownerUid, "+966500000010", "+966533971168");

  assert.notEqual(first.call.id, second.call.id);
  assert.notEqual(first.call.call_sid, second.call.call_sid);
  assert.notEqual(first.token, second.token);
  assert.equal(
    Number((db.prepare("SELECT COUNT(*) AS c FROM call_logs WHERE owner_uid = ? AND from_phone_norm = ?")
      .get(ownerUid, "966500000010") as { c: number }).c),
    2,
  );
  const stored = db.prepare("SELECT session_token_hash FROM call_logs WHERE id = ?").get(first.call.id) as { session_token_hash: string };
  assert.notEqual(stored.session_token_hash, first.token);
  assert.equal(stored.session_token_hash.length, 64);
});

test("customer matching uses the configured CRM repository adapter", async () => {
  const ownerUid = "repository-owner";
  db.prepare(
    `INSERT INTO customers (id, owner_uid, name, phone, city, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', 'manual', ?, ?)`,
  ).run("cust_repository", ownerUid, "عميل المستودع", "0550000099", new Date().toISOString(), new Date().toISOString());

  const customer = await findCustomerByPhoneRepository(ownerUid, "+966550000099");
  assert.deepEqual(customer, { id: "cust_repository", name: "عميل المستودع" });
});

test("an invalid selection retries once, then creates a general follow-up", async () => {
  const ownerUid = "invalid-menu-owner";
  upsertTelephonyConfig(ownerUid, { enabled: true, main_number: "966533971103" });
  createDepartment(ownerUid, { digit: "1", name: "المبيعات", agents: [] });
  const session = sessionFromGreeting(ownerUid, "966500000011", "966533971168");
  const callSid = String(session.call.call_sid);

  const retry = handleDigit(ownerUid, {
    callSid,
    from: "966500000011",
    to: "966533971168",
    digit: "9",
    sessionToken: session.token,
    raw: {},
  }, "https://crm.example.com");
  assert.equal(retry[0].action, "gather");

  const ended = handleDigit(ownerUid, {
    callSid,
    from: "966500000011",
    to: "966533971168",
    digit: "9",
    sessionToken: session.token,
    raw: {},
  }, "https://crm.example.com");
  assert.deepEqual(ended.map((instruction) => instruction.action), ["say", "hangup"]);
  await runMissedCallFlow(callSid);
  const updated = getCallBySid(callSid)!;
  assert.equal(updated.call_status, "no_answer");
  assert.ok(updated.task_id);
});

test("phone leads are de-duplicated for the same number and department within 30 days", () => {
  const ownerUid = "lead-dedupe-owner";
  upsertTelephonyConfig(ownerUid, { enabled: true, main_number: "966533971104" });
  createDepartment(ownerUid, {
    digit: "3",
    name: "المبيعات الجديدة",
    workflow_action: "lead",
    agents: [{ name: "وجهة مبيعات", phone: "966500000030", active: true }],
  });

  for (let index = 0; index < 2; index += 1) {
    const session = sessionFromGreeting(ownerUid, "966500000012", "966533971168");
    handleDigit(ownerUid, {
      callSid: String(session.call.call_sid),
      from: "966500000012",
      to: "966533971168",
      digit: "3",
      sessionToken: session.token,
      raw: {},
    }, "https://crm.example.com");
  }

  const result = db.prepare(
    "SELECT COUNT(*) AS c FROM crm_deals WHERE owner_uid = ? AND source = 'phone_call' AND customer_phone = ?",
  ).get(ownerUid, "966500000012") as { c: number };
  assert.equal(Number(result.c), 1);
});

test("status events and missed-call side effects remain idempotent", async () => {
  const ownerUid = "event-dedupe-owner";
  upsertTelephonyConfig(ownerUid, { enabled: true, main_number: "966533971105" });
  const callSid = "provider-event-1";
  recordCall({ ownerUid, provider: "unifonic", callSid, from: "966500000013", to: "966533971168", status: "forwarding" });
  updateCallBySid(callSid, { call_status: "forwarding", status: "forwarding" });
  const status = { callSid, from: "966500000013", to: "966533971168", status: "no_answer" as const, occurredAt: "2026-07-13T12:00:00Z", raw: { callSid, status: "no_answer" } };

  const first = beginTelephonyEvent(ownerUid, "unifonic", status);
  const duplicateWhileProcessing = beginTelephonyEvent(ownerUid, "unifonic", status);
  assert.equal(first.duplicate, false);
  assert.equal(duplicateWhileProcessing.duplicate, true);
  const handled = await handleCallStatus(status);
  completeTelephonyEvent(first.eventId, String(handled.callId || ""));
  const duplicateAfterProcessing = beginTelephonyEvent(ownerUid, "unifonic", status);
  assert.equal(duplicateAfterProcessing.duplicate, true);

  await runMissedCallFlow(callSid);
  const taskCount = db.prepare("SELECT COUNT(*) AS c FROM crm_tasks WHERE owner_uid = ? AND related_type = 'call'")
    .get(ownerUid) as { c: number };
  const messageCount = db.prepare("SELECT COUNT(*) AS c FROM communication_outbox WHERE owner_uid = ?")
    .get(ownerUid) as { c: number };
  assert.equal(Number(taskCount.c), 1);
  assert.equal(Number(messageCount.c), 1);
});

test("a WhatsApp outage queues exactly one SMS fallback", async () => {
  const ownerUid = "sms-fallback-owner";
  const previousMode = process.env.OUTBOUND_MODE;
  const previousApproval = process.env.OFFICIAL_LAUNCH_APPROVED;
  process.env.OUTBOUND_MODE = "production";
  process.env.OFFICIAL_LAUNCH_APPROVED = "true";
  try {
    const callSid = "sms-fallback-call";
    recordCall({ ownerUid, provider: "unifonic", callSid, from: "966500000024", to: "966533971168", status: "no_answer" });
    updateCallBySid(callSid, { call_status: "no_answer", missed: 1 });
    await runMissedCallFlow(callSid);
    await runMissedCallFlow(callSid);

    const job = db.prepare("SELECT dispatched_channel FROM communication_outbox WHERE owner_uid = ?")
      .get(ownerUid) as { dispatched_channel?: string };
    const sms = db.prepare("SELECT COUNT(*) AS c FROM gateway_outbox WHERE owner_uid = ?")
      .get(ownerUid) as { c: number };
    assert.equal(job.dispatched_channel, "sms");
    assert.equal(Number(sms.c), 1);
  } finally {
    if (previousMode === undefined) delete process.env.OUTBOUND_MODE;
    else process.env.OUTBOUND_MODE = previousMode;
    if (previousApproval === undefined) delete process.env.OFFICIAL_LAUNCH_APPROVED;
    else process.env.OFFICIAL_LAUNCH_APPROVED = previousApproval;
  }
});

test("ambiguous fallback matching refuses to attach a status to either repeated call", async () => {
  const ownerUid = "ambiguous-owner";
  upsertTelephonyConfig(ownerUid, { enabled: true, main_number: "966533971106" });
  sessionFromGreeting(ownerUid, "966500000014", "966533971168");
  sessionFromGreeting(ownerUid, "966500000014", "966533971168");

  const result = await handleCallStatus({
    callSid: "",
    from: "966500000014",
    to: "966533971168",
    status: "ringing",
    raw: {},
  });
  assert.equal(result.handled, false);
  assert.equal(result.reason, "ambiguous_recent_call");
});

test("late status events cannot regress a completed call", async () => {
  const ownerUid = "late-event-owner";
  const callSid = "late-call";
  recordCall({ ownerUid, provider: "unifonic", callSid, from: "966500000015", to: "966533971168", status: "completed" });
  updateCallBySid(callSid, { call_status: "completed", status: "completed" });

  const result = await handleCallStatus({ callSid, status: "ringing", raw: {} });
  assert.equal(result.ignored, true);
  assert.equal(getCallBySid(callSid)?.call_status, "completed");
});

test("completing follow-up preserves the original call lifecycle state", () => {
  const ownerUid = "followup-owner";
  const callSid = "followup-call";
  const call = recordCall({ ownerUid, provider: "unifonic", callSid, from: "966500000016", to: "966533971168", status: "no_answer" });
  updateCallBySid(callSid, { call_status: "no_answer", follow_up_status: "assigned" });

  assert.equal(markCallHandled(ownerUid, call.id, "agent-1", "completed", "تم التواصل"), true);
  const updated = getCallBySid(callSid)!;
  assert.equal(updated.call_status, "no_answer");
  assert.equal(updated.follow_up_status, "done");
  assert.equal(updated.follow_up_notes, "تم التواصل");
});

test("specialist call queries expose only rows assigned to that user", () => {
  const ownerUid = "shared-workspace-owner";
  recordCall({ ownerUid, provider: "unifonic", callSid: "scope-a", from: "966500000031", to: "966533971168" });
  recordCall({ ownerUid, provider: "unifonic", callSid: "scope-b", from: "966500000032", to: "966533971168" });
  updateCallBySid("scope-a", { assigned_user_id: "agent-a", agent_user_id: "agent-a" });
  updateCallBySid("scope-b", { assigned_user_id: "agent-b", agent_user_id: "agent-b" });

  const mine = listCalls({ ownerUid, assignedUserId: "agent-a" });
  assert.equal(mine.length, 1);
  assert.equal(mine[0].call_sid, "scope-a");
});
