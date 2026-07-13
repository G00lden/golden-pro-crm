export type ProductCatalogRecord = {
  id: string;
  data: Record<string, any>;
};

const CRM_POLICY_FIELDS = [
  "interval_months",
  "remind_text",
  "product_type",
  "service_mode",
  "policy_active",
  "service_tasks",
  "compatibility_group",
  "warranty_enabled",
  "warranty_months",
  "reminder_media_type",
  "reminder_media_url",
  "reminder_cta",
] as const;

function text(value: unknown) {
  return String(value ?? "").trim();
}

function listSize(value: unknown) {
  if (Array.isArray(value)) return value.length;
  if (typeof value !== "string" || !value.trim()) return 0;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

export function normalizeProductSku(value: unknown) {
  return text(value).replace(/\s+/g, "").toLocaleLowerCase("en-US");
}

function remoteId(record: ProductCatalogRecord) {
  return text(record.data.store_product_id);
}

function recordScore(record: ProductCatalogRecord) {
  const data = record.data;
  let score = 0;
  if (remoteId(record)) score += 100;
  if (text(data.source).toLowerCase() === "salla") score += 30;
  if (data.policy_active === true || data.policy_active === 1) score += 25;
  score += Math.min(20, listSize(data.service_tasks) * 3);
  if (text(data.remind_text)) score += 5;
  if (text(data.compatibility_group)) score += 5;
  if (text(data.image_url)) score += 2;
  return score;
}

function policyScore(record: ProductCatalogRecord) {
  const data = record.data;
  let score = 0;
  if (data.policy_active === true || data.policy_active === 1) score += 1_000;
  score += listSize(data.service_tasks) * 20;
  if (text(data.remind_text)) score += 10;
  if (text(data.compatibility_group)) score += 10;
  if (Number(data.warranty_months || 0) > 0) score += 5;
  return score;
}

/**
 * Build safe duplicate groups.
 *
 * Salla's product id is authoritative. SKU is only used to attach legacy or
 * manual rows when that SKU belongs to at most one remote product. If Salla
 * itself contains two different product ids with the same SKU, those products
 * remain separate just like they are in the store.
 */
export function buildProductDuplicateGroups(records: ProductCatalogRecord[]) {
  const parent = new Map(records.map((record) => [record.id, record.id]));
  const byId = new Map(records.map((record) => [record.id, record]));

  const find = (id: string): string => {
    const current = parent.get(id) || id;
    if (current === id) return id;
    const root = find(current);
    parent.set(id, root);
    return root;
  };
  const union = (left: string, right: string) => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent.set(b, a);
  };

  const remoteBuckets = new Map<string, ProductCatalogRecord[]>();
  const skuBuckets = new Map<string, ProductCatalogRecord[]>();
  for (const record of records) {
    const remote = remoteId(record);
    const sku = normalizeProductSku(record.data.sku);
    if (remote) remoteBuckets.set(remote, [...(remoteBuckets.get(remote) || []), record]);
    if (sku) skuBuckets.set(sku, [...(skuBuckets.get(sku) || []), record]);
  }

  for (const bucket of remoteBuckets.values()) {
    for (let index = 1; index < bucket.length; index += 1) union(bucket[0].id, bucket[index].id);
  }

  for (const bucket of skuBuckets.values()) {
    const remoteIds = new Set(bucket.map(remoteId).filter(Boolean));
    if (remoteIds.size <= 1) {
      for (let index = 1; index < bucket.length; index += 1) union(bucket[0].id, bucket[index].id);
      continue;
    }

    // Ambiguous SKU: keep each Salla product separate, but still collapse
    // multiple old rows that have no Salla id yet.
    const legacy = bucket.filter((record) => !remoteId(record));
    for (let index = 1; index < legacy.length; index += 1) union(legacy[0].id, legacy[index].id);
  }

  const groups = new Map<string, ProductCatalogRecord[]>();
  for (const id of byId.keys()) {
    const root = find(id);
    groups.set(root, [...(groups.get(root) || []), byId.get(id)!]);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

export function chooseCanonicalProduct(records: ProductCatalogRecord[]) {
  if (!records.length) throw new Error("Cannot choose a canonical product from an empty group.");
  return [...records].sort((left, right) => {
    const score = recordScore(right) - recordScore(left);
    if (score) return score;
    const leftCreated = text(left.data.createdAt || left.data.created_at);
    const rightCreated = text(right.data.createdAt || right.data.created_at);
    if (leftCreated && rightCreated && leftCreated !== rightCreated) return leftCreated.localeCompare(rightCreated);
    return left.id.localeCompare(right.id);
  })[0];
}

function meaningfulPolicyValue(field: string, value: unknown) {
  if (field === "service_tasks") return listSize(value) > 0;
  if (field === "policy_active" || field === "warranty_enabled") return value === true || value === 1;
  if (field === "interval_months" || field === "warranty_months") return Number(value || 0) > 0;
  return Boolean(text(value));
}

/** Keep CRM-only maintenance policy fields while Salla refreshes store fields. */
export function mergeProductCatalogRecords(records: ProductCatalogRecord[], canonicalId?: string) {
  const canonical = records.find((record) => record.id === canonicalId) || chooseCanonicalProduct(records);
  const merged: Record<string, any> = { ...canonical.data };
  const richFirst = [...records].sort((left, right) => policyScore(right) - policyScore(left));

  for (const field of CRM_POLICY_FIELDS) {
    const best = richFirst.find((record) => meaningfulPolicyValue(field, record.data[field]));
    if (best) merged[field] = best.data[field];
  }

  const createdDates = records
    .map((record) => text(record.data.createdAt || record.data.created_at))
    .filter(Boolean)
    .sort();
  if (createdDates[0]) merged.createdAt = createdDates[0];
  return merged;
}

export function duplicateProductCount(records: ProductCatalogRecord[]) {
  return buildProductDuplicateGroups(records).reduce((total, group) => total + group.length - 1, 0);
}
