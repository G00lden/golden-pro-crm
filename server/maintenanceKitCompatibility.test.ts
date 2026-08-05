import assert from "node:assert/strict";
import test from "node:test";
import { compatibleMaintenanceKits, isMaintenanceKitProduct, maintenanceDevicesWithCompatibleKits } from "./maintenanceKitCompatibility";

const kits = [
  { id: "home", name: "حزمة طقم تبديل فلاتر - إصدار الخاص", category: "قطع الصيانة الدورية لأنظمة التحلية", variants: ["5 مراحل", "6 مراحل", "7 مراحل"] },
  { id: "ten", name: "طقم غيار من ٦ فلاتر لأجهزة التحلية ١٠ مراحل", category: "قطع الصيانة الدورية لأنظمة التحلية" },
  { id: "brafco", name: "طقم غيار فلاتر برادة برافكو طاولة 15", category: "قطع الصيانة الدورية" },
  { id: "cooler", name: "طقم فلاتر برادة 3 مراحل", category: "قطع الصيانة الدورية" },
  { id: "jumbo", name: "طقم غيار 3 فلاتر 20 انش مطور - فلتر الجامبو", category: "قطع الصيانة الدورية" },
  { id: "cells", name: "طقم قطع غيار خلايا تبريد المكيف الاسترالي Breez Air", variants: ["TBQI-350", "TBSI-580"] },
];

test("7-stage home RO receives its filter bundle and never cooling cells", () => {
  const matches = compatibleMaintenanceKits({ id: "ro7", name: "جهاز تحلية منزلي RO 7 مراحل" }, kits);
  assert.deepEqual(matches.map((item) => item.product.id), ["home"]);
  assert.equal(matches[0].kind, "filter_change");
});

test("10-stage RO receives only its specific ten-stage kit", () => {
  const matches = compatibleMaintenanceKits({ id: "ro10", name: "جهاز تحلية منزلي 10 مراحل" }, kits);
  assert.deepEqual(matches.map((item) => item.product.id), ["ten"]);
});

test("Breez Air receives cooling cells while a generic desert cooler does not", () => {
  const breezAir = compatibleMaintenanceKits({ id: "ba", name: "مكيف استرالي Breez Air TBQI-350" }, kits);
  assert.deepEqual(breezAir.map((item) => item.product.id), ["cells"]);
  assert.equal(breezAir[0].kind, "cooling_cells");
  assert.deepEqual(compatibleMaintenanceKits({ id: "generic", name: "مكيف صحراوي مركزي عام" }, kits), []);
  assert.deepEqual(compatibleMaintenanceKits({ id: "split", name: "مكيف BreeXe Pro سبليت" }, kits), []);
});

test("Brafco cooler is fail-closed to its exact kit", () => {
  const matches = compatibleMaintenanceKits({ id: "b", name: "برادة برافكو طاولة" }, kits);
  assert.deepEqual(matches.map((item) => item.product.id), ["brafco"]);
});

test("an accessory description cannot turn the accessory into a maintenance device", () => {
  const accessory = {
    id: "pump-control",
    name: "اوتوماتيك مضخة إسباني موديل SP-3",
    category: "أنظمة دفع الماء والمضخات",
    description: "قطعة غيار يمكن استخدامها مع برادة برافكو طاولة",
  };
  assert.deepEqual(compatibleMaintenanceKits(accessory, kits), []);
  assert.deepEqual(maintenanceDevicesWithCompatibleKits([accessory, ...kits]), []);
});

test("kit products cannot be selected as devices", () => {
  assert.equal(isMaintenanceKitProduct(kits[0]), true);
  assert.deepEqual(compatibleMaintenanceKits(kits[0], kits), []);
});

test("periodic device indexing stays bounded on a production-sized catalog", () => {
  const unrelated = Array.from({ length: 2_000 }, (_, index) => ({
    id: `unrelated-${index}`,
    name: `مكيف BreeXe Pro سبليت ${index}`,
    category: "تكييف وتبريد",
    description: "وصف منتج ".repeat(20),
  }));
  const startedAt = performance.now();
  const devices = maintenanceDevicesWithCompatibleKits([
    ...unrelated,
    { id: "ro7", name: "جهاز تحلية منزلي RO 7 مراحل" },
    ...kits,
  ]);
  assert.deepEqual(devices.map((item) => item.id), ["ro7"]);
  assert.ok(performance.now() - startedAt < 2_000, "periodic catalog matching exceeded two seconds");
});
