import {
  MAX_OWNED_SCAN_LIMIT,
  type OwnedPage,
  type OwnedRecord,
} from "./repositories/ownedRepository";

const DEFAULT_CUSTOMER_PAGE_SIZE = 50;
const MAX_CUSTOMER_PAGE_SIZE = 100;
const RIYADH_TIME_ZONE = "Asia/Riyadh";
export const CUSTOMER_RECENT_ACTIVITY_DAYS = 90;

export type CustomerStatus = "active" | "blocked" | "unknown";
export type CustomerActivityFilter = "has_orders" | "no_orders" | "recent" | "inactive";
export type CustomerActivityStatus = "no_orders" | "recent" | "inactive" | "unknown";
export type CustomerSortBy = "name" | "created_at" | "last_order_at" | "orders_count" | "total_spent";
export type CustomerSortDirection = "asc" | "desc";

export type CustomerListQuery = {
  search: string;
  source: string;
  city: string;
  country: string;
  gender: string;
  group: string;
  status: CustomerStatus | "";
  activity: CustomerActivityFilter | "";
  dateFrom: string;
  dateTo: string;
  sortBy: CustomerSortBy;
  sortDirection: CustomerSortDirection;
  page: number;
  pageSize: number;
  all: boolean;
};

export type CustomerFacet = {
  value: string;
  label: string;
  count: number;
};

export type CustomerFacets = {
  sources: CustomerFacet[];
  cities: CustomerFacet[];
  countries: CustomerFacet[];
  genders: CustomerFacet[];
  groups: CustomerFacet[];
  statuses: CustomerFacet[];
};

export type CustomerOrderAggregationOptions = {
  now?: Date | string | number;
  recentDays?: number;
};

function firstQueryValue(value: unknown) {
  return Array.isArray(value) ? value[0] : value;
}

function boundedQueryInteger(value: unknown, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(firstQueryValue(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

function cleanFilter(value: unknown, maximum = 120) {
  return String(firstQueryValue(value) ?? "").trim().slice(0, maximum);
}

function allowedFilter<T extends string>(value: unknown, allowed: readonly T[], fallback: T | "" = "") {
  const cleaned = cleanFilter(value).toLowerCase();
  return (allowed as readonly string[]).includes(cleaned) ? cleaned as T : fallback;
}

function validDateOnly(value: unknown) {
  const cleaned = cleanFilter(value, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(cleaned);
  if (!match) return "";
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
    ? cleaned
    : "";
}

export function parseCustomerListQuery(query: Record<string, unknown>): CustomerListQuery {
  const rawAll = cleanFilter(query.all).toLowerCase();
  return {
    search: cleanFilter(query.search, 200),
    source: cleanFilter(query.source),
    city: cleanFilter(query.city),
    country: cleanFilter(query.country),
    gender: cleanFilter(query.gender),
    group: cleanFilter(query.group ?? query.customer_group),
    status: allowedFilter(query.status, ["active", "blocked", "unknown"] as const),
    activity: allowedFilter(query.activity, ["has_orders", "no_orders", "recent", "inactive"] as const),
    dateFrom: validDateOnly(query.date_from ?? query.dateFrom),
    dateTo: validDateOnly(query.date_to ?? query.dateTo),
    sortBy: allowedFilter(
      query.sort_by ?? query.sortBy,
      ["name", "created_at", "last_order_at", "orders_count", "total_spent"] as const,
      "name",
    ) as CustomerSortBy,
    sortDirection: allowedFilter(
      query.sort_direction ?? query.sortDirection ?? query.sort_dir,
      ["asc", "desc"] as const,
      "asc",
    ) as CustomerSortDirection,
    page: boundedQueryInteger(query.page, 1, 1, MAX_OWNED_SCAN_LIMIT),
    pageSize: boundedQueryInteger(
      query.pageSize ?? query.page_size,
      DEFAULT_CUSTOMER_PAGE_SIZE,
      1,
      MAX_CUSTOMER_PAGE_SIZE,
    ),
    all: rawAll === "true" || rawAll === "1" || rawAll === "yes",
  };
}

const arabicDigits = "٠١٢٣٤٥٦٧٨٩";
const persianDigits = "۰۱۲۳۴۵۶۷۸۹";

export function normalizeCustomerText(value: unknown) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[٠-٩]/g, (digit) => String(arabicDigits.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String(persianDigits.indexOf(digit)))
    .toLocaleLowerCase("ar")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeCustomerPhone(value: unknown) {
  let digits = normalizeCustomerText(value).replace(/\D/g, "");
  if (digits.startsWith("00966")) digits = digits.slice(2);
  if (/^05\d{8}$/.test(digits)) return `966${digits.slice(1)}`;
  if (/^5\d{8}$/.test(digits)) return `966${digits}`;
  return digits;
}

function firstText(...values: unknown[]) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

export function customerSource(customer: OwnedRecord) {
  return normalizeCustomerText(
    firstText(customer.store_provider, customer.storeProvider, customer.source, "unknown"),
  );
}

function booleanStatus(value: unknown): boolean | null {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  const normalized = normalizeCustomerText(value);
  if (["true", "1", "yes", "blocked"].includes(normalized)) return true;
  if (["false", "0", "no", "active"].includes(normalized)) return false;
  return null;
}

export function customerStatus(customer: OwnedRecord): CustomerStatus {
  if (customer.is_blocked !== undefined || customer.isBlocked !== undefined) {
    const blocked = booleanStatus(customer.is_blocked ?? customer.isBlocked);
    if (blocked !== null) return blocked ? "blocked" : "active";
  }
  const explicit = allowedFilter(customer.status, ["active", "blocked", "unknown"] as const);
  return explicit || "unknown";
}

function searchableCustomerValue(customer: OwnedRecord) {
  return [
    customer.name,
    customer.phone,
    customer.city,
    customer.country,
    customer.email,
    customer.store_customer_id,
    customer.storeCustomerId,
    normalizeCustomerPhone(customer.phone),
  ].map(normalizeCustomerText).join(" ");
}

const riyadhDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: RIYADH_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function dateOnlyInRiyadh(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return validDateOnly(text);
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) return "";
  const parts = Object.fromEntries(
    riyadhDateFormatter.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

type CustomerGroup = {
  value: string;
  label: string;
  aliases: string[];
};

function customerGroups(customer: OwnedRecord): CustomerGroup[] {
  const raw = customer.customer_groups ?? customer.customerGroups;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const groups: CustomerGroup[] = [];
  for (const item of raw) {
    if (item === null || item === undefined) continue;
    if (typeof item !== "object") {
      const label = String(item).trim();
      const value = normalizeCustomerText(label);
      if (!value || seen.has(value)) continue;
      seen.add(value);
      groups.push({ value, label, aliases: [value] });
      continue;
    }
    const record = item as Record<string, unknown>;
    const id = firstText(record.id);
    const name = firstText(record.name, record.title);
    const title = firstText(record.title);
    const value = normalizeCustomerText(id || name || title);
    const label = name || title || id;
    const aliases = [...new Set([id, name, title].map(normalizeCustomerText).filter(Boolean))];
    if (!value || !label || seen.has(value)) continue;
    seen.add(value);
    groups.push({ value, label, aliases });
  }
  return groups;
}

function dateText(value: unknown) {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return firstText(record.date, record.datetime, record.value);
  }
  return firstText(value);
}

function recordCreatedAt(customer: OwnedRecord) {
  for (const value of [customer.remote_created_at, customer.remoteCreatedAt, customer.createdAt, customer.created_at]) {
    const candidate = dateText(value);
    if (candidate && timestamp(candidate) !== null) return candidate;
  }
  return "";
}

function activityMatches(customer: OwnedRecord, requested: CustomerActivityFilter | "") {
  if (!requested) return true;
  const count = Number(customer.orders_count || 0);
  const status = String(customer.activity_status || "no_orders") as CustomerActivityStatus;
  if (requested === "has_orders") return Number.isFinite(count) && count > 0;
  if (requested === "no_orders") return !Number.isFinite(count) || count <= 0;
  return status === requested;
}

export function filterCustomerRecords(
  customers: OwnedRecord[],
  queryOrSearch: CustomerListQuery | string,
) {
  const query = typeof queryOrSearch === "string"
    ? parseCustomerListQuery({ search: queryOrSearch })
    : queryOrSearch;
  const search = normalizeCustomerText(query.search);
  const phoneSearch = /^[+\d\s().-]+$/.test(search) ? normalizeCustomerPhone(search) : "";
  const source = normalizeCustomerText(query.source);
  const city = normalizeCustomerText(query.city);
  const country = normalizeCustomerText(query.country);
  const gender = normalizeCustomerText(query.gender);
  const group = normalizeCustomerText(query.group);

  if (query.dateFrom && query.dateTo && query.dateFrom > query.dateTo) return [];

  return customers.filter((customer) => {
    if (search) {
      const searchable = searchableCustomerValue(customer);
      if (!searchable.includes(search) && (!phoneSearch || !searchable.includes(phoneSearch))) return false;
    }
    if (source && customerSource(customer) !== source) return false;
    if (city && normalizeCustomerText(customer.city) !== city) return false;
    if (country && normalizeCustomerText(customer.country) !== country) return false;
    if (gender && normalizeCustomerText(customer.gender) !== gender) return false;
    if (group && !customerGroups(customer).some((candidate) => candidate.aliases.includes(group))) return false;
    if (query.status && customerStatus(customer) !== query.status) return false;
    if (!activityMatches(customer, query.activity)) return false;
    if (query.dateFrom || query.dateTo) {
      const createdDate = dateOnlyInRiyadh(recordCreatedAt(customer));
      if (!createdDate) return false;
      if (query.dateFrom && createdDate < query.dateFrom) return false;
      if (query.dateTo && createdDate > query.dateTo) return false;
    }
    return true;
  });
}

function finiteAmount(value: unknown): number | null {
  const candidate = value && typeof value === "object"
    ? (value as Record<string, unknown>).amount ?? (value as Record<string, unknown>).value
    : value;
  if (candidate === null || candidate === undefined || candidate === "") return null;
  const amount = Number(candidate);
  return Number.isFinite(amount) ? amount : null;
}

function orderTotal(order: OwnedRecord) {
  const direct = finiteAmount(order.total ?? order.total_amount ?? order.amount);
  if (direct !== null) return direct;
  if (!Array.isArray(order.items)) return 0;
  return order.items.reduce((sum: number, item: unknown) => {
    if (!item || typeof item !== "object") return sum;
    const record = item as Record<string, unknown>;
    const itemTotal = finiteAmount(record.total_price ?? record.total);
    if (itemTotal !== null) return sum + itemTotal;
    const unit = finiteAmount(record.unit_price ?? record.price);
    const quantity = Number(record.quantity ?? 1);
    return unit !== null && Number.isFinite(quantity) ? sum + unit * quantity : sum;
  }, 0);
}

function orderDate(order: OwnedRecord) {
  return firstText(
    order.order_created_at,
    order.orderCreatedAt,
    order.order_date,
    order.orderDate,
  ) || null;
}

function timestamp(value: unknown) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function roundedMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function enrichCustomerRecordsWithOrders(
  customers: OwnedRecord[],
  orders: OwnedRecord[],
  options: CustomerOrderAggregationOptions = {},
) {
  const byId = new Map(customers.map((customer) => [String(customer.id), customer]));
  const byPhone = new Map<string, OwnedRecord[]>();
  for (const customer of customers) {
    const phone = normalizeCustomerPhone(customer.phone);
    if (!phone) continue;
    const matches = byPhone.get(phone) || [];
    matches.push(customer);
    byPhone.set(phone, matches);
  }

  type Aggregate = { count: number; total: number; lastOrderAt: string | null; lastOrderMs: number | null };
  const aggregates = new Map<string, Aggregate>();
  for (const order of orders) {
    const requestedId = firstText(order.customer_id, order.customerId);
    let customer = requestedId ? byId.get(requestedId) : undefined;
    if (!customer) {
      const phone = normalizeCustomerPhone(order.customer_phone ?? order.customerPhone);
      const phoneMatches = phone ? byPhone.get(phone) || [] : [];
      // A duplicate phone is not a safe identity. Such orders remain unassigned
      // unless their immutable local customer_id is present.
      if (phoneMatches.length === 1) customer = phoneMatches[0];
    }
    if (!customer) continue;

    const key = String(customer.id);
    const aggregate = aggregates.get(key) || { count: 0, total: 0, lastOrderAt: null, lastOrderMs: null };
    aggregate.count += 1;
    aggregate.total += orderTotal(order);
    const candidateDate = orderDate(order);
    const candidateMs = timestamp(candidateDate);
    if (
      candidateDate && candidateMs !== null &&
      (aggregate.lastOrderMs === null || candidateMs > aggregate.lastOrderMs)
    ) {
      aggregate.lastOrderAt = candidateDate;
      aggregate.lastOrderMs = candidateMs;
    }
    aggregates.set(key, aggregate);
  }

  const nowValue = options.now instanceof Date ? options.now.getTime() : new Date(options.now ?? Date.now()).getTime();
  const safeNow = Number.isFinite(nowValue) ? nowValue : Date.now();
  const requestedRecentDays = Number(options.recentDays ?? CUSTOMER_RECENT_ACTIVITY_DAYS);
  const recentDays = Number.isFinite(requestedRecentDays) && requestedRecentDays >= 0
    ? requestedRecentDays
    : CUSTOMER_RECENT_ACTIVITY_DAYS;
  const recentCutoff = safeNow - recentDays * 86_400_000;

  return customers.map((customer) => {
    const aggregate = aggregates.get(String(customer.id)) || {
      count: 0,
      total: 0,
      lastOrderAt: null,
      lastOrderMs: null,
    };
    const activityStatus: CustomerActivityStatus = aggregate.count === 0
      ? "no_orders"
      : aggregate.lastOrderMs === null
        ? "unknown"
        : aggregate.lastOrderMs >= recentCutoff
          ? "recent"
          : "inactive";
    return {
      ...customer,
      orders_count: aggregate.count,
      total_spent: roundedMoney(aggregate.total),
      last_order_at: aggregate.lastOrderAt,
      activity_status: activityStatus,
    };
  });
}

function nullableSortValue(customer: OwnedRecord, sortBy: CustomerSortBy): string | number | null {
  if (sortBy === "name") return normalizeCustomerText(customer.name) || null;
  if (sortBy === "created_at") return timestamp(recordCreatedAt(customer));
  if (sortBy === "last_order_at") return timestamp(customer.last_order_at);
  const raw = customer[sortBy];
  if (raw === null || raw === undefined || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function sortCustomerRecords(
  customers: OwnedRecord[],
  query: Pick<CustomerListQuery, "sortBy" | "sortDirection">,
) {
  const direction = query.sortDirection === "desc" ? -1 : 1;
  return [...customers].sort((left, right) => {
    const leftValue = nullableSortValue(left, query.sortBy);
    const rightValue = nullableSortValue(right, query.sortBy);
    if (leftValue === null && rightValue !== null) return 1;
    if (leftValue !== null && rightValue === null) return -1;
    if (leftValue !== null && rightValue !== null) {
      const compared = typeof leftValue === "number" && typeof rightValue === "number"
        ? leftValue - rightValue
        : String(leftValue).localeCompare(String(rightValue), "ar", { numeric: true, sensitivity: "base" });
      if (compared !== 0) return compared * direction;
    }
    return String(left.id).localeCompare(String(right.id), "en", { numeric: true });
  });
}

function buildFacet(
  customers: OwnedRecord[],
  valueOf: (customer: OwnedRecord) => { value: string; label: string } | null,
) {
  const counts = new Map<string, CustomerFacet>();
  for (const customer of customers) {
    const candidate = valueOf(customer);
    if (!candidate?.value) continue;
    const existing = counts.get(candidate.value);
    if (existing) existing.count += 1;
    else counts.set(candidate.value, { ...candidate, count: 1 });
  }
  return [...counts.values()].sort((left, right) =>
    left.label.localeCompare(right.label, "ar", { numeric: true, sensitivity: "base" }));
}

function textFacet(value: unknown) {
  const label = String(value ?? "").trim();
  const normalized = normalizeCustomerText(label);
  return normalized ? { value: normalized, label } : null;
}

export function buildCustomerFacets(customers: OwnedRecord[]): CustomerFacets {
  return {
    sources: buildFacet(customers, (customer) => {
      const value = customerSource(customer);
      return { value, label: value };
    }),
    cities: buildFacet(customers, (customer) => textFacet(customer.city)),
    countries: buildFacet(customers, (customer) => textFacet(customer.country)),
    genders: buildFacet(customers, (customer) => textFacet(customer.gender)),
    groups: (() => {
      const counts = new Map<string, CustomerFacet>();
      for (const customer of customers) {
        for (const group of customerGroups(customer)) {
          const existing = counts.get(group.value);
          if (existing) existing.count += 1;
          else counts.set(group.value, { value: group.value, label: group.label, count: 1 });
        }
      }
      return [...counts.values()].sort((left, right) =>
        left.label.localeCompare(right.label, "ar", { numeric: true, sensitivity: "base" }));
    })(),
    statuses: buildFacet(customers, (customer) => {
      const value = customerStatus(customer);
      return { value, label: value };
    }),
  };
}

export function paginateCustomerRecords(
  customers: OwnedRecord[],
  query: Pick<CustomerListQuery, "page" | "pageSize" | "all">,
  options: { total?: number; capped?: boolean } = {},
): OwnedPage {
  const accessible = customers.slice(0, MAX_OWNED_SCAN_LIMIT);
  const requestedTotal = Number(options.total ?? accessible.length);
  const total = Number.isFinite(requestedTotal)
    ? Math.max(accessible.length, Math.trunc(requestedTotal))
    : accessible.length;
  const capped = options.capped === true || customers.length > MAX_OWNED_SCAN_LIMIT;

  if (query.all) {
    return {
      data: accessible,
      total,
      page: 1,
      pageSize: Math.max(1, accessible.length),
      totalPages: 1,
      hasNext: false,
      hasPrevious: false,
      capped,
    };
  }

  const pageSize = boundedQueryInteger(
    query.pageSize,
    DEFAULT_CUSTOMER_PAGE_SIZE,
    1,
    MAX_CUSTOMER_PAGE_SIZE,
  );
  const totalPages = Math.max(1, Math.ceil(accessible.length / pageSize));
  const page = boundedQueryInteger(query.page, 1, 1, totalPages);
  const start = (page - 1) * pageSize;

  return {
    data: accessible.slice(start, start + pageSize),
    total,
    page,
    pageSize,
    totalPages,
    hasNext: page < totalPages,
    hasPrevious: page > 1,
    capped,
  };
}
