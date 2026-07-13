import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const bookingsSource = readFileSync(new URL("./Bookings.tsx", import.meta.url), "utf8");
const installationsSource = readFileSync(new URL("./Installations.tsx", import.meta.url), "utf8");
const apiSource = readFileSync(new URL("../api.ts", import.meta.url), "utf8");

function sourceSection(source: string, start: string, end: string) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing section start: ${start}`);
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return source.slice(from, to);
}

test("saving a booking is separate from technician notification", () => {
  assert.equal((bookingsSource.match(/api\.notifyTechnicianBooking/g) || []).length, 1);
  assert.doesNotMatch(bookingsSource, /notifyTechnicianBooking\(bookingId/);
  assert.match(bookingsSource, /تم حفظ الحجز دون إرسال/);
  assert.match(bookingsSource, /استخدم زر إرسال الموعد للفني/);
});

test("manual booking and installation sends expose per-item locks", () => {
  assert.match(bookingsSource, /technicianNoticeLock\.acquire\(booking\.id\)/);
  assert.match(bookingsSource, /disabled=\{sendingTechnicianIds\.has\(booking\.id\)\}/);
  assert.match(installationsSource, /reminderLock\.acquire\(installation\.id\)/);
  assert.match(installationsSource, /<fieldset[\s\S]*?disabled=\{reminderPending\}[\s\S]*?aria-busy=\{reminderPending\}/);
  assert.match(installationsSource, /runDueLock\.current/);
  assert.match(installationsSource, /loading=\{runningDue\}/);
});

test("dry-run outcomes are described as simulation rather than delivery", () => {
  assert.match(bookingsSource, /if \(result\.simulated\)[\s\S]*?محاكاة فقط:[\s\S]*?لم تُرسل أي رسالة فعلية/);
  assert.match(installationsSource, /if \(result\.simulated\)[\s\S]*?محاكاة فقط:[\s\S]*?لم تُرسل أي رسالة/);
  assert.match(installationsSource, /else if \(result\.simulated\)[\s\S]*?لم تُرسل أي رسالة فعلية أو تتغير مرحلة الإرسال/);
  assert.match(bookingsSource, /role="status" aria-live="polite"/);
  assert.match(installationsSource, /role="status" aria-live="polite"/);
});

test("booking and reminder API actions resolve outbound mode before any prompt", () => {
  const remind = sourceSection(apiSource, "export const remindInstallation", "export const runDueReminders");
  const runDue = sourceSection(apiSource, "export const runDueReminders", "export const getTechnicians");
  const notifyTechnician = sourceSection(apiSource, "export const notifyTechnicianBooking", "export const completeBooking");

  for (const section of [remind, runDue, notifyTechnician]) {
    assert.match(section, /prepareManualOutboundAction/);
    assert.doesNotMatch(section, /requestOutboundCode\(/);
  }
});
