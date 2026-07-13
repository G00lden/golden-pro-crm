import assert from "node:assert/strict";
import test from "node:test";
import {
  catalogProductIsVisible,
  mergedProductTarget,
  productIsManuallyDeleted,
  productIsMerged,
  productIsRetired,
  visibleCatalogProductCount,
  visibleCatalogProducts,
} from "./productCatalogState";

test("catalog visibility is identical for server and direct-provider product reads", () => {
  assert.equal(catalogProductIsVisible({ catalog_visible: true }), true);
  assert.equal(catalogProductIsVisible({ catalog_visible: 1 }), true);
  assert.equal(catalogProductIsVisible({ catalog_visible: false }), false);
  assert.equal(catalogProductIsVisible({ catalog_visible: 0 }), false);
  assert.equal(catalogProductIsVisible({ catalog_visible: "false" }), false);
  assert.equal(catalogProductIsVisible({ catalog_visible: true, merged_into: "canonical-1" }), false);
  assert.equal(catalogProductIsVisible({ catalog_visible: true, store_status: "MANUAL_DELETED" }), false);
  assert.equal(productIsMerged({ merged_into: " canonical-1 " }), true);
  assert.equal(productIsManuallyDeleted({ store_status: " manual_deleted " }), true);
  assert.equal(productIsRetired({ store_status: "manual_deleted" }), true);
  assert.equal(mergedProductTarget({ merged_into: " canonical-1 " }), "canonical-1");
});

test("provider-neutral list and count helpers exclude exactly the same tombstones", () => {
  const products = [
    { id: "visible", catalog_visible: true },
    { id: "hidden", catalog_visible: false },
    { id: "merged", catalog_visible: true, merged_into: "visible" },
    { id: "manually-deleted", catalog_visible: true, store_status: "manual_deleted" },
    { id: "legacy-visible" },
  ];
  assert.deepEqual(visibleCatalogProducts(products).map((product) => product.id), ["visible", "legacy-visible"]);
  assert.equal(visibleCatalogProductCount(products), 2);
});
