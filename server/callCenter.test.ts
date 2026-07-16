import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const directory = mkdtempSync(path.join(os.tmpdir(), "breexe-call-center-"));
process.env.DB_PATH = path.join(directory, "calls.db");
process.env.NODE_ENV = "test";
process.env.DATA_PROVIDER = "sqlite";

const db = (await import("./db")).default;
const {
  exportCallSelection,
  listCallCenterCalls,
  previewCallSelection,
  upsertCallContact,
} = await import("./callCenter");

test("call center filters, freezes selections, exports, and replaces placeholder contact names", (t) => {
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const ownerUid = "owner-call-center";
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO customers
      (id, owner_uid, name, phone, company, source, contact_needs_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', 'phone_call', 1, ?, ?)`,
  ).run("customer-placeholder", ownerUid, "متصل CRM 8176", "+966535848176", now, now);
  db.prepare(
    `INSERT INTO call_logs
      (id, owner_uid, provider, call_sid, from_phone, to_phone, customer_id, customer_name,
       status, missed, disposition, handled, duration_sec, created_at, updated_at)
     VALUES (?, ?, 'android', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
  ).run(
    "call-missed", ownerUid, "sid-missed", "966535848176", "966500000000",
    "customer-placeholder", "متصل CRM 8176", "no_answer", 1, "no_answer", 0, now, now,
  );
  db.prepare(
    `INSERT INTO call_logs
      (id, owner_uid, provider, call_sid, from_phone, to_phone, status, missed, disposition,
       handled, duration_sec, created_at, updated_at)
     VALUES (?, ?, 'android', ?, ?, ?, 'completed', 0, 'answered', 1, 45, ?, ?)`,
  ).run("call-answered", ownerUid, "sid-answered", "966511111111", "966500000000", now, now);

  const missed = listCallCenterCalls(ownerUid, { dispositions: ["no_answer"], page: 1, pageSize: 25 });
  assert.equal(missed.total, 1);
  assert.equal(missed.calls[0].id, "call-missed");
  assert.equal(missed.calls[0].contact_needs_name, 1);

  const preview = previewCallSelection({
    ownerUid, actorUid: "admin", action: "export", filters: { dispositions: ["no_answer"] },
  });
  assert.equal(preview.count, 1);
  assert.equal(preview.sample[0].id, "call-missed");
  const csv = exportCallSelection({ ownerUid, actorUid: "admin", selectionId: preview.selectionId, format: "csv" });
  assert.match(csv.filename, /breexe-calls-\d{4}-\d{2}-\d{2}\.csv/);
  assert.match(csv.body, /966535848176/);

  const contact = upsertCallContact({
    ownerUid, actorUid: "admin", callId: "call-missed", name: "عميل الاختبار الحقيقي",
    phone: "0535848176", company: "BreeXe QA",
  });
  assert.equal(contact.name, "عميل الاختبار الحقيقي");
  const updated = listCallCenterCalls(ownerUid, { q: "عميل الاختبار", page: 1, pageSize: 25 });
  assert.equal(updated.total, 1);
  assert.equal(updated.calls[0].customer_name, "عميل الاختبار الحقيقي");
  assert.equal(updated.calls[0].contact_needs_name, 0);
});
