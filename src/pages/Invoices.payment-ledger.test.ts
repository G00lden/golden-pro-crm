import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");
const invoicesSource = read("./Invoices.tsx");
const apiSource = read("../api.ts");
const stylesSource = read("../index.css");
const paymentRoutesSource = read("../../server/routes-payment.ts");

function section(source: string, start: string, end: string) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing section start: ${start}`);
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return source.slice(from, to);
}

test("invoice UI records an immutable collection instead of directly marking an invoice paid", () => {
  assert.match(invoicesSource, /api\.getInvoicePaymentOverview\(50\)/);
  assert.match(invoicesSource, /api\.recordInvoicePayment\(collectingInvoice\.id, input, idempotencyKey\)/);
  assert.match(invoicesSource, /idempotencyKey = useRef\(`invoice-payment:\$\{invoice\.id\}:\$\{crypto\.randomUUID\(\)\}`\)/);
  assert.match(invoicesSource, />\s*تسجيل تحصيل\s*</);
  assert.doesNotMatch(invoicesSource, /setInvoiceStatus\(invoice,\s*"paid"\)/);
  assert.match(apiSource, /export const recordInvoicePayment = async/);
  assert.match(apiSource, /"Idempotency-Key": idempotencyKey/);
});

test("cashbox exposes balances, per-invoice collection progress, and an append-only reversal action", () => {
  assert.match(invoicesSource, /صندوق التحصيل وسجل العمليات/);
  assert.match(invoicesSource, /paymentSummary\.by_method\.cash/);
  assert.match(invoicesSource, /paymentSummary\.balance/);
  assert.match(invoicesSource, /محصل \{money\(totalsForInvoice\(invoice\)\?\.collected/);
  assert.match(invoicesSource, /متبقي \{money\(totalsForInvoice\(invoice\)\?\.outstanding/);
  assert.match(invoicesSource, /api\.reverseInvoicePayment\(entry\.id, reason, idempotencyKey\)/);
  assert.match(invoicesSource, /تم عكس عملية التحصيل وإضافتها كسطر سالب في السجل/);
  assert.doesNotMatch(invoicesSource, /deleteInvoicePayment/);
});

test("issued invoice correction creates a new editable draft without mutating the original", () => {
  const correction = section(invoicesSource, "const createCorrectionDraft", "const closeInvoiceEditor");
  assert.match(correction, /api\.createInvoice\(\{/);
  assert.match(correction, /status:\s*"draft"/);
  assert.match(correction, /const draft = await api\.getInvoice\(draftId\)/);
  assert.match(correction, /setEditing\(draft\)/);
  assert.doesNotMatch(correction, /api\.updateInvoice/);
  assert.match(invoicesSource, />\s*تعديل المسودة\s*</);
  assert.match(invoicesSource, />\s*نسخ للتصحيح\s*</);
});

test("collection form and ledger retain accessible labels and responsive scrolling", () => {
  assert.match(invoicesSource, /name="invoice_payment_amount"/);
  assert.match(invoicesSource, /name="invoice_payment_method"/);
  assert.match(invoicesSource, /name="invoice_payment_date"/);
  assert.match(invoicesSource, /role="region"\s*aria-label="سجل عمليات تحصيل الفواتير"\s*tabIndex=\{0\}/);
  assert.match(invoicesSource, /<caption className="sr-only">/);
  assert.match(invoicesSource, /<th scope="col">التاريخ<\/th>/);
  assert.match(stylesSource, /\.invoice-payment-table-wrap\s*\{[\s\S]*?overflow:\s*auto;[\s\S]*?overscroll-behavior:\s*contain;/);
  assert.match(stylesSource, /@media \(max-width: 430px\)[\s\S]*?\.invoice-payment-summary-grid\s*\{\s*grid-template-columns:\s*1fr;/);
});

test("Tap charges only the outstanding balance and provider refunds create a reversal", () => {
  const reservation = section(paymentRoutesSource, "function reservePayment", "function providerIdempotencyKey");
  assert.match(reservation, /invoiceOutstandingAmount\(ownerUid, invoiceId\)/);
  assert.match(reservation, /outstandingAmount,\s*invoice!\.currency/);
  assert.doesNotMatch(reservation, /invoice!\.total_with_vat/);
  assert.match(paymentRoutesSource, /updated\.status === "cancelled"[\s\S]*?syncCancelledTapPayment\(updated\)/);
});
