import type express from "express";
import { adminDb } from "./firebaseAdmin";
import { todayInTimeZone } from "./reminderEngine";
import type { AuthedRequest } from "./auth";
import { recordWhatsAppMessage, whatsappService } from "./whatsapp";

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

function addMonths(date: string, months: number) {
  const [year, month, day] = date.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
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

function badRequest(message: string): never {
  const err = new Error(message) as Error & { status?: number };
  err.status = 400;
  throw err;
}

function textField(
  body: Record<string, any>,
  key: string,
  options: { required?: boolean; max?: number; fallback?: string } = {},
) {
  const hasValue = body[key] !== undefined && body[key] !== null;
  const value = hasValue ? String(body[key]).trim() : options.fallback;
  if (options.required && !value) badRequest(`${key} is required.`);
  if (value && options.max && value.length > options.max) badRequest(`${key} must be ${options.max} characters or less.`);
  return value;
}

function numberField(
  body: Record<string, any>,
  key: string,
  options: { fallback?: number; min?: number; max?: number; integer?: boolean } = {},
) {
  if (body[key] === undefined || body[key] === null || body[key] === "") return options.fallback;
  const raw = Number(body[key]);
  if (!Number.isFinite(raw)) badRequest(`${key} must be a valid number.`);
  const value = options.integer ? Math.trunc(raw) : raw;
  if (options.min !== undefined && value < options.min) badRequest(`${key} must be at least ${options.min}.`);
  if (options.max !== undefined && value > options.max) badRequest(`${key} must be at most ${options.max}.`);
  return value;
}

function dateField(body: Record<string, any>, key: string, required = false) {
  const value = textField(body, key, { required, max: 10 });
  if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) badRequest(`${key} must be YYYY-MM-DD.`);
  return value;
}

function enumField<T extends string>(
  body: Record<string, any>,
  key: string,
  allowed: ReadonlySet<T>,
  fallback?: T,
) {
  if (body[key] === undefined || body[key] === null || body[key] === "") return fallback;
  const value = String(body[key]).trim() as T;
  if (!allowed.has(value)) badRequest(`${key} is invalid.`);
  return value;
}

const productTypes = new Set(["sale_only", "install_maintenance", "maintenance_existing", "external_maintenance", "needs_review"]);
const installationStatuses = new Set(["pending_installation", "pending_external_service", "active", "completed", "cancelled"]);
const remindTypes = new Set(["first", "second", "last"]);
const bookingStatuses = new Set(["confirmed", "completed", "cancelled"]);
const bookingTypes = new Set(["installation", "maintenance", "external_maintenance"]);

function docData(doc: DocSnapshot): Record<string, any> & { id: string } {
  return { id: doc.id, ...doc.data() };
}

async function listOwned(table: string, uid: string, orderField?: string, limit = 250): Promise<Array<Record<string, any> & { id: string }>> {
  let ref = adminDb.collection(table).where("createdBy", "==", uid);
  if (orderField) ref = ref.orderBy(orderField);
  const snap = await ref.limit(limit).get();
  return snap.docs.map((doc: DocSnapshot) => docData(doc));
}

async function getOwned(table: string, id: string, uid: string) {
  const snap = await adminDb.collection(table).doc(id).get();
  if (!snap.exists) return null;
  const data = docData(snap);
  // SQLite stores ownership in `owner_uid`; the Firestore code path uses `createdBy`.
  // Accept either so the adapter abstraction does not require reverse-mapping.
  const ownerKey = (data as Record<string, unknown>).createdBy ?? (data as Record<string, unknown>).owner_uid;
  return ownerKey === uid ? data : null;
}

async function createOwned(table: string, uid: string, data: Record<string, unknown>) {
  const ref = adminDb.collection(table).doc();
  const now = nowIso();
  await ref.set(clean({
    ...data,
    createdBy: uid,
    createdAt: data.createdAt || now,
    updatedAt: now,
  }));
  return ref.id;
}

async function updateOwned(table: string, id: string, uid: string, data: Record<string, unknown>) {
  const existing = await getOwned(table, id, uid);
  if (!existing) return false;
  await adminDb.collection(table).doc(id).update(clean({ ...data, updatedAt: nowIso() }));
  return true;
}

async function deleteOwned(table: string, id: string, uid: string) {
  const existing = await getOwned(table, id, uid);
  if (!existing) return false;
  await adminDb.collection(table).doc(id).delete();
  return true;
}

async function stats(uid: string) {
  const [customers, products, technicians, installations, reminders, quotes, settings] = await Promise.all([
    listOwned("customers", uid, undefined, 1000),
    listOwned("products", uid, undefined, 1000),
    listOwned("technicians", uid, undefined, 1000),
    listOwned("installations", uid, undefined, 1000),
    listOwned("reminders", uid, undefined, 1000),
    listOwned("quotes", uid, undefined, 1000),
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

  return {
    customers: customers.length,
    products: products.length,
    technicians: technicians.length,
    installations: installations.length,
    quotes: quotes.length,
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
    care: customers.filter((customer) => {
      const hasInstallation = installations.some((item) => item.customer_id === customer.id || item.customer_phone === customer.phone);
      const hasReminder = reminders.some((item) => item.customer_id === customer.id || item.customer_phone === customer.phone);
      return !hasInstallation || !hasReminder;
    }).length,
  };
}

async function getSettings(uid: string) {
  const snap = await adminDb.collection("settings").doc(uid).get();
  if (!snap.exists) return defaultSettings;
  return { ...defaultSettings, ...snap.data() };
}

type QuoteStatus = "draft" | "issued" | "confirmed" | "declined" | "expired" | "follow_up";

const quoteStatuses = new Set(["draft", "issued", "confirmed", "declined", "expired", "follow_up"]);

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
        description: String(row.description || "").trim(),
        quantity,
        unit_price: unitPrice,
        total: quantity * unitPrice,
      };
    })
    .filter((item) => item.description || item.quantity > 0 || item.unit_price > 0);
}

function quoteTotals(items: Array<{ total: number }>, discount = 0, tax = 0) {
  const subtotal = items.reduce((sum, item) => sum + Number(item.total || 0), 0);
  const cleanDiscount = Math.max(0, Number(discount || 0));
  const cleanTax = Math.max(0, Number(tax || 0));
  return {
    subtotal,
    discount: cleanDiscount,
    tax: cleanTax,
    total: Math.max(0, subtotal - cleanDiscount + cleanTax),
  };
}

function quotePaymentFields(row: Record<string, any>, existing?: Record<string, any>) {
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
  };
}

function quoteInvoiceFields(row: Record<string, any>, existing?: Record<string, any>) {
  return {
    invoice_status: row.invoice_status || existing?.invoice_status || "not_issued",
    invoice_number: String(row.invoice_number || existing?.invoice_number || "").trim(),
    invoice_issued_at: String(row.invoice_issued_at || existing?.invoice_issued_at || "").trim(),
    invoice_seller_name: String(row.invoice_seller_name || existing?.invoice_seller_name || "").trim(),
    invoice_vat_number: String(row.invoice_vat_number || existing?.invoice_vat_number || "").trim(),
    invoice_vat_rate: Number(row.invoice_vat_rate ?? existing?.invoice_vat_rate ?? 15),
    invoice_vat_amount: Number(row.invoice_vat_amount ?? existing?.invoice_vat_amount ?? 0),
    invoice_qr_payload: String(row.invoice_qr_payload || existing?.invoice_qr_payload || "").trim(),
    invoice_phase: String(row.invoice_phase || existing?.invoice_phase || "").trim(),
  };
}

function normalizeQuote(row: Record<string, any>): Record<string, any> {
  const items = normalizeQuoteItems(row.items);
  const totals = quoteTotals(items, row.discount, row.tax);
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
    ...quoteInvoiceFields(row),
    subtotal: Number(row.subtotal ?? totals.subtotal),
    discount: Number(row.discount ?? totals.discount),
    tax: Number(row.tax ?? totals.tax),
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
  const totals = quoteTotals(items, body.discount, body.tax);
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
    ...quoteInvoiceFields(body, existing),
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
    const search = String(req.query.search || "").trim();
    let data = await listOwned("customers", userId(req), "name", 250);
    if (search) data = data.filter((item) => `${item.name || ""} ${item.phone || ""} ${item.city || ""}`.includes(search));
    res.json({ data, total: data.length });
  }));

  app.post("/api/customers", asyncRoute(async (req, res) => {
    const body = (req.body || {}) as Record<string, any>;
    const name = textField(body, "name", { required: true, max: 160 });
    const phone = textField(body, "phone", { required: true, max: 40 });
    const id = await createOwned("customers", userId(req), {
      name,
      phone,
      city: textField(body, "city", { max: 120, fallback: "" }),
      source: textField(body, "source", { max: 40, fallback: "manual" }),
      notes: textField(body, "notes", { max: 2000, fallback: "" }),
    });
    res.status(201).json({ id });
  }));

  app.put("/api/customers/:id", asyncRoute(async (req, res) => {
    const body = (req.body || {}) as Record<string, any>;
    const payload = clean({
      name: body.name !== undefined ? textField(body, "name", { required: true, max: 160 }) : undefined,
      phone: body.phone !== undefined ? textField(body, "phone", { required: true, max: 40 }) : undefined,
      city: body.city !== undefined ? textField(body, "city", { max: 120 }) : undefined,
      source: body.source !== undefined ? textField(body, "source", { max: 40 }) : undefined,
      notes: body.notes !== undefined ? textField(body, "notes", { max: 2000 }) : undefined,
    });
    if (!(await updateOwned("customers", req.params.id, userId(req), payload))) return res.status(404).json({ error: "Customer was not found." });
    res.json({ success: true });
  }));

  app.delete("/api/customers/:id", asyncRoute(async (req, res) => {
    if (!(await deleteOwned("customers", req.params.id, userId(req)))) return res.status(404).json({ error: "Customer was not found." });
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

  app.post("/api/quotes", asyncRoute(async (req, res) => {
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
      quote_number: quoteNumber(Date.now(), allQuotes.length + 1),
    };
    const id = await createOwned("quotes", uid, payload);
    const quote = await getOwned("quotes", id, uid);
    res.status(201).json({ id, quote: quote ? normalizeQuote(quote) : null });
  }));

  app.put("/api/quotes/:id", asyncRoute(async (req, res) => {
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

  app.post("/api/quotes/:id/status", asyncRoute(async (req, res) => {
    const uid = userId(req);
    const status = String(req.body?.status || "").trim() as QuoteStatus;
    if (!quoteStatuses.has(status)) {
      res.status(400).json({ error: "Invalid quote status." });
      return;
    }
    const update = clean({
      status,
      follow_up_date: req.body?.follow_up_date ?? undefined,
      confirmed_at: status === "confirmed" ? nowIso() : undefined,
    });
    if (!(await updateOwned("quotes", req.params.id, uid, update))) {
      res.status(404).json({ error: "Quote was not found." });
      return;
    }
    const quote = await getOwned("quotes", req.params.id, uid);
    res.json({ quote: quote ? normalizeQuote(quote) : null });
  }));

  app.delete("/api/quotes/:id", asyncRoute(async (req, res) => {
    if (!(await deleteOwned("quotes", req.params.id, userId(req)))) return res.status(404).json({ error: "Quote was not found." });
    res.json({ success: true });
  }));

  app.post("/api/quotes/:id/send-whatsapp", asyncRoute(async (req, res) => {
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
    res.json(await listOwned("products", userId(req), "name", 250));
  }));

  app.post("/api/products", asyncRoute(async (req, res) => {
    const body = (req.body || {}) as Record<string, any>;
    const id = await createOwned("products", userId(req), {
      name: textField(body, "name", { required: true, max: 180 }),
      interval_months: numberField(body, "interval_months", { fallback: 1, min: 1, max: 120, integer: true }),
      category: textField(body, "category", { max: 120, fallback: "" }),
      sku: textField(body, "sku", { max: 120, fallback: "" }),
      remind_text: textField(body, "remind_text", { max: 2000, fallback: "" }),
      source: textField(body, "source", { max: 40, fallback: "manual" }),
      product_type: enumField(body, "product_type", productTypes, "install_maintenance"),
      price: numberField(body, "price", { min: 0 }),
      sale_price: numberField(body, "sale_price", { min: 0 }),
      currency: textField(body, "currency", { max: 12, fallback: "SAR" }),
      stock_quantity: numberField(body, "stock_quantity", { min: 0 }),
    });
    res.status(201).json({ id });
  }));

  app.put("/api/products/:id", asyncRoute(async (req, res) => {
    const body = (req.body || {}) as Record<string, any>;
    const payload = clean({
      name: body.name !== undefined ? textField(body, "name", { required: true, max: 180 }) : undefined,
      interval_months: body.interval_months !== undefined ? numberField(body, "interval_months", { min: 1, max: 120, integer: true }) : undefined,
      category: body.category !== undefined ? textField(body, "category", { max: 120 }) : undefined,
      sku: body.sku !== undefined ? textField(body, "sku", { max: 120 }) : undefined,
      remind_text: body.remind_text !== undefined ? textField(body, "remind_text", { max: 2000 }) : undefined,
      source: body.source !== undefined ? textField(body, "source", { max: 40 }) : undefined,
      product_type: body.product_type !== undefined ? enumField(body, "product_type", productTypes) : undefined,
      price: body.price !== undefined ? numberField(body, "price", { min: 0 }) : undefined,
      sale_price: body.sale_price !== undefined ? numberField(body, "sale_price", { min: 0 }) : undefined,
      currency: body.currency !== undefined ? textField(body, "currency", { max: 12 }) : undefined,
      stock_quantity: body.stock_quantity !== undefined ? numberField(body, "stock_quantity", { min: 0 }) : undefined,
    });
    if (!(await updateOwned("products", req.params.id, userId(req), payload))) return res.status(404).json({ error: "Product was not found." });
    res.json({ success: true });
  }));

  app.delete("/api/products/:id", asyncRoute(async (req, res) => {
    if (!(await deleteOwned("products", req.params.id, userId(req)))) return res.status(404).json({ error: "Product was not found." });
    res.json({ success: true });
  }));

  app.get("/api/installations", asyncRoute(async (req, res) => {
    const data = await listOwned("installations", userId(req), "next_maintenance", 300);
    res.json(data.map((item) => ({ ...item, days_until: daysUntil(String(item.next_maintenance || "")) })));
  }));

  app.post("/api/installations", asyncRoute(async (req, res) => {
    const body = (req.body || {}) as Record<string, any>;
    const id = await createOwned("installations", userId(req), {
      customer_id: textField(body, "customer_id", { required: true, max: 120 }),
      customer_name: textField(body, "customer_name", { required: true, max: 180 }),
      customer_phone: textField(body, "customer_phone", { required: true, max: 40 }),
      product_id: textField(body, "product_id", { required: true, max: 120 }),
      product_name: textField(body, "product_name", { required: true, max: 180 }),
      product_sku: textField(body, "product_sku", { max: 120, fallback: "" }),
      install_date: dateField(body, "install_date", true),
      next_maintenance: dateField(body, "next_maintenance", true),
      label: textField(body, "label", { max: 180, fallback: "" }),
      remind_count: 0,
      next_remind_type: enumField(body, "next_remind_type", remindTypes, "first"),
      status: enumField(body, "status", installationStatuses, "active"),
      completed_date: null,
      last_remind_at: null,
      last_remind_attempt_at: null,
      source: textField(body, "source", { max: 40, fallback: "manual" }),
      notes: textField(body, "notes", { max: 2000, fallback: "" }),
    });
    res.status(201).json({ id });
  }));

  app.put("/api/installations/:id", asyncRoute(async (req, res) => {
    const body = (req.body || {}) as Record<string, any>;
    const payload = clean({
      customer_id: body.customer_id !== undefined ? textField(body, "customer_id", { required: true, max: 120 }) : undefined,
      customer_name: body.customer_name !== undefined ? textField(body, "customer_name", { required: true, max: 180 }) : undefined,
      customer_phone: body.customer_phone !== undefined ? textField(body, "customer_phone", { required: true, max: 40 }) : undefined,
      product_id: body.product_id !== undefined ? textField(body, "product_id", { required: true, max: 120 }) : undefined,
      product_name: body.product_name !== undefined ? textField(body, "product_name", { required: true, max: 180 }) : undefined,
      product_sku: body.product_sku !== undefined ? textField(body, "product_sku", { max: 120 }) : undefined,
      install_date: body.install_date !== undefined ? dateField(body, "install_date", true) : undefined,
      next_maintenance: body.next_maintenance !== undefined ? dateField(body, "next_maintenance", true) : undefined,
      label: body.label !== undefined ? textField(body, "label", { max: 180 }) : undefined,
      next_remind_type: body.next_remind_type !== undefined ? enumField(body, "next_remind_type", remindTypes) : undefined,
      status: body.status !== undefined ? enumField(body, "status", installationStatuses) : undefined,
      completed_date: body.completed_date !== undefined ? dateField(body, "completed_date") : undefined,
      source: body.source !== undefined ? textField(body, "source", { max: 40 }) : undefined,
      notes: body.notes !== undefined ? textField(body, "notes", { max: 2000 }) : undefined,
    });
    if (!(await updateOwned("installations", req.params.id, userId(req), payload))) return res.status(404).json({ error: "Installation was not found." });
    res.json({ success: true });
  }));

  app.post("/api/installations/:id/complete", asyncRoute(async (req, res) => {
    if (!(await updateOwned("installations", req.params.id, userId(req), {
      status: "completed",
      completed_date: req.body?.completedDate || todayInTimeZone(),
      next_remind_type: null,
    }))) return res.status(404).json({ error: "Installation was not found." });
    res.json({ success: true });
  }));

  app.delete("/api/installations/:id", asyncRoute(async (req, res) => {
    if (!(await deleteOwned("installations", req.params.id, userId(req)))) return res.status(404).json({ error: "Installation was not found." });
    res.json({ success: true });
  }));

  app.get("/api/technicians", asyncRoute(async (req, res) => {
    res.json(await listOwned("technicians", userId(req), "name", 250));
  }));

  app.post("/api/technicians", asyncRoute(async (req, res) => {
    const body = (req.body || {}) as Record<string, any>;
    const id = await createOwned("technicians", userId(req), {
      name: textField(body, "name", { required: true, max: 160 }),
      phone: textField(body, "phone", { max: 40, fallback: "" }),
      specialty: textField(body, "specialty", { max: 160, fallback: "" }),
      max_daily: numberField(body, "max_daily", { fallback: 4, min: 1, max: 30, integer: true }),
      notes: textField(body, "notes", { max: 2000, fallback: "" }),
    });
    res.status(201).json({ id });
  }));

  app.put("/api/technicians/:id", asyncRoute(async (req, res) => {
    const body = (req.body || {}) as Record<string, any>;
    const payload = clean({
      name: body.name !== undefined ? textField(body, "name", { required: true, max: 160 }) : undefined,
      phone: body.phone !== undefined ? textField(body, "phone", { max: 40 }) : undefined,
      specialty: body.specialty !== undefined ? textField(body, "specialty", { max: 160 }) : undefined,
      max_daily: body.max_daily !== undefined ? numberField(body, "max_daily", { min: 1, max: 30, integer: true }) : undefined,
      notes: body.notes !== undefined ? textField(body, "notes", { max: 2000 }) : undefined,
    });
    if (!(await updateOwned("technicians", req.params.id, userId(req), payload))) return res.status(404).json({ error: "Technician was not found." });
    res.json({ success: true });
  }));

  app.delete("/api/technicians/:id", asyncRoute(async (req, res) => {
    if (!(await deleteOwned("technicians", req.params.id, userId(req)))) return res.status(404).json({ error: "Technician was not found." });
    res.json({ success: true });
  }));

  app.get("/api/bookings", asyncRoute(async (req, res) => {
    const uid = userId(req);
    let ref = adminDb.collection("bookings").where("createdBy", "==", uid);
    if (req.query.date) ref = ref.where("date", "==", String(req.query.date));
    const snap = await ref.orderBy(req.query.date ? "scheduled_time" : "date").limit(300).get();
    res.json(snap.docs.map((doc: DocSnapshot) => docData(doc)));
  }));

  app.post("/api/bookings", asyncRoute(async (req, res) => {
    const uid = userId(req);
    const body = (req.body || {}) as Record<string, any>;
    const technicianId = textField(body, "technician_id", { max: 120, fallback: "" }) || "";
    if (technicianId && !(await getOwned("technicians", technicianId, uid))) {
      res.status(400).json({ error: "Technician was not found." });
      return;
    }
    const id = await createOwned("bookings", uid, {
      installation_id: textField(body, "installation_id", { max: 120, fallback: "" }),
      customer_id: textField(body, "customer_id", { max: 120, fallback: "" }),
      customer_name: textField(body, "customer_name", { required: true, max: 180 }),
      customer_phone: textField(body, "customer_phone", { max: 40, fallback: "" }),
      product_id: textField(body, "product_id", { max: 120, fallback: "" }),
      product_name: textField(body, "product_name", { required: true, max: 180 }),
      technician_id: technicianId || null,
      tech_name: textField(body, "tech_name", { required: true, max: 180 }),
      date: dateField(body, "date", true),
      scheduled_time: textField(body, "scheduled_time", { required: true, max: 40 }),
      status: enumField(body, "status", bookingStatuses, "confirmed"),
      booking_type: enumField(body, "booking_type", bookingTypes, "maintenance"),
      source: textField(body, "source", { max: 40, fallback: "manual" }),
      notes: textField(body, "notes", { max: 2000, fallback: "" }),
    });
    res.status(201).json({ id });
  }));

  app.put("/api/bookings/:id", asyncRoute(async (req, res) => {
    const uid = userId(req);
    const body = (req.body || {}) as Record<string, any>;
    const technicianId = body.technician_id !== undefined ? textField(body, "technician_id", { max: 120 }) : undefined;
    if (technicianId && !(await getOwned("technicians", technicianId, uid))) {
      res.status(400).json({ error: "Technician was not found." });
      return;
    }
    const payload = clean({
      installation_id: body.installation_id !== undefined ? textField(body, "installation_id", { max: 120 }) : undefined,
      customer_id: body.customer_id !== undefined ? textField(body, "customer_id", { max: 120 }) : undefined,
      customer_name: body.customer_name !== undefined ? textField(body, "customer_name", { required: true, max: 180 }) : undefined,
      customer_phone: body.customer_phone !== undefined ? textField(body, "customer_phone", { max: 40 }) : undefined,
      product_id: body.product_id !== undefined ? textField(body, "product_id", { max: 120 }) : undefined,
      product_name: body.product_name !== undefined ? textField(body, "product_name", { required: true, max: 180 }) : undefined,
      technician_id: technicianId,
      tech_name: body.tech_name !== undefined ? textField(body, "tech_name", { required: true, max: 180 }) : undefined,
      date: body.date !== undefined ? dateField(body, "date", true) : undefined,
      scheduled_time: body.scheduled_time !== undefined ? textField(body, "scheduled_time", { required: true, max: 40 }) : undefined,
      status: body.status !== undefined ? enumField(body, "status", bookingStatuses) : undefined,
      booking_type: body.booking_type !== undefined ? enumField(body, "booking_type", bookingTypes) : undefined,
      source: body.source !== undefined ? textField(body, "source", { max: 40 }) : undefined,
      notes: body.notes !== undefined ? textField(body, "notes", { max: 2000 }) : undefined,
    });
    if (!(await updateOwned("bookings", req.params.id, uid, payload))) return res.status(404).json({ error: "Booking was not found." });
    res.json({ success: true });
  }));

  app.delete("/api/bookings/:id", asyncRoute(async (req, res) => {
    if (!(await deleteOwned("bookings", req.params.id, userId(req)))) return res.status(404).json({ error: "Booking was not found." });
    res.json({ success: true });
  }));

  app.get("/api/reminders", asyncRoute(async (req, res) => {
    res.json(await listOwned("reminders", userId(req), "sent_at", 300));
  }));

  app.get("/api/settings", asyncRoute(async (req, res) => {
    res.json(await getSettings(userId(req)));
  }));

  app.put("/api/settings", asyncRoute(async (req, res) => {
    const uid = userId(req);
    const body = (req.body || {}) as Record<string, any>;
    await adminDb.collection("settings").doc(uid).set({
      ...defaultSettings,
      techs: numberField(body, "techs", { fallback: defaultSettings.techs, min: 1, max: 100, integer: true }),
      jobs_per_tech: numberField(body, "jobs_per_tech", { fallback: defaultSettings.jobs_per_tech, min: 1, max: 50, integer: true }),
      response_rate: numberField(body, "response_rate", { fallback: defaultSettings.response_rate, min: 0, max: 100, integer: true }),
      maxDaily: numberField(body, "maxDaily", { fallback: defaultSettings.maxDaily, min: 1, max: 500, integer: true }),
      createdBy: uid,
      updatedAt: nowIso(),
    }, { merge: true });
    res.json({ success: true });
  }));

  app.post("/api/demo-data", asyncRoute(async (req, res) => {
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
}
