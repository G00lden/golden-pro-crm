import assert from "node:assert/strict";
import test from "node:test";

process.env.DATA_PROVIDER = "sqlite";
process.env.DB_PROVIDER = "sqlite";
process.env.DB_PATH = ":memory:";
process.env.ENABLE_DAILY_CRON = "false";

const { adminDb } = await import("./firebaseAdmin");
const {
  __crmApiTestables,
  createProductForUser,
  deleteProductForUser,
  updateProductForUser,
} = await import("./crmApi");
const {
  __storeWebhookTestables,
  getStoreProductCatalogIndex,
} = await import("./storeWebhook");

test("manual product mutations invalidate the store-order catalog immediately", async () => {
  const uid = "catalog-mutation-owner";
  __storeWebhookTestables.resetProductCatalogIndexCache();

  const emptyIndex = await getStoreProductCatalogIndex(uid);
  assert.equal(__storeWebhookTestables.findProductMatch(
    { sku: "CACHE-OLD", remoteProductId: "" },
    emptyIndex,
  ), null);
  assert.equal(__storeWebhookTestables.productCatalogIndexLoadCount(), 1);

  const id = await createProductForUser(uid, {
    name: "Cached product",
    sku: "CACHE-OLD",
    interval_months: 3,
    source: "manual",
    catalog_visible: true,
  });
  const afterCreate = await getStoreProductCatalogIndex(uid);
  assert.equal(
    __storeWebhookTestables.findProductMatch(
      { sku: "CACHE-OLD", remoteProductId: "" },
      afterCreate,
    )?.doc.id,
    id,
  );
  assert.equal(__storeWebhookTestables.productCatalogIndexLoadCount(), 2);

  assert.equal(await updateProductForUser(uid, id, { sku: "CACHE-NEW" }), true);
  const afterUpdate = await getStoreProductCatalogIndex(uid);
  assert.equal(__storeWebhookTestables.findProductMatch(
    { sku: "CACHE-OLD", remoteProductId: "" },
    afterUpdate,
  ), null);
  assert.equal(
    __storeWebhookTestables.findProductMatch(
      { sku: "CACHE-NEW", remoteProductId: "" },
      afterUpdate,
    )?.doc.id,
    id,
  );
  assert.equal(__storeWebhookTestables.productCatalogIndexLoadCount(), 3);

  assert.equal(await deleteProductForUser(uid, id), true);
  const afterDelete = await getStoreProductCatalogIndex(uid);
  assert.equal(__storeWebhookTestables.findProductMatch(
    { sku: "CACHE-NEW", remoteProductId: "" },
    afterDelete,
  ), null);
  assert.equal(__storeWebhookTestables.productCatalogIndexLoadCount(), 4);

  const retired = await adminDb.collection("products").doc(id).get();
  assert.equal(retired.exists, true);
  assert.equal(Boolean(retired.data()?.catalog_visible), false);
  assert.equal(Boolean(retired.data()?.is_available), false);
  assert.equal(retired.data()?.store_status, "manual_deleted");
});

test("store matching never selects a merged tombstone", async () => {
  const uid = "catalog-merged-owner";
  const canonicalId = "catalog-merged-canonical";
  const tombstoneId = "catalog-merged-tombstone";
  __storeWebhookTestables.resetProductCatalogIndexCache();

  await adminDb.collection("products").doc(canonicalId).set({
    createdBy: uid,
    name: "Canonical product",
    sku: "MERGED-SKU",
    store_product_id: "remote-merged",
    source: "salla",
    catalog_visible: true,
  });
  await adminDb.collection("products").doc(tombstoneId).set({
    createdBy: uid,
    name: "Merged duplicate",
    sku: "MERGED-SKU",
    store_product_id: "remote-merged",
    source: "salla",
    catalog_visible: false,
    store_status: "merged",
    merged_into: canonicalId,
  });

  const index = await getStoreProductCatalogIndex(uid);
  assert.equal(
    __storeWebhookTestables.findProductMatch(
      { sku: "MERGED-SKU", remoteProductId: "remote-merged" },
      index,
    )?.doc.id,
    canonicalId,
  );
  assert.equal(
    __storeWebhookTestables.findProductMatch(
      { sku: "MERGED-SKU", remoteProductId: null },
      index,
    )?.doc.id,
    canonicalId,
  );
  assert.equal(await deleteProductForUser(uid, canonicalId), false);
  assert.equal((await adminDb.collection("products").doc(canonicalId).get()).exists, true);
  assert.equal(await deleteProductForUser(uid, tombstoneId), false);
  assert.equal((await adminDb.collection("products").doc(tombstoneId).get()).exists, true);
});

test("a delete paused after its read cannot remove a tombstone created by deduplication", async () => {
  const uid = "catalog-delete-race-owner";
  const canonicalId = "catalog-delete-race-canonical";
  const candidateId = "catalog-delete-race-candidate";
  const candidateRef = adminDb.collection("products").doc(candidateId);

  await adminDb.collection("products").doc(canonicalId).set({
    createdBy: uid,
    name: "Canonical race product",
    sku: "DELETE-RACE-SKU",
    source: "manual",
    catalog_visible: true,
  });
  await candidateRef.set({
    createdBy: uid,
    name: "Candidate race product",
    sku: "DELETE-RACE-SKU",
    source: "manual",
    catalog_visible: true,
  });

  let observed = false;
  __crmApiTestables.setProductDeleteLifecycleObserver(async (event) => {
    assert.deepEqual(event, {
      phase: "after_read_before_soft_delete",
      uid,
      id: candidateId,
    });
    observed = true;
    await candidateRef.set({
      catalog_visible: false,
      is_available: false,
      store_status: "merged",
      merged_into: canonicalId,
      merged_at: new Date().toISOString(),
    }, { merge: true });
  });

  try {
    assert.equal(await deleteProductForUser(uid, candidateId), true);
  } finally {
    __crmApiTestables.setProductDeleteLifecycleObserver(null);
  }

  assert.equal(observed, true);
  const tombstone = await candidateRef.get();
  assert.equal(tombstone.exists, true);
  assert.equal(tombstone.data()?.merged_into, canonicalId);
  assert.equal(tombstone.data()?.store_status, "merged");
  assert.equal(Boolean(tombstone.data()?.catalog_visible), false);
});
