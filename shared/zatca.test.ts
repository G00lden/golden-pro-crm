import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanInvoiceTerms,
  generateZatcaQrBase64,
  invoiceQrTimestamp,
  isSaudiVatNumber,
  resolveInvoiceTaxType,
} from "./zatca";

test("invoice output hides legacy compliance boilerplate but keeps real terms", () => {
  assert.equal(cleanInvoiceTerms("فاتورة ضريبية مبسطة - متوافقة مع ZATCA"), "");
  assert.equal(cleanInvoiceTerms("الكود متوافق مع زاتكا"), "");
  assert.equal(
    cleanInvoiceTerms("الدفع خلال 30 يوماً\nمتوافقة مع ZATCA\nالضمان سنة"),
    "الدفع خلال 30 يوماً\nالضمان سنة",
  );
});

test("invoice type follows B2C/B2B rules instead of total alone", () => {
  assert.equal(resolveInvoiceTaxType({ buyerVat: "", taxableAmount: 5000 }), "simplified");
  assert.equal(resolveInvoiceTaxType({ buyerVat: "123456789012345", taxableAmount: 999.99 }), "simplified");
  assert.equal(resolveInvoiceTaxType({ buyerVat: "123456789012345", taxableAmount: 1000 }), "tax");
  assert.equal(
    resolveInvoiceTaxType({ requested: "simplified", buyerVat: "123456789012345", taxableAmount: 1000 }),
    "tax",
  );
  assert.equal(
    resolveInvoiceTaxType({ requested: "simplified", buyerVat: "123456789012345", taxableAmount: 999.99 }),
    "simplified",
  );
  assert.equal(resolveInvoiceTaxType({ requested: "tax", buyerVat: "", taxableAmount: 10 }), "tax");
});

test("Saudi VAT identifiers contain exactly 15 digits", () => {
  assert.equal(isSaudiVatNumber("123456789012345"), true);
  assert.equal(isSaudiVatNumber("123 456 789 012 345"), true);
  assert.equal(isSaudiVatNumber("VAT123456789012345"), false);
  assert.equal(isSaudiVatNumber("123"), false);
});

test("QR timestamp uses the printed issue date and preserves an existing creation time", () => {
  assert.equal(
    invoiceQrTimestamp({ issueDate: "2026-07-10", createdAt: "2026-07-13T08:30:45.123Z" }),
    "2026-07-10T08:30:45Z",
  );
  assert.equal(invoiceQrTimestamp({ issueDate: "2026-07-10" }), "2026-07-10T00:00:00Z");
  assert.throws(
    () => invoiceQrTimestamp({ createdAt: "2026-07-13T08:30:45.123Z" }),
    /تاريخ إصدار الفاتورة/,
  );
  assert.throws(
    () => invoiceQrTimestamp({ issueDate: "2026-02-30", createdAt: "2026-07-13T08:30:45Z" }),
    /تاريخ إصدار الفاتورة/,
  );
  assert.throws(() => invoiceQrTimestamp({}), /تاريخ إصدار الفاتورة/);
});

test("ZATCA QR rejects malformed identifiers, timestamps, and financial totals", () => {
  const valid = {
    sellerName: "BreeXe Pro Co.",
    vatNumber: "313049114100003",
    timestamp: "2026-07-12T00:00:00Z",
    total: 115,
    vatTotal: 15,
  };
  assert.throws(() => generateZatcaQrBase64({ ...valid, vatNumber: "123" }), /15/);
  assert.throws(
    () => generateZatcaQrBase64({ ...valid, timestamp: "2026-02-30T00:00:00Z" }),
    /تاريخ ووقت/,
  );
  assert.throws(() => generateZatcaQrBase64({ ...valid, total: -1 }), /إجمالي/);
  assert.throws(() => generateZatcaQrBase64({ ...valid, vatTotal: 116 }), /إجمالي/);
});

test("ZATCA QR uses UTF-8 byte lengths and rejects oversized fields", () => {
  const qr = generateZatcaQrBase64({
    sellerName: "شركة بريكس برو",
    vatNumber: "313 049 114 100 003",
    timestamp: "2026-07-12T00:00:00Z",
    total: 115,
    vatTotal: 15,
  });
  const bytes = Uint8Array.from(atob(qr), (char) => char.charCodeAt(0));
  assert.equal(bytes[0], 1);
  assert.equal(bytes[1], new TextEncoder().encode("شركة بريكس برو").length);
  const vatOffset = 2 + bytes[1];
  assert.equal(bytes[vatOffset], 2);
  assert.equal(new TextDecoder().decode(bytes.slice(vatOffset + 2, vatOffset + 2 + bytes[vatOffset + 1])), "313049114100003");

  assert.throws(() => generateZatcaQrBase64({
    sellerName: "س".repeat(128),
    vatNumber: "313049114100003",
    timestamp: "2026-07-12T00:00:00Z",
    total: 115,
    vatTotal: 15,
  }), /255 UTF-8 bytes/);
});
