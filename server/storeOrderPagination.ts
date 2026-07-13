import { MAX_OWNED_SCAN_LIMIT, type OwnedRecord } from "./repositories/ownedRepository";
import { firstSallaDate } from "./sallaDate";

const DEFAULT_STORE_ORDER_PAGE_SIZE = 50;
const MAX_STORE_ORDER_PAGE_SIZE = 100;
const STORE_ORDER_SORTS = new Set([
  "order_created_at",
  "order_date",
  "remote_updated_at",
  "total",
  "order_number",
  "customer_name",
]);

export type StoreOrderFacetValue = { value: string; count: number };
export type StoreOrderFacets = {
  status: StoreOrderFacetValue[];
  city: StoreOrderFacetValue[];
  payment_method: StoreOrderFacetValue[];
  shipping_company: StoreOrderFacetValue[];
  shipment_status: StoreOrderFacetValue[];
  country: StoreOrderFacetValue[];
  sales_channel: StoreOrderFacetValue[];
  assigned_employee: StoreOrderFacetValue[];
  pickup_branch: StoreOrderFacetValue[];
  tag: StoreOrderFacetValue[];
  read_state: StoreOrderFacetValue[];
  order_kind: StoreOrderFacetValue[];
};

export type StoreOrderListQuery = {
  search: string;
  type: string;
  journey: string;
  status: string;
  city: string;
  product: string;
  dateFrom: string;
  dateTo: string;
  paymentMethod: string;
  shippingCompany: string;
  shipmentStatus: string;
  country: string;
  salesChannel: string;
  assignedEmployee: string;
  pickupBranch: string;
  tag: string;
  readState: "" | "read" | "unread";
  orderKind: "" | "order" | "price_quote";
  sortBy: "order_created_at" | "order_date" | "remote_updated_at" | "total" | "order_number" | "customer_name";
  sortDirection: "asc" | "desc";
  minTotal: number | null;
  maxTotal: number | null;
  page: number;
  pageSize: number;
};

export type StoreOrderPage = {
  data: OwnedRecord[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasNext: boolean;
  hasPrevious: boolean;
  capped: boolean;
  warning: string | null;
  facets: StoreOrderFacets;
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

function optionalNonNegativeNumber(value: unknown) {
  const raw = firstQueryValue(value);
  if (raw === null || raw === undefined || raw === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function cleanDate(value: unknown) {
  const candidate = cleanFilter(value, 10);
  const match = candidate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "";
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() + 1 === Number(match[2]) &&
    date.getUTCDate() === Number(match[3])
    ? candidate
    : "";
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T) {
  const candidate = cleanFilter(value).toLowerCase() as T;
  return allowed.includes(candidate) ? candidate : fallback;
}

export function parseStoreOrderListQuery(query: Record<string, unknown>): StoreOrderListQuery {
  return {
    search: cleanFilter(query.search, 200),
    type: cleanFilter(query.type),
    journey: cleanFilter(query.journey),
    status: cleanFilter(query.status),
    city: cleanFilter(query.city),
    product: cleanFilter(query.product, 200),
    dateFrom: cleanDate(query.date_from ?? query.dateFrom),
    dateTo: cleanDate(query.date_to ?? query.dateTo),
    paymentMethod: cleanFilter(query.payment_method ?? query.paymentMethod),
    shippingCompany: cleanFilter(query.shipping_company ?? query.shippingCompany),
    shipmentStatus: cleanFilter(query.shipment_status ?? query.shipmentStatus),
    country: cleanFilter(query.country),
    salesChannel: cleanFilter(query.sales_channel ?? query.salesChannel),
    assignedEmployee: cleanFilter(query.assigned_employee ?? query.assignedEmployee),
    pickupBranch: cleanFilter(query.pickup_branch ?? query.pickupBranch),
    tag: cleanFilter(query.tag),
    readState: enumValue(query.read_state ?? query.readState, ["", "read", "unread"] as const, ""),
    orderKind: enumValue(query.order_kind ?? query.orderKind, ["", "order", "price_quote"] as const, ""),
    sortBy: enumValue(
      query.sort_by ?? query.sortBy,
      [...STORE_ORDER_SORTS] as StoreOrderListQuery["sortBy"][],
      "order_created_at",
    ),
    sortDirection: enumValue(query.sort_direction ?? query.sortDirection, ["asc", "desc"] as const, "desc"),
    minTotal: optionalNonNegativeNumber(query.min_total ?? query.minTotal),
    maxTotal: optionalNonNegativeNumber(query.max_total ?? query.maxTotal),
    page: boundedQueryInteger(query.page, 1, 1, MAX_OWNED_SCAN_LIMIT),
    pageSize: boundedQueryInteger(
      query.pageSize ?? query.page_size,
      DEFAULT_STORE_ORDER_PAGE_SIZE,
      1,
      MAX_STORE_ORDER_PAGE_SIZE,
    ),
  };
}

function orderTotal(order: OwnedRecord) {
  const hasDirectTotal = order.total !== null && order.total !== undefined && order.total !== "";
  const direct = hasDirectTotal ? Number(order.total) : Number.NaN;
  if (hasDirectTotal && Number.isFinite(direct)) return direct;
  const itemTotals = itemRecords(order).map((item) => {
    const hasItemTotal = item.total_price !== null && item.total_price !== undefined && item.total_price !== "";
    const total = hasItemTotal ? Number(item.total_price) : Number.NaN;
    if (hasItemTotal && Number.isFinite(total)) return total;
    const hasUnitPrice = item.unit_price !== null && item.unit_price !== undefined && item.unit_price !== "";
    const unit = hasUnitPrice ? Number(item.unit_price) : Number.NaN;
    const quantity = Number(item.quantity || 1);
    return hasUnitPrice && Number.isFinite(unit) && Number.isFinite(quantity) ? unit * quantity : 0;
  });
  return itemTotals.length ? itemTotals.reduce((sum, value) => sum + value, 0) : null;
}

function normalized(value: unknown) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("ar");
}

function itemRecords(order: OwnedRecord) {
  return Array.isArray(order.items)
    ? order.items.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    : [];
}

function booleanValue(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value !== 0;
  if (typeof value !== "string") return null;
  const candidate = value.trim().toLowerCase();
  if (["true", "1", "yes", "read"].includes(candidate)) return true;
  if (["false", "0", "no", "unread"].includes(candidate)) return false;
  return null;
}

function orderTags(order: OwnedRecord) {
  const value = order.order_tags ?? order.orderTags;
  if (Array.isArray(value)) return value.map((item) => {
    if (item && typeof item === "object") {
      const tag = item as Record<string, unknown>;
      return String(tag.name ?? tag.title ?? tag.slug ?? tag.value ?? "").trim();
    }
    return String(item ?? "").trim();
  }).filter(Boolean);
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map((item) => String(item ?? "").trim()).filter(Boolean);
  } catch {
    // Legacy SQLite rows may contain a comma-delimited tag string.
  }
  return value.split(/[,،|]/).map((item) => item.trim()).filter(Boolean);
}

function orderLocalDate(order: OwnedRecord) {
  const direct = cleanDate(order.order_date ?? order.orderDate);
  if (direct) return direct;
  return firstSallaDate(
    [order.order_created_at ?? order.orderCreatedAt],
    String(order.order_timezone ?? order.orderTimezone ?? "Asia/Riyadh"),
  )?.orderDate || "";
}

function searchableOrderValue(order: OwnedRecord) {
  return [
    order.order_number,
    order.order_id,
    order.customer_name,
    order.customer_phone,
    order.customer_city,
    order.status,
    order.remote_status_name,
    order.remote_status_slug,
    order.payment_method,
    order.shipping_company,
    order.shipment_status,
    order.country,
    order.sales_channel,
    order.assigned_employee,
    order.pickup_branch,
    ...orderTags(order),
    ...itemRecords(order).flatMap((item) => [item.name, item.sku, item.remote_item_id]),
  ].map(normalized).join(" ");
}

function orderMatchesType(order: OwnedRecord, requestedType: string) {
  if (!requestedType || requestedType === "all") return true;
  if (order.journey_status === requestedType) return true;
  if (Array.isArray(order.order_types) && order.order_types.includes(requestedType)) return true;
  return itemRecords(order).some((item) =>
    item.status === requestedType ||
    item.manual_type === requestedType ||
    item.order_type === requestedType,
  );
}

export function filterStoreOrderRecords(orders: OwnedRecord[], query: StoreOrderListQuery) {
  const search = normalized(query.search.trim());
  const journey = normalized(query.journey.trim());
  const status = normalized(query.status.trim());
  const city = normalized(query.city.trim());
  const product = normalized(query.product.trim());
  const paymentMethod = normalized(query.paymentMethod.trim());
  const shippingCompany = normalized(query.shippingCompany.trim());
  const shipmentStatus = normalized(query.shipmentStatus.trim());
  const country = normalized(query.country.trim());
  const salesChannel = normalized(query.salesChannel.trim());
  const assignedEmployee = normalized(query.assignedEmployee.trim());
  const pickupBranch = normalized(query.pickupBranch.trim());
  const tag = normalized(query.tag.trim());
  return orders.filter((order) => {
    if (!orderMatchesType(order, query.type)) return false;
    if (
      journey &&
      normalized(order.journey_status) !== journey &&
      !itemRecords(order).some((item) => normalized(item.status) === journey)
    ) return false;
    if (
      status &&
      normalized(order.status) !== status &&
      normalized(order.remote_status_slug) !== status &&
      normalized(order.remote_status_name) !== status
    ) return false;
    if (city && normalized(order.customer_city) !== city) return false;
    const localDate = orderLocalDate(order);
    if (query.dateFrom && (!localDate || localDate < query.dateFrom)) return false;
    if (query.dateTo && (!localDate || localDate > query.dateTo)) return false;
    if (paymentMethod && normalized(order.payment_method) !== paymentMethod) return false;
    if (shippingCompany && normalized(order.shipping_company) !== shippingCompany) return false;
    if (shipmentStatus && normalized(order.shipment_status) !== shipmentStatus) return false;
    if (country && normalized(order.country) !== country) return false;
    if (salesChannel && normalized(order.sales_channel) !== salesChannel) return false;
    if (assignedEmployee && normalized(order.assigned_employee) !== assignedEmployee) return false;
    if (pickupBranch && normalized(order.pickup_branch) !== pickupBranch) return false;
    if (tag && !orderTags(order).some((value) => normalized(value) === tag)) return false;
    const isRead = booleanValue(order.is_read ?? order.isRead);
    if (query.readState === "read" && isRead !== true) return false;
    if (query.readState === "unread" && isRead !== false) return false;
    const isPriceQuote = booleanValue(order.is_price_quote ?? order.isPriceQuote) === true;
    if (query.orderKind === "price_quote" && !isPriceQuote) return false;
    if (query.orderKind === "order" && isPriceQuote) return false;
    if (product && !itemRecords(order).some((item) =>
      [item.name, item.sku, item.remote_item_id].map(normalized).some((value) => value.includes(product)))) return false;
    const total = orderTotal(order);
    if (query.minTotal !== null && (total === null || total < query.minTotal)) return false;
    if (query.maxTotal !== null && (total === null || total > query.maxTotal)) return false;
    return !search || searchableOrderValue(order).includes(search);
  });
}

const orderCollator = new Intl.Collator("ar", { numeric: true, sensitivity: "base" });

function timestampValue(value: unknown) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function compareNullable<T>(
  left: T | null,
  right: T | null,
  direction: "asc" | "desc",
  compare: (a: T, b: T) => number,
) {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  const result = compare(left, right);
  return direction === "asc" ? result : -result;
}

function stableOrderTieBreak(left: OwnedRecord, right: OwnedRecord) {
  const created = compareNullable(
    timestampValue(left.order_created_at ?? left.orderCreatedAt),
    timestampValue(right.order_created_at ?? right.orderCreatedAt),
    "desc",
    (a, b) => a - b,
  );
  if (created) return created;
  const number = orderCollator.compare(String(right.order_number || right.order_id || ""), String(left.order_number || left.order_id || ""));
  if (number) return number;
  return String(left.id || "").localeCompare(String(right.id || ""));
}

export function sortStoreOrderRecords(orders: OwnedRecord[], query: StoreOrderListQuery) {
  const sorted = [...orders];
  sorted.sort((left, right) => {
    let result = 0;
    if (query.sortBy === "order_created_at") {
      result = compareNullable(
        timestampValue(left.order_created_at ?? left.orderCreatedAt ?? left.order_date),
        timestampValue(right.order_created_at ?? right.orderCreatedAt ?? right.order_date),
        query.sortDirection,
        (a, b) => a - b,
      );
    } else if (query.sortBy === "order_date") {
      result = compareNullable(
        orderLocalDate(left) || null,
        orderLocalDate(right) || null,
        query.sortDirection,
        (a, b) => a.localeCompare(b),
      );
    } else if (query.sortBy === "remote_updated_at") {
      result = compareNullable(
        timestampValue(left.remote_updated_at ?? left.remoteUpdatedAt),
        timestampValue(right.remote_updated_at ?? right.remoteUpdatedAt),
        query.sortDirection,
        (a, b) => a - b,
      );
    } else if (query.sortBy === "total") {
      result = compareNullable(orderTotal(left), orderTotal(right), query.sortDirection, (a, b) => a - b);
    } else if (query.sortBy === "order_number") {
      const leftNumber = String(left.order_number || left.order_id || "").trim() || null;
      const rightNumber = String(right.order_number || right.order_id || "").trim() || null;
      result = compareNullable(leftNumber, rightNumber, query.sortDirection, (a, b) => orderCollator.compare(a, b));
    } else if (query.sortBy === "customer_name") {
      const leftName = String(left.customer_name || "").trim() || null;
      const rightName = String(right.customer_name || "").trim() || null;
      result = compareNullable(leftName, rightName, query.sortDirection, (a, b) => orderCollator.compare(a, b));
    }
    return result || stableOrderTieBreak(left, right);
  });
  return sorted;
}

function facetValues(entries: Array<string | null | undefined>) {
  const values = new Map<string, StoreOrderFacetValue>();
  for (const raw of entries) {
    const value = String(raw ?? "").trim();
    if (!value) continue;
    const key = normalized(value);
    const current = values.get(key);
    if (current) current.count += 1;
    else values.set(key, { value, count: 1 });
  }
  return [...values.values()].sort((left, right) => orderCollator.compare(left.value, right.value));
}

export function buildStoreOrderFacets(orders: OwnedRecord[]): StoreOrderFacets {
  return {
    status: facetValues(orders.map((order) => String(order.remote_status_slug || order.status || ""))),
    city: facetValues(orders.map((order) => String(order.customer_city || ""))),
    payment_method: facetValues(orders.map((order) => String(order.payment_method || ""))),
    shipping_company: facetValues(orders.map((order) => String(order.shipping_company || ""))),
    shipment_status: facetValues(orders.map((order) => String(order.shipment_status || ""))),
    country: facetValues(orders.map((order) => String(order.country || ""))),
    sales_channel: facetValues(orders.map((order) => String(order.sales_channel || ""))),
    assigned_employee: facetValues(orders.map((order) => String(order.assigned_employee || ""))),
    pickup_branch: facetValues(orders.map((order) => String(order.pickup_branch || ""))),
    tag: facetValues(orders.flatMap(orderTags)),
    read_state: facetValues(orders.flatMap((order) => {
      const read = booleanValue(order.is_read ?? order.isRead);
      return read === null ? [] : [read ? "read" : "unread"];
    })),
    order_kind: facetValues(orders.map((order) =>
      booleanValue(order.is_price_quote ?? order.isPriceQuote) === true ? "price_quote" : "order")),
  };
}

export function paginateStoreOrderRecords(
  orders: OwnedRecord[],
  query: Pick<StoreOrderListQuery, "page" | "pageSize">,
  options: { total?: number; capped?: boolean; facets?: StoreOrderFacets } = {},
): StoreOrderPage {
  const accessible = orders.slice(0, MAX_OWNED_SCAN_LIMIT);
  const requestedTotal = Number(options.total ?? orders.length);
  const total = Number.isFinite(requestedTotal)
    ? Math.max(accessible.length, Math.trunc(requestedTotal))
    : accessible.length;
  const capped = options.capped === true || orders.length > MAX_OWNED_SCAN_LIMIT || total > MAX_OWNED_SCAN_LIMIT;
  const pageSize = boundedQueryInteger(
    query.pageSize,
    DEFAULT_STORE_ORDER_PAGE_SIZE,
    1,
    MAX_STORE_ORDER_PAGE_SIZE,
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
    warning: capped
      ? `Store order browsing is limited to the first ${MAX_OWNED_SCAN_LIMIT} accessible records.`
      : null,
    facets: options.facets || buildStoreOrderFacets(accessible),
  };
}
