import assert from "node:assert/strict";
import test from "node:test";
import {
  generateZatcaQrBase64,
  isSaudiVatNumber,
  resolveInvoiceTaxType,
} from "./zatca";

test("invoice type follows B2C/B2B rules instead of total alone", () => {
  assert.equal(resolveInvoiceTaxType({ buyerVat: "", taxableAmount: 5000 }), "simplified");
  assert.equal(resolveInvoiceTaxType({ buyerVat: "123456789012345", taxableAmount: 999.99 }), "simplified");
  assert.equal(resolveInvoiceTaxType({ buyerVat: "123456789012345", taxableAmount: 1000 }), "tax");
  assert.equal(resolveInvoiceTaxType({ requested: "tax", buyerVat: "", taxableAmount: 10 }), "tax");
});

test("Saudi VAT identifiers contain exactly 15 digits", () => {
  assert.equal(isSaudiVatNumber("123456789012345"), true);
  assert.equal(isSaudiVatNumber("123 456 789 012 345"), true);
  assert.equal(isSaudiVatNumber("VAT123456789012345"), false);
  assert.equal(isSaudiVatNumber("123"), false);
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
