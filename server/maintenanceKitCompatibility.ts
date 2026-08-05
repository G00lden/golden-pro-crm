export type MaintenanceCatalogProduct = {
  id: string;
  name?: unknown;
  category?: unknown;
  nested_category?: unknown;
  subcategory?: unknown;
  description?: unknown;
  variants?: unknown;
  sku?: unknown;
  image_url?: unknown;
  imageUrl?: unknown;
};

export type MaintenanceKitKind = "filter_change" | "cooling_cells";

export type CompatibleMaintenanceKit = {
  product: MaintenanceCatalogProduct;
  kind: MaintenanceKitKind;
  compatibility_note: string;
};

export type PeriodicMaintenanceVirtualDevice = MaintenanceCatalogProduct & {
  periodic_parent_kit_id: string;
  periodic_variant_id: string;
};

const PERIODIC_VARIANT_PREFIX = "periodic_variant:";

const productTextCache = new WeakMap<object, string>();

function normalize(value: unknown) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .toLocaleLowerCase("ar")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function productText(product: MaintenanceCatalogProduct) {
  const cached = productTextCache.get(product);
  if (cached !== undefined) return cached;
  const text = normalize([
    product.name,
    product.category,
    product.nested_category,
    product.subcategory,
    product.description,
    typeof product.variants === "string" ? product.variants : JSON.stringify(product.variants || ""),
    product.sku,
  ].join(" "));
  productTextCache.set(product, text);
  return text;
}

function deviceIdentityText(product: MaintenanceCatalogProduct) {
  return normalize([
    product.name,
    product.category,
    product.nested_category,
    product.subcategory,
    product.sku,
  ].join(" "));
}

function hasAny(text: string, values: string[]) {
  return values.some((value) => {
    const needle = normalize(value);
    return Boolean(needle) && text.includes(needle);
  });
}

export function maintenanceKitKind(product: MaintenanceCatalogProduct): MaintenanceKitKind | null {
  const text = deviceIdentityText(product);
  const coolingCells = hasAny(text, ["خلايا تبريد", "خلية تبريد"])
    && hasAny(text, ["طقم", "قطع غيار", "قطع الصيانة الدورية"]);
  if (coolingCells) return "cooling_cells";
  const filterKit = hasAny(text, ["طقم", "حزمة"])
    && hasAny(text, ["فلتر", "فلاتر"]);
  return filterKit ? "filter_change" : null;
}

export function isMaintenanceKitProduct(product: MaintenanceCatalogProduct) {
  return maintenanceKitKind(product) !== null;
}

function isAccessoryProduct(product: MaintenanceCatalogProduct) {
  const name = normalize(product.name);
  const categories = normalize([product.category, product.nested_category, product.subcategory].join(" "));
  return categories.includes(normalize("قطع الصيانة الدورية"))
    || /^(خزان|دنمو|شبك|حامل|اوتوماتيك|مضخه|حنفيه|توصيله|توصيلات|تطويله|تطويلات|بخاخ|راس|صمام|محبس|قاعده|ملحق|قطعه)(?: |$)/.test(name);
}

function deviceFamily(text: string) {
  if (hasAny(text, ["breez air", "breezair", "بريز اير"])) return "breez_air";
  if (hasAny(text, ["برافكو"]) && hasAny(text, ["برادة", "براد", "مبرد مياه"])) return "brafco_cooler";
  if (hasAny(text, ["جامبو", "20 انش", "٢٠ انش"])) return "jumbo";
  if (hasAny(text, ["200 جالون", "400 جالون", "كافيه", "مطاعم", "محطة تحلية"])) return "commercial_ro";
  if (hasAny(text, ["برادة", "براد مياه", "مبرد مياه"])) return "water_cooler";
  if (hasAny(text, ["جهاز تحلية", "اجهزة تحلية منزلية", "تحلية منزلية", "نظام تحلية"]) || /(?:^| )ro(?: |$)/.test(text)) return "home_ro";
  return "unsupported";
}

function stageNumber(text: string) {
  const match = text.match(/(?:^|\s)(10|7|6|5|4|3)(?:\s|$|مراحل|مرحله)/);
  return match ? Number(match[1]) : null;
}

export function compatibleMaintenanceKits(
  device: MaintenanceCatalogProduct,
  catalog: MaintenanceCatalogProduct[],
): CompatibleMaintenanceKit[] {
  if (!device?.id || isMaintenanceKitProduct(device) || isAccessoryProduct(device)) return [];
  // Descriptions can mention compatible devices for spare parts and
  // accessories. Device classification therefore uses identity fields only;
  // descriptions and variants remain available when classifying the kit.
  const deviceText = deviceIdentityText(device);
  const family = deviceFamily(deviceText);
  const stages = stageNumber(deviceText);
  const matches: CompatibleMaintenanceKit[] = [];

  for (const product of catalog) {
    if (!product?.id || product.id === device.id) continue;
    const kind = maintenanceKitKind(product);
    if (!kind) continue;
    const kitText = productText(product);
    let compatible = false;
    let note = "";

    if (family === "breez_air") {
      compatible = kind === "cooling_cells" && hasAny(kitText, ["breez air", "breezair", "بريز اير"]);
      note = "خلايا تبريد مخصصة لمكيف Breez Air؛ اختر المقاس المطابق للموديل.";
    } else if (family === "brafco_cooler") {
      compatible = kind === "filter_change" && hasAny(kitText, ["برافكو"]);
      note = "طقم فلاتر مخصص لبرادة برافكو.";
    } else if (family === "jumbo") {
      compatible = kind === "filter_change" && hasAny(kitText, ["جامبو", "20 انش", "٢٠ انش"]);
      note = "طقم فلاتر 20 إنش متوافق مع نظام الجامبو.";
    } else if (family === "commercial_ro") {
      compatible = kind === "filter_change" && hasAny(kitText, ["200", "400", "كافيه", "مطاعم"]);
      note = "طقم فلاتر لمحطات التحلية التجارية 200/400 جالون.";
    } else if (family === "water_cooler") {
      compatible = kind === "filter_change"
        && hasAny(kitText, ["برادة", "براد"])
        && !hasAny(kitText, ["برافكو"]);
      if (compatible && stages) compatible = hasAny(kitText, [String(stages), stages === 3 ? "اول 3" : ""]);
      note = "طقم فلاتر للبرادة؛ طابق عدد مراحل الجهاز.";
    } else if (family === "home_ro") {
      compatible = kind === "filter_change"
        && !hasAny(kitText, ["برادة", "براد", "جامبو", "20 انش", "200", "400", "كافيه", "مطاعم", "شاور"]);
      if (compatible && stages === 10) compatible = hasAny(kitText, ["10 مراحل", "١٠ مراحل"]);
      if (compatible && stages && [5, 6, 7].includes(stages)) {
        compatible = hasAny(kitText, ["حزمة طقم تبديل فلاتر", "5 6 7", "5,6,7", "المرحلة 5,6,7"]);
      }
      note = stages ? `طقم فلاتر مناسب لجهاز تحلية ${stages} مراحل.` : "طقم فلاتر صيانة دورية لأجهزة التحلية المنزلية.";
    }

    if (compatible) matches.push({ product, kind, compatibility_note: note });
  }

  return matches.sort((left, right) => {
    const leftExact = productText(left.product).includes(normalize(device.name));
    const rightExact = productText(right.product).includes(normalize(device.name));
    return Number(rightExact) - Number(leftExact) || String(left.product.name || "").localeCompare(String(right.product.name || ""), "ar");
  });
}

export function maintenanceDevicesWithCompatibleKits(catalog: MaintenanceCatalogProduct[]) {
  const kits = catalog.filter(isMaintenanceKitProduct);
  return catalog
    .filter((product) => !isMaintenanceKitProduct(product) && !isAccessoryProduct(product))
    .filter((device) => compatibleMaintenanceKits(device, kits).length > 0);
}

function catalogVariants(product: MaintenanceCatalogProduct) {
  let raw = product.variants;
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { return []; }
  }
  return Array.isArray(raw) ? raw : [];
}

function coolingCellDeviceName(value: unknown) {
  const name = String(value || "").trim();
  if (!name) return "";
  return name.replace(/^خلايا\s+تبريد\s+(?:المكيف\s+)?/u, "مكيف ").trim();
}

/**
 * Some approved cooling-cell kits carry their supported Breez Air models as
 * variants even when the historical devices are no longer sold as separate
 * catalog products. These server-derived choices preserve exact compatibility
 * without accepting free text or a forged device/kit relationship.
 */
export function periodicCoolingCellVariantDevices(catalog: MaintenanceCatalogProduct[]) {
  const devices: PeriodicMaintenanceVirtualDevice[] = [];
  for (const kit of catalog) {
    if (!kit?.id || maintenanceKitKind(kit) !== "cooling_cells") continue;
    for (const candidate of catalogVariants(kit)) {
      if (!candidate || typeof candidate !== "object") continue;
      const variant = candidate as Record<string, unknown>;
      const variantId = String(variant.id || "").trim();
      const name = coolingCellDeviceName(variant.name);
      if (!variantId || !name) continue;
      devices.push({
        id: `${PERIODIC_VARIANT_PREFIX}${kit.id}:${variantId}`,
        name,
        category: kit.category,
        nested_category: kit.nested_category,
        subcategory: kit.subcategory,
        sku: variant.sku || kit.sku,
        image_url: kit.image_url || kit.imageUrl,
        periodic_parent_kit_id: kit.id,
        periodic_variant_id: variantId,
      });
    }
  }
  return devices;
}

export function resolvePeriodicCoolingCellVariantDevice(
  productId: string,
  catalog: MaintenanceCatalogProduct[],
) {
  const id = String(productId || "").trim();
  if (!id.startsWith(PERIODIC_VARIANT_PREFIX)) return null;
  const device = periodicCoolingCellVariantDevices(catalog).find((item) => item.id === id);
  if (!device) return null;
  const kit = catalog.find((item) => item.id === device.periodic_parent_kit_id);
  if (!kit || maintenanceKitKind(kit) !== "cooling_cells") return null;
  return { device, kit };
}
