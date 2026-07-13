import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProductDuplicateGroups,
  chooseCanonicalProduct,
  mergeProductCatalogRecords,
  normalizeProductSku,
  type ProductCatalogRecord,
} from "./productCatalog";

const row = (id: string, data: Record<string, unknown>): ProductCatalogRecord => ({ id, data });

test("SKU normalization ignores whitespace and letter case", () => {
  assert.equal(normalizeProductSku(" BP- 100 "), "bp-100");
});

test("same Salla id is always treated as one product", () => {
  const groups = buildProductDuplicateGroups([
    row("old", { store_product_id: "77", sku: "OLD" }),
    row("new", { store_product_id: "77", sku: "NEW", source: "salla" }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 2);
});

test("legacy SKU row joins the only matching Salla product", () => {
  const groups = buildProductDuplicateGroups([
    row("manual", { sku: "ABC-1", policy_active: true }),
    row("salla", { store_product_id: "91", sku: "abc-1", source: "salla" }),
  ]);
  assert.equal(groups.length, 1);
});

test("different Salla products sharing a SKU stay separate", () => {
  const groups = buildProductDuplicateGroups([
    row("one", { store_product_id: "1", sku: "shared", source: "salla" }),
    row("two", { store_product_id: "2", sku: "shared", source: "salla" }),
  ]);
  assert.equal(groups.length, 0);
});

test("legacy order SKU joins one unambiguous Salla variant parent", () => {
  const groups = buildProductDuplicateGroups([
    row("legacy", { sku: "FILTER-BLUE", source: "salla" }),
    row("parent", {
      store_product_id: "parent-1",
      sku: "FILTER",
      source: "salla",
      variants: [{ id: "variant-1", sku: "filter-blue" }],
    }),
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].map((record) => record.id).sort(), ["legacy", "parent"]);
});

test("ambiguous variant SKU never merges different Salla parents", () => {
  const groups = buildProductDuplicateGroups([
    row("legacy", { sku: "SHARED-VARIANT", source: "salla" }),
    row("one", { store_product_id: "1", sku: "ONE", variants: [{ sku: "SHARED-VARIANT" }] }),
    row("two", { store_product_id: "2", sku: "TWO", variants: [{ sku: "SHARED-VARIANT" }] }),
  ]);
  assert.equal(groups.length, 0);
});

test("canonical merge preserves the richest CRM maintenance policy", () => {
  const records = [
    row("salla", { store_product_id: "7", sku: "F-7", source: "salla", name: "Store name", interval_months: 3 }),
    row("legacy", {
      sku: "F-7",
      policy_active: true,
      interval_months: 6,
      remind_text: "غيّر الفلتر",
      service_tasks: [{ key: "filter", name: "تغيير الفلتر" }],
    }),
  ];
  const canonical = chooseCanonicalProduct(records);
  const merged = mergeProductCatalogRecords(records, canonical.id);
  assert.equal(canonical.id, "salla");
  assert.equal(merged.policy_active, true);
  assert.equal(merged.interval_months, 6);
  assert.equal(merged.remind_text, "غيّر الفلتر");
  assert.equal(merged.service_tasks.length, 1);
});
