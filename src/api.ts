import {
  db,
  collection,
  doc,
  setDoc,
  getDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  query,
  where,
  handleFirestoreError,
  OperationType,
  logout as firebaseLogout,
  getCountFromServer,
  limit,
  orderBy,
  writeBatch,
  getCurrentAppUser,
  buildLocalToken,
} from "./firebase";

export type Customer = {
  id: string;
  name: string;
  phone: string;
  city?: string;
  source?: "manual" | "salla" | "odoo" | "import";
  customer_type?: "retail" | "wholesale" | "unknown";
  odoo_id?: string | null;
  store_provider?: string;
  store_customer_id?: string | null;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type Product = {
  id: string;
  name: string;
  interval_months: number;
  category?: string;
  sku?: string;
  remind_text?: string;
  source?: "manual" | "salla";
  store_provider?: string;
  store_product_id?: string;
  price?: number | null;
  sale_price?: number | null;
  currency?: string;
  image_url?: string;
  image_urls?: string[] | string;
  stock_quantity?: number | null;
  store_status?: string;
  description?: string;
  store_url?: string;
  store_admin_url?: string;
  store_product_type?: string;
  categories?: Array<{ id?: string | null; name: string }> | string;
  variants?: ProductVariant[] | string;
  is_available?: boolean | number;
  unlimited_quantity?: boolean | number;
  last_synced_at?: string;
  product_type?: "sale_only" | "install_maintenance" | "maintenance_existing" | "external_maintenance" | "needs_review";
  service_mode?: "none" | "asset_maintenance" | "consumable_replacement" | "service";
  policy_active?: boolean;
  service_tasks?: ServiceTask[] | string;
  compatibility_group?: string;
  warranty_enabled?: boolean;
  warranty_months?: number;
  reminder_media_type?: "none" | "image" | "video";
  reminder_media_url?: string;
  reminder_cta?: string;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type ProductVariant = {
  id?: string | null;
  name?: string;
  sku?: string;
  barcode?: string;
  price?: number | null;
  sale_price?: number | null;
  stock_quantity?: number | null;
};

export type ServiceTask = {
  key: string;
  name: string;
  interval_value: number;
  interval_unit: "days" | "months";
  lead_days: number;
  start_event: "purchase" | "delivery" | "installation" | "service_completion";
  template: string;
  media_type: "none" | "image" | "video";
  media_url: string;
  cta: "auto" | "reorder" | "booking" | "both" | "contact";
  active: boolean;
};

export type CustomerAsset = {
  id: string;
  asset_code: string;
  status: "unassigned" | "active" | "paused" | "retired";
  origin?: "sold" | "legacy" | "external";
  customer_id?: string;
  customer_name?: string;
  customer_phone?: string;
  product_id?: string;
  product_name?: string;
  manufacturer_serial?: string;
  location_label?: string;
  purchase_date?: string;
  installation_date?: string;
  warranty_end?: string | null;
  warranty_days_remaining?: number | null;
  public_url: string;
  createdAt?: string;
};

export type ServiceCycle = {
  id: string;
  asset_id: string;
  task_name: string;
  customer_name?: string;
  product_name?: string;
  due_date: string;
  status: string;
  computed_status?: string;
  days_until?: number;
  reminder_count?: number;
};

export type AssetWorkspace = {
  assets: CustomerAsset[];
  cycles: ServiceCycle[];
  products: Product[];
  customers: Customer[];
  campaigns: Array<Record<string, unknown> & { id: string }>;
  replacement_links: Array<Record<string, unknown> & { id: string }>;
  stats: { unassigned: number; active_assets: number; due: number; overdue: number; warranty_expiring: number };
};

export type Installation = {
  id: string;
  customer_id: string;
  customer_name: string;
  customer_phone: string;
  product_id: string;
  product_name: string;
  product_sku?: string;
  install_date: string;
  next_maintenance: string;
  remind_count: number;
  next_remind_type?: "first" | "second" | "last" | null;
  label?: string;
  status: "pending_installation" | "pending_external_service" | "active" | "completed" | "cancelled";
  completed_date?: string | null;
  last_remind_at?: string | null;
  last_remind_attempt_at?: string | null;
  days_until?: number;
  source?: "manual" | "salla";
  store_order_id?: string;
  store_order_number?: string;
  order_item_type?: string;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type Technician = {
  id: string;
  name: string;
  phone: string;
  specialty?: string;
  max_daily: number;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type Booking = {
  id: string;
  installation_id?: string;
  customer_id: string;
  customer_name: string;
  customer_phone?: string;
  product_id: string;
  product_name: string;
  technician_id: string;
  tech_name: string;
  date: string;
  scheduled_time: string;
  status: "confirmed" | "completed" | "cancelled";
  booking_type?: "installation" | "maintenance" | "external_maintenance";
  source?: "manual" | "salla";
  store_order_id?: string;
  store_order_number?: string;
  completed_at?: string;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type Reminder = {
  id: string;
  installation_id?: string;
  customer_id: string;
  customer_name?: string;
  customer_phone?: string;
  product_id?: string;
  product_name?: string;
  message: string;
  reminder_type?: string;
  status: string;
  trigger?: string;
  sent_at: string;
  error?: string;
  whatsapp_jid?: string;
  whatsapp_message_id?: string | null;
  createdBy?: string;
};

export type Settings = {
  techs: number;
  jobs_per_tech: number;
  response_rate: number;
  maxDaily: number;
  seller_name?: string;
  seller_vat_number?: string;
  seller_address?: string;
  createdBy?: string;
  updatedAt?: string;
};

export type WhatsAppStatus = {
  status: string;
  provider?: "web" | "cloud_api";
  qr?: string;
  lastError?: string;
  user?: string;
  connectedAt?: string;
  outbound?: {
    mode: "dry_run" | "allowlist" | "code" | "production";
    launchApproved: boolean;
    enabled: boolean;
    requiresCode?: boolean;
    codeConfigured?: boolean;
    allowlistCount: number;
    dryRun: boolean;
  };
  updatedAt?: string;
};

export type TechnicianNotificationResult = {
  success: boolean;
  technician_id: string;
  technician_phone: string;
  message_id?: string | null;
  provider?: string;
  dry_run?: boolean;
  reason?: string;
};

export type ReminderRunResult = {
  success: boolean;
  checked: number;
  sent: number;
  failed: number;
  skipped: number;
  blocked?: boolean;
  error?: string;
  results: Array<{ success?: boolean; skipped?: boolean; installation_id?: string; error?: string; reason?: string }>;
  whatsapp?: WhatsAppStatus;
  scheduler?: unknown;
};

export type ReminderDiagnostics = {
  success: boolean;
  today: string;
  timeZone: string;
  whatsapp: WhatsAppStatus;
  blocker: string | null;
  scheduler: unknown;
  due: number;
  ready: number;
  retryCooldownMinutes: number;
  preview: Array<{
    installation_id: string;
    customer_name: string;
    customer_phone: string;
    product_name: string;
    next_maintenance: string;
    next_remind_type?: string | null;
  }>;
};

export type StoreWebhookDiagnostics = {
  success: boolean;
  configured: boolean;
  ownerConfigured: boolean;
  ownerMatchesCurrentUser: boolean;
  endpoint: string;
  hmacHeader: string;
  sallaSignatureHeader?: string;
  secretHeader: string;
  createBookings: boolean;
  defaultMaintenanceMonths: number;
  defaultTechnicianConfigured?: boolean;
  itemClassification?: Record<string, string>;
  recentAttempts?: Array<{
    at?: string | null;
    method?: string;
    path?: string;
    statusCode?: number;
    accepted?: boolean;
    resultStatus?: string | null;
    error?: string | null;
    userAgent?: string;
    contentLength?: string;
    hasSharedSecret?: boolean;
    hasGoldenSignature?: boolean;
    hasSallaSignature?: boolean;
    event?: string | null;
    orderId?: string | number | null;
    bodyKeys?: string[];
  }>;
  recentEvents: Array<{
    id: string;
    provider?: string;
    event_type?: string;
    order_id?: string;
    order_number?: string;
    status?: string;
    received_at?: string;
    processed_at?: string;
    error?: string;
    imported?: {
      customer_id?: string;
      product_ids?: string[];
      installation_ids?: string[];
      booking_ids?: string[];
    };
  }>;
};

export type StoreItemType =
  | "sale_only"
  | "install_maintenance"
  | "maintenance_existing"
  | "external_maintenance"
  | "needs_review";
export type StoreJourneyStatus =
  | "received"
  | "sale_recorded"
  | "installation_created"
  | "awaiting_schedule"
  | "booking_created"
  | "maintenance_matched"
  | "needs_review"
  | "completed"
  | "cancelled";

export type StoreOrderItem = {
  name: string;
  sku: string;
  quantity: number;
  unit_price?: number | null;
  total_price?: number | null;
  currency?: string | null;
  tags?: string[];
  order_type: StoreItemType;
  detected_type?: StoreItemType | null;
  manual_type?: StoreItemType | null;
  status: StoreJourneyStatus;
  product_id?: string | null;
  installation_id?: string | null;
  booking_id?: string | null;
  reason?: string | null;
};

export type StoreOrder = {
  id: string;
  source?: "salla";
  provider?: string;
  order_id: string;
  order_number: string;
  status?: string;
  external_order_id?: string;
  external_status?: string;
  journey_status: StoreJourneyStatus;
  current_step?: StoreJourneyStatus;
  customer_id?: string;
  customer_name: string;
  customer_phone: string;
  customer_city?: string | null;
  product_ids?: string[];
  installation_ids?: string[];
  booking_ids?: string[];
  order_types?: StoreItemType[];
  items?: StoreOrderItem[];
  scheduled_date?: string | null;
  scheduled_time?: string | null;
  order_date?: string;
  total?: number | null;
  imported_at?: string;
  synced_at?: string;
  last_remote_update_at?: string;
  updatedAt?: string;
  createdBy?: string;
};

export type StoreOrderClassificationResult = {
  success: boolean;
  order_id: string;
  item_sku: string;
  manual_type: StoreItemType;
  journey_status: StoreJourneyStatus;
};

export type StoreOrderTechnicianAssignmentResult = {
  success: boolean;
  order_id: string;
  item_sku: string;
  installation_id: string;
  booking_id: string;
  technician_id: string;
  technician_name: string;
  journey_status: StoreJourneyStatus;
  notification?: TechnicianNotificationResult | null;
};

export type SallaIntegrationStatus = {
  provider: "salla";
  auth_mode?: "easy" | "custom";
  configured: boolean;
  linked: boolean;
  status: "not_configured" | "ready_to_connect" | "connected" | "error";
  redirect_uri: string;
  webhook_url?: string;
  connect_supported?: boolean;
  webhook_secret_configured?: boolean;
  owner_uid_configured?: boolean;
  scopes: string;
  sync_schedule: string;
  sync_enabled: boolean;
  store_name?: string | null;
  store_url?: string | null;
  merchant_id?: string | number | null;
  expires_at?: string | null;
  has_refresh_token?: boolean;
  last_authorized_at?: string | null;
  last_event_at?: string | null;
  last_event_type?: string | null;
  last_sync_at?: string | null;
  last_sync_status?: "success" | "error" | "idle" | null;
  last_sync_count?: number;
  last_sync_error?: string | null;
  last_product_sync_at?: string | null;
  last_product_sync_count?: number;
  last_product_sync_error?: string | null;
};

export type SallaConnectResponse = {
  url: string;
  redirect_uri: string;
  scopes: string;
};

export type SallaSyncResult = {
  success: boolean;
  imported: number;
  updated: number;
  failed: number;
  pages: number;
  fetched: number;
  last_sync_at: string;
  last_error?: string | null;
  deduplicated?: number;
  relinked?: number;
  orders?: {
    success: boolean;
    imported: number;
    updated: number;
    failed: number;
    pages: number;
    fetched: number;
    last_sync_at: string;
    last_error?: string | null;
  };
  products?: {
    success: boolean;
    imported: number;
    updated: number;
    failed: number;
    pages: number;
    fetched: number;
    last_sync_at: string;
    last_error?: string | null;
    deduplicated?: number;
    relinked?: number;
  };
};

export type ProductDeduplicationResult = {
  success: boolean;
  deduplicated: number;
  relinked: number;
  remaining: number;
};

export type DailyPreparationResult = {
  success: boolean;
  prepared_at: string;
  sync?: SallaSyncResult | { success: false; error: string } | null;
  summary: {
    technicians: number;
    storeOrders: number;
    needsReview: number;
    awaitingSchedule: number;
    todayBookings: number;
  };
  checks: Array<{
    id: string;
    ok: boolean;
    label: string;
    detail: string;
  }>;
};

export type CustomerCareReason =
  | "no_activity"
  | "never_contacted"
  | "not_targeted"
  | "due_soon"
  | "overdue_maintenance";

export type CustomerCareItem = {
  id: string;
  customer_id: string;
  customer_name: string;
  customer_phone: string;
  city?: string;
  source?: Customer["source"];
  reason: CustomerCareReason;
  priority: "high" | "medium" | "low";
  next_action: string;
  installation_id?: string;
  product_name?: string;
  next_maintenance?: string;
  days_until?: number;
  last_remind_at?: string | null;
};

export type QuoteStatus = "draft" | "issued" | "confirmed" | "declined" | "expired" | "follow_up";

export type QuoteItem = {
  product_id?: string | null;
  product_sku?: string;
  description: string;
  quantity: number;
  unit_price: number;
  total: number;
  vat_excluded?: boolean;
};

export type QuoteInstallment = {
  percent: number;
  label: string;
  deadline_days?: number;
};

export type Quote = {
  id: string;
  quote_number: string;
  customer_id?: string | null;
  customer_name: string;
  customer_phone?: string;
  customer_city?: string;
  customer_vat?: string;
  title?: string;
  status: QuoteStatus;
  issue_date: string;
  valid_until?: string | null;
  follow_up_date?: string | null;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  currency: string;
  payment_method?: string;
  payment_down_percent?: number;
  payment_final_percent?: number;
  payment_down_text?: string;
  payment_final_text?: string;
  payment_bank?: string;
  payment_account?: string;
  payment_iban?: string;
  payment_note?: string;
  installments?: QuoteInstallment[];
  items: QuoteItem[];
  notes?: string;
  terms?: string;
  confirmed_at?: string | null;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type QuoteInput = Partial<Omit<Quote, "id" | "quote_number" | "subtotal" | "total" | "createdBy" | "createdAt" | "updatedAt">> & {
  customer_name: string;
  items: QuoteItem[];
};

export type QuoteStats = {
  total: number;
  draft: number;
  issued: number;
  confirmed: number;
  follow_up: number;
  declined: number;
  expired: number;
  total_value: number;
  confirmed_value: number;
};

export type QuoteListResponse = {
  data: Quote[];
  total: number;
  stats: QuoteStats;
};

export type InvoiceStatus = "draft" | "issued" | "sent" | "paid" | "cancelled" | "refunded";

export type InvoiceItem = {
  product_id?: string | null;
  product_sku?: string;
  description: string;
  quantity: number;
  unit_price: number;
  total: number;
  vat_excluded: boolean;
};

export type Invoice = {
  id: string;
  invoice_number: string;
  quote_id?: string | null;
  customer_id?: string | null;
  customer_name: string;
  customer_phone?: string;
  customer_city?: string;
  customer_vat?: string;
  title?: string;
  status: InvoiceStatus;
  issue_date: string;
  due_date?: string | null;
  paid_at?: string | null;
  payment_method?: string;
  subtotal: number;
  discount: number;
  vat_percent: number;  // 15 for ZATCA standard
  vat_amount: number;
  total_with_vat: number;
  total_without_vat: number;
  currency: string;
  items: InvoiceItem[];
  notes?: string;
  terms?: string;
  seller_name: string;
  seller_vat_number: string;
  seller_address: string;
  qr_code?: string;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type InvoiceInput = Partial<Omit<Invoice, "id" | "invoice_number" | "subtotal" | "vat_amount" | "total_with_vat" | "total_without_vat" | "createdBy" | "createdAt" | "updatedAt" | "qr_code">> & {
  customer_name: string;
  items: InvoiceItem[];
};

export type InvoiceStats = {
  total: number;
  draft: number;
  issued: number;
  sent: number;
  paid: number;
  cancelled: number;
  refunded: number;
  total_value: number;
  paid_value: number;
};

export type InvoiceListResponse = {
  data: Invoice[];
  total: number;
  stats: InvoiceStats;
};

const nowIso = () => new Date().toISOString();
const today = () => new Date().toLocaleDateString("en-CA");
const tomorrow = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toLocaleDateString("en-CA");
};
const localDayWindow = () => ({
  start: new Date(`${today()}T00:00:00`).toISOString(),
  end: new Date(`${tomorrow()}T00:00:00`).toISOString(),
});
const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA");
};
const addMonths = (date: string, months: number) => {
  const d = new Date(`${date}T00:00:00`);
  const targetDay = d.getDate();
  d.setMonth(d.getMonth() + Number(months || 1));
  // setMonth overflows month-end dates (Jan 31 + 1 month => Mar 3, not Feb 28).
  // If the day rolled into the following month, clamp to the intended month's
  // last day.
  if (d.getDate() !== targetDay) {
    d.setDate(0);
  }
  return d.toLocaleDateString("en-CA");
};

const wrap = async <T>(op: () => Promise<T>, type: OperationType, path: string) => {
  try {
    return await op();
  } catch (e) {
    handleFirestoreError(e, type, path);
  }
};

type LocalDb = {
  customers: Customer[];
  products: Product[];
  installations: Installation[];
  technicians: Technician[];
  bookings: Booking[];
  reminders: Reminder[];
  quotes: Quote[];
  invoices: Invoice[];
  settings: Settings;
};

const defaultSettings = (): Settings => ({ techs: 3, jobs_per_tech: 4, response_rate: 50, maxDaily: 24, seller_name: "Breexe Pro Co.", seller_vat_number: "313049114100003", seller_address: "شركة بريكس برو شخص واحد ذات مسؤولية محدودة - الرياض" });
const localDbKey = (uid: string) => `golden-pro-crm-local-db:${uid}`;
const localId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const withoutId = <T extends { id: string }>(item: T): Omit<T, "id"> => {
  const { id: _id, ...data } = item;
  return data;
};

function getUserOrThrow() {
  const user = getCurrentAppUser();
  if (!user) throw new Error("يجب تسجيل الدخول أولا.");
  return user;
}

function emptyLocalDb(): LocalDb {
  return {
    customers: [],
    products: [],
    installations: [],
    technicians: [],
    bookings: [],
    reminders: [],
    quotes: [],
    invoices: [],
    settings: defaultSettings(),
  };
}

function loadLocalDb(uid: string): LocalDb {
  if (typeof window === "undefined") return emptyLocalDb();
  try {
    const raw = JSON.parse(window.localStorage.getItem(localDbKey(uid)) || "{}") as Partial<LocalDb>;
    return {
      ...emptyLocalDb(),
      ...raw,
      customers: raw.customers || [],
      products: raw.products || [],
      installations: raw.installations || [],
      technicians: raw.technicians || [],
      bookings: raw.bookings || [],
      reminders: raw.reminders || [],
      quotes: raw.quotes || [],
      invoices: raw.invoices || [],
      settings: { ...defaultSettings(), ...(raw.settings || {}) },
    };
  } catch {
    return emptyLocalDb();
  }
}

function saveLocalDb(uid: string, data: LocalDb) {
  window.localStorage.setItem(localDbKey(uid), JSON.stringify(data));
}

function localInstallationWithDays(item: Installation): Installation {
  const todayMs = Date.parse(`${today()}T00:00:00`);
  const nextMs = Date.parse(`${item.next_maintenance}T00:00:00`);
  return {
    ...item,
    days_until: Math.ceil((nextMs - todayMs) / 86_400_000),
  };
}

function daysUntil(value?: string) {
  if (!value) return undefined;
  const todayMs = Date.parse(`${today()}T00:00:00`);
  const valueMs = Date.parse(`${value}T00:00:00`);
  if (!Number.isFinite(valueMs)) return undefined;
  return Math.ceil((valueMs - todayMs) / 86_400_000);
}

function sameCustomer(customer: Customer, record: { customer_id?: string; customer_phone?: string }) {
  return Boolean(
    (record.customer_id && record.customer_id === customer.id) ||
    (record.customer_phone && customer.phone && record.customer_phone === customer.phone),
  );
}

function buildCustomerCareQueue(
  customers: Customer[],
  installations: Installation[],
  reminders: Reminder[],
  bookings: Booking[] = [],
) {
  const queue: CustomerCareItem[] = [];
  const priorities: Record<CustomerCareItem["priority"], number> = { high: 0, medium: 1, low: 2 };

  const push = (item: CustomerCareItem) => {
    if (!queue.some((existing) => existing.id === item.id)) queue.push(item);
  };

  for (const customer of customers) {
    const customerInstallations = installations.filter((item) => sameCustomer(customer, item));
    const customerBookings = bookings.filter((item) => sameCustomer(customer, item));
    const customerReminders = reminders.filter((item) => sameCustomer(customer, item));
    const sentReminders = customerReminders.filter((item) => item.status === "sent");
    const activeInstallations = customerInstallations.filter((item) => item.status === "active");

    if (!customerInstallations.length && !customerBookings.length && !customerReminders.length) {
      push({
        id: `care:${customer.id}:no_activity`,
        customer_id: customer.id,
        customer_name: customer.name,
        customer_phone: customer.phone,
        city: customer.city,
        source: customer.source,
        reason: "no_activity",
        priority: "high",
        next_action: "تواصل أولي وتصنيف احتياج العميل",
      });
      continue;
    }

    for (const installation of activeInstallations) {
      const dueIn = typeof installation.days_until === "number" ? installation.days_until : daysUntil(installation.next_maintenance);
      const hasSentForInstallation = sentReminders.some((item) => item.installation_id === installation.id);
      if (typeof dueIn !== "number" || dueIn > 7) continue;

      const reason: CustomerCareReason =
        dueIn <= 0 && !hasSentForInstallation
          ? "not_targeted"
          : dueIn < 0
            ? "overdue_maintenance"
            : "due_soon";

      push({
        id: `care:${customer.id}:${installation.id}:${reason}`,
        customer_id: customer.id,
        customer_name: customer.name,
        customer_phone: customer.phone,
        city: customer.city,
        source: customer.source,
        reason,
        priority: dueIn <= 0 ? "high" : "medium",
        next_action: reason === "not_targeted" ? "إرسال تذكير الآن" : "متابعة موعد الصيانة",
        installation_id: installation.id,
        product_name: installation.product_name,
        next_maintenance: installation.next_maintenance,
        days_until: dueIn,
        last_remind_at: installation.last_remind_at || null,
      });
    }

    const alreadyQueued = queue.some((item) => item.customer_id === customer.id);
    if (!alreadyQueued && activeInstallations.length && !sentReminders.length) {
      const firstInstallation = activeInstallations[0];
      push({
        id: `care:${customer.id}:never_contacted`,
        customer_id: customer.id,
        customer_name: customer.name,
        customer_phone: customer.phone,
        city: customer.city,
        source: customer.source,
        reason: "never_contacted",
        priority: "low",
        next_action: "إضافة العميل إلى دورة متابعة دورية",
        installation_id: firstInstallation.id,
        product_name: firstInstallation.product_name,
        next_maintenance: firstInstallation.next_maintenance,
        days_until: daysUntil(firstInstallation.next_maintenance),
        last_remind_at: firstInstallation.last_remind_at || null,
      });
    }
  }

  return queue.sort((a, b) => {
    const priority = priorities[a.priority] - priorities[b.priority];
    if (priority) return priority;
    return (a.days_until ?? 9999) - (b.days_until ?? 9999);
  });
}

function getNextReminderType(current?: string | null, countAfterSend = 1): Installation["next_remind_type"] {
  if (countAfterSend >= 3) return null;
  if (current === "first") return "second";
  if (current === "second") return "last";
  if (current === "last") return null;
  return "second";
}

function buildWhatsAppReminderMessage(installation: Installation) {
  return `عزيزي ${installation.customer_name}، نود تذكيركم بموعد صيانة ${installation.product_name}. فريق BreeXe Pro في خدمتكم.`;
}

async function sendLocalReminderViaWhatsApp(data: LocalDb, installationId: string, uid: string, type?: string, outboundCode?: string) {
  const installation = data.installations.find((item) => item.id === installationId);
  if (!installation) throw new Error("لم يتم العثور على التركيب.");
  if (installation.createdBy !== uid) throw new Error("لا تملك صلاحية هذا التركيب.");
  if (installation.status !== "active") throw new Error("يمكن إرسال التذكير للتركيبات النشطة فقط.");

  const now = nowIso();
  const message = buildWhatsAppReminderMessage(installation);
  const reminderType = type || installation.next_remind_type || "first";

  try {
    const whatsAppResult = await apiFetch<{ success: boolean; result?: { jid?: string; messageId?: string | null; dryRun?: boolean; reason?: string } }>(
      "/api/whatsapp/send-test",
      {
        method: "POST",
        body: JSON.stringify({ phone: installation.customer_phone, message, outboundCode }),
      },
    );

    const remindCount = Number(installation.remind_count || 0) + 1;
    const nextReminderType = getNextReminderType(installation.next_remind_type, remindCount);

    data.reminders.unshift({
      id: localId("rem"),
      installation_id: installation.id,
      customer_id: installation.customer_id,
      customer_name: installation.customer_name,
      customer_phone: installation.customer_phone,
      product_id: installation.product_id,
      product_name: installation.product_name,
      message,
      reminder_type: reminderType,
      status: whatsAppResult.result?.dryRun ? "dry_run" : "sent",
      trigger: "manual",
      sent_at: now,
      error: whatsAppResult.result?.dryRun ? whatsAppResult.result.reason : undefined,
      whatsapp_jid: whatsAppResult.result?.jid || "",
      whatsapp_message_id: whatsAppResult.result?.messageId || null,
      createdBy: uid,
    });

    if (whatsAppResult.result?.dryRun) {
      installation.last_remind_attempt_at = now;
      installation.updatedAt = now;

      return {
        success: false,
        error: whatsAppResult.result.reason,
        remind_count: Number(installation.remind_count || 0),
        next_remind_type: installation.next_remind_type || null,
      };
    }

    installation.remind_count = remindCount;
    installation.last_remind_at = now;
    installation.last_remind_attempt_at = now;
    installation.next_remind_type = nextReminderType;
    installation.updatedAt = now;

    return {
      success: true,
      remind_count: remindCount,
      next_remind_type: nextReminderType,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    data.reminders.unshift({
      id: localId("rem"),
      installation_id: installation.id,
      customer_id: installation.customer_id,
      customer_name: installation.customer_name,
      customer_phone: installation.customer_phone,
      product_id: installation.product_id,
      product_name: installation.product_name,
      message,
      reminder_type: reminderType,
      status: "failed",
      trigger: "manual",
      sent_at: now,
      error: errorMessage,
      whatsapp_jid: "",
      whatsapp_message_id: null,
      createdBy: uid,
    });
    installation.last_remind_attempt_at = now;
    installation.updatedAt = now;

    return {
      success: false,
      error: errorMessage,
      remind_count: Number(installation.remind_count || 0),
      next_remind_type: installation.next_remind_type || null,
    };
  }
}

function buildTechnicianBookingMessage(booking: Booking, technician: Technician, trigger?: string) {
  const action =
    trigger === "created" ? "تم تأكيد موعد جديد" :
      trigger === "updated" ? "تم تعديل موعد مؤكد" :
        "تنبيه موعد مؤكد";

  return [
    `BreeXe Pro CRM - ${action}`,
    "",
    `الفني: ${technician.name}`,
    `العميل: ${booking.customer_name}`,
    `جوال العميل: ${booking.customer_phone || "-"}`,
    `الخدمة: ${booking.product_name}`,
    booking.store_order_number ? `رقم طلب المتجر: ${booking.store_order_number}` : null,
    booking.booking_type ? `نوع المهمة: ${booking.booking_type}` : null,
    `التاريخ: ${booking.date}`,
    `الوقت: ${booking.scheduled_time}`,
    "الحالة: مؤكد",
  ].filter(Boolean).join("\n");
}

async function sendLocalTechnicianNotification(uid: string, bookingId: string, trigger?: string, outboundCode?: string) {
  const data = loadLocalDb(uid);
  const booking = data.bookings.find((item) => item.id === bookingId);
  if (!booking) throw new Error("الحجز غير موجود.");
  if (booking.createdBy !== uid) throw new Error("لا تملك صلاحية هذا الحجز.");
  if (booking.status !== "confirmed") throw new Error("إشعار الفني يرسل للحجوزات المؤكدة فقط.");

  const technician = data.technicians.find((item) => item.id === booking.technician_id);
  if (!technician) throw new Error("الفني غير موجود.");
  if (!technician.phone) throw new Error("رقم جوال الفني غير موجود.");

  const message = buildTechnicianBookingMessage(booking, technician, trigger);
  const result = await apiFetch<{ success: boolean; result?: { jid?: string; messageId?: string | null; provider?: string; dryRun?: boolean; reason?: string } }>(
    "/api/whatsapp/send-test",
    {
      method: "POST",
      body: JSON.stringify({ phone: technician.phone, message, outboundCode }),
    },
  );

  return {
    success: !result.result?.dryRun,
    dry_run: result.result?.dryRun,
    technician_id: technician.id,
    technician_phone: technician.phone,
    message_id: result.result?.messageId || null,
    provider: result.result?.provider,
    reason: result.result?.reason,
  } satisfies TechnicianNotificationResult;
}

function hasSuccessfulReminderToday(data: LocalDb, installationId: string) {
  const { start, end } = localDayWindow();
  return data.reminders.some(
    (item) =>
      item.installation_id === installationId &&
      item.status === "sent" &&
      item.sent_at >= start &&
      item.sent_at < end,
  );
}

function hasRecentReminderAttempt(data: LocalDb, installationId: string, minutes = 9) {
  const since = Date.now() - minutes * 60 * 1000;
  return data.reminders.some(
    (item) =>
      item.installation_id === installationId &&
      new Date(item.sent_at).getTime() >= since,
  );
}

function requestOutboundCode() {
  if (typeof window === "undefined") return "";
  const code = window.prompt("أدخل كود الإرسال");
  if (!code?.trim()) throw new Error("كود الإرسال مطلوب قبل إرسال أي رسالة.");
  return code.trim();
}

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const user = getCurrentAppUser();
  const token = user?.local ? buildLocalToken(user.uid) : await user?.getIdToken?.();
  if (!token) throw new Error("يجب تسجيل الدخول أولا.");

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);

  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(path, { ...init, headers });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(body?.error || `HTTP ${response.status}`);
  }

  return body as T;
}

const serverDataEnabled = () =>
  ["sqlite", "supabase"].includes(import.meta.env.VITE_DATA_PROVIDER || "") ||
  ["sqlite", "supabase"].includes(import.meta.env.VITE_DB_PROVIDER || "");

export const logout = firebaseLogout;
export const isAuthenticated = () => !!getCurrentAppUser();

export type DashboardStats = {
  customers: number;
  products: number;
  technicians: number;
  installations: number;
  quotes: number;
  confirmedQuotes: number;
  quoteFollowUps: number;
  overdue: number;
  week: number;
  sentToday: number;
  maxDaily: number;
  completed: number;
  care: number;
};

export const getStats = async (): Promise<DashboardStats> => {
  const user = getCurrentAppUser();
  if (!user) {
    return {
      customers: 0,
      products: 0,
      technicians: 0,
      installations: 0,
      quotes: 0,
      confirmedQuotes: 0,
      quoteFollowUps: 0,
      overdue: 0,
      week: 0,
      sentToday: 0,
      maxDaily: 0,
      completed: 0,
      care: 0,
    };
  }
  const uid = user.uid;
  const { start: todayStart, end: tomorrowStart } = localDayWindow();
  const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toLocaleDateString("en-CA");

  if (user.local) {
    const data = loadLocalDb(uid);
    return {
      customers: data.customers.length,
      products: data.products.length,
      technicians: data.technicians.length,
      installations: data.installations.length,
      quotes: data.quotes.length,
      confirmedQuotes: data.quotes.filter((item) => item.status === "confirmed").length,
      quoteFollowUps: data.quotes.filter((item) => item.status === "follow_up").length,
      overdue: data.installations.filter((item) => item.status === "active" && item.next_maintenance < today()).length,
      week: data.installations.filter((item) => item.status === "active" && item.next_maintenance >= today() && item.next_maintenance <= nextWeek).length,
      sentToday: data.reminders.filter((item) => item.status === "sent" && item.sent_at >= todayStart && item.sent_at < tomorrowStart).length,
      maxDaily: data.settings.maxDaily,
      completed: data.installations.filter((item) => item.status === "completed").length,
      care: buildCustomerCareQueue(data.customers, data.installations.map(localInstallationWithDays), data.reminders, data.bookings).length,
    };
  }

  if (serverDataEnabled()) {
    return apiFetch<{
      customers: number;
      products: number;
      technicians: number;
      installations: number;
      quotes: number;
      confirmedQuotes: number;
      quoteFollowUps: number;
      overdue: number;
      week: number;
      sentToday: number;
      maxDaily: number;
      completed: number;
      care: number;
    }>("/api/stats");
  }

  const [
    custCount,
    prodCount,
    techCount,
    instCount,
    quoteCount,
    confirmedQuoteCount,
    quoteFollowUpCount,
    overdueCount,
    weekCount,
    completedCount,
    sentToday,
  ] =
    await Promise.all([
      getCountFromServer(query(collection(db, "customers"), where("createdBy", "==", uid))),
      getCountFromServer(query(collection(db, "products"), where("createdBy", "==", uid))),
      getCountFromServer(query(collection(db, "technicians"), where("createdBy", "==", uid))),
      getCountFromServer(query(collection(db, "installations"), where("createdBy", "==", uid))),
      getCountFromServer(query(collection(db, "quotes"), where("createdBy", "==", uid))),
      getCountFromServer(query(collection(db, "quotes"), where("createdBy", "==", uid), where("status", "==", "confirmed"))),
      getCountFromServer(query(collection(db, "quotes"), where("createdBy", "==", uid), where("status", "==", "follow_up"))),
      getCountFromServer(
        query(
          collection(db, "installations"),
          where("createdBy", "==", uid),
          where("status", "==", "active"),
          where("next_maintenance", "<", today()),
        ),
      ),
      getCountFromServer(
        query(
          collection(db, "installations"),
          where("createdBy", "==", uid),
          where("status", "==", "active"),
          where("next_maintenance", ">=", today()),
          where("next_maintenance", "<=", nextWeek),
        ),
      ),
      getCountFromServer(
        query(collection(db, "installations"), where("createdBy", "==", uid), where("status", "==", "completed")),
      ),
      getCountFromServer(
        query(
          collection(db, "reminders"),
          where("createdBy", "==", uid),
          where("status", "==", "sent"),
          where("sent_at", ">=", todayStart),
          where("sent_at", "<", tomorrowStart),
        ),
      ),
    ]);

  const settings = await getSettings();
  const careQueue = await getCustomerCareQueue();

  return {
    customers: custCount.data().count,
    products: prodCount.data().count,
    technicians: techCount.data().count,
    installations: instCount.data().count,
    quotes: quoteCount.data().count,
    confirmedQuotes: confirmedQuoteCount.data().count,
    quoteFollowUps: quoteFollowUpCount.data().count,
    overdue: overdueCount.data().count,
    week: weekCount.data().count,
    sentToday: sentToday.data().count,
    maxDaily: settings.maxDaily,
    completed: completedCount.data().count,
    care: careQueue.length,
  };
};

export const getCustomers = async (search = "") => {
  const user = getCurrentAppUser();
  if (!user) return { data: [] as Customer[], total: 0 };
  const uid = user.uid;
  if (user.local) {
    const cleanSearch = search.trim();
    let data = loadLocalDb(uid).customers.sort((a, b) => a.name.localeCompare(b.name));
    if (cleanSearch) data = data.filter((c) => `${c.name} ${c.phone} ${c.city || ""}`.includes(cleanSearch));
    return { data, total: data.length };
  }
  if (serverDataEnabled()) {
    const params = new URLSearchParams();
    if (search.trim()) params.set("search", search.trim());
    return apiFetch<{ data: Customer[]; total: number }>(`/api/customers${params.toString() ? `?${params}` : ""}`);
  }
  const baseQ = query(collection(db, "customers"), where("createdBy", "==", uid));
  const [snap, countSnap] = await Promise.all([
    getDocs(query(baseQ, orderBy("name"), limit(100))),
    getCountFromServer(baseQ),
  ]);

  let data = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Customer);
  const cleanSearch = search.trim();
  if (cleanSearch) {
    data = data.filter((c) => `${c.name} ${c.phone} ${c.city || ""}`.includes(cleanSearch));
  }

  return { data, total: countSnap.data().count };
};

export const createCustomer = (data: Omit<Customer, "id">) => {
  const user = getUserOrThrow();
  const uid = user.uid;
  if (user.local) {
    const localDb = loadLocalDb(uid);
    localDb.customers.push({
      ...data,
      id: localId("cust"),
      city: data.city || "",
      source: data.source || "manual",
      createdBy: uid,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    saveLocalDb(uid, localDb);
    return Promise.resolve();
  }
  if (serverDataEnabled()) {
    return apiFetch<{ id: string }>("/api/customers", {
      method: "POST",
      body: JSON.stringify(data),
    }).then(() => undefined);
  }
  const id = doc(collection(db, "customers")).id;
  return wrap(
    () =>
      setDoc(doc(db, "customers", id), {
        ...data,
        city: data.city || "",
        source: data.source || "manual",
        createdBy: uid,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }),
    OperationType.CREATE,
    "customers",
  );
};

export const updateCustomer = (id: string, data: Partial<Customer>) => {
  const user = getUserOrThrow();
  if (user.local) {
    const localDb = loadLocalDb(user.uid);
    localDb.customers = localDb.customers.map((item) => item.id === id ? { ...item, ...data, updatedAt: nowIso() } : item);
    saveLocalDb(user.uid, localDb);
    return Promise.resolve();
  }
  if (serverDataEnabled()) {
    return apiFetch(`/api/customers/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }).then(() => undefined);
  }
  return wrap(() => updateDoc(doc(db, "customers", id), { ...data, updatedAt: nowIso() }), OperationType.UPDATE, `customers/${id}`);
};

export const deleteCustomer = (id: string) => {
  const user = getUserOrThrow();
  if (user.local) {
    const localDb = loadLocalDb(user.uid);
    localDb.customers = localDb.customers.filter((item) => item.id !== id);
    saveLocalDb(user.uid, localDb);
    return Promise.resolve();
  }
  if (serverDataEnabled()) {
    return apiFetch(`/api/customers/${id}`, { method: "DELETE" }).then(() => undefined);
  }
  return wrap(() => deleteDoc(doc(db, "customers", id)), OperationType.DELETE, `customers/${id}`);
};

// Extract the trailing sequence from a formatted number like "INV-20260706-014".
function sequenceOf(value: unknown): number {
  const str = String(value ?? "");
  const tail = str.includes("-") ? str.slice(str.lastIndexOf("-") + 1) : str;
  const n = parseInt(tail, 10);
  return Number.isFinite(n) ? n : 0;
}

// One past the highest number already issued, so a deletion never lets a
// previously used invoice/quote number be reused (ZATCA uniqueness).
function nextNumberIndex(records: Array<Record<string, unknown>>, field: string): number {
  return records.reduce((max, row) => Math.max(max, sequenceOf(row[field])), 0) + 1;
}

function quoteNumber(seed = Date.now(), index = 1) {
  const d = new Date(seed);
  const ymd = d.toISOString().slice(0, 10).replace(/-/g, "");
  return `QT-${ymd}-${String(index).padStart(3, "0")}`;
}

function normalizeQuoteItems(items: QuoteItem[] = []) {
  return items
    .map((item) => {
      const quantity = Math.max(0, Number(item.quantity || 0));
      const unitPrice = Math.max(0, Number(item.unit_price || 0));
      return {
        product_id: item.product_id || null,
        product_sku: String(item.product_sku || "").trim(),
        description: String(item.description || "").trim(),
        quantity,
        unit_price: unitPrice,
        total: quantity * unitPrice,
        vat_excluded: item.vat_excluded !== false,
      };
    })
    .filter((item) => item.description || item.quantity > 0 || item.unit_price > 0);
}

function quoteTotals(items: QuoteItem[], discount = 0, tax = 0) {
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

function quotePaymentFields(data: QuoteInput, existing?: Quote) {
  const installments = data.installments?.length
    ? data.installments
    : existing?.installments?.length
      ? existing.installments
      : [
          { percent: Number(data.payment_down_percent ?? 70), label: String(data.payment_down_text || "عند اعتماد العرض وبدء تنفيذ الطلب.").trim() },
          { percent: Number(data.payment_final_percent ?? 30), label: String(data.payment_final_text || "بعد التوريد أو التركيب والتشغيل حسب نطاق العمل.").trim() },
        ];
  return {
    payment_method: String(data.payment_method || existing?.payment_method || "تحويل بنكي").trim(),
    payment_down_percent: Number(data.payment_down_percent ?? existing?.payment_down_percent ?? 70),
    payment_final_percent: Number(data.payment_final_percent ?? existing?.payment_final_percent ?? 30),
    payment_down_text: String(data.payment_down_text || existing?.payment_down_text || "عند اعتماد العرض وبدء تنفيذ الطلب.").trim(),
    payment_final_text: String(data.payment_final_text || existing?.payment_final_text || "بعد التوريد أو التركيب والتشغيل حسب نطاق العمل.").trim(),
    payment_bank: String(data.payment_bank || existing?.payment_bank || "").trim(),
    payment_account: String(data.payment_account || existing?.payment_account || "BreeXe Pro").trim(),
    payment_iban: String(data.payment_iban || existing?.payment_iban || "").trim(),
    payment_note: String(data.payment_note || existing?.payment_note || "يرجى إرسال إيصال التحويل بعد الدفع لتأكيد الطلب.").trim(),
    installments,
  };
}

function quoteStats(quotes: Quote[]): QuoteStats {
  return {
    total: quotes.length,
    draft: quotes.filter((item) => item.status === "draft").length,
    issued: quotes.filter((item) => item.status === "issued").length,
    confirmed: quotes.filter((item) => item.status === "confirmed").length,
    follow_up: quotes.filter((item) => item.status === "follow_up").length,
    declined: quotes.filter((item) => item.status === "declined").length,
    expired: quotes.filter((item) => item.status === "expired").length,
    total_value: quotes.reduce((sum, item) => sum + Number(item.total || 0), 0),
    confirmed_value: quotes.filter((item) => item.status === "confirmed").reduce((sum, item) => sum + Number(item.total || 0), 0),
  };
}

function filterQuotes(quotes: Quote[], filter: { search?: string; status?: string } = {}) {
  const search = String(filter.search || "").trim();
  return quotes
    .filter((item) => !filter.status || filter.status === "all" || item.status === filter.status)
    .filter((item) => {
      if (!search) return true;
      return `${item.quote_number} ${item.customer_name} ${item.customer_phone || ""} ${item.title || ""}`.includes(search);
    })
    .sort((a, b) => String(b.createdAt || b.issue_date).localeCompare(String(a.createdAt || a.issue_date)));
}

function localQuotePayload(data: QuoteInput, uid: string, existing?: Quote): Quote {
  const items = normalizeQuoteItems(data.items);
  const totals = quoteTotals(items, data.discount, data.tax);
  const now = nowIso();
  return {
    id: existing?.id || localId("quote"),
    quote_number: existing?.quote_number || "",
    customer_id: data.customer_id || existing?.customer_id || null,
    customer_name: String(data.customer_name || existing?.customer_name || "").trim(),
    customer_phone: String(data.customer_phone || existing?.customer_phone || "").trim(),
    customer_city: String(data.customer_city || existing?.customer_city || "").trim(),
    customer_vat: String(data.customer_vat || existing?.customer_vat || "").trim(),
    title: String(data.title || existing?.title || "").trim(),
    status: (data.status || existing?.status || "issued") as QuoteStatus,
    issue_date: data.issue_date || existing?.issue_date || today(),
    valid_until: data.valid_until || existing?.valid_until || null,
    follow_up_date: data.follow_up_date || existing?.follow_up_date || null,
    currency: data.currency || existing?.currency || "SAR",
    items,
    notes: String(data.notes || existing?.notes || "").trim(),
    terms: String(data.terms || existing?.terms || "").trim(),
    confirmed_at: data.status === "confirmed" && !existing?.confirmed_at ? now : existing?.confirmed_at || null,
    createdBy: uid,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    ...quotePaymentFields(data, existing),
    ...totals,
  };
}

function ensureLocalQuoteCustomer(localDb: LocalDb, uid: string, quote: Quote) {
  if (quote.customer_id && localDb.customers.some((item) => item.id === quote.customer_id)) return quote;
  const phone = String(quote.customer_phone || "").trim();
  const existing = phone ? localDb.customers.find((item) => item.phone === phone) : undefined;
  if (existing) {
    return {
      ...quote,
      customer_id: existing.id,
      customer_name: quote.customer_name || existing.name,
      customer_phone: quote.customer_phone || existing.phone,
      customer_city: quote.customer_city || existing.city || "",
    };
  }
  if (!quote.customer_name || !phone) return quote;
  const now = nowIso();
  const customer: Customer = {
    id: localId("cust"),
    name: quote.customer_name,
    phone,
    city: quote.customer_city || "",
    source: "manual",
    createdBy: uid,
    createdAt: now,
    updatedAt: now,
  };
  localDb.customers.push(customer);
  return { ...quote, customer_id: customer.id };
}

export const getQuotes = async (filter: { search?: string; status?: string } = {}): Promise<QuoteListResponse> => {
  const user = getCurrentAppUser();
  if (!user) return { data: [], total: 0, stats: quoteStats([]) };
  const uid = user.uid;
  if (user.local) {
    const all = loadLocalDb(uid).quotes;
    const data = filterQuotes(all, filter);
    return { data, total: data.length, stats: quoteStats(all) };
  }
  if (serverDataEnabled()) {
    const params = new URLSearchParams();
    if (filter.search) params.set("search", filter.search);
    if (filter.status && filter.status !== "all") params.set("status", filter.status);
    return apiFetch<QuoteListResponse>(`/api/quotes${params.toString() ? `?${params}` : ""}`);
  }
  const snap = await getDocs(query(collection(db, "quotes"), where("createdBy", "==", uid), orderBy("createdAt", "desc"), limit(300)));
  const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Quote);
  const data = filterQuotes(all, filter);
  return { data, total: data.length, stats: quoteStats(all) };
};

export const createQuote = async (data: QuoteInput) => {
  const user = getUserOrThrow();
  const uid = user.uid;
  if (user.local) {
    const localDb = loadLocalDb(uid);
    let quote = localQuotePayload(data, uid);
    quote.quote_number = quoteNumber(Date.now(), nextNumberIndex(localDb.quotes, "quote_number"));
    quote = ensureLocalQuoteCustomer(localDb, uid, quote);
    localDb.quotes.unshift(quote);
    saveLocalDb(uid, localDb);
    return quote.id;
  }
  if (serverDataEnabled()) {
    return apiFetch<{ id: string }>("/api/quotes", {
      method: "POST",
      body: JSON.stringify(data),
    }).then((result) => result.id);
  }
  const existing = await getQuotes();
  const id = doc(collection(db, "quotes")).id;
  const payload = localQuotePayload(data, uid);
  payload.id = id;
  payload.quote_number = quoteNumber(Date.now(), nextNumberIndex(existing.data, "quote_number"));
  await wrap(() => setDoc(doc(db, "quotes", id), withoutId(payload)), OperationType.CREATE, `quotes/${id}`);
  return id;
};

export const updateQuote = async (id: string, data: QuoteInput) => {
  const user = getUserOrThrow();
  if (user.local) {
    const localDb = loadLocalDb(user.uid);
    localDb.quotes = localDb.quotes.map((item) => item.id === id ? localQuotePayload(data, user.uid, item) : item);
    saveLocalDb(user.uid, localDb);
    return;
  }
  if (serverDataEnabled()) {
    return apiFetch(`/api/quotes/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }).then(() => undefined);
  }
  const items = normalizeQuoteItems(data.items);
  return wrap(
    () => updateDoc(doc(db, "quotes", id), {
      customer_id: data.customer_id || null,
      customer_name: String(data.customer_name || "").trim(),
      customer_phone: String(data.customer_phone || "").trim(),
      customer_city: String(data.customer_city || "").trim(),
      title: String(data.title || "").trim(),
      status: data.status || "issued",
      issue_date: data.issue_date || today(),
      valid_until: data.valid_until || null,
      follow_up_date: data.follow_up_date || null,
      currency: data.currency || "SAR",
      ...quotePaymentFields(data),
      items,
      notes: String(data.notes || "").trim(),
      terms: String(data.terms || "").trim(),
      ...quoteTotals(items, data.discount, data.tax),
      updatedAt: nowIso(),
    }),
    OperationType.UPDATE,
    `quotes/${id}`,
  );
};

export const setQuoteStatus = async (id: string, status: QuoteStatus, followUpDate?: string | null) => {
  const user = getUserOrThrow();
  const now = nowIso();
  if (user.local) {
    const localDb = loadLocalDb(user.uid);
    localDb.quotes = localDb.quotes.map((item) =>
      item.id === id
        ? {
            ...item,
            status,
            follow_up_date: followUpDate !== undefined ? followUpDate : item.follow_up_date || null,
            confirmed_at: status === "confirmed" ? item.confirmed_at || now : item.confirmed_at || null,
            updatedAt: now,
          }
        : item,
    );
    saveLocalDb(user.uid, localDb);
    return;
  }
  if (serverDataEnabled()) {
    return apiFetch(`/api/quotes/${id}/status`, {
      method: "POST",
      body: JSON.stringify({ status, follow_up_date: followUpDate }),
    }).then(() => undefined);
  }
  const snap = await getDoc(doc(db, "quotes", id));
  const prevConfirmedAt = (snap.exists() ? (snap.data() as Quote).confirmed_at : null) ?? null;
  return wrap(
    () => updateDoc(doc(db, "quotes", id), {
      status,
      follow_up_date: followUpDate !== undefined ? followUpDate : null,
      // Preserve the original confirmation time; only stamp it on first confirm.
      confirmed_at: prevConfirmedAt || (status === "confirmed" ? now : null),
      updatedAt: now,
    }),
    OperationType.UPDATE,
    `quotes/${id}`,
  );
};

export const deleteQuote = (id: string) => {
  const user = getUserOrThrow();
  if (user.local) {
    const localDb = loadLocalDb(user.uid);
    localDb.quotes = localDb.quotes.filter((item) => item.id !== id);
    saveLocalDb(user.uid, localDb);
    return Promise.resolve();
  }
  if (serverDataEnabled()) {
    return apiFetch(`/api/quotes/${id}`, { method: "DELETE" }).then(() => undefined);
  }
  return wrap(() => deleteDoc(doc(db, "quotes", id)), OperationType.DELETE, `quotes/${id}`);
};

export const sendQuoteWhatsApp = async (quote: Quote, message: string) => {
  const outboundCode = requestOutboundCode();
  const user = getCurrentAppUser();
  const metadata = {
    kind: "quote",
    quote_id: quote.id,
    quote_number: quote.quote_number,
  };
  if (serverDataEnabled() && !user?.local) {
    return apiFetch<{ success: boolean; result: unknown }>(`/api/quotes/${quote.id}/send-whatsapp`, {
      method: "POST",
      body: JSON.stringify({
        phone: quote.customer_phone,
        message,
        outboundCode,
        metadata,
      }),
    });
  }
  return apiFetch<{ success: boolean; result: unknown }>("/api/whatsapp/send-test", {
    method: "POST",
    body: JSON.stringify({
      phone: quote.customer_phone,
      message,
      outboundCode,
      metadata,
    }),
  });
};

/* ── Invoice helpers ───────────────────────────────────── */

function invoiceNumber(seed = Date.now(), index = 1) {
  const d = new Date(seed);
  const ymd = d.toISOString().slice(0, 10).replace(/-/g, "");
  return `INV-${ymd}-${String(index).padStart(3, "0")}`;
}

function normalizeInvoiceItems(items: InvoiceItem[] = []) {
  return items
    .map((item) => {
      const quantity = Math.max(0, Number(item.quantity || 0));
      const unitPrice = Math.max(0, Number(item.unit_price || 0));
      return {
        product_id: item.product_id || null,
        product_sku: String(item.product_sku || "").trim(),
        description: String(item.description || "").trim(),
        quantity,
        unit_price: unitPrice,
        total: quantity * unitPrice,
        vat_excluded: item.vat_excluded !== undefined ? item.vat_excluded : true,
      };
    })
    .filter((item) => item.description || item.quantity > 0 || item.unit_price > 0);
}

// Treat an explicit 0 (zero-rated) as a valid VAT rate. Only an unset value
// (undefined / null / "") or a non-numeric value falls back to the default —
// `0 || 15` would otherwise turn a 0% invoice into 15%.
function resolveVatPercent(value: unknown, fallback = 15): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
}

function invoiceTotals(items: InvoiceItem[], discount = 0, vat_percent = 15) {
  const cleanVatPercent = resolveVatPercent(vat_percent);
  const vatRate = cleanVatPercent / 100;
  const subtotal = items.reduce((sum, item) => {
    const total = Number(item.total || 0);
    return sum + (item.vat_excluded === false && vatRate > 0 ? total / (1 + vatRate) : total);
  }, 0);
  const cleanDiscount = Math.max(0, Number(discount || 0));
  const withoutVat = Math.max(0, subtotal - cleanDiscount);
  const vatAmount = withoutVat * vatRate;
  return {
    subtotal: Math.round(subtotal * 100) / 100,
    discount: cleanDiscount,
    vat_percent: cleanVatPercent,
    vat_amount: Math.round(vatAmount * 100) / 100,
    total_with_vat: Math.round((withoutVat + vatAmount) * 100) / 100,
    total_without_vat: Math.round(withoutVat * 100) / 100,
  };
}

function filterInvoices(invoices: Invoice[], filter: { search?: string; status?: string } = {}) {
  const search = String(filter.search || "").trim();
  return invoices
    .filter((item) => !filter.status || filter.status === "all" || item.status === filter.status)
    .filter((item) => {
      if (!search) return true;
      return `${item.invoice_number} ${item.customer_name} ${item.customer_phone || ""} ${item.title || ""}`.includes(search);
    })
    .sort((a, b) => String(b.createdAt || b.issue_date).localeCompare(String(a.createdAt || a.issue_date)));
}

function invoiceStats(invoices: Invoice[]): InvoiceStats {
  return {
    total: invoices.length,
    draft: invoices.filter((item) => item.status === "draft").length,
    issued: invoices.filter((item) => item.status === "issued").length,
    sent: invoices.filter((item) => item.status === "sent").length,
    paid: invoices.filter((item) => item.status === "paid").length,
    cancelled: invoices.filter((item) => item.status === "cancelled").length,
    refunded: invoices.filter((item) => item.status === "refunded").length,
    total_value: invoices.reduce((sum, item) => sum + Number(item.total_with_vat || 0), 0),
    paid_value: invoices.filter((item) => item.status === "paid").reduce((sum, item) => sum + Number(item.total_with_vat || 0), 0),
  };
}

function localInvoicePayload(data: InvoiceInput, uid: string, settings: Settings, existing?: Invoice): Invoice {
  const items = normalizeInvoiceItems(data.items);
  const totals = invoiceTotals(items, data.discount, data.vat_percent);
  const now = nowIso();
  return {
    id: existing?.id || localId("inv"),
    invoice_number: existing?.invoice_number || "",
    quote_id: data.quote_id ?? existing?.quote_id ?? null,
    customer_id: data.customer_id || existing?.customer_id || null,
    customer_name: String(data.customer_name || existing?.customer_name || "").trim(),
    customer_phone: String(data.customer_phone || existing?.customer_phone || "").trim(),
    customer_city: String(data.customer_city || existing?.customer_city || "").trim(),
    customer_vat: String(data.customer_vat || existing?.customer_vat || "").trim(),
    title: String(data.title || existing?.title || "").trim(),
    status: (data.status || existing?.status || "issued") as InvoiceStatus,
    issue_date: data.issue_date || existing?.issue_date || today(),
    due_date: data.due_date ?? existing?.due_date ?? addDays(today(), 30),
    paid_at: data.status === "paid" && !existing?.paid_at ? now : existing?.paid_at || null,
    payment_method: data.payment_method || existing?.payment_method || "",
    currency: data.currency || existing?.currency || "SAR",
    items,
    notes: String(data.notes || existing?.notes || "").trim(),
    terms: String(data.terms || existing?.terms || "").trim(),
    seller_name: String(data.seller_name || existing?.seller_name || settings.seller_name || "").trim(),
    seller_vat_number: String(data.seller_vat_number || existing?.seller_vat_number || settings.seller_vat_number || "").trim(),
    seller_address: String(data.seller_address || existing?.seller_address || settings.seller_address || "").trim(),
    qr_code: existing?.qr_code || "",
    createdBy: uid,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    ...totals,
  };
}

/* ── Invoice API ───────────────────────────────────────── */

export const getInvoices = async (filter: { search?: string; status?: string } = {}): Promise<InvoiceListResponse> => {
  const user = getCurrentAppUser();
  if (!user) return { data: [], total: 0, stats: invoiceStats([]) };
  const uid = user.uid;
  if (user.local) {
    const all = loadLocalDb(uid).invoices;
    const data = filterInvoices(all, filter);
    return { data, total: data.length, stats: invoiceStats(all) };
  }
  if (serverDataEnabled()) {
    const params = new URLSearchParams();
    if (filter.search) params.set("search", filter.search);
    if (filter.status && filter.status !== "all") params.set("status", filter.status);
    return apiFetch<InvoiceListResponse>(`/api/invoices${params.toString() ? `?${params}` : ""}`);
  }
  const snap = await getDocs(query(collection(db, "invoices"), where("createdBy", "==", uid), orderBy("createdAt", "desc"), limit(300)));
  const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Invoice);
  const data = filterInvoices(all, filter);
  return { data, total: data.length, stats: invoiceStats(all) };
};

export const createInvoice = async (data: InvoiceInput) => {
  const user = getUserOrThrow();
  const uid = user.uid;
  if (user.local) {
    const localDb = loadLocalDb(uid);
    let invoice = localInvoicePayload(data, uid, localDb.settings);
    invoice.invoice_number = invoiceNumber(Date.now(), nextNumberIndex(localDb.invoices, "invoice_number"));
    localDb.invoices.unshift(invoice);
    saveLocalDb(uid, localDb);
    return invoice.id;
  }
  if (serverDataEnabled()) {
    return apiFetch<{ id: string }>("/api/invoices", {
      method: "POST",
      body: JSON.stringify(data),
    }).then((result) => result.id);
  }
  const existing = await getInvoices();
  const id = doc(collection(db, "invoices")).id;
  const payload = localInvoicePayload(data, uid, defaultSettings());
  payload.id = id;
  payload.invoice_number = invoiceNumber(Date.now(), nextNumberIndex(existing.data, "invoice_number"));
  await wrap(() => setDoc(doc(db, "invoices", id), withoutId(payload)), OperationType.CREATE, `invoices/${id}`);
  return id;
};

export const updateInvoice = async (id: string, data: InvoiceInput) => {
  const user = getUserOrThrow();
  if (user.local) {
    const localDb = loadLocalDb(user.uid);
    localDb.invoices = localDb.invoices.map((item) =>
      item.id === id ? localInvoicePayload(data, user.uid, localDb.settings, item) : item,
    );
    saveLocalDb(user.uid, localDb);
    return;
  }
  if (serverDataEnabled()) {
    return apiFetch(`/api/invoices/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }).then(() => undefined);
  }
  const items = normalizeInvoiceItems(data.items);
  return wrap(
    () => updateDoc(doc(db, "invoices", id), {
      customer_id: data.customer_id || null,
      customer_name: String(data.customer_name || "").trim(),
      customer_phone: String(data.customer_phone || "").trim(),
      customer_city: String(data.customer_city || "").trim(),
      title: String(data.title || "").trim(),
      status: data.status || "issued",
      issue_date: data.issue_date || today(),
      due_date: data.due_date || null,
      payment_method: data.payment_method || "",
      currency: data.currency || "SAR",
      items,
      notes: String(data.notes || "").trim(),
      terms: String(data.terms || "").trim(),
      seller_name: String(data.seller_name || "").trim(),
      seller_vat_number: String(data.seller_vat_number || "").trim(),
      seller_address: String(data.seller_address || "").trim(),
      ...invoiceTotals(items, data.discount, data.vat_percent),
      updatedAt: nowIso(),
    }),
    OperationType.UPDATE,
    `invoices/${id}`,
  );
};

export const setInvoiceStatus = async (id: string, status: InvoiceStatus) => {
  const user = getUserOrThrow();
  const now = nowIso();
  if (user.local) {
    const localDb = loadLocalDb(user.uid);
    localDb.invoices = localDb.invoices.map((item) =>
      item.id === id
        ? {
            ...item,
            status,
            paid_at: status === "paid" ? item.paid_at || now : item.paid_at || null,
            updatedAt: now,
          }
        : item,
    );
    saveLocalDb(user.uid, localDb);
    return;
  }
  if (serverDataEnabled()) {
    return apiFetch(`/api/invoices/${id}/status`, {
      method: "POST",
      body: JSON.stringify({ status }),
    }).then(() => undefined);
  }
  const snap = await getDoc(doc(db, "invoices", id));
  const prevPaidAt = (snap.exists() ? (snap.data() as Invoice).paid_at : null) ?? null;
  return wrap(
    () => updateDoc(doc(db, "invoices", id), {
      status,
      // Preserve the original payment time; only stamp it the first time paid.
      paid_at: prevPaidAt || (status === "paid" ? now : null),
      updatedAt: now,
    }),
    OperationType.UPDATE,
    `invoices/${id}`,
  );
};

export const deleteInvoice = (id: string) => {
  const user = getUserOrThrow();
  if (user.local) {
    const localDb = loadLocalDb(user.uid);
    localDb.invoices = localDb.invoices.filter((item) => item.id !== id);
    saveLocalDb(user.uid, localDb);
    return Promise.resolve();
  }
  if (serverDataEnabled()) {
    return apiFetch(`/api/invoices/${id}`, { method: "DELETE" }).then(() => undefined);
  }
  return wrap(() => deleteDoc(doc(db, "invoices", id)), OperationType.DELETE, `invoices/${id}`);
};

export const convertQuoteToInvoice = async (quoteId: string) => {
  const user = getUserOrThrow();
  const uid = user.uid;

  if (!user.local && serverDataEnabled()) {
    return apiFetch<{ id: string }>(`/api/quotes/${quoteId}/convert-to-invoice`, {
      method: "POST",
    }).then((result) => result.id);
  }

  let quote: Quote | null = null;
  if (user.local) {
    const localDb = loadLocalDb(uid);
    quote = localDb.quotes.find((q) => q.id === quoteId) || null;
  } else {
    const snap = await getDoc(doc(db, "quotes", quoteId));
    if (snap.exists()) quote = { id: snap.id, ...snap.data() } as Quote;
  }
  if (!quote) throw new Error("عرض السعر غير موجود");

  const settings = user.local
    ? loadLocalDb(uid).settings
    : defaultSettings();

  const invoiceInput: InvoiceInput = {
    quote_id: quote.id,
    customer_id: quote.customer_id,
    customer_name: quote.customer_name,
    customer_phone: quote.customer_phone,
    customer_city: quote.customer_city,
    title: quote.title || "",
    issue_date: today(),
    due_date: addDays(today(), 30),
    currency: quote.currency || "SAR",
    discount: quote.discount,
    vat_percent: 15,
    items: quote.items.map((item) => ({
      product_id: item.product_id || null,
      product_sku: item.product_sku || "",
      description: item.description,
      quantity: item.quantity,
      unit_price: item.unit_price,
      total: item.total,
      vat_excluded: item.vat_excluded !== false,
    })),
    notes: quote.notes,
    terms: quote.terms,
    seller_name: settings.seller_name || "",
    seller_vat_number: settings.seller_vat_number || "",
    seller_address: settings.seller_address || "",
  };

  return createInvoice(invoiceInput);
};

export const generateInvoiceQRCode = (invoice: Invoice): string => {
  const source = invoice.createdAt || `${invoice.issue_date}T00:00:00Z`;
  const parsed = new Date(source);
  const timestamp = (Number.isNaN(parsed.getTime()) ? new Date(`${invoice.issue_date}T00:00:00Z`) : parsed).toISOString().replace(/\.\d{3}Z$/, "Z");
  const total = invoice.total_with_vat.toFixed(2);
  const vatAmount = invoice.vat_amount.toFixed(2);

  const tlvData: Array<[number, string]> = [
    [1, invoice.seller_name],
    [2, invoice.seller_vat_number],
    [3, timestamp],
    [4, total],
    [5, vatAmount],
  ];

  const encoder = new TextEncoder();
  const bytes: number[] = [];

  for (const [tag, value] of tlvData) {
    const valueBytes = Array.from(encoder.encode(String(value)));
    bytes.push(tag, valueBytes.length);
    bytes.push(...valueBytes);
  }

  return btoa(String.fromCharCode(...bytes));
};

export const sendInvoiceWhatsApp = async (invoice: Invoice, message: string) => {
  const outboundCode = requestOutboundCode();
  const user = getCurrentAppUser();
  const metadata = {
    kind: "invoice",
    invoice_id: invoice.id,
    invoice_number: invoice.invoice_number,
  };
  if (serverDataEnabled() && !user?.local) {
    return apiFetch<{ success: boolean; result: unknown }>(`/api/invoices/${invoice.id}/send-whatsapp`, {
      method: "POST",
      body: JSON.stringify({
        phone: invoice.customer_phone,
        message,
        outboundCode,
        metadata,
      }),
    });
  }
  return apiFetch<{ success: boolean; result: unknown }>("/api/whatsapp/send-test", {
    method: "POST",
    body: JSON.stringify({
      phone: invoice.customer_phone,
      message,
      outboundCode,
      metadata,
    }),
  });
};

/* ── Products ──────────────────────────────────────────── */

export const getProducts = async () => {
  const user = getCurrentAppUser();
  if (!user) return [] as Product[];
  const uid = user.uid;
  if (user.local) {
    return loadLocalDb(uid).products.sort((a, b) => a.name.localeCompare(b.name));
  }
  if (serverDataEnabled()) return apiFetch<Product[]>("/api/products");
  const snap = await getDocs(query(collection(db, "products"), where("createdBy", "==", uid), orderBy("name"), limit(100)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Product);
};

export const createProduct = (data: Omit<Product, "id">) => {
  const user = getUserOrThrow();
  const uid = user.uid;
  if (user.local) {
    const localDb = loadLocalDb(uid);
    localDb.products.push({
      ...data,
      id: localId("prod"),
      interval_months: Number(data.interval_months || 1),
      category: data.category || "",
      sku: data.sku || "",
      remind_text: data.remind_text || "",
      source: data.source || "manual",
      product_type: data.product_type || "install_maintenance",
      createdBy: uid,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    saveLocalDb(uid, localDb);
    return Promise.resolve();
  }
  if (serverDataEnabled()) {
    return apiFetch<{ id: string }>("/api/products", {
      method: "POST",
      body: JSON.stringify(data),
    }).then(() => undefined);
  }
  const id = doc(collection(db, "products")).id;
  return wrap(
    () =>
      setDoc(doc(db, "products", id), {
        ...data,
        interval_months: Number(data.interval_months || 1),
        category: data.category || "",
        sku: data.sku || "",
        remind_text: data.remind_text || "",
        source: data.source || "manual",
        product_type: data.product_type || "install_maintenance",
        createdBy: uid,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }),
    OperationType.CREATE,
    "products",
  );
};

export const updateProduct = (id: string, data: Partial<Product>) => {
  const user = getUserOrThrow();
  if (user.local) {
    const localDb = loadLocalDb(user.uid);
    localDb.products = localDb.products.map((item) =>
      item.id === id ? { ...item, ...data, interval_months: Number(data.interval_months || item.interval_months || 1), updatedAt: nowIso() } : item,
    );
    saveLocalDb(user.uid, localDb);
    return Promise.resolve();
  }
  if (serverDataEnabled()) {
    return apiFetch(`/api/products/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }).then(() => undefined);
  }
  return wrap(
    () => updateDoc(doc(db, "products", id), { ...data, interval_months: Number(data.interval_months || 1), updatedAt: nowIso() }),
    OperationType.UPDATE,
    `products/${id}`,
  );
};

/* ── Assets, maintenance cycles, warranty and campaigns ── */

export const getAssetWorkspace = () => apiFetch<AssetWorkspace>("/api/assets/workspace");

export const createAssetLabels = (count: number, productId?: string) =>
  apiFetch<{ items: CustomerAsset[] }>("/api/assets/labels", {
    method: "POST",
    body: JSON.stringify({ count, product_id: productId || null }),
  });

export type AssetActivationPayload = {
  customer_id?: string;
  customer_name?: string;
  customer_phone?: string;
  customer_city?: string;
  customer_type?: "retail" | "wholesale" | "unknown";
  product_id: string;
  manufacturer_serial?: string;
  location_label?: string;
  purchase_date?: string;
  installation_date?: string;
  origin?: "sold" | "legacy" | "external";
  source?: "manual" | "salla" | "odoo" | "import";
  notes?: string;
};

export const activateAsset = (id: string, payload: AssetActivationPayload) =>
  apiFetch(`/api/assets/${id}/activate`, { method: "POST", body: JSON.stringify(payload) });

export const setAssetStatus = (id: string, status: "active" | "paused" | "retired") =>
  apiFetch(`/api/assets/${id}/status`, { method: "PUT", body: JSON.stringify({ status }) });

export const completeServiceCycle = (id: string, completedDate: string, notes = "") =>
  apiFetch(`/api/service-cycles/${id}/complete`, {
    method: "POST",
    body: JSON.stringify({ completed_date: completedDate, notes }),
  });

export const updateProductServicePolicy = (id: string, policy: Partial<Product>) =>
  apiFetch(`/api/products/${id}/service-policy`, { method: "PUT", body: JSON.stringify(policy) });

export const runAssetReminders = () =>
  apiFetch<{ sent: number; failed: number; skipped: number }>("/api/asset-reminders/run", {
    method: "POST",
    body: JSON.stringify({ limit: 100 }),
  });

export const selectReplacementAsset = (id: string, assetId: string) =>
  apiFetch(`/api/replacement-links/${id}/select`, { method: "POST", body: JSON.stringify({ asset_id: assetId }) });

export const createMarketingCampaign = (payload: {
  name: string;
  message: string;
  selected_customer_ids: string[];
  media_type?: "none" | "image" | "video";
  media_url?: string;
}) => apiFetch<{ id: string }>("/api/marketing-campaigns", { method: "POST", body: JSON.stringify(payload) });

export const sendMarketingCampaign = (id: string) =>
  apiFetch<{ sent: number; failed: number }>(`/api/marketing-campaigns/${id}/send`, { method: "POST" });

export const importOdooCustomers = (rows: Array<Record<string, unknown>>, commit: boolean) =>
  apiFetch<{ created: number; updated: number; skipped: number; preview: Array<Record<string, unknown>> }>("/api/odoo/import", {
    method: "POST",
    body: JSON.stringify({ rows, commit }),
  });

export const getOdooExternalStatus = () =>
  apiFetch<{ configured: boolean; url: string | null; database: string | null; username: string | null; customer_type_field: string | null }>("/api/odoo/external/status");

export const syncOdooCustomers = () =>
  apiFetch<{ fetched: number; created: number; updated: number; skipped: number }>("/api/odoo/external/sync-customers", {
    method: "POST",
    body: JSON.stringify({ limit: 500 }),
  });

export const deleteProduct = (id: string) => {
  const user = getUserOrThrow();
  if (user.local) {
    const localDb = loadLocalDb(user.uid);
    localDb.products = localDb.products.filter((item) => item.id !== id);
    saveLocalDb(user.uid, localDb);
    return Promise.resolve();
  }
  if (serverDataEnabled()) {
    return apiFetch(`/api/products/${id}`, { method: "DELETE" }).then(() => undefined);
  }
  return wrap(() => deleteDoc(doc(db, "products", id)), OperationType.DELETE, `products/${id}`);
};

export const getInstallations = async () => {
  const user = getCurrentAppUser();
  if (!user) return [] as Installation[];
  const uid = user.uid;
  if (user.local) {
    return loadLocalDb(uid).installations
      .sort((a, b) => a.next_maintenance.localeCompare(b.next_maintenance))
      .map(localInstallationWithDays);
  }
  if (serverDataEnabled()) return apiFetch<Installation[]>("/api/installations");
  const snap = await getDocs(
    query(collection(db, "installations"), where("createdBy", "==", uid), orderBy("next_maintenance"), limit(150)),
  );
  const todayMs = Date.parse(`${today()}T00:00:00`);

  return snap.docs.map((d) => {
    const data = d.data() as Installation;
    const nextMs = Date.parse(`${data.next_maintenance}T00:00:00`);
    return {
      id: d.id,
      ...data,
      days_until: Math.ceil((nextMs - todayMs) / 86_400_000),
    } as Installation;
  });
};

export const createInstallation = (data: Omit<Installation, "id" | "remind_count" | "status">) => {
  const user = getUserOrThrow();
  const uid = user.uid;
  if (user.local) {
    const localDb = loadLocalDb(uid);
    localDb.installations.push({
      ...data,
      id: localId("inst"),
      label: data.label || "",
      remind_count: 0,
      next_remind_type: data.next_remind_type || "first",
      status: "active",
      completed_date: null,
      last_remind_at: null,
      last_remind_attempt_at: null,
      source: data.source || "manual",
      createdBy: uid,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    saveLocalDb(uid, localDb);
    return Promise.resolve();
  }
  if (serverDataEnabled()) {
    return apiFetch<{ id: string }>("/api/installations", {
      method: "POST",
      body: JSON.stringify(data),
    }).then(() => undefined);
  }
  const id = doc(collection(db, "installations")).id;
  return wrap(
    () =>
      setDoc(doc(db, "installations", id), {
        ...data,
        label: data.label || "",
        remind_count: 0,
        next_remind_type: data.next_remind_type || "first",
        status: "active",
        completed_date: null,
        last_remind_at: null,
        last_remind_attempt_at: null,
        source: data.source || "manual",
        createdBy: uid,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }),
    OperationType.CREATE,
    "installations",
  );
};

export const updateInstallation = (id: string, data: Partial<Installation>) => {
  const user = getUserOrThrow();
  if (user.local) {
    const localDb = loadLocalDb(user.uid);
    localDb.installations = localDb.installations.map((item) => item.id === id ? { ...item, ...data, updatedAt: nowIso() } : item);
    saveLocalDb(user.uid, localDb);
    return Promise.resolve();
  }
  if (serverDataEnabled()) {
    return apiFetch(`/api/installations/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }).then(() => undefined);
  }
  return wrap(() => updateDoc(doc(db, "installations", id), { ...data, updatedAt: nowIso() }), OperationType.UPDATE, `installations/${id}`);
};

export const completeInstallation = (id: string, completedDate = today()) => {
  const user = getUserOrThrow();
  if (user.local) {
    const localDb = loadLocalDb(user.uid);
    localDb.installations = localDb.installations.map((item) =>
      item.id === id ? { ...item, status: "completed", completed_date: completedDate, next_remind_type: null, updatedAt: nowIso() } : item,
    );
    saveLocalDb(user.uid, localDb);
    return Promise.resolve();
  }
  if (serverDataEnabled()) {
    return apiFetch(`/api/installations/${id}/complete`, {
      method: "POST",
      body: JSON.stringify({ completedDate }),
    }).then(() => undefined);
  }
  return wrap(
    () =>
      updateDoc(doc(db, "installations", id), {
        status: "completed",
        completed_date: completedDate,
        next_remind_type: null,
        updatedAt: nowIso(),
      }),
    OperationType.UPDATE,
    `installations/${id}`,
  );
};

export const deleteInstallation = (id: string) => {
  const user = getUserOrThrow();
  if (user.local) {
    const localDb = loadLocalDb(user.uid);
    localDb.installations = localDb.installations.filter((item) => item.id !== id);
    localDb.bookings = localDb.bookings.filter((item) => item.installation_id !== id);
    saveLocalDb(user.uid, localDb);
    return Promise.resolve();
  }
  if (serverDataEnabled()) {
    return apiFetch(`/api/installations/${id}`, { method: "DELETE" }).then(() => undefined);
  }
  return wrap(() => deleteDoc(doc(db, "installations", id)), OperationType.DELETE, `installations/${id}`);
};

export const remindInstallation = async (id: string, type?: string) => {
  const user = getUserOrThrow();
  const outboundCode = requestOutboundCode();
  if (user.local) {
    const localDb = loadLocalDb(user.uid);
    const result = await sendLocalReminderViaWhatsApp(localDb, id, user.uid, type, outboundCode);
    saveLocalDb(user.uid, localDb);
    if (!result.success) throw new Error(result.error || "تعذر إرسال التذكير عبر واتساب.");
    return result;
  }
  return apiFetch<{ success: boolean; remind_count: number; next_remind_type: string | null }>(`/api/installations/${id}/remind`, {
    method: "POST",
    body: JSON.stringify({ type, outboundCode }),
  });
};

export const runDueReminders = async (options: { automatic?: boolean } = {}) => {
  const user = getUserOrThrow();
  const outboundCode = options.automatic ? "" : requestOutboundCode();
  if (user.local) {
    const whatsapp = await getWhatsAppStatus().catch(() => null);
    if (whatsapp?.status !== "connected") {
      return {
        success: false,
        checked: 0,
        sent: 0,
        failed: 0,
        skipped: 0,
        blocked: true,
        error: "واتساب غير متصل. افتح تبويب واتساب والسجل واربط الجلسة أولا.",
        results: [],
        whatsapp: whatsapp || undefined,
      } satisfies ReminderRunResult;
    }
    const localDb = loadLocalDb(user.uid);
    const due = localDb.installations.filter((item) =>
      item.status === "active" &&
      item.next_maintenance <= today() &&
      item.next_remind_type &&
      !(
        hasSuccessfulReminderToday(localDb, item.id) ||
        (options.automatic && hasRecentReminderAttempt(localDb, item.id))
      ),
    );
    const results = [];
    for (const item of due) {
      try {
        results.push(await sendLocalReminderViaWhatsApp(localDb, item.id, user.uid, item.next_remind_type || undefined, outboundCode));
      } catch (error) {
        results.push({ success: false, installation_id: item.id, error: error instanceof Error ? error.message : String(error) });
      }
      if (options.automatic && results.length >= 5) break;
    }
    saveLocalDb(user.uid, localDb);
    return {
      success: true,
      checked: due.length,
      sent: results.filter((item) => item.success).length,
      failed: results.filter((item) => !item.success && !("skipped" in item)).length,
      skipped: results.filter((item) => "skipped" in item).length,
      blocked: false,
      results,
      whatsapp,
    } satisfies ReminderRunResult;
  }
  return apiFetch<ReminderRunResult>("/api/reminders/run-due", {
    method: "POST",
    body: JSON.stringify({ mode: options.automatic ? "automatic" : "manual", outboundCode }),
  });
};

export const getTechnicians = async () => {
  const user = getCurrentAppUser();
  if (!user) return [] as Technician[];
  const uid = user.uid;
  if (user.local) {
    return loadLocalDb(uid).technicians.sort((a, b) => a.name.localeCompare(b.name));
  }
  if (serverDataEnabled()) return apiFetch<Technician[]>("/api/technicians");
  const snap = await getDocs(query(collection(db, "technicians"), where("createdBy", "==", uid), orderBy("name"), limit(100)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Technician);
};

export const createTechnician = (data: Omit<Technician, "id">) => {
  const user = getUserOrThrow();
  const uid = user.uid;
  if (user.local) {
    const localDb = loadLocalDb(uid);
    localDb.technicians.push({
      ...data,
      id: localId("tech"),
      specialty: data.specialty || "",
      max_daily: Number(data.max_daily || 4),
      createdBy: uid,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    saveLocalDb(uid, localDb);
    return Promise.resolve();
  }
  if (serverDataEnabled()) {
    return apiFetch<{ id: string }>("/api/technicians", {
      method: "POST",
      body: JSON.stringify(data),
    }).then(() => undefined);
  }
  const id = doc(collection(db, "technicians")).id;
  return wrap(
    () =>
      setDoc(doc(db, "technicians", id), {
        ...data,
        specialty: data.specialty || "",
        max_daily: Number(data.max_daily || 4),
        createdBy: uid,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }),
    OperationType.CREATE,
    "technicians",
  );
};

export const updateTechnician = (id: string, data: Partial<Technician>) => {
  const user = getUserOrThrow();
  if (user.local) {
    const localDb = loadLocalDb(user.uid);
    localDb.technicians = localDb.technicians.map((item) =>
      item.id === id ? { ...item, ...data, max_daily: Number(data.max_daily || item.max_daily || 4), updatedAt: nowIso() } : item,
    );
    saveLocalDb(user.uid, localDb);
    return Promise.resolve();
  }
  if (serverDataEnabled()) {
    return apiFetch(`/api/technicians/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }).then(() => undefined);
  }
  return wrap(
    () => updateDoc(doc(db, "technicians", id), { ...data, max_daily: Number(data.max_daily || 4), updatedAt: nowIso() }),
    OperationType.UPDATE,
    `technicians/${id}`,
  );
};

export const deleteTechnician = (id: string) => {
  const user = getUserOrThrow();
  if (user.local) {
    const localDb = loadLocalDb(user.uid);
    localDb.technicians = localDb.technicians.filter((item) => item.id !== id);
    saveLocalDb(user.uid, localDb);
    return Promise.resolve();
  }
  if (serverDataEnabled()) {
    return apiFetch(`/api/technicians/${id}`, { method: "DELETE" }).then(() => undefined);
  }
  return wrap(() => deleteDoc(doc(db, "technicians", id)), OperationType.DELETE, `technicians/${id}`);
};

export const getBookings = async (params: { date?: string } = {}) => {
  const user = getCurrentAppUser();
  if (!user) return [] as Booking[];
  const uid = user.uid;
  if (user.local) {
    const data = loadLocalDb(uid).bookings.filter((item) => !params.date || item.date === params.date);
    return data.sort((a, b) => params.date ? a.scheduled_time.localeCompare(b.scheduled_time) : a.date.localeCompare(b.date));
  }
  if (serverDataEnabled()) {
    const search = new URLSearchParams();
    if (params.date) search.set("date", params.date);
    return apiFetch<Booking[]>(`/api/bookings${search.toString() ? `?${search}` : ""}`);
  }
  const q = params.date
    ? query(
        collection(db, "bookings"),
        where("createdBy", "==", uid),
        where("date", "==", params.date),
        orderBy("scheduled_time"),
        limit(100),
      )
    : query(collection(db, "bookings"), where("createdBy", "==", uid), orderBy("date"), limit(100));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Booking);
};

export const createBooking = (data: Omit<Booking, "id">) => {
  const user = getUserOrThrow();
  const uid = user.uid;
  if (user.local) {
    const localDb = loadLocalDb(uid);
    const id = localId("book");
    localDb.bookings.push({
      ...data,
      id,
      status: data.status || "confirmed",
      booking_type: data.booking_type || "maintenance",
      source: data.source || "manual",
      createdBy: uid,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    saveLocalDb(uid, localDb);
    return Promise.resolve(id);
  }
  if (serverDataEnabled()) {
    return apiFetch<{ id: string }>("/api/bookings", {
      method: "POST",
      body: JSON.stringify(data),
    }).then((result) => result.id);
  }
  const id = doc(collection(db, "bookings")).id;
  return wrap(
    () =>
      setDoc(doc(db, "bookings", id), {
        ...data,
        status: data.status || "confirmed",
        booking_type: data.booking_type || "maintenance",
        source: data.source || "manual",
        createdBy: uid,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }),
    OperationType.CREATE,
    "bookings",
  ).then(() => id);
};

export const updateBooking = (id: string, data: Partial<Booking>) => {
  const user = getUserOrThrow();
  if (user.local) {
    const localDb = loadLocalDb(user.uid);
    localDb.bookings = localDb.bookings.map((item) => item.id === id ? { ...item, ...data, updatedAt: nowIso() } : item);
    saveLocalDb(user.uid, localDb);
    return Promise.resolve();
  }
  if (serverDataEnabled()) {
    return apiFetch(`/api/bookings/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }).then(() => undefined);
  }
  return wrap(() => updateDoc(doc(db, "bookings", id), { ...data, updatedAt: nowIso() }), OperationType.UPDATE, `bookings/${id}`);
};

export const deleteBooking = (id: string) => {
  const user = getUserOrThrow();
  if (user.local) {
    const localDb = loadLocalDb(user.uid);
    localDb.bookings = localDb.bookings.filter((item) => item.id !== id);
    saveLocalDb(user.uid, localDb);
    return Promise.resolve();
  }
  if (serverDataEnabled()) {
    return apiFetch(`/api/bookings/${id}`, { method: "DELETE" }).then(() => undefined);
  }
  return wrap(() => deleteDoc(doc(db, "bookings", id)), OperationType.DELETE, `bookings/${id}`);
};

export const notifyTechnicianBooking = async (id: string, trigger = "manual") => {
  const user = getUserOrThrow();
  const outboundCode = requestOutboundCode();
  if (user.local) return sendLocalTechnicianNotification(user.uid, id, trigger, outboundCode);

  return apiFetch<TechnicianNotificationResult>(`/api/bookings/${id}/notify-technician`, {
    method: "POST",
    body: JSON.stringify({ trigger, outboundCode }),
  });
};

export const completeBooking = async (id: string) => {
  const user = getUserOrThrow();
  if (user.local) {
    const localDb = loadLocalDb(user.uid);
    const booking = localDb.bookings.find((item) => item.id === id);
    if (!booking) throw new Error("الحجز غير موجود.");
    const now = nowIso();
    booking.status = "completed";
    booking.completed_at = now;
    booking.updatedAt = now;

    const installation = localDb.installations.find((item) => item.id === booking.installation_id);
    if (installation) {
      const product = localDb.products.find((item) => item.id === installation.product_id || item.id === booking.product_id);
      const months = Number(product?.interval_months || 3);
      installation.status = "active";
      installation.install_date =
        booking.booking_type === "installation" || booking.booking_type === "external_maintenance"
          ? booking.date
          : installation.install_date || booking.date;
      installation.next_maintenance = addMonths(booking.date, months);
      installation.remind_count = 0;
      installation.next_remind_type = "first";
      installation.completed_date = null;
      installation.last_remind_at = null;
      installation.last_remind_attempt_at = null;
      installation.updatedAt = now;
    }

    saveLocalDb(user.uid, localDb);
    return { success: true, booking_id: id, installation_id: booking.installation_id || null, completed_at: now };
  }

  return apiFetch<{ success: boolean; booking_id: string; installation_id?: string | null; completed_at: string }>(
    `/api/bookings/${id}/complete`,
    { method: "POST" },
  );
};

export const getReminders = async () => {
  const user = getCurrentAppUser();
  if (!user) return [] as Reminder[];
  const uid = user.uid;
  if (user.local) {
    return loadLocalDb(uid).reminders.sort((a, b) => b.sent_at.localeCompare(a.sent_at));
  }
  if (serverDataEnabled()) return apiFetch<Reminder[]>("/api/reminders");
  const snap = await getDocs(query(collection(db, "reminders"), where("createdBy", "==", uid), orderBy("sent_at", "desc"), limit(100)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Reminder);
};

export const getCustomerCareQueue = async () => {
  const user = getCurrentAppUser();
  if (!user) return [] as CustomerCareItem[];
  const uid = user.uid;

  if (user.local) {
    const data = loadLocalDb(uid);
    return buildCustomerCareQueue(
      data.customers,
      data.installations.map(localInstallationWithDays),
      data.reminders,
      data.bookings,
    );
  }
  if (serverDataEnabled()) {
    const [customers, installations, reminders, bookings] = await Promise.all([
      getCustomers(""),
      getInstallations(),
      getReminders(),
      getBookings(),
    ]);
    return buildCustomerCareQueue(customers.data, installations, reminders, bookings);
  }

  const [customersSnap, installationsSnap, remindersSnap, bookingsSnap] = await Promise.all([
    getDocs(query(collection(db, "customers"), where("createdBy", "==", uid), limit(250))),
    getDocs(query(collection(db, "installations"), where("createdBy", "==", uid), limit(300))),
    getDocs(query(collection(db, "reminders"), where("createdBy", "==", uid), limit(300))),
    getDocs(query(collection(db, "bookings"), where("createdBy", "==", uid), limit(300))),
  ]);

  return buildCustomerCareQueue(
    customersSnap.docs.map((d) => ({ id: d.id, ...d.data() }) as Customer),
    installationsSnap.docs.map((d) => localInstallationWithDays({ id: d.id, ...d.data() } as Installation)),
    remindersSnap.docs.map((d) => ({ id: d.id, ...d.data() }) as Reminder),
    bookingsSnap.docs.map((d) => ({ id: d.id, ...d.data() }) as Booking),
  );
};

export const getSettings = async (): Promise<Settings> => {
  const user = getCurrentAppUser();
  if (!user) return defaultSettings();
  const uid = user.uid;
  if (user.local) return loadLocalDb(uid).settings;
  if (serverDataEnabled()) return apiFetch<Settings>("/api/settings");
  const snap = await getDoc(doc(db, "settings", uid));
  return snap.exists()
    ? ({ techs: 3, jobs_per_tech: 4, response_rate: 50, maxDaily: 24, ...snap.data() } as Settings)
    : { techs: 3, jobs_per_tech: 4, response_rate: 50, maxDaily: 24 };
};

export const updateSettings = (data: Settings) => {
  const user = getUserOrThrow();
  const uid = user.uid;
  if (user.local) {
    const localDb = loadLocalDb(uid);
    localDb.settings = { ...defaultSettings(), ...data, createdBy: uid, updatedAt: nowIso() };
    saveLocalDb(uid, localDb);
    return Promise.resolve();
  }
  if (serverDataEnabled()) {
    return apiFetch("/api/settings", {
      method: "PUT",
      body: JSON.stringify(data),
    }).then(() => undefined);
  }
  return wrap(
    () =>
      setDoc(
        doc(db, "settings", uid),
        {
          ...data,
          createdBy: uid,
          updatedAt: nowIso(),
        },
        { merge: true },
      ),
    OperationType.UPDATE,
    `settings/${uid}`,
  );
};

function buildDemoDataSet(uid: string, count = 10) {
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(8, 14);
  const now = nowIso();

  const demoProducts: Product[] = [
    { id: localId("prod"), name: `فلتر Breexe ${stamp}`, interval_months: 3, category: "فلاتر", sku: `BP-F-${stamp}`, remind_text: "", createdBy: uid, createdAt: now, updatedAt: now },
    { id: localId("prod"), name: `مضخة Breexe ${stamp}`, interval_months: 6, category: "مضخات", sku: `BP-P-${stamp}`, remind_text: "", createdBy: uid, createdAt: now, updatedAt: now },
    { id: localId("prod"), name: `جهاز تحلية Breexe ${stamp}`, interval_months: 4, category: "تحلية", sku: `BP-R-${stamp}`, remind_text: "", createdBy: uid, createdAt: now, updatedAt: now },
    { id: localId("prod"), name: `عقد صيانة Breexe ${stamp}`, interval_months: 1, category: "خدمة", sku: `BP-S-${stamp}`, remind_text: "", createdBy: uid, createdAt: now, updatedAt: now },
  ];

  const demoTechs: Technician[] = [
    { id: localId("tech"), name: `فني شمال ${stamp}`, phone: "0000000000", specialty: "فلاتر", max_daily: 5, createdBy: uid, createdAt: now, updatedAt: now },
    { id: localId("tech"), name: `فني شرق ${stamp}`, phone: "0000000000", specialty: "مضخات", max_daily: 4, createdBy: uid, createdAt: now, updatedAt: now },
    { id: localId("tech"), name: `فني جنوب ${stamp}`, phone: "0000000000", specialty: "تحلية", max_daily: 4, createdBy: uid, createdAt: now, updatedAt: now },
  ];

  const dueOffsets = [-7, -3, 0, 0, 2, 5, 9, 16, -1, 30];
  const cities = ["الرياض", "جدة", "الدمام", "مكة", "الخبر"];
  const customers: Customer[] = [];
  const installations: Installation[] = [];
  const bookings: Booking[] = [];

  for (let i = 0; i < count; i += 1) {
    const product = demoProducts[i % demoProducts.length];
    const tech = demoTechs[i % demoTechs.length];
    const customer: Customer = {
      id: localId("cust"),
      name: `عميل تجربة ${i + 1} - ${stamp}`,
      phone: "0000000000",
      city: cities[i % cities.length],
      createdBy: uid,
      createdAt: now,
      updatedAt: now,
    };
    const status: Installation["status"] = i === count - 2 ? "completed" : i === count - 1 ? "cancelled" : "active";
    const installDate = addDays(today(), -30 - i);
    const nextMaintenance = addDays(today(), dueOffsets[i % dueOffsets.length]);
    const installation: Installation = {
      id: localId("inst"),
      customer_id: customer.id,
      customer_name: customer.name,
      customer_phone: customer.phone,
      product_id: product.id,
      product_name: product.name,
      install_date: installDate,
      next_maintenance: nextMaintenance,
      remind_count: 0,
      next_remind_type: status === "active" ? "first" : null,
      label: i < 4 ? "مستحق للتذكير" : "تجربة سير عمل",
      status,
      completed_date: status === "completed" ? today() : null,
      last_remind_at: null,
      last_remind_attempt_at: null,
      createdBy: uid,
      createdAt: now,
      updatedAt: now,
    };
    const booking: Booking = {
      id: localId("book"),
      installation_id: installation.id,
      customer_id: customer.id,
      customer_name: customer.name,
      customer_phone: customer.phone,
      product_id: product.id,
      product_name: product.name,
      technician_id: tech.id,
      tech_name: tech.name,
      date: nextMaintenance,
      scheduled_time: `${String(9 + (i % 8)).padStart(2, "0")}:00`,
      status: status === "cancelled" ? "cancelled" : status === "completed" ? "completed" : "confirmed",
      createdBy: uid,
      createdAt: now,
      updatedAt: now,
    };

    customers.push(customer);
    installations.push(installation);
    bookings.push(booking);
  }

  const demoInvoice: Invoice = {
    id: localId("inv"),
    invoice_number: invoiceNumber(Date.now(), 1),
    quote_id: null,
    customer_id: customers[0]?.id || null,
    customer_name: customers[0]?.name || "عميل تجربة",
    customer_phone: customers[0]?.phone || "0000000000",
    customer_city: customers[0]?.city || "الرياض",
    title: "فاتورة تجربة - خدمة صيانة",
    status: "issued",
    issue_date: today(),
    due_date: addDays(today(), 30),
    paid_at: null,
    payment_method: "تحويل بنكي",
    currency: "SAR",
    items: [
      { description: "خدمة صيانة دورية", quantity: 1, unit_price: 500, total: 500, vat_excluded: true },
      { description: "قطع غيار", quantity: 2, unit_price: 150, total: 300, vat_excluded: true },
    ],
    subtotal: 800,
    discount: 0,
    vat_percent: 15,
    vat_amount: 120,
    total_with_vat: 920,
    total_without_vat: 800,
    notes: "",
    terms: "فاتورة ضريبية مبسطة - متوافقة مع ZATCA",
    seller_name: "Breexe Pro Co.",
    seller_vat_number: "300000000000003",
    seller_address: "الرياض، المملكة العربية السعودية",
    qr_code: "",
    createdBy: uid,
    createdAt: now,
    updatedAt: now,
  };

  return {
    products: demoProducts,
    technicians: demoTechs,
    customers,
    installations,
    bookings,
    invoices: [demoInvoice],
  };
}

export const seedDemoData = async (count = 10) => {
  const user = getUserOrThrow();
  const uid = user.uid;
  const demo = buildDemoDataSet(uid, count);

  if (user.local) {
    const localDb = loadLocalDb(uid);
    localDb.products.push(...demo.products);
    localDb.technicians.push(...demo.technicians);
    localDb.customers.push(...demo.customers);
    localDb.installations.push(...demo.installations);
    localDb.bookings.push(...demo.bookings);
    if (demo.invoices) localDb.invoices.push(...demo.invoices);
    saveLocalDb(uid, localDb);
  } else {
    if (serverDataEnabled()) {
      return apiFetch<{
        customers: number;
        products: number;
        technicians: number;
        installations: number;
        bookings: number;
      }>("/api/demo-data", {
        method: "POST",
        body: JSON.stringify({ count }),
      });
    }
    const batch = writeBatch(db);
    demo.products.forEach((item) => batch.set(doc(db, "products", item.id), withoutId(item)));
    demo.technicians.forEach((item) => batch.set(doc(db, "technicians", item.id), withoutId(item)));
    demo.customers.forEach((item) => batch.set(doc(db, "customers", item.id), withoutId(item)));
    demo.installations.forEach((item) => batch.set(doc(db, "installations", item.id), withoutId(item)));
    demo.bookings.forEach((item) => batch.set(doc(db, "bookings", item.id), withoutId(item)));
    if (demo.invoices) demo.invoices.forEach((item) => batch.set(doc(db, "invoices", item.id), withoutId(item)));
    await wrap(() => batch.commit(), OperationType.CREATE, "demo-data");
  }

  return {
    customers: count,
    products: demo.products.length,
    technicians: demo.technicians.length,
    installations: count,
    bookings: count,
    invoices: demo.invoices?.length || 0,
  };
};

export const getWhatsAppStatus = async () => apiFetch<WhatsAppStatus>("/api/whatsapp/status");

export const connectWhatsApp = async () =>
  apiFetch<WhatsAppStatus>("/api/whatsapp/connect", { method: "POST" });

export const getWhatsAppQR = async () => apiFetch<{ qr: string }>("/api/whatsapp/qr");

export const disconnectWhatsApp = async () =>
  apiFetch<WhatsAppStatus>("/api/whatsapp/disconnect", { method: "POST" });

export const testWhatsApp = async (phone: string, message: string, metadata?: Record<string, unknown>) => {
  const outboundCode = requestOutboundCode();
  return apiFetch<{ success: boolean; result: unknown }>("/api/whatsapp/send-test", {
    method: "POST",
    body: JSON.stringify({ phone, message, outboundCode, metadata }),
  });
};

export const getReminderDiagnostics = async (): Promise<ReminderDiagnostics> => {
  const user = getUserOrThrow();
  if (user.local) {
    const localDb = loadLocalDb(user.uid);
    const whatsapp = await getWhatsAppStatus().catch(() => ({ status: "error", lastError: "تعذر قراءة حالة واتساب" }));
    const due = localDb.installations.filter(
      (item) =>
        item.status === "active" &&
        item.next_maintenance <= today() &&
        item.next_remind_type &&
        !hasSuccessfulReminderToday(localDb, item.id),
    );
    const ready = due.filter((item) => !hasRecentReminderAttempt(localDb, item.id));
    const blocker = whatsapp.status === "connected" ? null : "واتساب غير متصل. افتح تبويب واتساب والسجل واربط الجلسة أولا.";

    return {
      success: true,
      today: today(),
      timeZone: "Asia/Riyadh",
      whatsapp,
      blocker,
      scheduler: { mode: "browser-local", note: "في الوضع المحلي يعمل الفحص التلقائي من المتصفح فقط." },
      due: due.length,
      ready: ready.length,
      retryCooldownMinutes: 9,
      preview: ready.slice(0, 10).map((item) => ({
        installation_id: item.id,
        customer_name: item.customer_name,
        customer_phone: item.customer_phone,
        product_name: item.product_name,
        next_maintenance: item.next_maintenance,
        next_remind_type: item.next_remind_type,
      })),
    };
  }

  return apiFetch<ReminderDiagnostics>("/api/reminders/diagnostics");
};

export const getStoreWebhookDiagnostics = async (): Promise<StoreWebhookDiagnostics> => {
  return apiFetch<StoreWebhookDiagnostics>("/api/store/webhook/diagnostics");
};

export const getSallaIntegrationStatus = async (): Promise<SallaIntegrationStatus> => {
  return apiFetch<SallaIntegrationStatus>("/api/integrations/salla/status");
};

export const getSallaConnectUrl = async (): Promise<SallaConnectResponse> => {
  return apiFetch<SallaConnectResponse>("/api/integrations/salla/connect");
};

export const syncSallaOrders = async (): Promise<SallaSyncResult> => {
  return apiFetch<SallaSyncResult>("/api/integrations/salla/sync", { method: "POST" });
};

export const syncSallaProductsCatalog = async (): Promise<SallaSyncResult> => {
  return apiFetch<SallaSyncResult>("/api/integrations/salla/products/sync", { method: "POST" });
};

export const deduplicateProducts = async (): Promise<ProductDeduplicationResult> => {
  return apiFetch<ProductDeduplicationResult>("/api/products/deduplicate", { method: "POST" });
};

export const prepareDailyOperations = async (data: { syncSalla?: boolean } = {}): Promise<DailyPreparationResult> => {
  return apiFetch<DailyPreparationResult>("/api/operations/prepare-daily", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

export const getStoreOrders = async (params: { type?: string } = {}) => {
  const user = getCurrentAppUser();
  if (!user) return [] as StoreOrder[];
  const search = new URLSearchParams();
  if (params.type && params.type !== "all") search.set("type", params.type);
  return apiFetch<StoreOrder[]>(`/api/store/orders${search.toString() ? `?${search.toString()}` : ""}`);
};

export const getStoreOrder = async (id: string) => apiFetch<StoreOrder>(`/api/store/orders/${id}`);

export const linkStoreOrderInstallation = async (id: string, data: { installationId: string; itemSku?: string }) =>
  apiFetch<{ success: boolean; order_id: string; installation_id: string; journey_status: StoreJourneyStatus }>(
    `/api/store/orders/${id}/link-installation`,
    {
      method: "POST",
      body: JSON.stringify(data),
    },
  );

export const classifyStoreOrderItem = async (
  id: string,
  data: { itemSku?: string; manualType: StoreItemType },
) =>
  apiFetch<StoreOrderClassificationResult>(`/api/store/orders/${id}/classify`, {
    method: "POST",
    body: JSON.stringify(data),
  });

export const assignStoreOrderTechnician = async (
  id: string,
  data: { itemSku?: string; technicianId: string; scheduledDate: string; scheduledTime?: string; sendNow?: boolean },
) => {
  const outboundCode = data.sendNow ? requestOutboundCode() : undefined;
  return apiFetch<StoreOrderTechnicianAssignmentResult>(`/api/store/orders/${id}/assign-technician`, {
    method: "POST",
    body: JSON.stringify({ ...data, outboundCode }),
  });
};

// ============================================================
// User management (admin panel)
// ============================================================

export type AppUserRole = "admin" | "manager" | "sales" | "technician" | "user";

export type ManagedAppUser = {
  id: string;
  uid: string | null;
  name: string;
  email: string | null;
  phone: string;
  role: AppUserRole;
  permissions: Record<string, boolean>;
  active: boolean;
  provider: string;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
};

export type MeResponse = {
  uid: string;
  email: string | null;
  name: string;
  role: AppUserRole;
  permissions: Record<string, boolean>;
  active: boolean;
  record: ManagedAppUser | null;
};

export const getMe = () => apiFetch<MeResponse>("/api/me");

export const listAppUsers = (filter: { search?: string; role?: string; active?: boolean } = {}) => {
  const params = new URLSearchParams();
  if (filter.search) params.set("search", filter.search);
  if (filter.role) params.set("role", filter.role);
  if (typeof filter.active === "boolean") params.set("active", filter.active ? "true" : "false");
  const qs = params.toString();
  return apiFetch<{ users: ManagedAppUser[] }>(`/api/admin/users${qs ? `?${qs}` : ""}`);
};

export const createAppUser = (data: {
  name: string;
  email?: string;
  phone?: string;
  role: AppUserRole;
  permissions?: Record<string, boolean>;
}) =>
  apiFetch<{ user: ManagedAppUser }>("/api/admin/users", {
    method: "POST",
    body: JSON.stringify(data),
  });

export const updateAppUser = (
  id: string,
  data: Partial<{
    name: string;
    email: string | null;
    phone: string;
    role: AppUserRole;
    permissions: Record<string, boolean>;
    active: boolean;
  }>,
) =>
  apiFetch<{ user: ManagedAppUser }>(`/api/admin/users/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });

export const setAppUserActive = (id: string, active: boolean) =>
  apiFetch<{ user: ManagedAppUser }>(`/api/admin/users/${id}/${active ? "activate" : "deactivate"}`, {
    method: "POST",
    body: JSON.stringify({}),
  });

export const deleteAppUser = (id: string) =>
  apiFetch<{ success: boolean }>(`/api/admin/users/${id}`, { method: "DELETE" });

// ============================================================
// Maintenance lifecycle + escalations (reminder dashboard)
// ============================================================

export type MaintenanceUpcomingItem = {
  id: string;
  customer_name?: string;
  customer_phone?: string;
  product_name?: string;
  next_maintenance: string;
  next_remind_type?: string | null;
  remind_count?: number;
  days_until?: number;
  days_overdue?: number;
};

export type EscalationStats = {
  total: number;
  active: number;
  assigned: number;
  resolved: number;
  today_resolved: number;
  today_created: number;
};

export type EscalationItem = {
  id: string;
  installation_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  product_name: string | null;
  original_maintenance_date: string | null;
  remind_count: number;
  last_reminded_at: string | null;
  status: "active" | "assigned" | "resolved";
  assigned_to: string | null;
  notes: string;
  created_at: string;
};

export const getMaintenanceUpcoming = (days = 7) =>
  apiFetch<{ count: number; days_ahead: number; items: MaintenanceUpcomingItem[] }>(
    `/api/maintenance/upcoming?days=${days}`,
  );

export const getMaintenanceOverdue = (days = 0) =>
  apiFetch<{ count: number; days_past: number; items: MaintenanceUpcomingItem[] }>(
    `/api/maintenance/overdue?days=${days}`,
  );

export const getEscalationStats = () => apiFetch<EscalationStats>("/api/escalations/stats");

export const getEscalations = (status: "active" | "assigned" | "resolved" | "all" = "active") =>
  apiFetch<{ count: number; status: string; items: EscalationItem[] }>(
    `/api/escalations?status=${status}`,
  );

export const resolveEscalation = (id: string, notes?: string) =>
  apiFetch<EscalationItem>(`/api/escalations/${id}/resolve`, {
    method: "POST",
    body: JSON.stringify({ notes: notes || "" }),
  });

export const assignEscalation = (id: string, assigned_to: string, notes?: string) =>
  apiFetch<EscalationItem>(`/api/escalations/${id}/assign`, {
    method: "POST",
    body: JSON.stringify({ assigned_to, notes: notes || "" }),
  });

// ============================================================
// WhatsApp console: messages, stats, devices, templates
// ============================================================
export type WhatsAppMessage = {
  id: string;
  type?: string;
  provider?: string;
  from_phone?: string | null;
  to_phone?: string | null;
  message?: string | null;
  template_name?: string | null;
  message_id?: string | null;
  status?: string | null;
  direction?: "inbound" | "outbound" | null;
  installation_id?: string | null;
  booking_id?: string | null;
  owner_uid?: string | null;
  metadata?: unknown;
  created_at?: string;
};

export type WhatsAppDailyStats = {
  today: { sent: number; delivered: number; read: number; failed: number; inbound: number };
  provider: "web" | "cloud_api";
  status: string;
  user?: string;
  outbound?: { mode: string; enabled?: boolean; launchApproved?: boolean };
};

export type WhatsAppDevice = {
  id: string;
  provider: string;
  status: string;
  connected_since?: string;
  label?: string;
};

export type WhatsAppTemplateInfo = { name: string; sample: string };

export const listRecentWhatsAppMessages = (limit = 50) =>
  apiFetch<{ count: number; items: WhatsAppMessage[] }>(`/api/whatsapp/messages?limit=${limit}`);

export const getWhatsAppDailyStats = () => apiFetch<WhatsAppDailyStats>("/api/whatsapp/stats");

export const getWhatsAppDevices = () =>
  apiFetch<{ count: number; devices: WhatsAppDevice[] }>("/api/whatsapp/devices");

export const getWhatsAppTemplates = () =>
  apiFetch<{ templates: WhatsAppTemplateInfo[] }>("/api/whatsapp/templates");

export const sendWhatsAppTemplateMessage = (data: {
  phone: string;
  template: string;
  vars?: Record<string, string>;
  installation_id?: string;
  booking_id?: string;
  outboundCode?: string;
}) =>
  apiFetch<{ success: boolean; result: { messageId?: string | null; template?: string; body?: string } }>(
    "/api/whatsapp/send-template",
    { method: "POST", body: JSON.stringify(data) },
  );

export const getConversationByPhone = (phone: string, limit = 200) =>
  apiFetch<{ phone: string; count: number; messages: WhatsAppMessage[] }>(
    `/api/whatsapp/conversations/${encodeURIComponent(phone)}?limit=${limit}`,
  );

// ============================================================
// Odoo-style CRM workspace
// ============================================================
export type OdooCrmStage = "lead" | "opportunity" | "quote" | "invoice" | "paid" | "lost";

export type OdooDeal = {
  id: string;
  record_type?: "deal" | "quote" | "invoice";
  title: string;
  customer_id?: string | null;
  customer_name?: string | null;
  customer_phone?: string | null;
  stage: OdooCrmStage;
  amount?: number;
  currency?: string;
  probability?: number;
  expected_close?: string | null;
  assigned_to?: string | null;
  source?: string;
  quote_id?: string | null;
  invoice_id?: string | null;
  status?: string;
  notes?: string;
  created_at?: string;
  updated_at?: string;
};

export type OdooTask = {
  id: string;
  title: string;
  status: "open" | "done" | "cancelled";
  priority?: string;
  due_date?: string | null;
  assigned_to?: string | null;
  related_type?: string | null;
  related_id?: string | null;
  customer_id?: string | null;
  notes?: string;
  completed_at?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type OdooDashboard = {
  pipeline: Array<{ stage: OdooCrmStage; count: number; amount: number }>;
  financial: {
    paid_sales: number;
    paid_invoices: number;
    open_invoice_total: number;
    open_invoices: number;
    overdue_invoice_total: number;
    overdue_invoices: number;
    quote_followups_due: number;
  };
  operations: {
    open_tasks: number;
    overdue_tasks: number;
  };
};

export type OdooSearchItem = {
  type: "customer" | "store_order" | "quote" | "invoice" | "whatsapp";
  id: string;
  title: string;
  subtitle?: string;
  meta?: string;
};

export type OdooAuditLog = {
  id: string;
  action: string;
  entity_type: string;
  entity_id?: string | null;
  summary?: string;
  actor_uid?: string | null;
  created_at?: string;
};

export type Customer360 = {
  customer: Customer;
  store_orders: StoreOrder[];
  quotes: Quote[];
  invoices: Invoice[];
  installations: Installation[];
  bookings: Booking[];
  conversations: WhatsAppMessage[];
  notes: Array<{ id: string; body: string; created_by?: string; created_at?: string }>;
  tasks: OdooTask[];
  audit: OdooAuditLog[];
};

export const getOdooDashboard = () => apiFetch<OdooDashboard>("/api/odoo/dashboard");
export const getOdooPipeline = () =>
  apiFetch<{ stages: Array<{ stage: OdooCrmStage; count: number; amount: number; items: OdooDeal[] }>; items: OdooDeal[] }>("/api/odoo/pipeline");
export const createOdooDeal = (data: Partial<OdooDeal> & { title: string }) =>
  apiFetch<{ deal: OdooDeal }>("/api/odoo/pipeline", { method: "POST", body: JSON.stringify(data) });
export const updateOdooDeal = (id: string, data: Partial<OdooDeal>) =>
  apiFetch<{ deal: OdooDeal }>(`/api/odoo/pipeline/${id}`, { method: "PUT", body: JSON.stringify(data) });
export const getOdooTasks = (status: "open" | "done" | "cancelled" | "all" = "open") =>
  apiFetch<{ data: OdooTask[]; total: number }>(`/api/odoo/tasks?status=${status}`);
export const createOdooTask = (data: Partial<OdooTask> & { title: string }) =>
  apiFetch<{ task: OdooTask }>("/api/odoo/tasks", { method: "POST", body: JSON.stringify(data) });
export const updateOdooTask = (id: string, data: Partial<OdooTask>) =>
  apiFetch<{ task: OdooTask }>(`/api/odoo/tasks/${id}`, { method: "PUT", body: JSON.stringify(data) });
export const searchOdoo = (q: string) => apiFetch<{ items: OdooSearchItem[] }>(`/api/odoo/search?q=${encodeURIComponent(q)}`);
export const getCustomer360 = (id: string) => apiFetch<Customer360>(`/api/odoo/customer-360/${id}`);
export const addCustomer360Note = (id: string, body: string) =>
  apiFetch<{ note: { id: string; body: string } }>(`/api/odoo/customer-360/${id}/notes`, { method: "POST", body: JSON.stringify({ body }) });
export const getOdooAudit = () => apiFetch<{ data: OdooAuditLog[] }>("/api/odoo/audit");

export const importText = async (text: string) => {
  const lines = text.trim().split("\n");
  let imported = 0;
  let skipped = 0;

  for (const line of lines) {
    const [name, phone, city] = line.split("\t").map((part) => part?.trim());
    if (name && phone) {
      await createCustomer({ name, phone, city });
      imported += 1;
    } else {
      skipped += 1;
    }
  }

  return { imported, skipped, errors: 0 };
};

/* ── Telephony / IVR call routing ─────────────────────────────────────────── */

export type TelephonyAgentInput = {
  user_id?: string | null;
  name?: string;
  phone: string;
  sort_order?: number;
  active?: boolean;
};

export type TelephonyAgent = TelephonyAgentInput & { id: string; phone: string };

export type TelephonyDepartment = {
  id: string;
  digit: string;
  name: string;
  ring_timeout_sec: number;
  active: boolean;
  sort_order: number;
  agents: TelephonyAgent[];
};

export type TelephonyDepartmentInput = {
  digit: string;
  name: string;
  ring_timeout_sec?: number;
  active?: boolean;
  sort_order?: number;
  agents?: TelephonyAgentInput[];
};

export type TelephonyConfig = {
  owner_uid: string;
  provider: string;
  main_number: string;
  greeting: string;
  menu_prompt: string;
  ring_timeout_sec: number;
  enabled: boolean;
};

export type TelephonyReadinessCheck = {
  id: "system_enabled" | "main_number" | "public_url" | "webhook_secret" | "departments" | "agents";
  label: string;
  ready: boolean;
  blocking: boolean;
  detail: string;
};

export type TelephonyReadiness = {
  ready: boolean;
  provider: string;
  enabled: boolean;
  active_departments: number;
  reachable_agents: number;
  uncovered_departments: string[];
  webhook_base_url: string;
  ivr_webhook_url: string;
  status_webhook_url: string;
  checks: TelephonyReadinessCheck[];
};

export type CallLogRow = {
  id: string;
  from_phone: string | null;
  to_phone: string | null;
  department_name: string | null;
  selected_digit: string | null;
  agent_name: string | null;
  agent_phone: string | null;
  customer_name: string | null;
  status: string;
  missed: number;
  handled: number;
  handled_at: string | null;
  wa_customer_notified: number;
  wa_agent_notified: number;
  created_at: string;
};

export const getTelephonyConfig = () =>
  apiFetch<{ config: TelephonyConfig }>("/api/telephony/config").then((r) => r.config);

export const getTelephonyReadiness = () =>
  apiFetch<{ readiness: TelephonyReadiness }>("/api/telephony/readiness").then((r) => r.readiness);

export const updateTelephonyConfig = (patch: Partial<TelephonyConfig>) =>
  apiFetch<{ config: TelephonyConfig }>("/api/telephony/config", {
    method: "PUT",
    body: JSON.stringify(patch),
  }).then((r) => r.config);

export const getTelephonyDepartments = () =>
  apiFetch<{ departments: TelephonyDepartment[] }>("/api/telephony/departments").then((r) => r.departments);

export const createTelephonyDepartment = (data: TelephonyDepartmentInput) =>
  apiFetch<{ department: TelephonyDepartment }>("/api/telephony/departments", {
    method: "POST",
    body: JSON.stringify(data),
  }).then((r) => r.department);

export const updateTelephonyDepartment = (id: string, data: Partial<TelephonyDepartmentInput>) =>
  apiFetch<{ department: TelephonyDepartment }>(`/api/telephony/departments/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  }).then((r) => r.department);

export const deleteTelephonyDepartment = (id: string) =>
  apiFetch(`/api/telephony/departments/${id}`, { method: "DELETE" }).then(() => undefined);

export const getCallLogs = (opts: { limit?: number; missed?: boolean } = {}) => {
  const params = new URLSearchParams();
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.missed) params.set("missed", "true");
  return apiFetch<{ calls: CallLogRow[] }>(
    `/api/telephony/calls${params.toString() ? `?${params}` : ""}`,
  ).then((r) => r.calls);
};

export const markCallHandled = (id: string) =>
  apiFetch<{ success: boolean }>(`/api/telephony/calls/${id}/handle`, { method: "POST" });

export type CallStats = { missed_unhandled: number; missed_today: number; total_today: number };

export const getCallStats = () => apiFetch<CallStats>("/api/telephony/calls/summary");

export const testMissedCall = (data: { from_phone: string; digit?: string; department_id?: string }) =>
  apiFetch<{ success: boolean; callSid: string; department: string; result: unknown }>(
    "/api/telephony/test-missed",
    { method: "POST", body: JSON.stringify(data) },
  );

/* ── Self-hosted phone gateway ─────────────────────────────────────────────── */

export type GatewayOutboxRow = {
  id: string;
  to_phone: string;
  body: string;
  role: string;
  status: string;
  created_at: string;
  sent_at: string | null;
};

export type GatewayStatus = {
  configured: boolean;
  routing_mode: "menu" | "direct";
  pending: number;
  recent: GatewayOutboxRow[];
};

export const getGatewayStatus = () => apiFetch<GatewayStatus>("/api/gateway/status");

// ── Tap Payment Gateway ──

export interface PaymentResponse {
  id: string;
  invoice_id: string;
  amount: number;
  currency: string;
  status: string;
  redirect_url?: string;
  created_at: string;
}

export const createPayment = async (invoiceId: string) => {
  const user = getUserOrThrow();
  const uid = user.uid;
  if (user.local) {
    return apiFetch<PaymentResponse>("/api/payments/create", {
      method: "POST",
      body: JSON.stringify({ invoice_id: invoiceId }),
      headers: { "Content-Type": "application/json" },
    });
  }
  const token = await user.getIdToken();
  return apiFetch<PaymentResponse>("/api/payments/create", {
    method: "POST",
    body: JSON.stringify({ invoice_id: invoiceId }),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
};

