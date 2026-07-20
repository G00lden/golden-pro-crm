import type express from "express";
import crypto from "crypto";
import QRCode from "qrcode";
import { adminDb } from "./firebaseAdmin";
import { todayInTimeZone } from "./reminderEngine";
import type { AuthedRequest } from "./auth";
import { recordWhatsAppMessage, whatsappService } from "./whatsapp";
import { queueFieldTechSync } from "./fieldtechIntegration";
import { publicInvoiceShareQuerySchema, validate, validateParams, validateQuery } from "./validation";
import {
  bookingCreateSchema,
  bookingUpdateSchema,
  crmIdParamsSchema,
  customerCreateSchema,
  customerUpdateSchema,
  demoDataSchema,
  documentSendSchema,
  installationCompleteSchema,
  installationCreateSchema,
  installationUpdateSchema,
  invoiceCreateSchema,
  invoiceStatusSchema,
  invoiceUpdateSchema,
  productCreateSchema,
  productUpdateSchema,
  quoteConvertSchema,
  quoteCreateSchema,
  quoteStatusSchema,
  quoteUpdateSchema,
  settingsUpdateSchema,
  technicianCreateSchema,
  technicianUpdateSchema,
} from "./crmValidation";
import {
  calculateDocumentTotals,
  calculateDocumentLineAmounts,
  normalizeVatPercent,
  validateInstallments,
  type DiscountMode,
} from "../shared/financial";
import { displayInvoiceItems, verifiableInvoiceItems } from "../shared/invoiceItems";
import { productIsMerged, visibleCatalogProductCount, visibleCatalogProducts } from "../shared/productCatalogState";
import {
  cleanInvoiceTerms,
  generateZatcaQrBase64,
  invoiceQrTimestamp as resolveInvoiceQrTimestamp,
  resolveInvoiceTaxType,
  zatcaQrFields,
  type InvoiceTaxType,
  type InvoiceTaxTypeInput,
} from "../shared/zatca";
import {
  createOwnedRepository,
  MAX_OWNED_SCAN_LIMIT,
  type FirestoreLikeStore,
} from "./repositories/ownedRepository";
import {
  buildCustomerFacets,
  enrichCustomerRecordsWithOrders,
  filterCustomerRecords,
  paginateCustomerRecords,
  parseCustomerListQuery,
  sortCustomerRecords,
} from "./customerPagination";
import { invalidateStoreProductCatalogIndex } from "./storeWebhook";
import { allocateInvoiceSequence } from "./invoiceSequence";
import { createAtomicInvoiceDocumentWithDatabase } from "./invoiceDocumentWriter";
import { compareAndSetDocument } from "./atomicDocumentUpdate";
import { captureCrmStageAttribution } from "./tiktokAttribution";
import { logError } from "./logger";
import {
  canApplyCorrection,
  canApplyOperationalInvoiceStatus,
  correctionKindForStatus,
  deriveInvoiceStatuses,
  invoiceIsCreditNote,
  invoiceIsMutableDraft,
  invoiceLedgerSign,
  type InvoiceAdjustmentKind,
  type InvoiceStatus,
} from "../shared/invoiceLifecycle";

const ownedRepository = createOwnedRepository(adminDb as unknown as FirestoreLikeStore);
const {
  list: listOwned,
  count: countOwned,
  get: getOwned,
  create: createOwned,
  update: updateOwned,
  delete: deleteOwned,
  findBlockingReferences,
} = ownedRepository;

type ProductDeleteLifecycleEvent = {
  phase: "after_read_before_soft_delete";
  uid: string;
  id: string;
};

let productDeleteLifecycleObserver:
  ((event: ProductDeleteLifecycleEvent) => void | Promise<void>) | null = null;

/** Test-only lifecycle seam for deterministic delete/deduplication races. */
export const __crmApiTestables = {
  setProductDeleteLifecycleObserver(
    observer: ((event: ProductDeleteLifecycleEvent) => void | Promise<void>) | null,
  ) {
    productDeleteLifecycleObserver = observer;
  },
};

/**
 * Keep the store-order catalog index coherent with operator mutations. These
 * functions are deliberately below the repository boundary so every server
 * caller gets the same invalidation semantics, not just the HTTP handler.
 */
export async function createProductForUser(uid: string, data: Record<string, unknown>) {
  const id = await createOwned("products", uid, data);
  invalidateStoreProductCatalogIndex(uid);
  return id;
}

export async function updateProductForUser(uid: string, id: string, data: Record<string, unknown>) {
  const updated = await updateOwned("products", id, uid, data);
  if (updated) invalidateStoreProductCatalogIndex(uid);
  return updated;
}

function productIsStoreManaged(product: Record<string, unknown>) {
  return String(product.source || "").trim().toLowerCase() === "salla"
    || Boolean(String(product.store_product_id || "").trim());
}

export async function deleteProductForUser(uid: string, id: string) {
  const existing = await getOwned("products", id, uid);
  if (!existing || productIsMerged(existing) || productIsStoreManaged(existing)) return false;

  await productDeleteLifecycleObserver?.({
    phase: "after_read_before_soft_delete",
    uid,
    id,
  });

  // Re-read after the lifecycle gap. Deduplication may have converted this
  // identity into a merged tombstone while the delete request was in flight.
  // Treat that as a successful logical deletion without overwriting its merge
  // metadata. No product identity is ever physically deleted here.
  const current = await getOwned("products", id, uid);
  if (!current) return false;
  if (productIsMerged(current)) {
    invalidateStoreProductCatalogIndex(uid);
    return true;
  }
  if (productIsStoreManaged(current)) return false;

  const retired = await updateOwned("products", id, uid, {
    catalog_visible: false,
    is_available: false,
    store_status: "manual_deleted",
  });
  if (retired) invalidateStoreProductCatalogIndex(uid);
  return retired;
}

type DocSnapshot = {
  id: string;
  exists?: boolean;
  data: () => Record<string, unknown>;
};

const defaultSettings = {
  techs: 3,
  jobs_per_tech: 4,
  response_rate: 50,
  maxDaily: 24,
  seller_name: "BreeXe Pro Co.",
  seller_vat_number: "313049114100003",
  seller_address: "شركة بريكس برو شخص واحد ذات مسؤولية محدودة - الرياض",
};

function asyncRoute(
  handler: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>,
) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function userId(req: express.Request) {
  return (req as AuthedRequest).user.uid;
}

function nowIso() {
  return new Date().toISOString();
}

function daysUntil(value?: string) {
  if (!value) return undefined;
  const todayMs = Date.parse(`${todayInTimeZone()}T00:00:00`);
  const valueMs = Date.parse(`${value}T00:00:00`);
  if (!Number.isFinite(valueMs)) return undefined;
  return Math.ceil((valueMs - todayMs) / 86_400_000);
}

function clean<T extends Record<string, unknown>>(value: T) {
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value || {})) {
    if (item !== undefined) copy[key] = item;
  }
  return copy;
}

function docData(doc: DocSnapshot): Record<string, any> & { id: string } {
  return { id: doc.id, ...doc.data() };
}

async function stats(uid: string) {
  const [
    customerCount,
    productCount,
    technicianCount,
    installationCount,
    quoteCount,
    customers,
    installations,
    reminders,
    quotes,
    settings,
  ] = await Promise.all([
    countOwned("customers", uid),
    listOwned("products", uid, undefined, MAX_OWNED_SCAN_LIMIT)
      .then(visibleCatalogProductCount),
    countOwned("technicians", uid),
    countOwned("installations", uid),
    countOwned("quotes", uid),
    listOwned("customers", uid, undefined, MAX_OWNED_SCAN_LIMIT),
    listOwned("installations", uid, undefined, MAX_OWNED_SCAN_LIMIT),
    listOwned("reminders", uid, undefined, MAX_OWNED_SCAN_LIMIT),
    listOwned("quotes", uid, undefined, MAX_OWNED_SCAN_LIMIT),
    getSettings(uid),
  ]);

  const today = todayInTimeZone();
  const nextWeek = new Date(`${today}T00:00:00`);
  nextWeek.setDate(nextWeek.getDate() + 7);
  const nextWeekString = nextWeek.toISOString().slice(0, 10);
  const todayStart = new Date(`${today}T00:00:00`).toISOString();
  const tomorrow = new Date(`${today}T00:00:00`);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStart = tomorrow.toISOString();
  const values = (records: Array<Record<string, any>>, field: string) => new Set(
    records
      .map((record) => String(record[field] ?? "").trim())
      .filter(Boolean),
  );
  const installationCustomerIds = values(installations, "customer_id");
  const installationCustomerPhones = values(installations, "customer_phone");
  const reminderCustomerIds = values(reminders, "customer_id");
  const reminderCustomerPhones = values(reminders, "customer_phone");
  const care = customers.reduce((count, customer) => {
    const customerId = String(customer.id ?? "").trim();
    const customerPhone = String(customer.phone ?? "").trim();
    const hasInstallation = installationCustomerIds.has(customerId)
      || (customerPhone !== "" && installationCustomerPhones.has(customerPhone));
    const hasReminder = reminderCustomerIds.has(customerId)
      || (customerPhone !== "" && reminderCustomerPhones.has(customerPhone));
    return count + (!hasInstallation || !hasReminder ? 1 : 0);
  }, 0);

  return {
    customers: customerCount.total,
    products: productCount,
    technicians: technicianCount.total,
    installations: installationCount.total,
    quotes: quoteCount.total,
    confirmedQuotes: quotes.filter((item) => item.status === "confirmed").length,
    quoteFollowUps: quotes.filter((item) => item.status === "follow_up").length,
    overdue: installations.filter((item) => item.status === "active" && String(item.next_maintenance) < today).length,
    week: installations.filter(
      (item) => item.status === "active" && String(item.next_maintenance) >= today && String(item.next_maintenance) <= nextWeekString,
    ).length,
    sentToday: reminders.filter(
      (item) => item.status === "sent" && String(item.sent_at) >= todayStart && String(item.sent_at) < tomorrowStart,
    ).length,
    completed: installations.filter((item) => item.status === "completed").length,
    maxDaily: settings.maxDaily,
    care,
  };
}

async function getSettings(uid: string) {
  const snap = await adminDb.collection("settings").doc(uid).get();
  if (!snap.exists) return defaultSettings;
  return { ...defaultSettings, ...snap.data() };
}

type QuoteStatus = "draft" | "issued" | "confirmed" | "declined" | "expired" | "follow_up";

const quoteStatuses = new Set(["draft", "issued", "confirmed", "declined", "expired", "follow_up"]);

// Extract the trailing sequence from a formatted number like "INV-20260706-014".
function sequenceOf(value: unknown): number {
  const str = String(value ?? "");
  const match = str.match(/^(?:INV|CN|QT)-.+-(\d+)$/i);
  const n = match ? Number(match[1]) : 0;
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

// Next sequence index: one past the highest number already issued for this owner.
// Deriving from max (not the record count) means deleting an invoice never lets a
// previously used number be reused — a ZATCA uniqueness requirement.
function nextSequence(records: Array<Record<string, any>>, field: string): number {
  return records.reduce((max, row) => Math.max(max, sequenceOf(row[field])), 0) + 1;
}

function quoteNumber(seed = Date.now(), index = 1) {
  const ymd = new Date(seed).toISOString().slice(0, 10).replace(/-/g, "");
  return `QT-${ymd}-${String(index).padStart(3, "0")}`;
}

function normalizeQuoteItems(items: unknown) {
  const raw = Array.isArray(items) ? items : [];
  return raw
    .map((item) => {
      const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
      const quantity = Math.max(0, Number(row.quantity || 0));
      const unitPrice = Math.max(0, Number(row.unit_price || row.unitPrice || 0));
      return {
        product_id: row.product_id || row.productId || null,
        product_sku: String(row.product_sku || row.productSku || "").trim(),
        description: String(row.description || "").trim(),
        quantity,
        unit_price: unitPrice,
        total: quantity * unitPrice,
        vat_excluded: row.vat_excluded !== false,
      };
    })
    .filter((item) => item.description || item.quantity > 0 || item.unit_price > 0);
}

function quoteTotals(
  items: Array<{ total: number; vat_excluded?: boolean }>,
  discountValue = 0,
  tax = 0,
  discountMode: DiscountMode = "fixed",
  vatPercent = 15,
) {
  const totals = calculateDocumentTotals({
    lines: items,
    discountValue,
    discountMode,
    vatPercent,
    additionalTax: tax,
  });
  return {
    subtotal: totals.subtotal,
    discount: totals.discountAmount,
    discount_mode: totals.discountMode,
    discount_value: totals.discountValue,
    tax: totals.additionalTax,
    vat_percent: totals.vatPercent,
    vat_amount: totals.vatAmount,
    total_without_vat: totals.totalWithoutVat,
    total: totals.total,
  };
}

function quotePaymentFields(row: Record<string, any>, existing?: Record<string, any>) {
  const installments = (() => {
    const raw = row.installments ?? existing?.installments;
    if (Array.isArray(raw) && raw.length) return raw;
    // fallback: build from legacy flat fields
    return [
      { percent: Number(row.payment_down_percent ?? existing?.payment_down_percent ?? 70), label: String(row.payment_down_text || existing?.payment_down_text || "عند اعتماد العرض وبدء تنفيذ الطلب.").trim(), deadline_days: undefined },
      { percent: Number(row.payment_final_percent ?? existing?.payment_final_percent ?? 30), label: String(row.payment_final_text || existing?.payment_final_text || "بعد التوريد أو التركيب والتشغيل حسب نطاق العمل.").trim(), deadline_days: undefined },
    ];
  })();
  const installmentValidation = validateInstallments(installments);
  if (!installmentValidation.valid) {
    throw Object.assign(new Error(installmentValidation.error || "Invalid installments."), { status: 400 });
  }
  return {
    payment_method: String(row.payment_method || existing?.payment_method || "تحويل بنكي").trim(),
    payment_down_percent: Number(row.payment_down_percent ?? existing?.payment_down_percent ?? 70),
    payment_final_percent: Number(row.payment_final_percent ?? existing?.payment_final_percent ?? 30),
    payment_down_text: String(row.payment_down_text || existing?.payment_down_text || "عند اعتماد العرض وبدء تنفيذ الطلب.").trim(),
    payment_final_text: String(row.payment_final_text || existing?.payment_final_text || "بعد التوريد أو التركيب والتشغيل حسب نطاق العمل.").trim(),
    payment_bank: String(row.payment_bank || existing?.payment_bank || "").trim(),
    payment_account: String(row.payment_account || existing?.payment_account || "Breexe Pro").trim(),
    payment_iban: String(row.payment_iban || existing?.payment_iban || "").trim(),
    payment_note: String(row.payment_note || existing?.payment_note || "يرجى إرسال إيصال التحويل بعد الدفع لتأكيد الطلب.").trim(),
    installments: JSON.stringify(installments),
  };
}

function normalizeQuote(row: Record<string, any>): Record<string, any> {
  const items = normalizeQuoteItems(row.items);
  const discountMode: DiscountMode = row.discount_mode === "percent" ? "percent" : "fixed";
  const totals = quoteTotals(
    items,
    row.discount_value ?? row.discount,
    row.tax,
    discountMode,
    row.vat_percent,
  );
  let installments = row.installments;
  if (typeof installments === "string") {
    try { installments = JSON.parse(installments); } catch { installments = undefined; }
  }
  return {
    ...row,
    customer_id: row.customer_id || null,
    customer_name: row.customer_name || "",
    customer_phone: row.customer_phone || "",
    customer_city: row.customer_city || "",
    status: quoteStatuses.has(row.status) ? row.status : "issued",
    issue_date: row.issue_date || String(row.created_at || row.createdAt || "").slice(0, 10) || todayInTimeZone(),
    valid_until: row.valid_until || null,
    follow_up_date: row.follow_up_date || null,
    currency: row.currency || "SAR",
    confirmed_at: row.confirmed_at || null,
    items,
    ...quotePaymentFields(row),
    installments: installments || undefined,
    subtotal: Number(row.subtotal ?? totals.subtotal),
    discount: Number(row.discount ?? totals.discount),
    discount_mode: discountMode,
    discount_value: Number(row.discount_value ?? row.discount ?? totals.discount_value),
    tax: Number(row.tax ?? totals.tax),
    vat_percent: Number(row.vat_percent ?? totals.vat_percent),
    vat_amount: Number(row.vat_amount ?? totals.vat_amount),
    total_without_vat: Number(row.total_without_vat ?? totals.total_without_vat),
    total: Number(row.total ?? totals.total),
  };
}

function quoteStats(quotes: Array<Record<string, any>>) {
  const normalized = quotes.map(normalizeQuote);
  return {
    total: normalized.length,
    draft: normalized.filter((item) => item.status === "draft").length,
    issued: normalized.filter((item) => item.status === "issued").length,
    confirmed: normalized.filter((item) => item.status === "confirmed").length,
    follow_up: normalized.filter((item) => item.status === "follow_up").length,
    declined: normalized.filter((item) => item.status === "declined").length,
    expired: normalized.filter((item) => item.status === "expired").length,
    total_value: normalized.reduce((sum, item) => sum + Number(item.total || 0), 0),
    confirmed_value: normalized.filter((item) => item.status === "confirmed").reduce((sum, item) => sum + Number(item.total || 0), 0),
  };
}

async function ensureQuoteCustomer(uid: string, body: Record<string, any>) {
  const customerId = String(body.customer_id || "").trim();
  if (customerId) {
    const existing = await getOwned("customers", customerId, uid);
    if (existing) {
      return {
        customer_id: existing.id,
        customer_name: body.customer_name || existing.name || "",
        customer_phone: body.customer_phone || existing.phone || "",
        customer_city: body.customer_city || existing.city || "",
      };
    }
  }

  const phone = String(body.customer_phone || "").trim();
  if (phone) {
    const customers = await listOwned("customers", uid, undefined, 1000);
    const match = customers.find((item) => String(item.phone || "") === phone);
    if (match) {
      return {
        customer_id: match.id,
        customer_name: body.customer_name || match.name || "",
        customer_phone: phone,
        customer_city: body.customer_city || match.city || "",
      };
    }
  }

  const name = String(body.customer_name || "").trim();
  if (!name || !phone) {
    return {
      customer_id: customerId || null,
      customer_name: name,
      customer_phone: phone,
      customer_city: String(body.customer_city || "").trim(),
    };
  }

  const newCustomerId = await createOwned("customers", uid, {
    name,
    phone,
    city: String(body.customer_city || "").trim(),
    source: "manual",
  });

  return {
    customer_id: newCustomerId,
    customer_name: name,
    customer_phone: phone,
    customer_city: String(body.customer_city || "").trim(),
  };
}

function quotePayload(body: Record<string, any>, customer: Record<string, any>, existing?: Record<string, any>) {
  const items = normalizeQuoteItems(body.items);
  const discountMode: DiscountMode = body.discount_mode === "percent" ? "percent" : "fixed";
  const totals = quoteTotals(
    items,
    body.discount_value ?? body.discount,
    body.tax,
    discountMode,
    body.vat_percent,
  );
  const status = quoteStatuses.has(body.status) ? body.status as QuoteStatus : (existing?.status || "issued") as QuoteStatus;
  const now = nowIso();
  return clean({
    quote_number: existing?.quote_number || body.quote_number,
    customer_id: customer.customer_id || null,
    customer_name: customer.customer_name,
    customer_phone: customer.customer_phone || "",
    customer_city: customer.customer_city || "",
    title: String(body.title || existing?.title || "").trim(),
    status,
    issue_date: body.issue_date || existing?.issue_date || todayInTimeZone(),
    valid_until: body.valid_until || null,
    follow_up_date: body.follow_up_date || null,
    currency: body.currency || existing?.currency || "SAR",
    items,
    notes: String(body.notes || "").trim(),
    terms: String(body.terms || "").trim(),
    confirmed_at: status === "confirmed" ? existing?.confirmed_at || now : existing?.confirmed_at || null,
    ...quotePaymentFields(body, existing),
    ...totals,
  });
}

function formatMoney(value: unknown, currency = "SAR") {
  return `${Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

function quoteWhatsAppText(quote: Record<string, any>) {
  const currency = String(quote.currency || "SAR");
  const lines = (Array.isArray(quote.items) ? quote.items : []).map(
    (item) => `- ${item.description} × ${item.quantity}: ${formatMoney(item.total, currency)}`,
  );
  return [
    `عرض سعر من Breexe Pro`,
    `${quote.quote_number} - ${quote.title || "عرض سعر"}`,
    `العميل: ${quote.customer_name}`,
    quote.valid_until ? `صالح حتى: ${quote.valid_until}` : "",
    "",
    ...lines,
    "",
    `الإجمالي: ${formatMoney(quote.total, currency)}`,
    quote.payment_method ? `طريقة الدفع: ${quote.payment_method}` : "",
    quote.terms ? `الشروط: ${quote.terms}` : "",
  ].filter(Boolean).join("\n");
}

export function registerCrmApiRoutes(app: express.Express) {
  app.get("/api/stats", asyncRoute(async (req, res) => {
    res.json(await stats(userId(req)));
  }));

  app.get("/api/customers", asyncRoute(async (req, res) => {
    const uid = userId(req);
    const query = parseCustomerListQuery(req.query as Record<string, unknown>);

    // Facets and activity metrics must describe the complete bounded owner
    // snapshot. Load customers and orders once each, then aggregate in memory;
    // querying orders per customer would turn this endpoint into an N+1 path.
    const [customers, orders] = await Promise.all([
      listOwned("customers", uid, undefined, MAX_OWNED_SCAN_LIMIT),
      listOwned("store_orders", uid, undefined, MAX_OWNED_SCAN_LIMIT),
    ]);
    const [customerCount, orderCount] = await Promise.all([
      customers.length < MAX_OWNED_SCAN_LIMIT
        ? Promise.resolve({ total: customers.length, capped: false })
        : countOwned("customers", uid),
      orders.length < MAX_OWNED_SCAN_LIMIT
        ? Promise.resolve({ total: orders.length, capped: false })
        : countOwned("store_orders", uid),
    ]);

    const enriched = enrichCustomerRecordsWithOrders(customers, orders);
    const facets = buildCustomerFacets(enriched);
    const filtered = filterCustomerRecords(enriched, query);
    const sorted = sortCustomerRecords(filtered, query);
    const hasFilters = Boolean(
      query.search || query.source || query.city || query.country || query.gender || query.group ||
      query.status || query.activity || query.dateFrom || query.dateTo,
    );
    res.json({
      ...paginateCustomerRecords(sorted, query, {
        total: hasFilters ? filtered.length : customerCount.total,
        capped: customerCount.capped || orderCount.capped,
      }),
      facets,
    });
  }));

  app.post("/api/customers", validate(customerCreateSchema), asyncRoute(async (req, res) => {
    const name = String(req.body?.name || "").trim();
    const phone = String(req.body?.phone || "").trim();
    if (!name || !phone) {
      res.status(400).json({ error: "Customer name and phone are required." });
      return;
    }
    const id = await createOwned("customers", userId(req), {
      ...req.body,
      name,
      phone,
      city: req.body?.city || "",
      source: req.body?.source || "manual",
    });
    res.status(201).json({ id });
  }));

  app.put("/api/customers/:id", validateParams(crmIdParamsSchema), validate(customerUpdateSchema), asyncRoute(async (req, res) => {
    if (!(await updateOwned("customers", req.params.id, userId(req), req.body || {}))) return res.status(404).json({ error: "Customer was not found." });
    res.json({ success: true });
  }));

  app.delete("/api/customers/:id", validateParams(crmIdParamsSchema), asyncRoute(async (req, res) => {
    const uid = userId(req);
    const id = req.params.id;
    const blocking = await findBlockingReferences(uid, [
      { table: "installations", field: "customer_id", value: id, label: "تركيبات" },
      { table: "bookings", field: "customer_id", value: id, label: "حجوزات" },
    ]);
    if (blocking) {
      return res.status(409).json({ error: `لا يمكن حذف العميل لارتباطه بسجلات: ${blocking}. احذفها أو أعد إسنادها أولًا.` });
    }
    if (!(await deleteOwned("customers", id, uid))) return res.status(404).json({ error: "Customer was not found." });
    res.json({ success: true });
  }));

  app.get("/api/quotes", asyncRoute(async (req, res) => {
    const search = String(req.query.search || "").trim();
    const status = String(req.query.status || "").trim();
    const all = (await listOwned("quotes", userId(req), undefined, 1000))
      .map(normalizeQuote)
      .sort((a, b) => String(b.createdAt || b.created_at || b.issue_date).localeCompare(String(a.createdAt || a.created_at || a.issue_date)));
    const data = all.filter((item) => {
      const statusOk = !status || status === "all" || item.status === status;
      if (!statusOk) return false;
      if (!search) return true;
      return `${item.quote_number || ""} ${item.customer_name || ""} ${item.customer_phone || ""} ${item.title || ""}`.includes(search);
    });
    res.json({ data, total: data.length, stats: quoteStats(all) });
  }));

  app.post("/api/quotes", validate(quoteCreateSchema), asyncRoute(async (req, res) => {
    const uid = userId(req);
    const items = normalizeQuoteItems(req.body?.items);
    const customerName = String(req.body?.customer_name || "").trim();
    if (!customerName) {
      res.status(400).json({ error: "Customer name is required." });
      return;
    }
    if (!items.length) {
      res.status(400).json({ error: "At least one quote item is required." });
      return;
    }
    const customer = await ensureQuoteCustomer(uid, req.body || {});
    const allQuotes = await listOwned("quotes", uid, undefined, 10000);
    const payload = {
      ...quotePayload({ ...req.body, items }, customer),
      quote_number: quoteNumber(Date.now(), nextSequence(allQuotes, "quote_number")),
    };
    const id = await createOwned("quotes", uid, payload);
    const quote = await getOwned("quotes", id, uid);
    res.status(201).json({ id, quote: quote ? normalizeQuote(quote) : null });
  }));

  app.put("/api/quotes/:id", validateParams(crmIdParamsSchema), validate(quoteUpdateSchema), asyncRoute(async (req, res) => {
    const uid = userId(req);
    const existing = await getOwned("quotes", req.params.id, uid);
    if (!existing) {
      res.status(404).json({ error: "Quote was not found." });
      return;
    }
    const customer = await ensureQuoteCustomer(uid, req.body || {});
    const payload = quotePayload(req.body || {}, customer, existing);
    await updateOwned("quotes", req.params.id, uid, payload);
    const quote = await getOwned("quotes", req.params.id, uid);
    res.json({ quote: quote ? normalizeQuote(quote) : null });
  }));

  app.post("/api/quotes/:id/status", validateParams(crmIdParamsSchema), validate(quoteStatusSchema), asyncRoute(async (req, res) => {
    const uid = userId(req);
    const status = String(req.body?.status || "").trim() as QuoteStatus;
    if (!quoteStatuses.has(status)) {
      res.status(400).json({ error: "Invalid quote status." });
      return;
    }
    const current = await getOwned("quotes", req.params.id, uid);
    if (!current) {
      res.status(404).json({ error: "Quote was not found." });
      return;
    }
    const update = clean({
      status,
      follow_up_date: req.body?.follow_up_date ?? undefined,
      // Keep the original confirmation time; only stamp it on the first confirm.
      confirmed_at: current.confirmed_at || (status === "confirmed" ? nowIso() : undefined),
    });
    if (!(await updateOwned("quotes", req.params.id, uid, update))) {
      res.status(404).json({ error: "Quote was not found." });
      return;
    }
    const quote = await getOwned("quotes", req.params.id, uid);
    res.json({ quote: quote ? normalizeQuote(quote) : null });
  }));

  app.delete("/api/quotes/:id", validateParams(crmIdParamsSchema), asyncRoute(async (req, res) => {
    if (!(await deleteOwned("quotes", req.params.id, userId(req)))) return res.status(404).json({ error: "Quote was not found." });
    res.json({ success: true });
  }));

  app.post("/api/quotes/:id/send-whatsapp", validateParams(crmIdParamsSchema), validate(documentSendSchema), asyncRoute(async (req, res) => {
    const uid = userId(req);
    const existing = await getOwned("quotes", req.params.id, uid);
    if (!existing) {
      res.status(404).json({ error: "Quote was not found." });
      return;
    }
    const quote = normalizeQuote(existing);
    const phone = String(req.body?.phone || quote.customer_phone || "").trim();
    if (!phone) {
      res.status(400).json({ error: "رقم جوال العميل مطلوب لإرسال عرض السعر." });
      return;
    }
    const message = String(req.body?.message || quoteWhatsAppText(quote)).trim();
    let result: Awaited<ReturnType<typeof whatsappService.sendText>>;
    try {
      result = await whatsappService.sendText(phone, message, { confirmationCode: req.body?.outboundCode });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("credentials are missing") || msg.includes("is not connected")) {
        const err = new Error(msg) as Error & { status?: number };
        err.status = 503;
        throw err;
      }
      throw error;
    }
    recordWhatsAppMessage({
      type: "sent",
      provider: whatsappService.getStatus().provider,
      direction: "outbound",
      to_phone: phone,
      message,
      message_id: (result as { messageId?: string | null })?.messageId || null,
      status: (result as { dryRun?: boolean })?.dryRun ? "dry_run" : "sent",
      owner_uid: uid,
      metadata: {
        kind: "quote",
        quote_id: req.params.id,
        quote_number: quote.quote_number,
      },
    });
    res.json({ success: true, result });
  }));

  app.get("/api/products", asyncRoute(async (req, res) => {
    const products = await listOwned("products", userId(req), "name", MAX_OWNED_SCAN_LIMIT);
    res.json(visibleCatalogProducts(products));
  }));

  app.post("/api/products", validate(productCreateSchema), asyncRoute(async (req, res) => {
    const id = await createProductForUser(userId(req), {
      ...req.body,
      interval_months: Number(req.body?.interval_months || 1),
      category: req.body?.category || "",
      sku: req.body?.sku || "",
      remind_text: req.body?.remind_text || "",
      source: req.body?.source || "manual",
      catalog_visible: true,
      product_type: req.body?.product_type || "install_maintenance",
    });
    res.status(201).json({ id });
  }));

  app.put("/api/products/:id", validateParams(crmIdParamsSchema), validate(productUpdateSchema), asyncRoute(async (req, res) => {
    if (!(await updateProductForUser(userId(req), req.params.id, {
      ...req.body,
      interval_months: req.body?.interval_months ? Number(req.body.interval_months) : undefined,
    }))) return res.status(404).json({ error: "Product was not found." });
    res.json({ success: true });
  }));

  app.delete("/api/products/:id", validateParams(crmIdParamsSchema), asyncRoute(async (req, res) => {
    const uid = userId(req);
    const id = req.params.id;
    const blocking = await findBlockingReferences(uid, [
      { table: "installations", field: "product_id", value: id, label: "تركيبات" },
      { table: "bookings", field: "product_id", value: id, label: "حجوزات" },
    ]);
    if (blocking) {
      return res.status(409).json({ error: `لا يمكن حذف المنتج لارتباطه بسجلات: ${blocking}. احذفها أو أعد إسنادها أولًا.` });
    }
    if (!(await deleteProductForUser(uid, id))) return res.status(404).json({ error: "Product was not found." });
    res.json({ success: true });
  }));

  app.get("/api/installations", asyncRoute(async (req, res) => {
    const data = await listOwned("installations", userId(req), "next_maintenance", 300);
    res.json(data.map((item) => ({ ...item, days_until: daysUntil(String(item.next_maintenance || "")) })));
  }));

  app.post("/api/installations", validate(installationCreateSchema), asyncRoute(async (req, res) => {
    const id = await createOwned("installations", userId(req), {
      ...req.body,
      label: req.body?.label || "",
      remind_count: 0,
      next_remind_type: req.body?.next_remind_type || "first",
      status: req.body?.status || "active",
      completed_date: null,
      last_remind_at: null,
      last_remind_attempt_at: null,
      source: req.body?.source || "manual",
    });
    res.status(201).json({ id });
  }));

  app.put("/api/installations/:id", validateParams(crmIdParamsSchema), validate(installationUpdateSchema), asyncRoute(async (req, res) => {
    if (!(await updateOwned("installations", req.params.id, userId(req), req.body || {}))) return res.status(404).json({ error: "Installation was not found." });
    res.json({ success: true });
  }));

  app.post("/api/installations/:id/complete", validateParams(crmIdParamsSchema), validate(installationCompleteSchema), asyncRoute(async (req, res) => {
    if (!(await updateOwned("installations", req.params.id, userId(req), {
      status: "completed",
      completed_date: req.body?.completedDate || todayInTimeZone(),
      next_remind_type: null,
    }))) return res.status(404).json({ error: "Installation was not found." });
    res.json({ success: true });
  }));

  app.delete("/api/installations/:id", validateParams(crmIdParamsSchema), asyncRoute(async (req, res) => {
    if (!(await deleteOwned("installations", req.params.id, userId(req)))) return res.status(404).json({ error: "Installation was not found." });
    res.json({ success: true });
  }));

  app.get("/api/technicians", asyncRoute(async (req, res) => {
    res.json(await listOwned("technicians", userId(req), "name", 250));
  }));

  app.post("/api/technicians", validate(technicianCreateSchema), asyncRoute(async (req, res) => {
    const id = await createOwned("technicians", userId(req), {
      ...req.body,
      specialty: req.body?.specialty || "",
      max_daily: Number(req.body?.max_daily || 4),
    });
    queueFieldTechSync("technician_created");
    res.status(201).json({ id });
  }));

  app.put("/api/technicians/:id", validateParams(crmIdParamsSchema), validate(technicianUpdateSchema), asyncRoute(async (req, res) => {
    if (!(await updateOwned("technicians", req.params.id, userId(req), {
      ...req.body,
      max_daily: req.body?.max_daily ? Number(req.body.max_daily) : undefined,
    }))) return res.status(404).json({ error: "Technician was not found." });
    queueFieldTechSync("technician_updated");
    res.json({ success: true });
  }));

  app.delete("/api/technicians/:id", validateParams(crmIdParamsSchema), asyncRoute(async (req, res) => {
    const uid = userId(req);
    const id = req.params.id;
    // installations carry no technician_id — only bookings reference technicians.
    const blocking = await findBlockingReferences(uid, [
      { table: "bookings", field: "technician_id", value: id, label: "حجوزات" },
    ]);
    if (blocking) {
      return res.status(409).json({ error: `لا يمكن حذف الفني لارتباطه بسجلات: ${blocking}. احذفها أو أعد إسنادها أولًا.` });
    }
    if (!(await deleteOwned("technicians", id, uid))) return res.status(404).json({ error: "Technician was not found." });
    queueFieldTechSync("technician_deleted");
    res.json({ success: true });
  }));

  app.get("/api/bookings", asyncRoute(async (req, res) => {
    const uid = userId(req);
    let ref = adminDb.collection("bookings").where("createdBy", "==", uid);
    if (req.query.date) ref = ref.where("date", "==", String(req.query.date));
    const [snap, stateSnap] = await Promise.all([
      ref.orderBy(req.query.date ? "scheduled_time" : "date").limit(300).get(),
      adminDb.collection("fieldtech_job_states").where("createdBy", "==", uid).limit(500).get(),
    ]);
    const states = new Map<string, Record<string, any> & { id: string }>(
      stateSnap.docs.map((doc: DocSnapshot): [string, Record<string, any> & { id: string }] => [doc.id, docData(doc)]),
    );
    res.json(snap.docs.map((doc: DocSnapshot) => {
      const booking = docData(doc);
      const state = states.get(doc.id);
      return state ? {
        ...booking,
        fieldtech_status: state.app_status,
        fieldtech_updated_at: state.updatedAt || state.updated_at || state.occurred_at,
      } : booking;
    }));
  }));

  app.post("/api/bookings", validate(bookingCreateSchema), asyncRoute(async (req, res) => {
    const uid = userId(req);
    const technicianId = String(req.body?.technician_id || "").trim();
    if (technicianId && !(await getOwned("technicians", technicianId, uid))) {
      res.status(400).json({ error: "Technician was not found." });
      return;
    }
    const id = await createOwned("bookings", uid, {
      ...req.body,
      technician_id: technicianId || req.body?.technician_id,
      status: req.body?.status || "confirmed",
      booking_type: req.body?.booking_type || "maintenance",
      source: req.body?.source || "manual",
    });
    queueFieldTechSync("booking_created");
    res.status(201).json({ id });
  }));

  app.put("/api/bookings/:id", validateParams(crmIdParamsSchema), validate(bookingUpdateSchema), asyncRoute(async (req, res) => {
    if (!(await updateOwned("bookings", req.params.id, userId(req), req.body || {}))) return res.status(404).json({ error: "Booking was not found." });
    queueFieldTechSync("booking_updated");
    res.json({ success: true });
  }));

  app.delete("/api/bookings/:id", validateParams(crmIdParamsSchema), asyncRoute(async (req, res) => {
    // Assigned field work is a business record. Keep a tombstone-like cancelled
    // booking so an offline technician service can recover the cancellation on
    // its next full sync instead of retaining an orphaned live job.
    if (!(await updateOwned("bookings", req.params.id, userId(req), { status: "cancelled" }))) {
      return res.status(404).json({ error: "Booking was not found." });
    }
    queueFieldTechSync("booking_cancelled");
    res.json({ success: true, cancelled: true });
  }));

  app.get("/api/reminders", asyncRoute(async (req, res) => {
    res.json(await listOwned("reminders", userId(req), "sent_at", 300));
  }));

  app.get("/api/settings", asyncRoute(async (req, res) => {
    res.json(await getSettings(userId(req)));
  }));

  app.put("/api/settings", validate(settingsUpdateSchema), asyncRoute(async (req, res) => {
    const uid = userId(req);
    await adminDb.collection("settings").doc(uid).set({
      ...defaultSettings,
      ...req.body,
      createdBy: uid,
      updatedAt: nowIso(),
    }, { merge: true });
    res.json({ success: true });
  }));

  app.post("/api/demo-data", validate(demoDataSchema), asyncRoute(async (req, res) => {
    const uid = userId(req);
    const count = Math.max(1, Math.min(50, Number(req.body?.count || 10)));
    const stamp = new Date().toISOString().replace(/\D/g, "").slice(8, 14);
    const phoneSeed = (Date.now() % 90_000_000) + 10_000_000;
    const phoneFor = (index: number) => `05${String((phoneSeed + index) % 100_000_000).padStart(8, "0")}`;
    const productId = await createOwned("products", uid, {
      name: `فلتر ذهبي ${stamp}`,
      interval_months: 3,
      category: "فلاتر",
      sku: `INSTALL-DEMO-${stamp}`,
      source: "manual",
      product_type: "install_maintenance",
    });
    const techId = await createOwned("technicians", uid, {
      name: `فني تجربة ${stamp}`,
      phone: "0500000000",
      specialty: "صيانة",
      max_daily: 5,
    });

    for (let i = 0; i < count; i += 1) {
      const customerPhone = phoneFor(i);
      const customerId = await createOwned("customers", uid, {
        name: `عميل تجربة ${i + 1} - ${stamp}`,
        phone: customerPhone,
        city: "الرياض",
        source: "manual",
      });
      const installDate = todayInTimeZone();
      const next = new Date(`${installDate}T00:00:00`);
      next.setDate(next.getDate() + (i % 5) - 2);
      const nextMaintenance = next.toISOString().slice(0, 10);
      const installationId = await createOwned("installations", uid, {
        customer_id: customerId,
        customer_name: `عميل تجربة ${i + 1} - ${stamp}`,
        customer_phone: customerPhone,
        product_id: productId,
        product_name: `فلتر ذهبي ${stamp}`,
        product_sku: `INSTALL-DEMO-${stamp}`,
        install_date: installDate,
        next_maintenance: nextMaintenance,
        remind_count: 0,
        next_remind_type: "first",
        status: "active",
        source: "manual",
      });
      await createOwned("bookings", uid, {
        installation_id: installationId,
        customer_id: customerId,
        customer_name: `عميل تجربة ${i + 1} - ${stamp}`,
        customer_phone: customerPhone,
        product_id: productId,
        product_name: `فلتر ذهبي ${stamp}`,
        technician_id: techId,
        tech_name: `فني تجربة ${stamp}`,
        date: nextMaintenance,
        scheduled_time: `${String(9 + (i % 7)).padStart(2, "0")}:00`,
        status: "confirmed",
        booking_type: "maintenance",
        source: "manual",
      });
    }

    res.json({ customers: count, installations: count, bookings: count, products: 1, technicians: 1 });
  }));

/* ── Invoice Routes (Firestore) ────────────────────────────────── */

const invoiceStatuses = new Set(["draft", "issued", "sent", "paid", "cancelled", "refunded"]);

function invoiceNumber(seed: string | number | Date = Date.now(), index = 1) {
  const ymd = new Date(seed).toISOString().slice(0, 10).replace(/-/g, "");
  return `INV-${ymd}-${String(index).padStart(3, "0")}`;
}

function creditNoteNumber(seed: string | number | Date = Date.now(), index = 1) {
  const ymd = new Date(seed).toISOString().slice(0, 10).replace(/-/g, "");
  return `CN-${ymd}-${String(index).padStart(3, "0")}`;
}

function draftInvoiceNumber() {
  return `DRAFT-${crypto.randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function invoiceShareSecret() {
  const secret = process.env.INVOICE_SHARE_SECRET || process.env.JWT_SECRET || process.env.SESSION_SECRET;
  if (secret) return secret;
  // Fail closed in production: a guessable constant would make public invoice
  // share-links forgeable. Force an explicit secret before going live.
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "INVOICE_SHARE_SECRET (or JWT_SECRET / SESSION_SECRET) must be set in production for signed invoice share-links.",
    );
  }
  return "local-dev-invoice-share";
}

function invoiceShareToken(invoiceId: string, ownerUid: string) {
  return crypto
    .createHmac("sha256", invoiceShareSecret())
    .update(`${invoiceId}:${ownerUid}`)
    .digest("hex");
}

function validInvoiceShareToken(invoiceId: string, ownerUid: string, token: string) {
  const expected = invoiceShareToken(invoiceId, ownerUid);
  const received = String(token || "");
  if (expected.length !== received.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}

function publicBaseUrl(req: express.Request) {
  const configured = String(process.env.PUBLIC_APP_URL || process.env.APP_URL || "").replace(/\/+$/, "");
  if (configured) return configured;
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0];
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0];
  return `${proto}://${host}`;
}

function invoiceShareUrl(req: express.Request, invoice: Record<string, any>) {
  const ownerUid = String(invoice.createdBy || invoice.owner_uid || "");
  const token = invoiceShareToken(String(invoice.id), ownerUid);
  return `${publicBaseUrl(req)}/public/invoices/${encodeURIComponent(String(invoice.id))}?token=${token}`;
}

function invoiceQrTimestamp(invoice: Record<string, any>) {
  return resolveInvoiceQrTimestamp({
    issueDate: invoice.issue_date,
    createdAt: invoice.createdAt || invoice.created_at,
  });
}

function verifiedInvoiceQr(invoice: Record<string, any>, status = 422) {
  try {
    if (!Array.isArray(invoice.items) || invoice.items.length === 0) {
      throw new Error("لا يمكن التحقق من إجماليات الفاتورة من دون بند واحد على الأقل.");
    }
    if (invoice.financials_verifiable === false) {
      throw new Error("بنود الفاتورة الأصلية غير قابلة للتحقق المالي؛ يجب تصحيحها قبل إنشاء رمز QR.");
    }
    const items = verifiableInvoiceItems(invoice.items);
    if (!items) {
      throw new Error("بنود الفاتورة مفقودة أو غير قابلة للتحقق المالي؛ صحّح الوصف والكمية والسعر لكل بند.");
    }
    if (!items.length) {
      throw new Error("لا يمكن التحقق من إجماليات الفاتورة من دون بند واحد على الأقل.");
    }
    const totals = invoiceTotals(
      items,
      invoiceDiscountValue(invoice),
      invoice.vat_percent,
      invoice.discount_mode === "percent" ? "percent" : "fixed",
      invoice.additional_fee,
    );
    const input = {
      sellerName: String(invoice.seller_name || "").trim(),
      vatNumber: String(invoice.seller_vat_number || invoice.seller_vat || "").trim(),
      timestamp: invoiceQrTimestamp(invoice),
      total: totals.total_with_vat,
      vatTotal: totals.vat_amount,
    };
    return { input, qr: generateZatcaQrBase64(input) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "بيانات QR غير صالحة.";
    throw Object.assign(new Error(`تعذر إنشاء رمز QR للفاتورة: ${message}`), { status });
  }
}

function normalizeInvoiceItems(items: unknown) {
  return displayInvoiceItems(items);
}

// Resolve a VAT percentage while treating an explicit 0 (zero-rated) as valid.
// Only an unset value (undefined / null / "") or a non-numeric value falls back
// to the default — `0 || 15` would otherwise turn a 0% invoice into 15%.
function invoiceTotals(
  items: Array<{ total: number; vat_excluded?: boolean }>,
  discountValue = 0,
  vatPercent = 15,
  discountMode: DiscountMode = "fixed",
  additionalFee = 0,
) {
  const totals = calculateDocumentTotals({
    lines: items,
    discountValue,
    discountMode,
    vatPercent,
    additionalTax: additionalFee,
  });
  return {
    subtotal: totals.subtotal,
    discount: totals.discountAmount,
    discount_mode: totals.discountMode,
    discount_value: totals.discountValue,
    vat: totals.vatAmount,
    vat_percent: totals.vatPercent,
    vat_amount: totals.vatAmount,
    additional_fee: totals.additionalTax,
    total_without_vat: totals.totalWithoutVat,
    total_with_vat: totals.total,
  };
}

function invoiceDiscountValue(invoice: Record<string, any>) {
  const explicit = Number(invoice.discount_value);
  const historicalAmount = Number(invoice.discount);
  if (invoice.discount_mode === "percent") {
    return Number.isFinite(explicit) ? explicit : 0;
  }
  if (Number.isFinite(explicit) && (explicit > 0 || !Number.isFinite(historicalAmount) || historicalAmount <= 0)) {
    return explicit;
  }
  return Number.isFinite(historicalAmount) ? historicalAmount : 0;
}

function normalizeInvoice(row: Record<string, any>): Record<string, any> {
  const verifiableItems = verifiableInvoiceItems(row.items);
  const items = verifiableItems ?? normalizeInvoiceItems(row.items);
  const discountMode: DiscountMode = row.discount_mode === "percent" ? "percent" : "fixed";
  const totals = invoiceTotals(
    verifiableItems ?? [],
    invoiceDiscountValue(row),
    row.vat_percent,
    discountMode,
    row.additional_fee,
  );
  const hasVerifiableLines = verifiableItems !== null;
  const vatAmount = hasVerifiableLines
    ? totals.vat_amount
    : Number(row.vat_amount ?? row.vat ?? 0);
  const totalWithoutVat = hasVerifiableLines
    ? totals.total_without_vat
    : Number(row.total_without_vat ?? 0);
  const sellerVatNumber = String(row.seller_vat_number || row.seller_vat || "").trim();
  const invoiceType = resolveInvoiceTaxType({
    requested: row.invoice_type as InvoiceTaxTypeInput,
    buyerVat: row.customer_vat,
    taxableAmount: totalWithoutVat,
  });
  return {
    ...row,
    document_kind: invoiceIsCreditNote(row) ? "credit_note" : "invoice",
    sequence_no: row.sequence_no ?? row.sequenceNo ?? null,
    issued_at: row.issued_at ?? row.issuedAt ?? null,
    source_invoice_id: row.source_invoice_id ?? row.sourceInvoiceId ?? null,
    adjustment_kind: row.adjustment_kind ?? row.adjustmentKind ?? null,
    adjustment_scope: row.adjustment_scope ?? row.adjustmentScope ?? null,
    adjustment_reason: row.adjustment_reason ?? row.adjustmentReason ?? null,
    idempotency_key: row.idempotency_key ?? row.idempotencyKey ?? null,
    currency: row.currency || "SAR",
    status: invoiceStatuses.has(row.status) ? row.status : "draft",
    items,
    subtotal: hasVerifiableLines ? totals.subtotal : Number(row.subtotal ?? 0),
    discount: hasVerifiableLines ? totals.discount : Number(row.discount ?? 0),
    discount_mode: hasVerifiableLines ? totals.discount_mode : discountMode,
    discount_value: hasVerifiableLines ? totals.discount_value : invoiceDiscountValue(row),
    vat: vatAmount,
    vat_percent: hasVerifiableLines ? totals.vat_percent : Number(row.vat_percent ?? 15),
    vat_amount: vatAmount,
    additional_fee: hasVerifiableLines ? totals.additional_fee : Number(row.additional_fee ?? 0),
    total_without_vat: totalWithoutVat,
    total_with_vat: hasVerifiableLines ? totals.total_with_vat : Number(row.total_with_vat ?? 0),
    seller_vat: String(row.seller_vat || sellerVatNumber).trim(),
    seller_vat_number: sellerVatNumber,
    invoice_type: invoiceType,
    financials_verifiable: hasVerifiableLines,
  };
}

function normalizeInvoiceLedger(rows: Array<Record<string, any>>) {
  const normalized = rows.map(normalizeInvoice);
  const sourceNumbers = new Map(
    normalized
      .filter((invoice) => !invoiceIsCreditNote(invoice))
      .map((invoice) => [String(invoice.id), String(invoice.invoice_number || "")]),
  );
  return deriveInvoiceStatuses(normalized.map((invoice) => invoiceIsCreditNote(invoice) ? {
    ...invoice,
    source_invoice_number: sourceNumbers.get(String(invoice.source_invoice_id || "")) || "",
  } : invoice));
}

async function listInvoiceLedger(uid: string) {
  return normalizeInvoiceLedger(await listOwned("invoices", uid, undefined, 10_000));
}

async function getInvoiceLedgerRecord(uid: string, id: string) {
  return (await listInvoiceLedger(uid)).find((invoice) => invoice.id === id) || null;
}

function correctionDocumentId(uid: string, sourceInvoiceId: string, kind: InvoiceAdjustmentKind) {
  return `credit_${crypto.createHash("sha256").update(`${uid}\0${sourceInvoiceId}\0${kind}`).digest("hex").slice(0, 32)}`;
}

function isAlreadyExistsError(error: unknown) {
  const code = String((error as { code?: unknown })?.code || "");
  const message = error instanceof Error ? error.message : String(error);
  return code === "ALREADY_EXISTS" || code === "6" || /already exists|duplicate key|unique constraint/i.test(message);
}

function invoiceLedgerConflict(message: string) {
  const error = new Error(message) as Error & { status?: number };
  error.status = 409;
  return error;
}

function assertCorrectionAllowed(source: Record<string, any>, kind: InvoiceAdjustmentKind) {
  if (canApplyCorrection(source, kind)) return;
  const required = kind === "refund" ? "مدفوعة" : "مصدرة أو مرسلة";
  throw invoiceLedgerConflict(`لا يمكن إنشاء الإشعار الدائن: يجب أن تكون الفاتورة ${required}.`);
}

function atomicFieldsMatch(current: Record<string, unknown>, expected: Record<string, unknown>) {
  return Object.entries(expected).every(([key, value]) => {
    const actual = current[key];
    if (value === null || value === undefined) return actual === null || actual === undefined;
    return actual === value;
  });
}

type InvoiceDocumentRef = {
  get: () => Promise<DocSnapshot>;
  create: (data: Record<string, unknown>) => Promise<unknown>;
  delete: () => Promise<unknown>;
  compareAndSet?: (expected: Record<string, unknown>, data: Record<string, unknown>) => Promise<boolean>;
};

type InvoiceTransaction = {
  get: (document: unknown) => Promise<DocSnapshot>;
  create: (document: unknown, data: Record<string, unknown>) => void;
  update: (document: unknown, data: Record<string, unknown>) => void;
  delete: (document: unknown) => void;
};

function correctionRefs(uid: string, sourceInvoiceId: string) {
  return {
    cancellation: adminDb.collection("invoices").doc(correctionDocumentId(uid, sourceInvoiceId, "cancellation")),
    refund: adminDb.collection("invoices").doc(correctionDocumentId(uid, sourceInvoiceId, "refund")),
  };
}

/**
 * A fiscal status change and a full credit note must serialize against the same
 * three documents in native Firestore. SQLite and Supabase enforce the same
 * invariant with database triggers behind compareAndSet().
 */
async function compareAndSetInvoiceOperationalStatus(
  uid: string,
  source: Record<string, any>,
  update: Record<string, unknown>,
) {
  const sourceId = String(source.id);
  const sourceRef = adminDb.collection("invoices").doc(sourceId) as unknown as InvoiceDocumentRef;
  const expected = {
    status: source.status,
    issued_at: source.issued_at ?? null,
    sequence_no: source.sequence_no ?? null,
  };

  // Adapter-backed stores provide a conditional SQL update. Their ledger
  // triggers atomically reject status changes once a full credit exists.
  if (typeof sourceRef.compareAndSet === "function") {
    try {
      return await compareAndSetDocument(sourceRef, expected, update);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/INVOICE_PAYMENT_IN_PROGRESS/i.test(message)) {
        throw invoiceLedgerConflict("يوجد طلب دفع إلكتروني قيد التنفيذ؛ انتظر نتيجة بوابة الدفع قبل تأكيد الدفع يدويًا.");
      }
      if (/INVOICE_ALREADY_CREDITED|CREDIT_NOTE_SOURCE_STATE_CONFLICT/i.test(message)) return false;
      throw error;
    }
  }

  const firestore = adminDb as unknown as {
    runTransaction?: <T>(callback: (transaction: InvoiceTransaction) => Promise<T>) => Promise<T>;
  };
  if (typeof firestore.runTransaction !== "function") {
    throw new Error("The configured database does not support atomic invoice lifecycle updates.");
  }

  const refs = correctionRefs(uid, sourceId);
  return firestore.runTransaction(async (transaction) => {
    // Firestore requires every read before the first write. Reading both
    // deterministic credit-note ids makes status-vs-credit races conflict.
    const liveSourceSnapshot = await transaction.get(sourceRef);
    const cancellationSnapshot = await transaction.get(refs.cancellation);
    const refundSnapshot = await transaction.get(refs.refund);
    if (!liveSourceSnapshot.exists) return false;
    const liveSource = docData(liveSourceSnapshot);
    if (String(liveSource.createdBy || "") !== uid || !atomicFieldsMatch(liveSource, expected)) return false;
    if (cancellationSnapshot.exists || refundSnapshot.exists) return false;
    transaction.update(sourceRef, update);
    return true;
  });
}

async function compareAndDeleteInvoiceDraft(uid: string, source: Record<string, any>) {
  const ref = adminDb.collection("invoices").doc(String(source.id)) as unknown as InvoiceDocumentRef;
  if (typeof ref.compareAndSet === "function") {
    const snapshot = await ref.get();
    if (!snapshot.exists) return false;
    const live = docData(snapshot);
    if (String(live.createdBy ?? live.owner_uid ?? "") !== uid || !invoiceIsMutableDraft(live)) return false;
    try {
      await ref.delete();
      return true;
    } catch (error) {
      if (/ISSUED_INVOICE_DELETE_FORBIDDEN|immutable|forbidden/i.test(
        error instanceof Error ? error.message : String(error),
      )) return false;
      throw error;
    }
  }

  const firestore = adminDb as unknown as {
    runTransaction?: <T>(callback: (transaction: InvoiceTransaction) => Promise<T>) => Promise<T>;
  };
  if (typeof firestore.runTransaction !== "function") {
    throw new Error("The configured database does not support atomic invoice deletion.");
  }
  return firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return false;
    const live = docData(snapshot);
    if (String(live.createdBy || "") !== uid || !invoiceIsMutableDraft(live)) return false;
    if (!atomicFieldsMatch(live, {
      status: source.status,
      issued_at: source.issued_at ?? null,
      sequence_no: source.sequence_no ?? null,
    })) return false;
    transaction.delete(ref);
    return true;
  });
}

async function createFullInvoiceCreditNote(
  uid: string,
  source: Record<string, any>,
  kind: InvoiceAdjustmentKind,
  reason: string,
) {
  const id = correctionDocumentId(uid, String(source.id), kind);
  const ref = adminDb.collection("invoices").doc(id) as unknown as InvoiceDocumentRef;
  const existing = await ref.get();
  if (existing.exists) return normalizeInvoice(docData(existing));

  assertCorrectionAllowed(source, kind);

  const all = await listOwned("invoices", uid, undefined, 10_000);
  const minimumNext = nextSequence(all, "invoice_number");
  const sequence = await allocateInvoiceSequence(uid, minimumNext);
  const issuedAt = nowIso();
  const sourceNumber = String(source.invoice_number || "").trim();
  const correctionLabel = kind === "refund" ? "استرداد كامل" : "إلغاء كامل";
  const payload = clean({
    invoice_number: creditNoteNumber(issuedAt, sequence),
    document_kind: "credit_note",
    sequence_no: sequence,
    issued_at: issuedAt,
    source_invoice_id: String(source.id),
    adjustment_kind: kind,
    adjustment_scope: "full",
    adjustment_reason: reason,
    idempotency_key: `credit:${source.id}:${kind}`,
    quote_id: source.quote_id || null,
    customer_id: source.customer_id || null,
    customer_name: source.customer_name || "",
    customer_phone: source.customer_phone || "",
    customer_city: source.customer_city || "",
    customer_vat: source.customer_vat || "",
    title: `إشعار دائن - ${correctionLabel} للفاتورة ${sourceNumber}`,
    invoice_type: source.invoice_type,
    status: "issued",
    issue_date: todayInTimeZone(),
    due_date: null,
    paid_at: null,
    payment_method: source.payment_method || "",
    currency: source.currency || "SAR",
    items: source.items,
    notes: reason,
    terms: source.terms || "",
    subtotal: source.subtotal,
    discount: source.discount,
    discount_mode: source.discount_mode,
    discount_value: source.discount_value,
    vat: source.vat_amount,
    vat_percent: source.vat_percent,
    vat_amount: source.vat_amount,
    additional_fee: source.additional_fee,
    total_without_vat: source.total_without_vat,
    total_with_vat: source.total_with_vat,
    seller_name: source.seller_name,
    seller_vat: source.seller_vat || source.seller_vat_number,
    seller_vat_number: source.seller_vat_number,
    seller_address: source.seller_address,
    createdBy: uid,
    createdAt: issuedAt,
    updatedAt: issuedAt,
  });
  verifiedInvoiceQr(payload, 400);

  const firestore = adminDb as unknown as {
    runTransaction?: <T>(callback: (transaction: InvoiceTransaction) => Promise<T>) => Promise<T>;
  };
  if (typeof ref.compareAndSet !== "function" && typeof firestore.runTransaction === "function") {
    const sourceId = String(source.id);
    const sourceRef = adminDb.collection("invoices").doc(sourceId);
    const refs = correctionRefs(uid, sourceId);
    return firestore.runTransaction(async (transaction) => {
      const liveSourceSnapshot = await transaction.get(sourceRef);
      const cancellationSnapshot = await transaction.get(refs.cancellation);
      const refundSnapshot = await transaction.get(refs.refund);
      const targetSnapshot = kind === "refund" ? refundSnapshot : cancellationSnapshot;
      const otherSnapshot = kind === "refund" ? cancellationSnapshot : refundSnapshot;

      if (targetSnapshot.exists) return normalizeInvoice(docData(targetSnapshot));
      if (otherSnapshot.exists) {
        throw invoiceLedgerConflict("سبق إنشاء إشعار دائن كامل لهذه الفاتورة.");
      }
      if (!liveSourceSnapshot.exists) {
        throw invoiceLedgerConflict("تغيرت الفاتورة أو حُذفت قبل إنشاء الإشعار الدائن.");
      }
      const liveSource = normalizeInvoice(docData(liveSourceSnapshot));
      if (String(liveSource.createdBy || "") !== uid) {
        throw invoiceLedgerConflict("لا تملك صلاحية إنشاء إشعار دائن لهذه الفاتورة.");
      }
      assertCorrectionAllowed(liveSource, kind);
      transaction.create(ref, payload);
      return normalizeInvoice({ id, ...payload });
    });
  }

  try {
    await ref.create(payload);
    return normalizeInvoice({ id, ...payload });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/INVOICE_PAYMENT_REQUIRES_PROVIDER_RESOLUTION|INVOICE_PAYMENT_IN_PROGRESS/i.test(message)) {
      throw invoiceLedgerConflict("لا يمكن إنشاء إشعار دائن بينما توجد عملية Tap قيد التنفيذ أو مكتملة؛ عالجها أو استردها في بوابة الدفع أولًا.");
    }
    if (!isAlreadyExistsError(error) && !/CREDIT_NOTE_SOURCE_STATE_CONFLICT|INVOICE_ALREADY_CREDITED/i.test(message)) {
      throw error;
    }
    const duplicate = await ref.get();
    if (!duplicate.exists) {
      throw invoiceLedgerConflict("تغيرت حالة الفاتورة بالتزامن أو سبق إنشاء إشعار دائن كامل لها.");
    }
    return normalizeInvoice(docData(duplicate));
  }
}

function invoiceKindLabels(type: InvoiceTaxType) {
  return type === "tax"
    ? { ar: "فاتورة ضريبية", en: "Tax Invoice" }
    : { ar: "فاتورة ضريبية مبسطة", en: "Simplified Tax Invoice" };
}

function invoiceDocumentLabels(invoice: Record<string, any>) {
  if (invoiceIsCreditNote(invoice)) {
    return { ar: "إشعار دائن ضريبي", en: "Tax Credit Note" };
  }
  return invoiceKindLabels(invoice.invoice_type);
}

function invoiceBreakdown(invoice: Record<string, any>) {
  return calculateDocumentLineAmounts({
    lines: Array.isArray(invoice.items) ? invoice.items : [],
    discountValue: invoice.discount_value ?? invoice.discount,
    discountMode: invoice.discount_mode === "percent" ? "percent" : "fixed",
    vatPercent: invoice.vat_percent,
    additionalTax: invoice.additional_fee,
  });
}

async function publicInvoiceHtml(invoice: Record<string, any>) {
  const sellerName = invoice.seller_name || "BreeXe Pro Co.";
  const sellerLegalName = "شركة بريكس برو شخص واحد ذات مسؤولية محدودة";
  const sellerVat = invoice.seller_vat || invoice.seller_vat_number || "313049114100003";
  const sellerCr = invoice.seller_cr || invoice.seller_cr_number || "7016449519";
  const sellerPhone = invoice.seller_phone || "+966533971168";
  const kind = invoiceDocumentLabels(invoice);
  const { qr: qrBase64 } = verifiedInvoiceQr({
    ...invoice,
    seller_name: sellerName,
    seller_vat_number: sellerVat,
  });
  const qrSrc = await QRCode.toDataURL(qrBase64, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 132,
    color: { dark: "#000000", light: "#ffffff" },
  });
  const currency = String(invoice.currency || "SAR");
  const visibleTerms = cleanInvoiceTerms(invoice.terms);
  const breakdown = invoiceBreakdown(invoice);
  const rows = (Array.isArray(invoice.items) ? invoice.items : []).map((item: Record<string, any>, index: number) => {
    const line = breakdown.lines[index];
    const quantity = Math.max(0, Number(item.quantity || 0));
    const unitNet = quantity ? line.netBeforeDiscount / quantity : 0;
    const sku = item.product_sku ? `<small style="display:block;opacity:.6;font-size:.85em;direction:ltr">${escapeHtml(item.product_sku)}</small>` : "";
    return `<tr>
      <td data-label="البند">${index + 1}</td>
      <td class="description" data-label="البيان">${escapeHtml(item.description)}${sku}</td>
      <td data-label="الكمية">${quantity}</td>
      <td data-label="سعر الوحدة قبل الضريبة">${escapeHtml(formatMoney(unitNet, currency))}</td>
      <td data-label="خصم البند">${escapeHtml(formatMoney(line.discount, currency))}</td>
      <td data-label="الخاضع بعد الخصم">${escapeHtml(formatMoney(line.taxableAmount, currency))}</td>
      <td data-label="الضريبة">${escapeHtml(formatMoney(line.vat, currency))}</td>
      <td data-label="الإجمالي شامل الضريبة">${escapeHtml(formatMoney(line.gross, currency))}</td>
    </tr>`;
  }).join("");
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(invoice.invoice_number || "Tax invoice")}</title>
  <style>
    @page { size: A4; margin: 0; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #eef2f5; color: #17212b; font-family: Arial, Tahoma, sans-serif; }
    .doc { width: 210mm; min-height: 297mm; margin: 0 auto; padding: 12mm; background: #fff; }
    .head { display: grid; grid-template-columns: minmax(0, 1fr) minmax(170px, auto); gap: 14px; align-items: stretch; padding: 14px; border-radius: 12px; background: linear-gradient(135deg, #0b355c, #10212c); color: #fff; }
    .brand { display: grid; grid-template-columns: 194px minmax(0, 1fr); gap: 14px; align-items: center; min-width: 0; }
    .brand-logo { display: block; width: 194px; height: 61px; padding: 5px 7px; border-radius: 8px; background: #fff; object-fit: contain; }
    .brand-copy { min-width: 0; }
    .brand-copy strong { display: block; font-size: 12px; line-height: 1.55; }
    .brand-copy small { display: block; margin-top: 3px; color: rgba(255,255,255,.78); font-size: 9px; line-height: 1.45; overflow-wrap: anywhere; }
    .title { display: grid; align-content: center; gap: 5px; min-width: 170px; padding: 12px; border: 1px solid rgba(214,168,79,.45); border-radius: 10px; text-align: center; }
    .title span { color: #d6a84f; font-size: 12px; font-weight: 900; }
    .title h1 { margin: 0; color: #fff; font-size: 20px; }
    .title strong { color: #fff; font-size: 13px; }
    .box span { color: #64748b; font-size: 10px; font-weight: 900; }
    .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 14px 0; }
    .box { border: 1px solid #d7e0ea; border-radius: 10px; padding: 8px 9px; background: #f8fafc; }
    .box strong { display: block; margin-top: 4px; color: #10212c; font-size: 12px; }
    .parties { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: stretch; margin-bottom: 12px; }
    .party, .qr { border: 1px solid #d7e0ea; border-radius: 10px; background: #f8fafc; }
    .party { padding: 10px 12px; }
    .party h2 { margin: 0 0 7px; color: #0b355c; font-size: 12px; }
    .facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 10px; margin: 0; }
    .facts div { min-width: 0; padding: 6px 8px; border-radius: 7px; background: #fff; }
    .facts dt { color: #64748b; font-size: 9px; font-weight: 900; }
    .facts dd { margin: 2px 0 0; color: #172033; font-size: 11px; font-weight: 800; line-height: 1.45; overflow-wrap: anywhere; }
    .qr { display: grid; min-width: 114px; place-items: center; padding: 8px; }
    table { width: 100%; table-layout: fixed; border-collapse: collapse; margin-bottom: 12px; }
    th { padding: 8px 5px; background: #0f6a86; color: #fff; font-size: 9px; }
    td { padding: 7px 5px; border-bottom: 1px solid #e2e8f0; font-size: 10px; text-align: center; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; break-inside: avoid; }
    th:nth-child(1) { width: 4%; } th:nth-child(2) { width: 24%; } th:nth-child(3) { width: 7%; }
    th:nth-child(4) { width: 15%; } th:nth-child(5) { width: 11%; } th:nth-child(6) { width: 14%; }
    th:nth-child(7) { width: 10%; } th:nth-child(8) { width: 15%; }
    td:nth-child(2) { text-align: right; white-space: pre-line; }
    .totals { width: 330px; margin-right: auto; border: 1px solid #d7e0ea; border-radius: 10px; overflow: hidden; }
    .totals p { display: flex; justify-content: space-between; margin: 0; padding: 8px 10px; border-bottom: 1px solid #e2e8f0; font-size: 12px; }
    .totals p:last-child { border-bottom: 0; background: #12314a; color: #fff; font-weight: 900; }
    .terms { margin-top: 14px; padding: 10px; border: 1px solid #d7e0ea; border-radius: 10px; color: #475569; font-size: 11px; white-space: pre-line; }
    @media screen and (max-width: 820px) {
      .doc { width: 100%; min-height: 0; padding: 18px; }
      .head, .grid, .parties { grid-template-columns: 1fr; }
      .brand { grid-template-columns: 1fr; }
      .brand-logo { width: min(220px, 100%); height: auto; }
      .facts { grid-template-columns: 1fr; }
      .qr { justify-self: center; }
      table, tbody { display: block; }
      thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; clip-path: inset(50%); }
      tbody tr { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); padding: 8px; border: 1px solid #d7e0ea; border-radius: 10px; background: #f8fafc; }
      tbody tr + tr { margin-top: 8px; }
      td, td:nth-child(2) { display: grid; min-width: 0; gap: 3px; padding: 7px; border: 0; text-align: start; white-space: normal; }
      td::before { content: attr(data-label); color: #64748b; font-size: 9px; font-weight: 900; }
      td.description { grid-column: 1 / -1; }
      .totals { width: 100%; }
    }
    @media print { body { background: #fff; } .doc { margin: 0; box-shadow: none; } }
  </style>
</head>
<body>
  <main class="doc">
    <header class="head">
      <div class="brand">
        <img class="brand-logo" src="/brand/logo-full.png" alt="BreeXe Pro" width="194" height="61" />
        <div class="brand-copy">
          <strong>${sellerLegalName}</strong>
          <small>${escapeHtml(invoice.seller_address || "الرياض، المملكة العربية السعودية")}</small>
          <small><bdi dir="ltr">${escapeHtml(sellerPhone)}</bdi></small>
        </div>
      </div>
      <div class="title">
        <span>${kind.en}</span>
        <h1>${kind.ar}</h1>
        ${invoice.title ? `<em style="display:block;font-style:normal;font-size:.8em;opacity:.7">${escapeHtml(invoice.title)}</em>` : ""}
        <strong>${escapeHtml(invoice.invoice_number || "")}</strong>
      </div>
    </header>
    <section class="grid">
      <div class="box"><span>تاريخ الإصدار</span><strong>${escapeHtml(invoice.issue_date || "")}</strong></div>
      <div class="box"><span>الرقم الضريبي للبائع</span><strong>${escapeHtml(sellerVat)}</strong></div>
      <div class="box"><span>السجل التجاري</span><strong>${escapeHtml(sellerCr)}</strong></div>
      <div class="box"><span>الحالة</span><strong>${escapeHtml(invoice.status || "")}</strong></div>
    </section>
    <section class="parties">
      <article class="party">
        <h2>بيانات العميل</h2>
        <dl class="facts">
          <div><dt>الاسم</dt><dd>${escapeHtml(invoice.customer_name || "-")}</dd></div>
          <div><dt>الجوال</dt><dd><bdi dir="ltr">${escapeHtml(invoice.customer_phone || "-")}</bdi></dd></div>
          <div><dt>المدينة</dt><dd>${escapeHtml(invoice.customer_city || "-")}</dd></div>
          <div><dt>الرقم الضريبي</dt><dd>${escapeHtml(invoice.customer_vat || "-")}</dd></div>
        </dl>
      </article>
      <aside class="qr" aria-label="رمز الفاتورة الضريبية"><img src="${qrSrc}" width="96" height="96" alt="رمز الفاتورة الضريبية" /></aside>
    </section>
    <table>
      <thead><tr><th>#</th><th>البيان</th><th>الكمية</th><th>سعر الوحدة قبل الضريبة</th><th>خصم البند</th><th>الخاضع بعد الخصم</th><th>VAT</th><th>الإجمالي شامل الضريبة</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <section class="totals">
      <p><span>المجموع قبل الخصم والضريبة</span><strong>${escapeHtml(formatMoney(invoice.subtotal, currency))}</strong></p>
      <p><span>الخصم</span><strong>${escapeHtml(formatMoney(invoice.discount, currency))}</strong></p>
      <p><span>الخاضع للضريبة بعد الخصم</span><strong>${escapeHtml(formatMoney(invoice.total_without_vat, currency))}</strong></p>
      <p><span>ضريبة القيمة المضافة (${escapeHtml(normalizeVatPercent(invoice.vat_percent))}%)</span><strong>${escapeHtml(formatMoney(invoice.vat_amount || invoice.vat, currency))}</strong></p>
      ${Number(invoice.additional_fee || 0) > 0 ? `<p><span>رسوم إضافية</span><strong>${escapeHtml(formatMoney(invoice.additional_fee, currency))}</strong></p>` : ""}
      <p><span>الإجمالي شامل الضريبة</span><strong>${escapeHtml(formatMoney(invoice.total_with_vat, currency))}</strong></p>
    </section>
    ${visibleTerms ? `<section class="terms">${escapeHtml(visibleTerms)}</section>` : ""}
  </main>
</body>
</html>`;
}

  app.get("/public/invoices/:id", validateQuery(publicInvoiceShareQuerySchema), asyncRoute(async (req, res) => {
    const snap = await adminDb.collection("invoices").doc(req.params.id).get() as DocSnapshot;
    if (!snap.exists) {
      res.status(404).type("text/plain").send("Invoice not found.");
      return;
    }
    const rawInvoice = docData(snap);
    const ownerUid = String(rawInvoice.createdBy || rawInvoice.owner_uid || "");
    if (!ownerUid || !validInvoiceShareToken(req.params.id, ownerUid, String(req.query.token || ""))) {
      res.status(403).type("text/plain").send("Invalid invoice link.");
      return;
    }
    if (invoiceIsMutableDraft(rawInvoice)) {
      res.status(409).type("text/plain").send("Draft invoices cannot be shared as issued tax documents.");
      return;
    }
    res.type("html").send(await publicInvoiceHtml(normalizeInvoice(rawInvoice)));
  }));

  app.get("/api/invoices", asyncRoute(async (req, res) => {
    const search = String(req.query.search || "").trim();
    const status = String(req.query.status || "").trim();
    const all = (await listInvoiceLedger(userId(req)))
      .sort((a, b) => String(b.createdAt || b.created_at).localeCompare(String(a.createdAt || a.created_at)));
    const sourceInvoices = all.filter((item) => !invoiceIsCreditNote(item));
    const data = all.filter((item) => {
      const statusOk = !status || status === "all" || item.status === status;
      if (!statusOk) return false;
      if (!search) return true;
      return `${item.invoice_number || ""} ${item.source_invoice_number || ""} ${item.customer_name || ""} ${item.customer_phone || ""}`.includes(search);
    });
    const stats = {
      total: all.length,
      credit_notes: all.length - sourceInvoices.length,
      draft: sourceInvoices.filter((item) => item.status === "draft").length,
      issued: sourceInvoices.filter((item) => item.status === "issued").length,
      sent: sourceInvoices.filter((item) => item.status === "sent").length,
      paid: sourceInvoices.filter((item) => item.status === "paid").length,
      cancelled: sourceInvoices.filter((item) => item.status === "cancelled").length,
      refunded: sourceInvoices.filter((item) => item.status === "refunded").length,
      total_value: all.reduce((sum, item) => sum + invoiceLedgerSign(item) * Number(item.total_with_vat || 0), 0),
      paid_value: sourceInvoices.filter((item) => item.status === "paid").reduce((sum, item) => sum + Number(item.total_with_vat || 0), 0),
    };
    res.json({ data, total: data.length, stats });
  }));

  app.post("/api/invoices", validate(invoiceCreateSchema), asyncRoute(async (req, res) => {
    const uid = userId(req);
    const items = verifiableInvoiceItems(req.body?.items);
    const customerName = String(req.body?.customer_name || "").trim();
    if (!customerName) {
      res.status(400).json({ error: "اسم العميل مطلوب." });
      return;
    }
    if (!items) {
      res.status(400).json({ error: "مطلوب بند واحد على الأقل في الفاتورة." });
      return;
    }
    const requestedStatus = String(req.body?.status || "issued") as InvoiceStatus;
    if (requestedStatus !== "draft" && requestedStatus !== "issued") {
      res.status(400).json({ error: "عند الإنشاء اختر مسودة أو مصدرة فقط؛ الإرسال والدفع والإلغاء لها إجراءات مستقلة." });
      return;
    }
    const suppliedIdempotencyKey = String(req.get("Idempotency-Key") || "").trim();
    if (suppliedIdempotencyKey && !/^[A-Za-z0-9:_-]{8,160}$/.test(suppliedIdempotencyKey)) {
      res.status(400).json({ error: "مفتاح منع التكرار غير صالح." });
      return;
    }
    const idempotencyKey = suppliedIdempotencyKey || `invoice:${crypto.randomUUID()}`;
    const settings = await getSettings(uid);
    const discountMode: DiscountMode = req.body?.discount_mode === "percent" ? "percent" : "fixed";
    const totals = invoiceTotals(
      items,
      req.body?.discount_value ?? req.body?.discount,
      req.body?.vat_percent,
      discountMode,
      req.body?.additional_fee,
    );
    const invoiceType = resolveInvoiceTaxType({
      requested: req.body?.invoice_type,
      buyerVat: req.body?.customer_vat,
      taxableAmount: totals.total_without_vat,
    });
    const sellerVatNumber = String(req.body?.seller_vat_number || req.body?.seller_vat || settings.seller_vat_number || "313049114100003").trim();
    const result = await createAtomicInvoiceDocumentWithDatabase(adminDb as any, {
      ownerUid: uid,
      idempotencyKey,
      issued: requestedStatus === "issued",
      build: ({ sequence, issuedAt }) => {
        const payload = clean({
          invoice_number: issuedAt && sequence ? invoiceNumber(issuedAt, sequence) : draftInvoiceNumber(),
          document_kind: "invoice",
          sequence_no: sequence,
          issued_at: issuedAt,
          source_invoice_id: null,
          adjustment_kind: null,
          adjustment_scope: null,
          adjustment_reason: null,
          quote_id: req.body?.quote_id || null,
          customer_id: req.body?.customer_id || null,
          customer_name: customerName,
          customer_phone: String(req.body?.customer_phone || "").trim(),
          customer_city: String(req.body?.customer_city || "").trim(),
          customer_vat: String(req.body?.customer_vat || "").trim(),
          title: String(req.body?.title || "").trim(),
          invoice_type: invoiceType,
          status: requestedStatus,
          issue_date: req.body?.issue_date || todayInTimeZone(),
          due_date: req.body?.due_date || null,
          payment_method: String(req.body?.payment_method || "").trim(),
          currency: req.body?.currency || "SAR",
          items,
          notes: String(req.body?.notes || "").trim(),
          terms: String(req.body?.terms || "").trim(),
          ...totals,
          seller_name: String(req.body?.seller_name || settings.seller_name || "BreeXe Pro Co.").trim(),
          seller_vat: sellerVatNumber,
          seller_vat_number: sellerVatNumber,
          seller_address: String(req.body?.seller_address || settings.seller_address || "شركة بريكس برو شخص واحد ذات مسؤولية محدودة - الرياض").trim(),
          paid_at: null,
        });
        verifiedInvoiceQr(payload, 400);
        return payload;
      },
    });
    res.status(result.created ? 201 : 200).json({
      id: result.id,
      invoice: normalizeInvoice(result.data),
      idempotent_replay: !result.created,
    });
  }));

  app.get("/api/invoices/:id", asyncRoute(async (req, res) => {
    const existing = await getInvoiceLedgerRecord(userId(req), req.params.id);
    if (!existing) {
      res.status(404).json({ error: "الفاتورة غير موجودة." });
      return;
    }
    res.json(existing);
  }));

  app.get("/api/invoices/:id/share-link", asyncRoute(async (req, res) => {
    const existing = await getOwned("invoices", req.params.id, userId(req));
    if (!existing) {
      res.status(404).json({ error: "الفاتورة غير موجودة." });
      return;
    }
    if (invoiceIsMutableDraft(existing)) {
      res.status(409).json({ error: "أصدر المسودة أولًا قبل إنشاء رابط مشاركة ضريبي." });
      return;
    }
    const invoice = normalizeInvoice(existing);
    res.json({ url: invoiceShareUrl(req, invoice) });
  }));

  app.put("/api/invoices/:id", validateParams(crmIdParamsSchema), validate(invoiceUpdateSchema), asyncRoute(async (req, res) => {
    const uid = userId(req);
    const existing = await getOwned("invoices", req.params.id, uid);
    if (!existing) {
      res.status(404).json({ error: "الفاتورة غير موجودة." });
      return;
    }
    if (!invoiceIsMutableDraft(existing)) {
      res.status(409).json({ error: "الفاتورة المصدرة سجل مالي ثابت؛ يمكن تعديل أو حذف المسودة فقط. أنشئ إشعارًا دائنًا للإلغاء أو الاسترداد." });
      return;
    }
    const requestedStatus = String(req.body?.status || "draft") as InvoiceStatus;
    if (requestedStatus !== "draft" && requestedStatus !== "issued") {
      res.status(400).json({ error: "يمكن إبقاء المسودة أو إصدارها فقط من نموذج التحرير." });
      return;
    }
    const items = verifiableInvoiceItems(req.body?.items ?? existing.items);
    if (!items) {
      res.status(400).json({ error: "كل بند في الفاتورة يحتاج وصفًا وكمية أكبر من صفر وسعرًا غير سالب." });
      return;
    }
    const settings = await getSettings(uid);
    const discountMode: DiscountMode = (req.body?.discount_mode ?? existing.discount_mode) === "percent" ? "percent" : "fixed";
    const discountValue = req.body?.discount_value ?? req.body?.discount ?? existing.discount_value ?? existing.discount;
    const additionalFee = req.body?.additional_fee ?? existing.additional_fee ?? 0;
    const totals = invoiceTotals(
      items,
      discountValue,
      req.body?.vat_percent ?? existing.vat_percent,
      discountMode,
      additionalFee,
    );
    const customerVat = String(req.body?.customer_vat ?? existing.customer_vat ?? "").trim();
    const invoiceType = resolveInvoiceTaxType({
      requested: req.body?.invoice_type ?? existing.invoice_type,
      buyerVat: customerVat,
      taxableAmount: totals.total_without_vat,
    });
    const sellerVatNumber = String(req.body?.seller_vat_number || req.body?.seller_vat || existing.seller_vat_number || existing.seller_vat || settings.seller_vat_number || "313049114100003").trim();
    const issuedAt = requestedStatus === "issued" ? nowIso() : null;
    const all = issuedAt ? await listOwned("invoices", uid, undefined, 10_000) : [];
    const sequence = issuedAt
      ? await allocateInvoiceSequence(uid, nextSequence(all, "invoice_number"))
      : null;
    const payload = clean({
      invoice_number: issuedAt && sequence ? invoiceNumber(issuedAt, sequence) : existing.invoice_number,
      sequence_no: sequence,
      issued_at: issuedAt,
      customer_id: req.body?.customer_id ?? existing.customer_id,
      customer_name: String(req.body?.customer_name || existing.customer_name || "").trim(),
      customer_phone: String(req.body?.customer_phone || existing.customer_phone || "").trim(),
      customer_city: String(req.body?.customer_city || existing.customer_city || "").trim(),
      customer_vat: customerVat,
      title: String(req.body?.title || existing.title || "").trim(),
      invoice_type: invoiceType,
      status: requestedStatus,
      issue_date: req.body?.issue_date || existing.issue_date,
      due_date: req.body?.due_date ?? existing.due_date ?? null,
      payment_method: String(req.body?.payment_method || existing.payment_method || "").trim(),
      currency: req.body?.currency || existing.currency || "SAR",
      items,
      notes: String(req.body?.notes ?? existing.notes ?? "").trim(),
      terms: String(req.body?.terms ?? existing.terms ?? "").trim(),
      ...totals,
      seller_name: String(req.body?.seller_name || existing.seller_name || settings.seller_name || "BreeXe Pro Co.").trim(),
      seller_vat: sellerVatNumber,
      seller_vat_number: sellerVatNumber,
      seller_address: String(req.body?.seller_address || existing.seller_address || settings.seller_address || "شركة بريكس برو شخص واحد ذات مسؤولية محدودة - الرياض").trim(),
      updatedAt: nowIso(),
    });
    verifiedInvoiceQr({ ...existing, ...payload }, 400);
    const updated = await compareAndSetDocument(
      adminDb.collection("invoices").doc(req.params.id),
      { status: "draft", issued_at: null, sequence_no: null },
      payload,
    );
    if (!updated) {
      res.status(409).json({ error: "تغيرت المسودة أثناء الحفظ؛ أعد تحميل الصفحة قبل المحاولة مجددًا." });
      return;
    }
    const invoice = await getInvoiceLedgerRecord(uid, req.params.id);
    res.json({ invoice });
  }));

  app.post("/api/invoices/:id/status", validateParams(crmIdParamsSchema), validate(invoiceStatusSchema), asyncRoute(async (req, res) => {
    const uid = userId(req);
    const status = String(req.body?.status || "").trim() as InvoiceStatus;
    if (!invoiceStatuses.has(status)) {
      res.status(400).json({ error: "حالة غير صالحة." });
      return;
    }
    const current = await getOwned("invoices", req.params.id, uid);
    if (!current) {
      res.status(404).json({ error: "الفاتورة غير موجودة." });
      return;
    }
    const currentInvoice = normalizeInvoice(current);
    const correctionKind = correctionKindForStatus(status);
    if (correctionKind) {
      const reason = String(req.body?.reason || "").trim();
      if (reason.length < 3) {
        res.status(400).json({ error: "سبب الإلغاء أو الاسترداد مطلوب لإنشاء الإشعار الدائن." });
        return;
      }
      const creditNote = await createFullInvoiceCreditNote(uid, currentInvoice, correctionKind, reason);
      const invoice = await getInvoiceLedgerRecord(uid, req.params.id);
      res.json({ invoice, credit_note: creditNote });
      return;
    }

    const effectiveInvoice = await getInvoiceLedgerRecord(uid, req.params.id);
    if (effectiveInvoice && (effectiveInvoice.status === "cancelled" || effectiveInvoice.status === "refunded")) {
      res.status(409).json({ error: "الفاتورة مرتبطة بإشعار دائن كامل ولا يمكن تغيير حالتها التشغيلية." });
      return;
    }

    if (!canApplyOperationalInvoiceStatus(currentInvoice, status)) {
      res.status(409).json({ error: "انتقال حالة الفاتورة غير مسموح. استخدم الإشعار الدائن للإلغاء أو الاسترداد." });
      return;
    }
    if (String(currentInvoice.status || "draft") === status) {
      res.json({ invoice: await getInvoiceLedgerRecord(uid, req.params.id) });
      return;
    }

    let issuance: Record<string, unknown> = {};
    if (status === "issued") {
      if (!invoiceIsMutableDraft(currentInvoice)) {
        res.status(409).json({ error: "لا يمكن إصدار هذا السجل لأنه ليس مسودة قابلة للإصدار." });
        return;
      }
      verifiedInvoiceQr(currentInvoice, 400);
      const all = await listOwned("invoices", uid, undefined, 10_000);
      const issuedAt = nowIso();
      const sequence = await allocateInvoiceSequence(uid, nextSequence(all, "invoice_number"));
      issuance = {
        invoice_number: invoiceNumber(issuedAt, sequence),
        sequence_no: sequence,
        issued_at: issuedAt,
      };
    }
    const update = clean({
      status,
      ...issuance,
      // Keep the original payment time; only stamp it the first time it's paid.
      paid_at: currentInvoice.paid_at || (status === "paid" ? nowIso() : undefined),
      updatedAt: nowIso(),
    });
    const changed = await compareAndSetInvoiceOperationalStatus(uid, currentInvoice, update);
    if (!changed) {
      res.status(409).json({ error: "تغيرت حالة الفاتورة بالتزامن؛ أعد تحميل الصفحة قبل المحاولة مجددًا." });
      return;
    }
    const invoice = await getInvoiceLedgerRecord(uid, req.params.id);
    if (status === "paid" && invoice) {
      try {
        captureCrmStageAttribution({
          ownerUid: uid,
          entityId: req.params.id,
          phone: String(invoice.customer_phone || ""),
          stage: "paid",
          amount: Number(invoice.total_with_vat || invoice.total || 0),
          currency: String(invoice.currency || "SAR"),
          contentName: String(invoice.invoice_number || invoice.title || "مكيفات"),
          occurredAt: String(invoice.paid_at || nowIso()),
        });
      } catch (error) {
        logError("tiktok.attribution.manual_invoice_paid_failed", error, { invoiceId: req.params.id });
      }
    }
    res.json({ invoice });
  }));

  app.delete("/api/invoices/:id", validateParams(crmIdParamsSchema), asyncRoute(async (req, res) => {
    const uid = userId(req);
    const existing = await getOwned("invoices", req.params.id, uid);
    if (!existing) {
      res.status(404).json({ error: "الفاتورة غير موجودة." });
      return;
    }
    if (!invoiceIsMutableDraft(existing)) {
      res.status(409).json({ error: "لا يمكن حذف فاتورة مصدرة أو إشعار دائن؛ الحذف متاح للمسودة فقط." });
      return;
    }
    if (!(await compareAndDeleteInvoiceDraft(uid, normalizeInvoice({ id: req.params.id, ...existing })))) {
      res.status(409).json({ error: "أُصدرت الفاتورة أثناء طلب الحذف؛ بقي السجل محفوظًا." });
      return;
    }
    res.json({ success: true });
  }));

  app.post("/api/invoices/:id/send-whatsapp", validateParams(crmIdParamsSchema), validate(documentSendSchema), asyncRoute(async (req, res) => {
    const uid = userId(req);
    const existing = await getOwned("invoices", req.params.id, uid);
    if (!existing) {
      res.status(404).json({ error: "الفاتورة غير موجودة." });
      return;
    }
    if (invoiceIsMutableDraft(existing)) {
      res.status(409).json({ error: "أصدر المسودة أولًا قبل إرسالها كفاتورة ضريبية." });
      return;
    }
    const invoice = normalizeInvoice(existing);
    const phone = String(req.body?.phone || invoice.customer_phone || "").trim();
    if (!phone) {
      res.status(400).json({ error: "رقم جوال العميل مطلوب." });
      return;
    }
    const currency = String(invoice.currency || "SAR");
    const documentUrl = invoiceShareUrl(req, invoice);
    const breakdown = invoiceBreakdown(invoice);
    const lines = (Array.isArray(invoice.items) ? invoice.items : []).map(
      (item: Record<string, any>, index: number) => `- ${item.description} × ${item.quantity}: ${Number(breakdown.lines[index]?.gross || 0).toLocaleString("en-US", { minimumFractionDigits: 2 })} ${currency}`,
    );
    const message = [
      `${invoiceDocumentLabels(invoice).ar} - BreeXe Pro Co.`,
      `${invoice.invoice_number}`,
      `العميل: ${invoice.customer_name}`,
      "",
      ...lines,
      "",
      `المجموع قبل الخصم والضريبة: ${Number(invoice.subtotal || 0).toLocaleString("en-US", { minimumFractionDigits: 2 })} ${currency}`,
      `الخصم: ${Number(invoice.discount || 0).toLocaleString("en-US", { minimumFractionDigits: 2 })} ${currency}`,
      `الخاضع للضريبة بعد الخصم: ${Number(invoice.total_without_vat || 0).toLocaleString("en-US", { minimumFractionDigits: 2 })} ${currency}`,
      `ضريبة ${Number(invoice.vat_percent || 0).toLocaleString("ar-SA")}%: ${Number(invoice.vat_amount || invoice.vat || 0).toLocaleString("en-US", { minimumFractionDigits: 2 })} ${currency}`,
      Number(invoice.additional_fee || 0) > 0
        ? `رسوم إضافية: ${Number(invoice.additional_fee).toLocaleString("en-US", { minimumFractionDigits: 2 })} ${currency}`
        : "",
      `الإجمالي شامل الضريبة: ${Number(invoice.total_with_vat || 0).toLocaleString("en-US", { minimumFractionDigits: 2 })} ${currency}`,
      "",
      `الرقم الضريبي: ${invoice.seller_vat_number || invoice.seller_vat || "313049114100003"}`,
      `رابط الفاتورة للطباعة أو الحفظ PDF: ${documentUrl}`,
      invoice.notes ? `ملاحظات: ${invoice.notes}` : "",
    ].filter(Boolean).join("\n");
    let result: Awaited<ReturnType<typeof whatsappService.sendText>>;
    try {
      result = await whatsappService.sendText(phone, message, { confirmationCode: req.body?.outboundCode });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("credentials are missing") || msg.includes("is not connected")) {
        const err = new Error(msg) as Error & { status?: number };
        err.status = 503;
        throw err;
      }
      throw error;
    }
    recordWhatsAppMessage({
      type: "sent",
      provider: whatsappService.getStatus().provider,
      direction: "outbound",
      to_phone: phone,
      message,
      message_id: (result as { messageId?: string | null })?.messageId || null,
      status: (result as { dryRun?: boolean })?.dryRun ? "dry_run" : "sent",
      owner_uid: uid,
      metadata: {
        kind: "invoice",
        invoice_id: req.params.id,
        invoice_number: invoice.invoice_number,
        document_url: documentUrl,
      },
    });
    const dryRun = Boolean((result as { dryRun?: boolean })?.dryRun);
    if (!dryRun && !invoiceIsCreditNote(invoice) && invoice.status === "issued") {
      await compareAndSetInvoiceOperationalStatus(uid, invoice, { status: "sent", updatedAt: nowIso() });
    }
    const updatedInvoice = await getInvoiceLedgerRecord(uid, req.params.id);
    res.json({ success: true, dry_run: dryRun, result, invoice: updatedInvoice });
  }));

  app.get("/api/invoices/:id/qr", asyncRoute(async (req, res) => {
    const existing = await getOwned("invoices", req.params.id, userId(req));
    if (!existing) {
      res.status(404).json({ error: "الفاتورة غير موجودة." });
      return;
    }
    if (invoiceIsMutableDraft(existing)) {
      res.status(409).json({ error: "المسودة لا تحمل رمز فاتورة ضريبية نهائيًا؛ أصدرها أولًا." });
      return;
    }
    const { input: qrInput, qr } = verifiedInvoiceQr(existing);
    res.json({
      qr_base64: qr,
      format: "TLV_BASE64",
      phase: "ZATCA Phase 1 basic TLV fields (tags 1-5)",
      compliance_level: "phase1_basic_tlv",
      phase2_integrated: false,
      warning: "لا يشمل هذا الرمز توقيع XML أو الربط والإرسال المطلوبين للمرحلة الثانية.",
      fields: zatcaQrFields(qrInput),
    });
  }));

  app.post("/api/quotes/:id/convert-to-invoice", validateParams(crmIdParamsSchema), validate(quoteConvertSchema), asyncRoute(async (req, res) => {
    const uid = userId(req);
    const existing = await getOwned("quotes", req.params.id, uid);
    if (!existing) {
      res.status(404).json({ error: "عرض السعر غير موجود." });
      return;
    }
    const items = verifiableInvoiceItems(existing.items);
    if (!items) {
      res.status(400).json({ error: "لا يمكن تحويل عرض السعر: صحّح الوصف والكمية والسعر في جميع البنود أولًا." });
      return;
    }
    const quote = normalizeQuote(existing);
    const idempotencyKey = `quote:${req.params.id}`;
    const settings = await getSettings(uid);
    const totals = invoiceTotals(
      items,
      quote.discount_value ?? quote.discount,
      quote.vat_percent,
      quote.discount_mode === "percent" ? "percent" : "fixed",
      quote.tax,
    );
    const invoiceType = resolveInvoiceTaxType({
      requested: req.body?.invoice_type,
      buyerVat: quote.customer_vat,
      taxableAmount: totals.total_without_vat,
    });
    const sellerVatNumber = String(req.body?.seller_vat_number || req.body?.seller_vat || settings.seller_vat_number || "313049114100003").trim();
    const result = await createAtomicInvoiceDocumentWithDatabase(adminDb as any, {
      ownerUid: uid,
      idempotencyKey,
      issued: true,
      legacyIdentity: { field: "quote_id", value: req.params.id },
      build: ({ sequence, issuedAt }) => {
        if (!sequence || !issuedAt) throw new Error("تعذر حجز رقم الفاتورة الضريبية.");
        const payload = clean({
          invoice_number: invoiceNumber(issuedAt, sequence),
          document_kind: "invoice",
          sequence_no: sequence,
          issued_at: issuedAt,
          source_invoice_id: null,
          adjustment_kind: null,
          adjustment_scope: null,
          adjustment_reason: null,
          quote_id: req.params.id,
          customer_id: quote.customer_id || null,
          customer_name: quote.customer_name || "",
          customer_phone: quote.customer_phone || "",
          customer_city: quote.customer_city || "",
          customer_vat: quote.customer_vat || "",
          title: quote.title || "",
          invoice_type: invoiceType,
          status: "issued",
          issue_date: todayInTimeZone(),
          payment_method: quote.payment_method || "",
          currency: quote.currency || "SAR",
          items,
          notes: quote.notes || "",
          terms: quote.terms || "",
          ...totals,
          seller_name: String(req.body?.seller_name || settings.seller_name || "BreeXe Pro Co.").trim(),
          seller_vat: sellerVatNumber,
          seller_vat_number: sellerVatNumber,
          seller_address: String(req.body?.seller_address || settings.seller_address || "شركة بريكس برو شخص واحد ذات مسؤولية محدودة - الرياض").trim(),
        });
        verifiedInvoiceQr(payload, 400);
        return payload;
      },
    });
    res.status(result.created ? 201 : 200).json({
      id: result.id,
      invoice: normalizeInvoice(result.data),
      idempotent_replay: !result.created,
    });
  }));
}
