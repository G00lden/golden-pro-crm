import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.DATA_PROVIDER = "sqlite";
process.env.DB_PROVIDER = "sqlite";
process.env.DB_PATH = ":memory:";

const { adminDb } = await import("./firebaseAdmin");
const {
  listCompatibleMaintenanceKits,
  requireCompatibleMaintenanceKit,
  requireMaintenanceProduct,
  searchMaintenanceProducts,
} = await import("./maintenancePortalExperience");

test("periodic portal derives Breez Air devices from approved cooling-cell variants and rejects forgery", async () => {
  const ownerUid = "owner-periodic-variants";
  const kitId = "cells-kit";
  await adminDb.collection("products").doc(kitId).set({
    createdBy: ownerUid,
    name: "طقم قطع غيار خلايا تبريد المكيف الاسترالي Breez Air",
    category: "مكيفات صحراوية",
    sku: "CELLS-KIT",
    catalog_visible: true,
    is_available: true,
    variants: [
      { id: "350", name: "خلايا تبريد المكيف Breez Air ١ حصان TBQI-350" },
      { id: "580", name: "خلايا تبريد المكيف Breez Air ١.٥ حصان TBSI-580" },
    ],
  });

  const devices = await searchMaintenanceProducts(ownerUid, "Breez", 24, "periodic");
  assert.deepEqual(devices.map((item) => item.name), [
    "مكيف Breez Air ١ حصان TBQI-350",
    "مكيف Breez Air ١.٥ حصان TBSI-580",
  ]);

  const device = devices[0];
  const kits = await listCompatibleMaintenanceKits(ownerUid, device.id);
  assert.deepEqual(kits.map((item) => ({ id: item.id, kind: item.kind })), [
    { id: kitId, kind: "cooling_cells" },
  ]);
  assert.equal((await requireMaintenanceProduct(ownerUid, device.id)).name, device.name);
  assert.equal((await requireCompatibleMaintenanceKit(ownerUid, device.id, kitId)).id, kitId);

  await assert.rejects(
    () => requireMaintenanceProduct(ownerUid, "periodic_variant:cells-kit:forged"),
    /صالحاً|صالحًا/,
  );
  await assert.rejects(
    () => requireCompatibleMaintenanceKit(ownerUid, device.id, "forged-kit"),
    /غير متوافق/,
  );
});
