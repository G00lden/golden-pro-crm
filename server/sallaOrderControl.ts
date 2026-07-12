import crypto from "node:crypto";

type UnknownRecord = Record<string, unknown>;

export type SallaOrderStatus = {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  sort: number;
  type: string | null;
  original: string | null;
  parent: string | null;
  message: string | null;
};

export type SallaStatusCommand = {
  request: { slug?: string; status_id?: number; restore_items?: boolean };
  desired: SallaOrderStatus;
};

const UPDATE_ORDER_KEYS = new Set([
  "customer",
  "receiver",
  "delivery_method",
  "branch_id",
  "courier_id",
  "ship_to",
  "payment",
  "coupon_code",
  "employees",
]);

const SHIP_TO_KEYS = new Set([
  "country",
  "city",
  "district",
  "address",
  "address_line",
  "street_number",
  "block",
  "short_address",
  "building_number",
  "additional_number",
  "postal_code",
  "geo_coordinates",
]);

const NATIONAL_ADDRESS_REQUIRED_KEYS = [
  "country",
  "city",
  "address_line",
  "street_number",
  "block",
  "short_address",
  "building_number",
  "additional_number",
  "postal_code",
  "geo_coordinates",
];

function httpError(status: number, message: string) {
  const error = new Error(message) as Error & { status?: number };
  error.status = status;
  return error;
}

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function text(value: unknown, maximum = 500) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function integer(value: unknown) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function stableJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as UnknownRecord;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sallaOrderPayloadHash(value: unknown) {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

export function hasSallaScope(scope: unknown, required: string) {
  return String(scope || "").split(/\s+/).filter(Boolean).includes(required);
}

export function assertSallaOrderWriteScope(scope: unknown) {
  if (!hasSallaScope(scope, "orders.read_write")) {
    throw httpError(412, "Salla connection is missing the orders.read_write permission. Reconnect the app first.");
  }
}

export function normalizeSallaStatuses(payload: unknown): SallaOrderStatus[] {
  const body = asRecord(payload);
  const rows = Array.isArray(body.data) ? body.data : Array.isArray(payload) ? payload : [];
  return rows.map(asRecord).map((status) => {
    const parent = asRecord(status.parent);
    return {
      id: String(status.id ?? "").trim(),
      name: text(status.name, 120),
      slug: text(status.slug, 80),
      isActive: status.is_active !== false,
      sort: Number.isFinite(Number(status.sort)) ? Number(status.sort) : 0,
      type: text(status.type, 40) || null,
      original: text(status.original, 80) || null,
      parent: (() => {
        const value = parent.id ?? parent.slug ?? status.parent_id ?? status.parent;
        return value === null || value === undefined ? null : text(String(value), 80) || null;
      })(),
      message: text(status.message, 500) || null,
    };
  }).filter((status) => status.id && status.slug).sort((left, right) => left.sort - right.sort);
}

export function normalizeSallaStatusCommand(
  input: unknown,
  statuses: SallaOrderStatus[],
): SallaStatusCommand {
  const body = asRecord(input);
  const slug = text(body.slug, 80);
  const statusId = integer(body.status_id ?? body.statusId);
  if ((!slug && !statusId) || (slug && statusId)) {
    throw httpError(400, "Provide exactly one Salla status slug or status_id.");
  }
  const desired = statuses.find((status) => slug ? status.slug === slug : status.id === String(statusId));
  if (!desired) throw httpError(422, "The requested status is not available in this Salla store.");
  if (!desired.isActive) throw httpError(422, "The requested Salla status is inactive.");

  const request: SallaStatusCommand["request"] = slug
    ? { slug: desired.slug }
    : { status_id: Number(desired.id) };
  if (body.restore_items !== undefined) {
    if (typeof body.restore_items !== "boolean") throw httpError(400, "restore_items must be a boolean.");
    request.restore_items = body.restore_items;
  }
  return { request, desired };
}

function copyAllowedRecord(input: unknown, keys: string[], label: string) {
  const source = asRecord(input);
  if (!Object.keys(source).length) throw httpError(400, `${label} must be a non-empty object.`);
  const unknown = Object.keys(source).filter((key) => !keys.includes(key));
  if (unknown.length) throw httpError(400, `${label} contains unsupported fields: ${unknown.join(", ")}.`);
  return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined));
}

function validateOptionalString(record: UnknownRecord, key: string, label: string, maximum: number, minimum = 1) {
  if (record[key] === undefined) return;
  if (typeof record[key] !== "string") throw httpError(400, `${label}.${key} must be a string.`);
  const value = record[key].trim();
  if (value.length < minimum || value.length > maximum) {
    throw httpError(400, `${label}.${key} must contain ${minimum}-${maximum} characters.`);
  }
  record[key] = value;
}

function validateOptionalEmail(record: UnknownRecord, label: string) {
  if (record.email === undefined) return;
  validateOptionalString(record, "email", label, 254, 3);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(record.email))) {
    throw httpError(400, `${label}.email is invalid.`);
  }
}

function sanitizeCustomer(value: unknown) {
  const customer = copyAllowedRecord(value, ["id", "name", "mobile", "email"], "customer");
  if (customer.id !== undefined && !integer(customer.id)) throw httpError(400, "customer.id must be a positive integer.");
  if (customer.id !== undefined) customer.id = integer(customer.id);
  validateOptionalString(customer, "name", "customer", 120);
  validateOptionalString(customer, "mobile", "customer", 30, 5);
  if (customer.mobile !== undefined && !/^\+?[0-9]{5,30}$/.test(String(customer.mobile))) {
    throw httpError(400, "customer.mobile must contain digits with an optional leading +.");
  }
  validateOptionalEmail(customer, "customer");
  return customer;
}

function sanitizeReceiver(value: unknown) {
  const receiver = copyAllowedRecord(value, ["name", "country_code", "phone", "email", "notify"], "receiver");
  validateOptionalString(receiver, "name", "receiver", 120);
  validateOptionalString(receiver, "country_code", "receiver", 8, 2);
  validateOptionalString(receiver, "phone", "receiver", 30, 5);
  if (receiver.phone !== undefined && !/^\+?[0-9]{5,30}$/.test(String(receiver.phone))) {
    throw httpError(400, "receiver.phone must contain digits with an optional leading +.");
  }
  validateOptionalEmail(receiver, "receiver");
  if (receiver.notify !== undefined && typeof receiver.notify !== "boolean") {
    throw httpError(400, "receiver.notify must be a boolean.");
  }
  return receiver;
}

function sanitizePayment(value: unknown) {
  const payment = copyAllowedRecord(
    value,
    ["status", "method", "store_bank_id", "receipt_image_path", "accepted_methods", "cash_on_delivery"],
    "payment",
  );
  validateOptionalString(payment, "status", "payment", 40);
  validateOptionalString(payment, "method", "payment", 80);
  validateOptionalString(payment, "receipt_image_path", "payment", 1_000);
  if (payment.store_bank_id !== undefined) {
    const bankId = integer(payment.store_bank_id);
    if (!bankId) throw httpError(400, "payment.store_bank_id must be a positive integer.");
    payment.store_bank_id = bankId;
  }
  if (payment.accepted_methods !== undefined) {
    if (!Array.isArray(payment.accepted_methods) || payment.accepted_methods.length > 20 ||
      payment.accepted_methods.some((method) => typeof method !== "string" || !method.trim() || method.length > 80)) {
      throw httpError(400, "payment.accepted_methods must contain at most 20 non-empty strings.");
    }
    payment.accepted_methods = payment.accepted_methods.map((method) => String(method).trim());
  }
  if (payment.cash_on_delivery !== undefined) {
    const cash = copyAllowedRecord(payment.cash_on_delivery, ["amount", "currency"], "payment.cash_on_delivery");
    const amount = Number(cash.amount);
    if (!Number.isFinite(amount) || amount < 0) throw httpError(400, "payment.cash_on_delivery.amount must be zero or greater.");
    if (typeof cash.currency !== "string" || !/^[A-Za-z]{3,12}$/.test(cash.currency.trim())) {
      throw httpError(400, "payment.cash_on_delivery.currency is invalid.");
    }
    payment.cash_on_delivery = { amount, currency: cash.currency.trim().toUpperCase() };
  }
  return payment;
}

function sanitizeShipTo(value: unknown) {
  const shipTo = asRecord(value);
  const unknown = Object.keys(shipTo).filter((key) => !SHIP_TO_KEYS.has(key));
  if (unknown.length) throw httpError(400, `ship_to contains unsupported fields: ${unknown.join(", ")}.`);
  const missing = NATIONAL_ADDRESS_REQUIRED_KEYS.filter((key) => {
    const field = shipTo[key];
    return field === null || field === undefined || field === "";
  });
  if (missing.length) {
    throw httpError(422, `ship_to is missing mandatory National Address fields: ${missing.join(", ")}.`);
  }
  for (const key of ["country", "city", "district"]) {
    if (shipTo[key] === undefined) continue;
    const id = integer(shipTo[key]);
    if (!id) throw httpError(400, `ship_to.${key} must be a positive integer id.`);
    shipTo[key] = id;
  }
  for (const key of [
    "address_line",
    "street_number",
    "block",
    "short_address",
    "building_number",
    "additional_number",
    "postal_code",
  ]) {
    if (typeof shipTo[key] !== "string" || !shipTo[key].trim() || shipTo[key].trim().length > 160) {
      throw httpError(400, `ship_to.${key} must be a non-empty string with at most 160 characters.`);
    }
    shipTo[key] = shipTo[key].trim();
  }
  if (shipTo.address !== undefined) {
    if (typeof shipTo.address !== "string" || !shipTo.address.trim() || shipTo.address.trim().length > 500) {
      throw httpError(400, "ship_to.address must be a non-empty string with at most 500 characters.");
    }
    shipTo.address = shipTo.address.trim();
  }
  const coordinates = asRecord(shipTo.geo_coordinates);
  const lat = Number(coordinates.lat);
  const lng = Number(coordinates.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw httpError(422, "ship_to.geo_coordinates must include numeric lat and lng.");
  }
  return { ...shipTo, geo_coordinates: { lat, lng } };
}

export function sanitizeSallaOrderUpdate(input: unknown): UnknownRecord {
  const body = asRecord(input);
  const keys = Object.keys(body);
  if (!keys.length) throw httpError(400, "At least one editable Salla order field is required.");
  const unknown = keys.filter((key) => !UPDATE_ORDER_KEYS.has(key));
  if (unknown.length) throw httpError(400, `Unsupported Salla order fields: ${unknown.join(", ")}.`);

  const result: UnknownRecord = {};
  if (body.customer !== undefined) {
    result.customer = sanitizeCustomer(body.customer);
  }
  if (body.receiver !== undefined) {
    result.receiver = sanitizeReceiver(body.receiver);
  }
  if (body.delivery_method !== undefined) {
    const value = text(body.delivery_method, 80);
    if (!value) throw httpError(400, "delivery_method must be a non-empty string.");
    result.delivery_method = value;
  }
  for (const key of ["branch_id", "courier_id"]) {
    if (body[key] === undefined) continue;
    const value = integer(body[key]);
    if (!value) throw httpError(400, `${key} must be a positive integer.`);
    result[key] = value;
  }
  if (body.ship_to !== undefined) result.ship_to = sanitizeShipTo(body.ship_to);
  if (body.payment !== undefined) {
    result.payment = sanitizePayment(body.payment);
  }
  if (body.coupon_code !== undefined) {
    if (typeof body.coupon_code !== "string" || !body.coupon_code.trim() || body.coupon_code.trim().length > 120) {
      throw httpError(400, "coupon_code must be a non-empty string with at most 120 characters.");
    }
    result.coupon_code = body.coupon_code.trim();
  }
  if (body.employees !== undefined) {
    if (!Array.isArray(body.employees) || body.employees.length > 100) {
      throw httpError(400, "employees must be an array with at most 100 ids.");
    }
    const employees = body.employees.map(integer);
    if (employees.some((id) => id === null)) throw httpError(400, "Every employee id must be a positive integer.");
    result.employees = employees;
  }
  return result;
}

function remoteStatusSlug(remoteOrder: unknown) {
  const order = asRecord(remoteOrder);
  const status = asRecord(order.status);
  return text(status.slug || order.status, 80).toLowerCase();
}

export function assertSallaOrderUpdatePermitted(remoteOrder: unknown, payload: UnknownRecord) {
  const order = asRecord(remoteOrder);
  const completed = remoteStatusSlug(order) === "completed";
  if (completed && ["receiver", "delivery_method", "branch_id", "courier_id", "ship_to", "coupon_code"]
    .some((key) => payload[key] !== undefined)) {
    throw httpError(409, "Salla does not allow receiver, shipping, or coupon changes after an order is completed.");
  }

  if (payload.payment !== undefined) {
    const payment = asRecord(order.payment);
    const paymentStatus = text(payment.status || order.payment_status, 80).toLowerCase();
    if (paymentStatus && paymentStatus !== "pending" && paymentStatus !== "waiting") {
      throw httpError(409, "Salla only allows payment changes while payment is pending.");
    }
  }

  if (payload.customer !== undefined) {
    const customer = asRecord(order.customer);
    const hasLinkedCustomer = Boolean(customer.id);
    const isGuest = customer.is_guest === true || text(customer.type, 40).toLowerCase() === "guest";
    if (hasLinkedCustomer && !isGuest) {
      throw httpError(409, "Salla only allows customer changes when no customer is linked or the customer is a guest.");
    }
  }
}

export function sallaRemoteStatus(remoteOrder: unknown) {
  const order = asRecord(remoteOrder);
  const status = asRecord(order.status);
  return {
    id: String(status.id ?? "").trim() || null,
    name: text(status.name, 120) || null,
    slug: text(status.slug || order.status, 80) || null,
  };
}
