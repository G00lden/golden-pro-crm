import {
  MAX_OWNED_SCAN_LIMIT,
  type OwnedPage,
  type OwnedRecord,
} from "./repositories/ownedRepository";

const DEFAULT_CUSTOMER_PAGE_SIZE = 50;
const MAX_CUSTOMER_PAGE_SIZE = 100;

export type CustomerListQuery = {
  search: string;
  page: number;
  pageSize: number;
  all: boolean;
};

function firstQueryValue(value: unknown) {
  return Array.isArray(value) ? value[0] : value;
}

function boundedQueryInteger(value: unknown, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(firstQueryValue(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

export function parseCustomerListQuery(query: Record<string, unknown>): CustomerListQuery {
  const rawAll = String(firstQueryValue(query.all) ?? "").trim().toLowerCase();
  return {
    search: String(firstQueryValue(query.search) ?? "").trim().slice(0, 200),
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

function searchableCustomerValue(customer: OwnedRecord) {
  return [customer.name, customer.phone, customer.city]
    .map((value) => String(value ?? ""))
    .join(" ")
    .normalize("NFKC")
    .toLocaleLowerCase("ar");
}

export function filterCustomerRecords(customers: OwnedRecord[], search: string) {
  const needle = search.trim().normalize("NFKC").toLocaleLowerCase("ar");
  if (!needle) return customers;
  return customers.filter((customer) => searchableCustomerValue(customer).includes(needle));
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

