import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateDocumentLineAmounts,
  calculateDocumentTotals,
  calculateInstallmentAmounts,
  calculateLineAmounts,
  validateInstallments,
} from "./financial";

test("fixed discount is applied before VAT", () => {
  const totals = calculateDocumentTotals({
    lines: [{ total: 200, vat_excluded: true }],
    discountValue: 10,
    discountMode: "fixed",
    vatPercent: 15,
  });
  assert.deepEqual(
    { discount: totals.discountAmount, vat: totals.vatAmount, total: totals.total },
    { discount: 10, vat: 28.5, total: 218.5 },
  );
});

test("percentage discount stores its monetary effect correctly", () => {
  const totals = calculateDocumentTotals({
    lines: [{ total: 200, vat_excluded: true }],
    discountValue: 10,
    discountMode: "percent",
    vatPercent: 15,
  });
  assert.deepEqual(
    { discount: totals.discountAmount, vat: totals.vatAmount, total: totals.total },
    { discount: 20, vat: 27, total: 207 },
  );
});

test("VAT-inclusive prices are converted to net without double taxation", () => {
  const totals = calculateDocumentTotals({ lines: [{ total: 115, vat_excluded: false }], vatPercent: 15 });
  assert.deepEqual(
    { subtotal: totals.subtotal, vat: totals.vatAmount, total: totals.total },
    { subtotal: 100, vat: 15, total: 115 },
  );
  assert.deepEqual(calculateLineAmounts({ total: 115, vat_excluded: false }, 15), {
    enteredTotal: 115,
    net: 100,
    vat: 15,
    gross: 115,
  });
});

test("mixed inclusive and exclusive lines share one calculation", () => {
  const totals = calculateDocumentTotals({
    lines: [{ total: 100, vat_excluded: true }, { total: 115, vat_excluded: false }],
    vatPercent: 15,
  });
  assert.deepEqual(
    { subtotal: totals.subtotal, vat: totals.vatAmount, total: totals.total },
    { subtotal: 200, vat: 30, total: 230 },
  );
});

test("discounts and VAT percentages are clamped to safe bounds", () => {
  const totals = calculateDocumentTotals({
    lines: [{ total: 50 }],
    discountValue: 150,
    discountMode: "percent",
    vatPercent: 150,
  });
  assert.equal(totals.discountAmount, 50);
  assert.equal(totals.vatPercent, 100);
  assert.equal(totals.total, 0);
});

test("money is rounded to halalas", () => {
  const totals = calculateDocumentTotals({ lines: [{ total: 0.3 }], vatPercent: 15 });
  assert.equal(totals.vatAmount, 0.05);
  assert.equal(totals.total, 0.35);
});

test("installments must total 100 and their rounded amounts preserve the total", () => {
  const installments = [
    { percent: 33.33, label: "A" },
    { percent: 33.33, label: "B" },
    { percent: 33.34, label: "C" },
  ];
  assert.equal(validateInstallments(installments).valid, true);
  const amounts = calculateInstallmentAmounts(1000, installments).map((item) => item.amount);
  assert.deepEqual(amounts, [333.3, 333.3, 333.4]);
  assert.equal(amounts.reduce((sum, amount) => sum + amount, 0), 1000);
  assert.equal(validateInstallments([{ percent: 70 }, { percent: 20 }]).valid, false);
});

test("invoice line VAT reconciles with the discounted document header", () => {
  const result = calculateDocumentLineAmounts({
    lines: [
      { total: 100, vat_excluded: true },
      { total: 100, vat_excluded: true },
    ],
    discountValue: 20,
    discountMode: "fixed",
    vatPercent: 15,
  });

  assert.equal(result.lines.reduce((sum, line) => sum + line.discount, 0), 20);
  assert.equal(result.lines.reduce((sum, line) => sum + line.taxableAmount, 0), 180);
  assert.equal(result.lines.reduce((sum, line) => sum + line.vat, 0), 27);
  assert.equal(result.lines.reduce((sum, line) => sum + line.gross, 0), 207);
  assert.deepEqual(result.lines[0], {
    enteredTotal: 100,
    netBeforeDiscount: 100,
    discount: 10,
    taxableAmount: 90,
    vat: 13.5,
    gross: 103.5,
  });
});

test("halala allocation stays exact for uneven invoice lines", () => {
  const result = calculateDocumentLineAmounts({
    lines: [
      { total: 100, vat_excluded: true },
      { total: 50, vat_excluded: true },
    ],
    discountValue: 10,
    vatPercent: 15,
  });

  assert.equal(result.lines.reduce((sum, line) => sum + line.discount, 0), 10);
  assert.equal(result.lines.reduce((sum, line) => sum + line.taxableAmount, 0), 140);
  assert.equal(result.lines.reduce((sum, line) => sum + line.vat, 0), 21);
  assert.equal(result.lines.reduce((sum, line) => sum + line.gross, 0), 161);
});
