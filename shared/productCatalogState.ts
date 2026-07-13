export type ProductCatalogState = {
  catalog_visible?: unknown;
  merged_into?: unknown;
  store_status?: unknown;
};

function productState(product: unknown): ProductCatalogState {
  return product && typeof product === "object" && !Array.isArray(product)
    ? product as ProductCatalogState
    : {};
}

export function mergedProductTarget(product: unknown) {
  const state = productState(product);
  return String(state.merged_into || "").trim();
}

export function productIsMerged(product: unknown) {
  return Boolean(mergedProductTarget(product));
}

export function productIsManuallyDeleted(product: unknown) {
  return String(productState(product).store_status || "").trim().toLowerCase() === "manual_deleted";
}

export function productIsRetired(product: unknown) {
  return productIsMerged(product) || productIsManuallyDeleted(product);
}

/** Shared by server and direct-Firebase clients to keep provider behavior equal. */
export function catalogProductIsVisible(product: unknown) {
  if (productIsRetired(product)) return false;
  const value = productState(product).catalog_visible;
  return value !== false && value !== 0 && String(value).toLowerCase() !== "false";
}

export function visibleCatalogProducts<T>(products: readonly T[]) {
  return products.filter(catalogProductIsVisible);
}

export function visibleCatalogProductCount(products: readonly unknown[]) {
  return visibleCatalogProducts(products).length;
}
