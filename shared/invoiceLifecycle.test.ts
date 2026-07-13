import assert from "node:assert/strict";
import test from "node:test";
import {
  canApplyCorrection,
  canApplyOperationalInvoiceStatus,
  deriveInvoiceStatuses,
  invoiceIsMutableDraft,
  invoiceLedgerSign,
} from "./invoiceLifecycle";

test("only an unissued invoice draft is financially mutable", () => {
  assert.equal(invoiceIsMutableDraft({ status: "draft" }), true);
  assert.equal(invoiceIsMutableDraft({ status: "draft", sequence_no: 7 }), false);
  assert.equal(invoiceIsMutableDraft({ status: "draft", issued_at: "2026-07-13T12:00:00Z" }), false);
  assert.equal(invoiceIsMutableDraft({ document_kind: "credit_note", status: "draft" }), false);
  assert.equal(invoiceIsMutableDraft({ status: "issued" }), false);
});

test("operational transitions and full-credit eligibility are explicit", () => {
  assert.equal(canApplyOperationalInvoiceStatus({ status: "draft" }, "issued"), true);
  assert.equal(canApplyOperationalInvoiceStatus({ status: "issued" }, "sent"), true);
  assert.equal(canApplyOperationalInvoiceStatus({ status: "sent" }, "paid"), true);
  assert.equal(canApplyOperationalInvoiceStatus({ status: "paid" }, "sent"), false);
  assert.equal(canApplyCorrection({ status: "issued" }, "cancellation"), true);
  assert.equal(canApplyCorrection({ status: "paid" }, "refund"), true);
  assert.equal(canApplyCorrection({ status: "draft" }, "cancellation"), false);
});

test("credit notes derive source status without changing source financial data", () => {
  const source = { id: "invoice-1", status: "paid", total_with_vat: 115 };
  const credit = {
    id: "credit-1",
    document_kind: "credit_note",
    source_invoice_id: "invoice-1",
    adjustment_kind: "refund",
    status: "issued",
    total_with_vat: 115,
  };
  const derived = deriveInvoiceStatuses([source, credit]);
  assert.equal(derived[0].status, "refunded");
  assert.equal(derived[0].total_with_vat, 115);
  assert.equal(source.status, "paid", "the original object remains untouched");
  assert.equal(invoiceLedgerSign(source), 1);
  assert.equal(invoiceLedgerSign(credit), -1);
});
