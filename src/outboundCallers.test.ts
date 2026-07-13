import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(relative: string) {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

function sourceSection(source: string, start: string, end: string) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing section start: ${start}`);
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return source.slice(from, to);
}

const apiSource = read("./api.ts");
const dashboardSource = read("./pages/Dashboard.tsx");
const reminderDashboardSource = read("./components/ReminderDashboard.tsx");
const customerCareSource = read("./pages/CustomerCare.tsx");
const bookingsSource = read("./pages/Bookings.tsx");
const installationsSource = read("./pages/Installations.tsx");
const invoicesSource = read("./pages/Invoices.tsx");
const quotesSource = read("./pages/Quotes.tsx");
const consoleSource = read("./pages/WhatsAppConsole.tsx");
const storeOrdersSource = read("./pages/StoreOrders.tsx");
const reminderEngineSource = read("../server/reminderEngine.ts");
const reminderRoutesSource = read("../server/routes-reminders.ts");
const bookingNotificationsSource = read("../server/bookingNotifications.ts");
const maintenanceRoutesSource = read("../server/routes-maintenance.ts");
const storeRoutesSource = read("../server/routes-store.ts");
const whatsappRoutesSource = read("../server/routes-whatsapp.ts");
const validationSource = read("../server/validation.ts");

test("every manual outbound API reads the safe authenticated policy before prompting", () => {
  assert.match(apiSource, /getOutboundSafetyStatus[\s\S]*?\/api\/health\/details/);

  const sections = [
    sourceSection(apiSource, "export const sendQuoteWhatsApp", "/* ── Invoice helpers"),
    sourceSection(apiSource, "export const sendInvoiceWhatsApp", "/* ── Products"),
    sourceSection(apiSource, "export const remindInstallation", "export const runDueReminders"),
    sourceSection(apiSource, "export const runDueReminders", "export const getTechnicians"),
    sourceSection(apiSource, "export const notifyTechnicianBooking", "export const completeBooking"),
    sourceSection(apiSource, "export const testWhatsApp", "export const getReminderDiagnostics"),
    sourceSection(apiSource, "export const assignStoreOrderTechnician", "export type AppUserRole"),
    sourceSection(apiSource, "export const sendWhatsAppTemplateMessage", "export const getConversationByPhone"),
  ];

  for (const section of sections) {
    assert.match(section, /prepareManualOutboundAction\(getOutboundSafetyStatus/);
    assert.doesNotMatch(section, /requestOutboundCode\(/);
  }
});

test("confirmation codes reach every corresponding server send", () => {
  const sendTestSchema = sourceSection(validationSource, "export const sendTestSchema", "export const whatsappTemplateSendSchema");
  assert.match(sendTestSchema, /outboundCode:/);
  assert.match(whatsappRoutesSource, /sendText\(phone, body, \{[\s\S]*?confirmationCode: req\.body\?\.outboundCode/);
  assert.match(bookingNotificationsSource, /sendText\(technician\.phone, message, \{[\s\S]*?confirmationCode: outboundCode/);
  assert.match(maintenanceRoutesSource, /notifyTechnicianForBooking\([\s\S]*?req\.body\?\.outboundCode/);
  assert.match(storeRoutesSource, /notifyTechnicianForBooking\([\s\S]*?req\.body\?\.outboundCode/);
  assert.match(reminderEngineSource, /sendText\(inst\.customer_phone, message, \{[\s\S]*?confirmationCode: outboundCode/);
  assert.match(reminderRoutesSource, /sendReminderForInstallation\([\s\S]*?req\.body\?\.outboundCode/);
  assert.match(reminderRoutesSource, /runDueReminders\(\{[\s\S]*?outboundCode: req\.body\?\.outboundCode/);
});

test("dry-run reminders and technician pre-alerts never advance delivery state", () => {
  const dryReminder = sourceSection(
    reminderEngineSource,
    "if (isDryRunSendResult(whatsAppResult))",
    "const remindCount = Number(inst.remind_count || 0) + 1",
  );
  assert.match(dryReminder, /dry_run: true/);
  assert.match(dryReminder, /simulated: true/);
  assert.doesNotMatch(dryReminder, /last_remind_at\s*:/);
  assert.doesNotMatch(dryReminder, /await ref\.update/);

  const preAlert = sourceSection(
    bookingNotificationsSource,
    "const result = await notifyTechnicianForBooking(",
    "dispatched.push",
  );
  const guardPosition = preAlert.indexOf("if (result.dry_run)");
  const persistedPosition = preAlert.indexOf("UPDATE bookings SET technician_reminded_at");
  assert.ok(guardPosition >= 0 && guardPosition < persistedPosition, "dry-run guard must precede the delivered marker update");
  assert.match(preAlert, /if \(result\.dry_run\) \{[\s\S]*?continue;/);
});

test("all reminder UI callers branch on simulation before claiming a real send", () => {
  for (const source of [dashboardSource, reminderDashboardSource, customerCareSource]) {
    const simulation = source.indexOf("isOutboundSimulation(result)");
    const realSend = source.indexOf("تم إرسال", simulation);
    assert.ok(simulation >= 0, "simulation branch is required");
    assert.ok(realSend > simulation, "real-send wording must follow the simulation branch");
    assert.match(source, /محاكاة فقط:[\s\S]*?لم تُرسل/);
  }

  assert.match(bookingsSource, /if \(result\.simulated\)[\s\S]*?لم تُرسل أي رسالة فعلية/);
  assert.match(installationsSource, /if \(result\.simulated\)[\s\S]*?لم تُرسل أي رسالة/);
});

test("documents and WhatsApp console expose simulation without changing sent state", () => {
  assert.match(invoicesSource, /!dryRun[\s\S]*?!invoiceIsCreditNote\(invoice\)[\s\S]*?invoice\.status === "issued"[\s\S]*?returnedInvoice\?\.status !== "sent"/);
  assert.match(invoicesSource, /invoice\?: api\.Invoice \| null/);
  assert.match(invoicesSource, /invoice\.status !== "draft"/);
  assert.match(invoicesSource, /لم تُرسل للعميل ولم تتغير حالتها/);
  assert.match(quotesSource, /محاكاة إرسال عرض السعر فقط؛ لم تُرسل رسالة/);
  assert.match(consoleSource, /result\.simulated === true \|\| result\.dry_run === true/);
  assert.match(consoleSource, /api\.testWhatsApp\([\s\S]*?outboundCode\.trim\(\) \|\| undefined/);
  const assignment = sourceSection(
    apiSource,
    "export const assignStoreOrderTechnician",
    "export type AppUserRole",
  );
  assert.match(assignment, /prepareManualOutboundAction\(getOutboundSafetyStatus\)/);
  assert.match(assignment, /outboundCode: outbound\?\.outboundCode/);
  assert.match(assignment, /isOutboundSimulation\(result\.notification/);
  assert.doesNotMatch(assignment, /window\.prompt|requestOutboundCode/);
  assert.match(storeOrdersSource, /const notificationSimulated = Boolean\(result\.notification\?\.dry_run \|\| result\.notification\?\.simulated\)/);
  assert.match(storeOrdersSource, /const notificationSent = Boolean\(result\.notification\?\.success && !notificationSimulated\)/);
  assert.match(consoleSource, /تمت محاكاة الرسالة بأمان؛ لم تُرسل رسالة فعلية/);
  assert.match(storeOrdersSource, /محاكاة فقط: لم تُرسل رسالة فعلية للفني/);
});

test("invoice payment UI prevents duplicate requests and supplies an idempotency key", () => {
  assert.match(invoicesSource, /payingInvoiceIdsRef\.current\.has\(invoice\.id\)/);
  assert.match(invoicesSource, /aria-busy=\{payingInvoiceId === invoice\.id \|\| undefined\}/);
  assert.match(invoicesSource, /disabled=\{payingInvoiceId === invoice\.id \|\|/);
  assert.match(invoicesSource, /id="invoice-payment-unavailable-reason" role="status"/);
  assert.match(invoicesSource, /<span>\{paymentUnavailableMessage\}<\/span>/);
  assert.match(invoicesSource, /aria-describedby=\{paymentCapabilities\.data && !paymentCapabilities\.data\.available/);
  assert.match(invoicesSource, /بوابة الدفع غير مهيأة حاليًا\. تواصل مع مسؤول النظام لتفعيلها\./);
  assert.match(invoicesSource, /api\.createPayment\(invoice\.id, idempotencyKey\)/);
  const paymentApi = apiSource.slice(apiSource.indexOf("export const createPayment"));
  assert.match(paymentApi, /"Idempotency-Key": idempotencyKey/g);
});

test("invoice payment redirect reconciles tap_id through the server and cleans the URL", () => {
  assert.match(apiSource, /export const getPaymentStatus = \(paymentId: string, tapChargeId\?: string\)/);
  assert.match(apiSource, /\?tap_id=\$\{encodeURIComponent\(tapChargeId\)\}/);
  assert.match(invoicesSource, /searchParams\.get\("payment_id"\)/);
  assert.match(invoicesSource, /searchParams\.get\("tap_id"\)/);
  assert.match(invoicesSource, /api\.getPaymentStatus\(paymentId, tapChargeId\)/);
  assert.match(invoicesSource, /result\.status === "completed"[\s\S]*?await refreshAll\(\)/);
  assert.match(invoicesSource, /searchParams\.delete\("payment_id"\)[\s\S]*?searchParams\.delete\("tap_id"\)/);
  assert.match(invoicesSource, /window\.history\.replaceState/);
});
