#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getLocalTestToken } from "./local-test-auth.mjs";

const SEED_KEY = "qa-isolation-v1";
const CUSTOMER_PHONE = "0500000101";
const AGENT_PHONE = "0500000200";

function cliValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

export function assertLoopbackBaseUrl(rawUrl) {
  const url = new URL(rawUrl);
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "::1"].includes(hostname)) {
    throw new Error(`QA seed refuses non-loopback target: ${url.origin}`);
  }
  return url.origin;
}

function itemsFrom(payload, key) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.[key])) return payload[key];
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function digits(value) {
  return String(value || "").replace(/\D/g, "");
}

function samePhone(left, right) {
  const a = digits(left);
  const b = digits(right);
  return Boolean(a && b && (a === b || a.endsWith(b.slice(-9)) || b.endsWith(a.slice(-9))));
}

async function responseJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export async function seedQaData(options = {}) {
  const baseUrl = assertLoopbackBaseUrl(options.baseUrl || "http://127.0.0.1:4173");
  const uid = String(options.uid || "local-dev-owner");
  const storeWebhookSecret = String(options.storeWebhookSecret || process.env.STORE_WEBHOOK_SECRET || "");
  if (!storeWebhookSecret.startsWith("qa-store-") || storeWebhookSecret.length < 32) {
    throw new Error("STORE_WEBHOOK_SECRET must be a generated qa-store-* secret before QA seeding.");
  }

  const token = await getLocalTestToken(baseUrl, uid);
  const authHeaders = { Authorization: `Bearer ${token}` };

  async function request(pathname, init = {}) {
    const headers = new Headers(init.headers || {});
    if (init.auth !== false) headers.set("Authorization", authHeaders.Authorization);
    if (init.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const response = await fetch(`${baseUrl}${pathname}`, {
      method: init.method || "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const body = await responseJson(response);
    if (!response.ok) {
      throw new Error(`${init.method || "GET"} ${pathname} failed (${response.status}): ${JSON.stringify(body)}`);
    }
    return body;
  }

  // Fail closed before writing anything. These checks prove that this is the
  // loopback QA process, that schedulers are off, and that no linked provider
  // session can turn a button click into a real external mutation.
  const details = await request("/api/health/details");
  if (details?.outbound?.mode !== "dry_run" || details?.outbound?.dryRun !== true) {
    throw new Error(`QA seed requires server outbound mode dry_run: ${JSON.stringify(details?.outbound)}`);
  }
  if (details?.reminders?.enabled !== false) {
    throw new Error("QA seed requires ENABLE_DAILY_CRON=false.");
  }
  const whatsapp = await request("/api/whatsapp/status");
  if (whatsapp?.provider !== "cloud_api" || whatsapp?.configured !== false || whatsapp?.outbound?.dryRun !== true) {
    throw new Error(`QA seed requires an unconfigured Cloud API provider in dry-run: ${JSON.stringify(whatsapp)}`);
  }
  const salla = await request("/api/integrations/salla/status");
  if (salla?.linked || salla?.configured) {
    throw new Error("QA seed refuses a server with configured or linked Salla credentials.");
  }

  const summary = {
    seedKey: SEED_KEY,
    created: [],
    reused: [],
    storeOrders: [],
  };
  const track = (kind, created) => summary[created ? "created" : "reused"].push(kind);

  let customers = itemsFrom(await request(`/api/customers?search=${encodeURIComponent(CUSTOMER_PHONE)}&limit=100`), "data");
  let customer = customers.find((item) => samePhone(item.phone, CUSTOMER_PHONE));
  if (!customer) {
    const result = await request("/api/customers", {
      method: "POST",
      body: {
        name: "عميل اختبار معزول",
        phone: CUSTOMER_PHONE,
        city: "الرياض",
        source: "manual",
      },
    });
    customer = { id: result.id, name: "عميل اختبار معزول", phone: CUSTOMER_PHONE, city: "الرياض" };
    track("customer", true);
  } else track("customer", false);

  let products = itemsFrom(await request("/api/products"), "data");
  let product = products.find((item) => item.sku === "INSTALL-QA-ISOLATED");
  if (!product) {
    const result = await request("/api/products", {
      method: "POST",
      body: {
        name: "فلتر اختبار معزول",
        sku: "INSTALL-QA-ISOLATED",
        category: "QA",
        interval_months: 3,
        product_type: "install_maintenance",
        source: "manual",
      },
    });
    product = { id: result.id, name: "فلتر اختبار معزول", sku: "INSTALL-QA-ISOLATED" };
    track("product", true);
  } else track("product", false);

  let technicians = itemsFrom(await request("/api/technicians"), "data");
  let technician = technicians.find((item) => samePhone(item.phone, AGENT_PHONE));
  if (!technician) {
    const result = await request("/api/technicians", {
      method: "POST",
      body: {
        name: "فني اختبار معزول",
        phone: AGENT_PHONE,
        specialty: "QA",
        max_daily: 4,
      },
    });
    technician = { id: result.id, name: "فني اختبار معزول", phone: AGENT_PHONE };
    track("technician", true);
  } else track("technician", false);

  let installations = itemsFrom(await request("/api/installations"), "data");
  let installation = installations.find(
    (item) => item.customer_id === customer.id && item.product_id === product.id && item.label === SEED_KEY,
  );
  if (!installation) {
    const result = await request("/api/installations", {
      method: "POST",
      body: {
        customer_id: customer.id,
        customer_name: customer.name,
        customer_phone: customer.phone,
        product_id: product.id,
        product_name: product.name,
        product_sku: product.sku,
        install_date: "2026-07-01",
        next_maintenance: "2026-07-20",
        status: "active",
        label: SEED_KEY,
        source: "manual",
      },
    });
    installation = { id: result.id };
    track("installation", true);
  } else track("installation", false);

  let bookings = itemsFrom(await request("/api/bookings"), "data");
  let booking = bookings.find(
    (item) => item.installation_id === installation.id && item.date === "2026-07-20" && item.scheduled_time === "10:00",
  );
  if (!booking) {
    const result = await request("/api/bookings", {
      method: "POST",
      body: {
        installation_id: installation.id,
        customer_id: customer.id,
        customer_name: customer.name,
        customer_phone: customer.phone,
        product_id: product.id,
        product_name: product.name,
        technician_id: technician.id,
        tech_name: technician.name,
        date: "2026-07-20",
        scheduled_time: "10:00",
        status: "confirmed",
        booking_type: "maintenance",
        source: "manual",
      },
    });
    booking = { id: result.id };
    track("booking", true);
  } else track("booking", false);

  const quotesResponse = await request(`/api/quotes?search=${encodeURIComponent("عرض اختبار معزول")}`);
  let quote = itemsFrom(quotesResponse, "data").find((item) => item.title === "عرض اختبار معزول");
  if (!quote) {
    const result = await request("/api/quotes", {
      method: "POST",
      body: {
        customer_id: customer.id,
        customer_name: customer.name,
        customer_phone: customer.phone,
        customer_city: customer.city,
        title: "عرض اختبار معزول",
        status: "issued",
        issue_date: "2026-07-01",
        valid_until: "2026-08-01",
        items: [{ description: product.name, quantity: 1, unit_price: 1000, vat_excluded: true }],
        discount_mode: "fixed",
        discount_value: 50,
        vat_percent: 15,
        currency: "SAR",
        notes: SEED_KEY,
      },
    });
    quote = result.quote || { id: result.id };
    track("quote", true);
  } else track("quote", false);

  const invoicesResponse = await request(`/api/invoices?search=${encodeURIComponent(customer.phone)}`);
  let invoice = itemsFrom(invoicesResponse, "data").find((item) => item.quote_id === quote.id);
  if (!invoice) {
    const result = await request(`/api/quotes/${encodeURIComponent(quote.id)}/convert-to-invoice`, {
      method: "POST",
      body: {},
    });
    invoice = result.invoice || { id: result.id };
    track("invoice", true);
  } else track("invoice", false);

  const users = itemsFrom(await request("/api/admin/users"), "users");
  if (!users.some((item) => item.email === "qa-agent@example.test")) {
    await request("/api/admin/users", {
      method: "POST",
      body: {
        name: "موظف اختبار",
        email: "qa-agent@example.test",
        phone: AGENT_PHONE,
        role: "technician",
        permissions: { manage_bookings: true },
      },
    });
    track("app_user", true);
  } else track("app_user", false);

  const pipeline = itemsFrom(await request("/api/odoo/pipeline"), "items");
  if (!pipeline.some((item) => item.title === "فرصة اختبار معزولة")) {
    await request("/api/odoo/pipeline", {
      method: "POST",
      body: {
        title: "فرصة اختبار معزولة",
        customer_id: customer.id,
        customer_name: customer.name,
        customer_phone: customer.phone,
        stage: "opportunity",
        amount: 12500,
        probability: 60,
        source: "qa",
        notes: SEED_KEY,
      },
    });
    track("odoo_deal", true);
  } else track("odoo_deal", false);

  const tasks = itemsFrom(await request("/api/odoo/tasks?status=all"), "data");
  if (!tasks.some((item) => item.title === "متابعة عميل اختبار")) {
    await request("/api/odoo/tasks", {
      method: "POST",
      body: {
        title: "متابعة عميل اختبار",
        priority: "high",
        due_date: "2026-07-14",
        customer_id: customer.id,
        related_type: "customer",
        related_id: customer.id,
        notes: SEED_KEY,
      },
    });
    track("odoo_task", true);
  } else track("odoo_task", false);

  const customer360 = await request(`/api/odoo/customer-360/${encodeURIComponent(customer.id)}`);
  if (!itemsFrom(customer360, "notes").some((item) => item.body === "ملاحظة اختبار معزولة")) {
    await request(`/api/odoo/customer-360/${encodeURIComponent(customer.id)}/notes`, {
      method: "POST",
      body: { body: "ملاحظة اختبار معزولة" },
    });
    track("odoo_note", true);
  } else track("odoo_note", false);

  await request("/api/whatsapp/preferences", {
    method: "PUT",
    body: {
      phone: customer.phone,
      channel: "whatsapp",
      status: "granted",
      evidence: "QA isolated fixture consent",
      lift_suppression: true,
    },
  });
  track("whatsapp_preference", false);

  const campaigns = itemsFrom(await request("/api/whatsapp/campaigns"), "campaigns");
  if (!campaigns.some((item) => item.name === "حملة اختبار معزولة")) {
    await request("/api/whatsapp/campaigns", {
      method: "POST",
      body: {
        name: "حملة اختبار معزولة",
        template_name: "general_reminder",
        audience_filter: { customerIds: [customer.id] },
        template_vars: { message: "رسالة اختبار فقط" },
        rate_limit_per_minute: 10,
        frequency_cap_days: 7,
      },
    });
    track("campaign", true);
  } else track("campaign", false);

  const messages = itemsFrom(await request("/api/whatsapp/messages?limit=200"), "items");
  const hasDryRunMessage = messages.some((item) => item.metadata?.qa_seed_key === SEED_KEY);
  if (!hasDryRunMessage) {
    const result = await request("/api/whatsapp/send-test", {
      method: "POST",
      body: {
        phone: customer.phone,
        message: "رسالة QA dry-run لا تغادر الجهاز",
        metadata: { qa_seed_key: SEED_KEY },
      },
    });
    if (result?.result?.dryRun !== true) throw new Error("WhatsApp QA fixture was not blocked as dry-run.");
    track("whatsapp_message", true);
  } else track("whatsapp_message", false);

  await request("/api/telephony/config", {
    method: "PUT",
    body: {
      main_number: "0110000000",
      greeting: "مرحباً بكم في بيئة الاختبار",
      menu_prompt: "اضغط واحد للمبيعات",
      ring_timeout_sec: 20,
      enabled: true,
    },
  });

  let departments = itemsFrom(await request("/api/telephony/departments"), "departments");
  let department = departments.find((item) => item.digit === "1" && item.name === "المبيعات - QA");
  if (!department) {
    const result = await request("/api/telephony/departments", {
      method: "POST",
      body: {
        digit: "1",
        name: "المبيعات - QA",
        agents: [{ name: "موظف اختبار", phone: AGENT_PHONE, active: true }],
      },
    });
    department = result.department;
    track("telephony_department", true);
  } else track("telephony_department", false);

  const calls = itemsFrom(await request("/api/telephony/calls?limit=200"), "calls");
  if (!calls.some((item) => samePhone(item.from_phone, CUSTOMER_PHONE) && item.department_name === department.name)) {
    await request("/api/telephony/test-missed", {
      method: "POST",
      body: { from_phone: CUSTOMER_PHONE, department_id: department.id },
    });
    track("missed_call", true);
  } else track("missed_call", false);

  const orderCases = [
    {
      code: "INSTALL",
      // Store-order coverage stays sale-only here because the operational
      // installation/booking modules are seeded explicitly above. That keeps
      // this fixture focused on webhook idempotency and filter metadata.
      sku: "SALE-INSTALL-QA-ISOLATED",
      phone: CUSTOMER_PHONE,
      status: "paid",
      createdAt: "2026-07-03T09:00:00Z",
      payment: "mada",
      shipping: "SPL",
      tag: "priority",
    },
    {
      code: "SALE",
      sku: "SALE-QA-ISOLATED",
      phone: "0500000102",
      status: "shipped",
      createdAt: "2026-07-08T11:00:00Z",
      payment: "visa",
      shipping: "Aramex",
      tag: "wholesale",
    },
    {
      code: "REVIEW",
      sku: "OTHER-QA-REVIEW",
      phone: "0500000103",
      status: "pending",
      createdAt: "2026-07-13T07:30:00Z",
      payment: "cash",
      shipping: "SMSA",
      tag: "review",
    },
  ];

  for (const item of orderCases) {
    const orderId = `QA-${item.code}-ISOLATED-V1`;
    const result = await request("/api/store/webhook", {
      method: "POST",
      auth: false,
      headers: { "X-Golden-Webhook-Secret": storeWebhookSecret },
      body: {
        event: "order.created",
        event_id: `event-${orderId}`,
        provider: "salla",
        order: {
          id: orderId,
          number: orderId,
          status: item.status,
          created_at: item.createdAt,
          total: 1150,
          customer: { name: `عميل ${item.code}`, phone: item.phone, city: "الرياض", country: "SA" },
          payment: { method: item.payment },
          shipping: { company: item.shipping, country: "SA", city: "الرياض", status: "preparing" },
          sales_channel: "online",
          assigned_employee: "موظف اختبار",
          pickup_branch: "الفرع الرئيسي",
          tags: [item.tag],
          is_read: false,
          installation_date: "2026-07-21",
          installation_time: "10:00",
          items: [{ name: `منتج ${item.code}`, sku: item.sku, quantity: 1, maintenance_months: 3 }],
        },
      },
    });
    summary.storeOrders.push({ orderId, duplicate: result?.duplicate === true });
  }

  const storeOrders = await request("/api/store/orders?limit=100");
  const seededOrders = itemsFrom(storeOrders, "data").filter((item) => String(item.order_number || "").includes("ISOLATED-V1"));
  if (seededOrders.length !== orderCases.length) {
    throw new Error(`Expected ${orderCases.length} idempotent QA store orders, found ${seededOrders.length}.`);
  }

  return {
    ...summary,
    customerId: customer.id,
    productId: product.id,
    technicianId: technician.id,
    installationId: installation.id,
    bookingId: booking.id,
    quoteId: quote.id,
    invoiceId: invoice.id,
  };
}

async function main() {
  const result = await seedQaData({
    baseUrl: cliValue("base-url", process.env.APP_URL || "http://127.0.0.1:4173"),
    uid: cliValue("uid", process.env.LOCAL_AUTH_SHARED_UID || "local-dev-owner"),
  });
  console.log(JSON.stringify(result, null, 2));
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
