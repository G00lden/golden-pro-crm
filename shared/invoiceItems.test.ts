import assert from "node:assert/strict";
import test from "node:test";
import { displayInvoiceItems, verifiableInvoiceItems } from "./invoiceItems";

test("verifiable invoice items require every line to have a description, positive quantity, and non-negative price", () => {
  assert.deepEqual(verifiableInvoiceItems([{
    description: "Free warranty service",
    quantity: 1,
    unit_price: 0,
    vat_excluded: true,
  }]), [{
    product_id: null,
    product_sku: "",
    description: "Free warranty service",
    quantity: 1,
    unit_price: 0,
    total: 0,
    vat_excluded: true,
  }]);
  assert.equal(verifiableInvoiceItems([{ description: "Missing numbers" }]), null);
  assert.equal(verifiableInvoiceItems([
    { description: "Valid", quantity: 1, unit_price: 100 },
    { description: "Incomplete" },
  ]), null);
  assert.equal(verifiableInvoiceItems([{ description: "Zero quantity", quantity: 0, unit_price: 100 }]), null);
  assert.equal(verifiableInvoiceItems([{ description: "String quantity", quantity: "1", unit_price: 100 }]), null);
  assert.equal(verifiableInvoiceItems([]), null);
});

test("display normalization remains tolerant without making malformed lines verifiable", () => {
  assert.deepEqual(displayInvoiceItems('[{"description":"Historical line"}]'), [{
    product_id: null,
    product_sku: "",
    description: "Historical line",
    quantity: 0,
    unit_price: 0,
    total: 0,
    vat_excluded: true,
  }]);
  assert.equal(verifiableInvoiceItems(displayInvoiceItems([{ description: "Historical line" }])), null);
});
