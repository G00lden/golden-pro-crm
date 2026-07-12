import { MAX_OWNED_SCAN_LIMIT, type OwnedRecord } from "./repositories/ownedRepository";

const DEFAULT_STORE_ORDER_PAGE_SIZE = 50;
const MAX_STORE_ORDER_PAGE_SIZE = 100;

export type StoreOrderListQuery = {
  search: string;
  type: string;
  journey: string;
  status: string;
  city: string;
  product: string;
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

export function parseStoreOrderListQuery(query: Record<string, unknown>): StoreOrderListQuery {
  return {
    search: cleanFilter(query.search, 200),
    type: cleanFilter(query.type),
    journey: cleanFilter(query.journey),
    status: cleanFilter(query.status),
    city: cleanFilter(query.city),
    product: cleanFilter(query.product, 200),
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
    if (product && !itemRecords(order).some((item) =>
      [item.name, item.sku, item.remote_item_id].map(normalized).some((value) => value.includes(product)))) return false;
    const total = orderTotal(order);
    if (query.minTotal !== null && (total === null || total < query.minTotal)) return false;
    if (query.maxTotal !== null && (total === null || total > query.maxTotal)) return false;
    return !search || searchableOrderValue(order).includes(search);
  });
}

export function paginateStoreOrderRecords(
  orders: OwnedRecord[],
  query: Pick<StoreOrderListQuery, "page" | "pageSize">,
  options: { total?: number; capped?: boolean } = {},
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
  };
}
