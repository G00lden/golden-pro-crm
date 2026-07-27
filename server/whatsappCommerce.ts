import crypto, { randomUUID } from "node:crypto";
import db from "./db";
import { createPaymentLinkForInvoice } from "./routes-payment";
import { queueFieldTechSync } from "./fieldtechIntegration";
import { normalizePhoneDigits, phoneTail } from "../shared/phone";
import {
  clearWhatsAppCommerceSession,
  getWhatsAppCommerceSession,
  saveWhatsAppCommerceSession,
  type WhatsAppCommerceSession,
  type WhatsAppCommerceStep,
} from "./whatsappCommerceStorage";

type CustomerRow = {
  id: string;
  owner_uid: string;
  name: string;
  phone: string;
  city: string | null;
  address: string | null;
  customer_address: string | null;
};

type InstallationRow = {
  id: string;
  customer_id: string;
  customer_name: string;
  customer_phone: string;
  product_id: string;
  product_name: string;
  status: string;
  customer_address: string | null;
};

type ProductRow = {
  id: string;
  name: string;
  product_type: string;
};

type TechnicianRow = {
  id: string;
  name: string;
  max_daily: number;
};

type InvoiceRow = {
  id: string;
  invoice_number: string;
  total_with_vat: number;
  currency: string;
};

type SlotOption = {
  date: string;
  time: string;
};

type ServiceContext = {
  installationId?: string;
  productId: string;
  productName: string;
  bookingType: "installation" | "maintenance" | "external_maintenance";
};

type CommerceContext = {
  customerId?: string;
  slots?: SlotOption[];
  service?: ServiceContext;
};

export type WhatsAppCommerceResult = {
  handled: boolean;
  kind?: string;
  reply?: string;
  bookingId?: string;
  paymentId?: string;
  reason?: string;
};

type PaymentLinkResult = Awaited<ReturnType<typeof createPaymentLinkForInvoice>>;

type WhatsAppCommerceDependencies = {
  now?: () => Date;
  createPaymentLink?: typeof createPaymentLinkForInvoice;
  queueFieldTechSync?: (reason: string) => unknown;
};

const CUSTOMER_PHONE_SQL = `
  REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone, '+', ''), ' ', ''), '-', ''), '(', ''), ')', '')
`;
const INSTALLATION_PHONE_SQL = `
  REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(customer_phone, '+', ''), ' ', ''), '-', ''), '(', ''), ')', '')
`;
const INVOICE_PHONE_SQL = `
  REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(customer_phone, '+', ''), ' ', ''), '-', ''), '(', ''), ')', '')
`;

function normalizeArabicDigits(value: string) {
  return value
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)));
}

function normalizedText(value: unknown) {
  return normalizeArabicDigits(String(value || ""))
    .normalize("NFKC")
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function choiceNumber(value: string) {
  const match = normalizedText(value).match(/^(\d{1,2})(?:\s|$)/);
  return match ? Number(match[1]) : null;
}

function isGreeting(text: string) {
  return [
    "السلام",
    "السلام عليكم",
    "سلام",
    "مرحبا",
    "اهلا",
    "أهلا",
    "هلا",
    "hi",
    "hello",
    "menu",
    "القائمه",
    "القائمة",
  ].includes(text);
}

function isPaymentIntent(text: string) {
  return /(?:^|\s)(?:دفع|سداد|اسدد|أسدد|فاتوره|فاتورة)(?:\s|$)/.test(text)
    || /رابط\s*(?:ال)?دفع/.test(text);
}

function isBookingIntent(text: string) {
  return /(?:^|\s)(?:حجز|موعد|صيانه|صيانة|تركيب)(?:\s|$)/.test(text)
    || /احجز|أحجز/.test(text);
}

function isCancelIntent(text: string) {
  return /^(?:الغاء|إلغاء|الغي|ألغي|ابدأ من جديد|ابدا من جديد|reset)$/.test(text);
}

function sessionTtlMinutes() {
  return Math.max(5, Math.min(240, Number(process.env.WHATSAPP_COMMERCE_SESSION_MINUTES || 30)));
}

function saveSession(
  ownerUid: string,
  phone: string,
  step: WhatsAppCommerceStep,
  context: CommerceContext,
  now: Date,
) {
  saveWhatsAppCommerceSession(db, {
    ownerUid,
    phone,
    step,
    context: context as Record<string, unknown>,
    now: now.toISOString(),
    ttlMinutes: sessionTtlMinutes(),
  });
}

function mainMenu() {
  return [
    "أهلًا بك في جولدن برو 👋",
    "اختر الخدمة:",
    "1 - رابط دفع فاتورة",
    "2 - حجز موعد تركيب أو صيانة",
    "",
    "يمكنك أيضًا كتابة: دفع أو حجز.",
  ].join("\n");
}

function replyWithOptions(title: string, options: string[], footer = "أرسل رقم الخيار.") {
  return [title, ...options, "", footer].join("\n");
}

function findCustomer(ownerUid: string, phone: string): CustomerRow | null {
  const tail = phoneTail(phone);
  if (!tail) return null;
  return db.prepare(
    `SELECT id, owner_uid, name, phone, city, address, customer_address
       FROM customers
      WHERE owner_uid = ? AND ${CUSTOMER_PHONE_SQL} LIKE ?
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1`,
  ).get(ownerUid, `%${tail}`) as CustomerRow | undefined || null;
}

function customerAddress(customer: CustomerRow) {
  return String(customer.customer_address || customer.address || customer.city || "").trim();
}

function validCustomerName(value: string) {
  const name = value.replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 120 || /^\d+$/.test(name)) return "";
  return name;
}

function createCustomer(ownerUid: string, phone: string, name: string, now: Date): CustomerRow {
  return db.transaction(() => {
    const existing = findCustomer(ownerUid, phone);
    if (existing) return existing;
    const id = `wa_customer_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    db.prepare(
      `INSERT INTO customers (
         id, owner_uid, name, phone, city, address, customer_address,
         source, notes, created_at, updated_at
       ) VALUES (?, ?, ?, ?, '', '', '', 'whatsapp', ?, ?, ?)`,
    ).run(
      id,
      ownerUid,
      name,
      normalizePhoneDigits(phone),
      "أنشأه العميل عبر الحجز الذاتي في واتساب.",
      now.toISOString(),
      now.toISOString(),
    );
    return findCustomer(ownerUid, phone)!;
  }).immediate();
}

function saveCustomerAddress(customer: CustomerRow, address: string, now: Date) {
  const clean = address.replace(/\s+/g, " ").trim().slice(0, 300);
  if (clean.length < 4) return false;
  db.prepare(
    `UPDATE customers
        SET address = ?, customer_address = ?, updated_at = ?
      WHERE id = ? AND owner_uid = ?`,
  ).run(clean, clean, now.toISOString(), customer.id, customer.owner_uid);
  return true;
}

function listCustomerInstallations(ownerUid: string, customer: CustomerRow) {
  const tail = phoneTail(customer.phone);
  return db.prepare(
    `SELECT id, customer_id, customer_name, customer_phone, product_id, product_name,
            status, customer_address
       FROM installations
      WHERE owner_uid = ?
        AND status IN ('active', 'pending_installation', 'pending_external_service')
        AND (customer_id = ? OR ${INSTALLATION_PHONE_SQL} LIKE ?)
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 6`,
  ).all(ownerUid, customer.id, `%${tail}`) as InstallationRow[];
}

function listBookableProducts(ownerUid: string) {
  return db.prepare(
    `SELECT id, name, product_type
       FROM products
      WHERE owner_uid = ?
        AND COALESCE(catalog_visible, 1) <> 0
        AND COALESCE(is_available, 1) <> 0
        AND merged_into IS NULL
        AND product_type IN ('install_maintenance', 'external_maintenance')
      ORDER BY name ASC
      LIMIT 6`,
  ).all(ownerUid) as ProductRow[];
}

function serviceFromInstallation(installation: InstallationRow): ServiceContext {
  const bookingType =
    installation.status === "pending_installation"
      ? "installation"
      : installation.status === "pending_external_service"
        ? "external_maintenance"
        : "maintenance";
  return {
    installationId: installation.id,
    productId: installation.product_id,
    productName: installation.product_name,
    bookingType,
  };
}

function serviceFromProduct(product: ProductRow): ServiceContext {
  return {
    productId: product.id,
    productName: product.name,
    bookingType: product.product_type === "external_maintenance" ? "external_maintenance" : "installation",
  };
}

function riyadhDate(now: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.APP_TIMEZONE || "Asia/Riyadh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function slotTimes() {
  const configured = String(process.env.WHATSAPP_BOOKING_SLOT_TIMES || "09:00,11:00,14:00,16:00")
    .split(/[,\s]+/)
    .map((value) => value.trim())
    .filter((value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value));
  return [...new Set(configured)].sort();
}

function closedWeekdays() {
  return new Set(
    String(process.env.WHATSAPP_BOOKING_CLOSED_WEEKDAYS || "5")
      .split(/[,\s]+/)
      .map(Number)
      .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6),
  );
}

function bookingTechnicians(ownerUid: string) {
  return db.prepare(
    `SELECT id, name, MAX(1, COALESCE(max_daily, 4)) AS max_daily
       FROM technicians
      WHERE owner_uid = ?
      ORDER BY name ASC`,
  ).all(ownerUid) as TechnicianRow[];
}

function availableSlots(ownerUid: string, now: Date): SlotOption[] {
  const technicians = bookingTechnicians(ownerUid);
  if (!technicians.length) return [];
  const today = riyadhDate(now);
  const lookaheadDays = Math.max(1, Math.min(30, Number(process.env.WHATSAPP_BOOKING_LOOKAHEAD_DAYS || 10)));
  const leadMs = Math.max(0, Math.min(168, Number(process.env.WHATSAPP_BOOKING_MIN_LEAD_HOURS || 4))) * 3_600_000;
  const slots: SlotOption[] = [];
  const closed = closedWeekdays();

  for (let offset = 0; offset <= lookaheadDays && slots.length < 5; offset += 1) {
    const date = addDays(today, offset);
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (closed.has(weekday)) continue;
    for (const time of slotTimes()) {
      if (Date.parse(`${date}T${time}:00+03:00`) <= now.getTime() + leadMs) continue;
      const hasCapacity = technicians.some((technician) => {
        const daily = Number((db.prepare(
          `SELECT COUNT(*) AS count
             FROM bookings
            WHERE owner_uid = ? AND technician_id = ? AND date = ? AND status = 'confirmed'`,
        ).get(ownerUid, technician.id, date) as { count?: number } | undefined)?.count || 0);
        if (daily >= technician.max_daily) return false;
        const occupied = db.prepare(
          `SELECT 1
             FROM bookings
            WHERE owner_uid = ? AND technician_id = ? AND date = ?
              AND scheduled_time = ? AND status = 'confirmed'
            LIMIT 1`,
        ).get(ownerUid, technician.id, date, time);
        return !occupied;
      });
      if (hasCapacity) slots.push({ date, time });
      if (slots.length >= 5) break;
    }
  }
  return slots;
}

function formatSlot(slot: SlotOption) {
  const date = new Intl.DateTimeFormat("ar-SA-u-ca-gregory", {
    timeZone: process.env.APP_TIMEZONE || "Asia/Riyadh",
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(`${slot.date}T12:00:00+03:00`));
  return `${date} - ${slot.time}`;
}

function sessionContext(session: WhatsAppCommerceSession): CommerceContext {
  return session.context as CommerceContext;
}

function customerFromContext(ownerUid: string, phone: string, context: CommerceContext) {
  const byId = context.customerId
    ? db.prepare(
        `SELECT id, owner_uid, name, phone, city, address, customer_address
           FROM customers WHERE id = ? AND owner_uid = ? LIMIT 1`,
      ).get(context.customerId, ownerUid) as CustomerRow | undefined
    : undefined;
  if (byId && phoneTail(byId.phone) === phoneTail(phone)) return byId;
  return findCustomer(ownerUid, phone);
}

function offerSlots(
  ownerUid: string,
  phone: string,
  customer: CustomerRow,
  service: ServiceContext,
  now: Date,
): WhatsAppCommerceResult {
  const slots = availableSlots(ownerUid, now);
  if (!slots.length) {
    clearWhatsAppCommerceSession(db, ownerUid, phone);
    return {
      handled: true,
      kind: "booking_no_slots",
      reply: "لا توجد مواعيد متاحة آليًا الآن. تم إيقاف الحجز الذاتي مؤقتًا، وسيخدمك موظف المواعيد.",
    };
  }
  saveSession(ownerUid, phone, "awaiting_slot", {
    customerId: customer.id,
    service,
    slots,
  }, now);
  return {
    handled: true,
    kind: "booking_slots",
    reply: replyWithOptions(
      `اختر موعد ${service.productName}:`,
      slots.map((slot, index) => `${index + 1} - ${formatSlot(slot)}`),
    ),
  };
}

function beginProductSelection(
  ownerUid: string,
  phone: string,
  customer: CustomerRow,
  now: Date,
): WhatsAppCommerceResult {
  const products = listBookableProducts(ownerUid);
  if (!products.length) {
    clearWhatsAppCommerceSession(db, ownerUid, phone);
    return {
      handled: true,
      kind: "booking_no_products",
      reply: "لا توجد خدمات مهيأة للحجز الذاتي حاليًا. سيخدمك موظف المواعيد لتحديد الخدمة المناسبة.",
    };
  }
  saveSession(ownerUid, phone, "awaiting_product", { customerId: customer.id }, now);
  return {
    handled: true,
    kind: "booking_products",
    reply: replyWithOptions(
      "اختر الخدمة المطلوبة:",
      products.map((product, index) => `${index + 1} - ${product.name}`),
    ),
  };
}

function beginBookingService(
  ownerUid: string,
  phone: string,
  customer: CustomerRow,
  now: Date,
): WhatsAppCommerceResult {
  const installations = listCustomerInstallations(ownerUid, customer);
  if (!installations.length) return beginProductSelection(ownerUid, phone, customer, now);
  saveSession(ownerUid, phone, "awaiting_booking_kind", {
    customerId: customer.id,
  }, now);
  return {
    handled: true,
    kind: "booking_kind",
    reply: replyWithOptions(
      "ما نوع الموعد؟",
      [
        "1 - صيانة جهاز مسجل لديك",
        "2 - تركيب أو خدمة جديدة",
      ],
    ),
  };
}

function beginBooking(
  ownerUid: string,
  phone: string,
  now: Date,
): WhatsAppCommerceResult {
  const customer = findCustomer(ownerUid, phone);
  if (!customer) {
    saveSession(ownerUid, phone, "awaiting_name", {}, now);
    return {
      handled: true,
      kind: "booking_name_required",
      reply: "لبدء الحجز، اكتب اسمك الكامل كما تريد أن يظهر في الموعد.",
    };
  }
  if (!customerAddress(customer)) {
    saveSession(ownerUid, phone, "awaiting_address", { customerId: customer.id }, now);
    return {
      handled: true,
      kind: "booking_address_required",
      reply: "اكتب المدينة والحي والعنوان المختصر لتنفيذ الموعد.",
    };
  }
  return beginBookingService(ownerUid, phone, customer, now);
}

function latestPayableInvoice(ownerUid: string, phone: string): InvoiceRow | null {
  const tail = phoneTail(phone);
  if (!tail) return null;
  return db.prepare(
    `SELECT invoice.id, invoice.invoice_number, invoice.total_with_vat, invoice.currency
       FROM invoices invoice
      WHERE invoice.owner_uid = ?
        AND invoice.document_kind = 'invoice'
        AND invoice.issued_at IS NOT NULL
        AND invoice.status IN ('issued', 'sent')
        AND invoice.total_with_vat > 0
        AND ${INVOICE_PHONE_SQL.replaceAll("customer_phone", "invoice.customer_phone")} LIKE ?
        AND NOT EXISTS (
          SELECT 1 FROM invoices credit
          WHERE credit.owner_uid = invoice.owner_uid
            AND credit.source_invoice_id = invoice.id
            AND credit.document_kind = 'credit_note'
            AND credit.adjustment_scope = 'full'
        )
      ORDER BY invoice.issue_date DESC, invoice.created_at DESC
      LIMIT 1`,
  ).get(ownerUid, `%${tail}`) as InvoiceRow | undefined || null;
}

function paymentBaseUrl() {
  const raw = String(process.env.APP_URL || process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
      return "";
    }
    return url.origin;
  } catch {
    return "";
  }
}

async function sendPaymentLink(
  ownerUid: string,
  phone: string,
  now: Date,
  createPaymentLink: typeof createPaymentLinkForInvoice,
): Promise<WhatsAppCommerceResult> {
  const invoice = latestPayableInvoice(ownerUid, phone);
  if (!invoice) {
    clearWhatsAppCommerceSession(db, ownerUid, phone);
    return {
      handled: true,
      kind: "payment_not_found",
      reply: "لم أجد فاتورة صادرة وغير مدفوعة مرتبطة بهذا الرقم. أرسل رقم الفاتورة لموظف المبيعات للمساعدة.",
    };
  }
  const baseUrl = paymentBaseUrl();
  if (!baseUrl) {
    return {
      handled: true,
      kind: "payment_unavailable",
      reply: "رابط الدفع الإلكتروني غير متاح مؤقتًا. سيخدمك موظف المبيعات لإتمام الدفع.",
    };
  }
  try {
    const payment: PaymentLinkResult = await createPaymentLink({
      ownerUid,
      invoiceId: invoice.id,
      idempotencyKey: `wa:${crypto.createHash("sha256").update(`${ownerUid}\0${invoice.id}\0${phoneTail(phone)}`).digest("hex").slice(0, 48)}`,
      baseUrl,
    });
    if (!payment.redirect_url) throw new Error("Payment provider did not return a redirect URL.");
    clearWhatsAppCommerceSession(db, ownerUid, phone);
    return {
      handled: true,
      kind: "payment_link",
      paymentId: payment.payment_id,
      reply: [
        `رابط دفع الفاتورة ${invoice.invoice_number}`,
        `المبلغ: ${Number(invoice.total_with_vat).toFixed(2)} ${invoice.currency || "SAR"}`,
        payment.redirect_url,
        "",
        "بعد إتمام الدفع ارجع إلى واتساب واكتب: حجز",
      ].join("\n"),
    };
  } catch {
    return {
      handled: true,
      kind: "payment_unavailable",
      reply: "تعذر إنشاء رابط الدفع الآن. لم يتم إنشاء مطالبة مكررة؛ حاول بعد قليل أو تواصل مع موظف المبيعات.",
    };
  }
}

function chooseTechnician(ownerUid: string, slot: SlotOption) {
  return bookingTechnicians(ownerUid)
    .map((technician) => {
      const daily = Number((db.prepare(
        `SELECT COUNT(*) AS count
           FROM bookings
          WHERE owner_uid = ? AND technician_id = ? AND date = ? AND status = 'confirmed'`,
      ).get(ownerUid, technician.id, slot.date) as { count?: number } | undefined)?.count || 0);
      const occupied = Boolean(db.prepare(
        `SELECT 1
           FROM bookings
          WHERE owner_uid = ? AND technician_id = ? AND date = ?
            AND scheduled_time = ? AND status = 'confirmed'
          LIMIT 1`,
      ).get(ownerUid, technician.id, slot.date, slot.time));
      return { ...technician, daily, occupied };
    })
    .filter((technician) => !technician.occupied && technician.daily < technician.max_daily)
    .sort((left, right) => left.daily - right.daily || left.name.localeCompare(right.name, "ar"))[0] || null;
}

function validateService(
  ownerUid: string,
  phone: string,
  customer: CustomerRow,
  service: ServiceContext,
): ServiceContext | null {
  if (service.installationId) {
    const installation = db.prepare(
      `SELECT id, customer_id, customer_name, customer_phone, product_id, product_name,
              status, customer_address
         FROM installations
        WHERE id = ? AND owner_uid = ?
          AND status IN ('active', 'pending_installation', 'pending_external_service')
        LIMIT 1`,
    ).get(service.installationId, ownerUid) as InstallationRow | undefined;
    if (!installation) return null;
    if (installation.customer_id !== customer.id && phoneTail(installation.customer_phone) !== phoneTail(phone)) return null;
    return serviceFromInstallation(installation);
  }
  const product = db.prepare(
    `SELECT id, name, product_type
       FROM products
      WHERE id = ? AND owner_uid = ?
        AND COALESCE(catalog_visible, 1) <> 0
        AND COALESCE(is_available, 1) <> 0
        AND merged_into IS NULL
        AND product_type IN ('install_maintenance', 'external_maintenance')
      LIMIT 1`,
  ).get(service.productId, ownerUid) as ProductRow | undefined;
  return product ? serviceFromProduct(product) : null;
}

function confirmBooking(
  ownerUid: string,
  phone: string,
  context: CommerceContext,
  slot: SlotOption,
  now: Date,
): { id: string; service: ServiceContext; technician: TechnicianRow } | null {
  return db.transaction(() => {
    const customer = customerFromContext(ownerUid, phone, context);
    if (!customer) return null;
    const service = context.service ? validateService(ownerUid, phone, customer, context.service) : null;
    if (!service) return null;
    const technician = chooseTechnician(ownerUid, slot);
    if (!technician) return null;

    let installationId = service.installationId || "";
    if (!installationId) {
      installationId = `wa_install_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
      const installationStatus = service.bookingType === "external_maintenance"
        ? "pending_external_service"
        : "pending_installation";
      db.prepare(
        `INSERT INTO installations (
           id, owner_uid, customer_id, customer_name, customer_phone,
           product_id, product_name, label, install_date, next_maintenance,
           status, source, customer_address, notes, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, '', NULL, NULL, ?, 'whatsapp', ?, ?, ?, ?)`,
      ).run(
        installationId,
        ownerUid,
        customer.id,
        customer.name,
        normalizePhoneDigits(phone),
        service.productId,
        service.productName,
        installationStatus,
        customerAddress(customer),
        "أنشأه العميل عبر الحجز الذاتي في واتساب.",
        now.toISOString(),
        now.toISOString(),
      );
    }

    const duplicate = db.prepare(
      `SELECT id
         FROM bookings
        WHERE owner_uid = ? AND customer_id = ? AND installation_id = ?
          AND date = ? AND scheduled_time = ? AND status = 'confirmed'
        LIMIT 1`,
    ).get(ownerUid, customer.id, installationId, slot.date, slot.time) as { id?: string } | undefined;
    if (duplicate?.id) {
      clearWhatsAppCommerceSession(db, ownerUid, phone);
      return { id: duplicate.id, service: { ...service, installationId }, technician };
    }

    const id = `wa_booking_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    db.prepare(
      `INSERT INTO bookings (
         id, owner_uid, installation_id, customer_id, customer_name, customer_phone,
         product_id, product_name, technician_id, tech_name, date, scheduled_time,
         status, booking_type, source, customer_address, notes, parts,
         fieldtech_require_before_photo, fieldtech_require_after_photo,
         fieldtech_require_signature, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, 'whatsapp', ?, ?, '[]', 1, 1, 1, ?, ?)`,
    ).run(
      id,
      ownerUid,
      installationId,
      customer.id,
      customer.name,
      normalizePhoneDigits(phone),
      service.productId,
      service.productName,
      technician.id,
      technician.name,
      slot.date,
      slot.time,
      service.bookingType,
      customerAddress(customer),
      "حجز ذاتي مؤكد عبر WhatsApp Cloud.",
      now.toISOString(),
      now.toISOString(),
    );
    clearWhatsAppCommerceSession(db, ownerUid, phone);
    return { id, service: { ...service, installationId }, technician };
  }).immediate();
}

export function whatsappCommerceStoreSupported(
  provider = process.env.DATA_PROVIDER || process.env.DB_PROVIDER || "firebase",
) {
  return provider === "sqlite";
}

export async function handleWhatsAppCommerceConversation(
  input: {
    ownerUid: string;
    fromPhone: string;
    text: string;
  },
  dependencies: WhatsAppCommerceDependencies = {},
): Promise<WhatsAppCommerceResult> {
  if (process.env.WHATSAPP_COMMERCE_ENABLED === "false") {
    return { handled: false, reason: "commerce_disabled" };
  }
  if (!whatsappCommerceStoreSupported()) return { handled: false, reason: "unsupported_store" };
  const phone = normalizePhoneDigits(input.fromPhone);
  if (!phone || !input.ownerUid) return { handled: false, reason: "invalid_identity" };
  const text = normalizedText(input.text);
  if (!text) return { handled: false, reason: "empty_text" };
  const now = (dependencies.now || (() => new Date()))();
  const createPaymentLink = dependencies.createPaymentLink || createPaymentLinkForInvoice;
  const queueSync = dependencies.queueFieldTechSync || queueFieldTechSync;
  const session = getWhatsAppCommerceSession(db, input.ownerUid, phone, now.toISOString());

  if (isCancelIntent(text)) {
    clearWhatsAppCommerceSession(db, input.ownerUid, phone);
    saveSession(input.ownerUid, phone, "awaiting_action", {}, now);
    return { handled: true, kind: "commerce_reset", reply: mainMenu() };
  }

  if (!session) {
    if (isPaymentIntent(text)) return sendPaymentLink(input.ownerUid, phone, now, createPaymentLink);
    if (isBookingIntent(text)) return beginBooking(input.ownerUid, phone, now);
    if (isGreeting(text)) {
      saveSession(input.ownerUid, phone, "awaiting_action", {}, now);
      return { handled: true, kind: "commerce_menu", reply: mainMenu() };
    }
    return { handled: false, reason: "no_commerce_intent" };
  }

  const context = sessionContext(session);
  if (!["awaiting_name", "awaiting_address"].includes(session.step)) {
    if (isPaymentIntent(text)) return sendPaymentLink(input.ownerUid, phone, now, createPaymentLink);
    if (isBookingIntent(text)) return beginBooking(input.ownerUid, phone, now);
    if (isGreeting(text)) {
      saveSession(input.ownerUid, phone, "awaiting_action", {}, now);
      return { handled: true, kind: "commerce_menu", reply: mainMenu() };
    }
  }

  if (session.step === "awaiting_action") {
    const choice = choiceNumber(text);
    if (choice === 1) return sendPaymentLink(input.ownerUid, phone, now, createPaymentLink);
    if (choice === 2) return beginBooking(input.ownerUid, phone, now);
    return { handled: true, kind: "commerce_menu_retry", reply: mainMenu() };
  }

  if (session.step === "awaiting_name") {
    const name = validCustomerName(input.text);
    if (!name) {
      return {
        handled: true,
        kind: "booking_name_retry",
        reply: "الاسم غير واضح. اكتب اسمك الكامل بالحروف، مثل: عبدالله محمد.",
      };
    }
    const customer = createCustomer(input.ownerUid, phone, name, now);
    saveSession(input.ownerUid, phone, "awaiting_address", { customerId: customer.id }, now);
    return {
      handled: true,
      kind: "booking_address_required",
      reply: "شكرًا. اكتب المدينة والحي والعنوان المختصر لتنفيذ الموعد.",
    };
  }

  if (session.step === "awaiting_address") {
    const customer = customerFromContext(input.ownerUid, phone, context);
    if (!customer) return beginBooking(input.ownerUid, phone, now);
    if (!saveCustomerAddress(customer, input.text, now)) {
      return {
        handled: true,
        kind: "booking_address_retry",
        reply: "العنوان قصير أو غير واضح. اكتب المدينة، الحي، والشارع أو أقرب معلم.",
      };
    }
    const refreshed = findCustomer(input.ownerUid, phone)!;
    return beginBookingService(input.ownerUid, phone, refreshed, now);
  }

  if (session.step === "awaiting_booking_kind") {
    const customer = customerFromContext(input.ownerUid, phone, context);
    if (!customer) return beginBooking(input.ownerUid, phone, now);
    const choice = choiceNumber(text);
    if (choice === 2) return beginProductSelection(input.ownerUid, phone, customer, now);
    if (choice !== 1) {
      return {
        handled: true,
        kind: "booking_kind_retry",
        reply: replyWithOptions("اختر نوع الموعد:", ["1 - صيانة جهاز مسجل لديك", "2 - تركيب أو خدمة جديدة"]),
      };
    }
    const installations = listCustomerInstallations(input.ownerUid, customer);
    if (!installations.length) return beginProductSelection(input.ownerUid, phone, customer, now);
    if (installations.length === 1) {
      return offerSlots(input.ownerUid, phone, customer, serviceFromInstallation(installations[0]), now);
    }
    saveSession(input.ownerUid, phone, "awaiting_installation", {
      customerId: customer.id,
    }, now);
    return {
      handled: true,
      kind: "booking_installations",
      reply: replyWithOptions(
        "اختر الجهاز المطلوب صيانته:",
        installations.map((installation, index) => `${index + 1} - ${installation.product_name}`),
      ),
    };
  }

  if (session.step === "awaiting_installation") {
    const customer = customerFromContext(input.ownerUid, phone, context);
    if (!customer) return beginBooking(input.ownerUid, phone, now);
    const installations = listCustomerInstallations(input.ownerUid, customer);
    const choice = choiceNumber(text);
    const installation = choice ? installations[choice - 1] : undefined;
    if (!installation) {
      return {
        handled: true,
        kind: "booking_installation_retry",
        reply: "الخيار غير صحيح. أرسل رقم الجهاز من القائمة السابقة، أو اكتب إلغاء للبدء من جديد.",
      };
    }
    return offerSlots(input.ownerUid, phone, customer, serviceFromInstallation(installation), now);
  }

  if (session.step === "awaiting_product") {
    const customer = customerFromContext(input.ownerUid, phone, context);
    const products = listBookableProducts(input.ownerUid);
    const choice = choiceNumber(text);
    const product = choice ? products[choice - 1] : undefined;
    if (!customer || !product) {
      return {
        handled: true,
        kind: "booking_product_retry",
        reply: "الخيار غير صحيح. أرسل رقم الخدمة من القائمة السابقة، أو اكتب إلغاء للبدء من جديد.",
      };
    }
    return offerSlots(input.ownerUid, phone, customer, serviceFromProduct(product), now);
  }

  if (session.step === "awaiting_slot") {
    const slots = Array.isArray(context.slots) ? context.slots : [];
    const choice = choiceNumber(text);
    const slot = choice ? slots[choice - 1] : undefined;
    if (!slot || !/^\d{4}-\d{2}-\d{2}$/.test(slot.date) || !/^\d{2}:\d{2}$/.test(slot.time)) {
      return {
        handled: true,
        kind: "booking_slot_retry",
        reply: "الخيار غير صحيح. أرسل رقم الموعد من القائمة السابقة، أو اكتب إلغاء للبدء من جديد.",
      };
    }
    const booking = confirmBooking(input.ownerUid, phone, context, slot, now);
    if (!booking) {
      const customer = customerFromContext(input.ownerUid, phone, context);
      if (!customer || !context.service) return beginBooking(input.ownerUid, phone, now);
      return offerSlots(input.ownerUid, phone, customer, context.service, now);
    }
    queueSync("whatsapp_self_service_booking");
    return {
      handled: true,
      kind: "booking_confirmed",
      bookingId: booking.id,
      reply: [
        "تم تأكيد موعدك ✅",
        `الخدمة: ${booking.service.productName}`,
        `التاريخ: ${formatSlot(slot)}`,
        `الفني: ${booking.technician.name}`,
        `رقم الحجز: ${booking.id}`,
        "",
        "إذا احتجت التعديل اكتب: إلغاء ثم ابدأ حجزًا جديدًا.",
      ].join("\n"),
    };
  }

  return { handled: false, reason: "unknown_session_step" };
}
