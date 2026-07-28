import assert from "node:assert/strict";
import test from "node:test";

process.env.DATA_PROVIDER = "sqlite";
process.env.DB_PROVIDER = "sqlite";
process.env.DB_PATH = ":memory:";
process.env.APP_URL = "https://crm.test";
process.env.APP_TIMEZONE = "Asia/Riyadh";
process.env.WHATSAPP_BOOKING_SLOT_TIMES = "09:00,11:00,14:00,16:00";
process.env.WHATSAPP_BOOKING_LOOKAHEAD_DAYS = "3";
process.env.WHATSAPP_BOOKING_MIN_LEAD_HOURS = "4";
process.env.WHATSAPP_BOOKING_CLOSED_WEEKDAYS = "5";
process.env.WHATSAPP_CAMPAIGN_ORDER_URL_PREFIX = "https://goldenksa.store/";
process.env.ENABLE_DAILY_CRON = "false";

const ownerUid = "whatsapp-commerce-owner";
const existingPhone = "966500000001";
const newPhone = "966500000002";
const now = new Date("2026-07-27T06:00:00.000Z");

const db = (await import("./db")).default;
const { handleWhatsAppCommerceConversation } = await import("./whatsappCommerce");
const { saveWhatsAppCommerceSession } = await import("./whatsappCommerceStorage");
const { dispatchMessage } = await import("./gateway");

function clearCommerceFixtures() {
  for (const table of [
    "whatsapp_ai_intents",
    "whatsapp_commerce_sessions",
    "bookings",
    "installations",
    "technicians",
    "products",
    "payments",
    "customers",
    "crm_tasks",
    "salla_abandoned_carts",
    "communication_jobs",
    "communication_campaign_audience",
    "communication_campaign_recipients",
    "communication_campaigns",
    "communication_preferences",
    "communication_suppressions",
    "technician_notifications",
    "store_orders",
    "ivr_department_agents",
    "ivr_departments",
  ]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
}

function seedTechnician() {
  db.prepare(
    `INSERT INTO technicians (id, owner_uid, name, phone, max_daily)
     VALUES ('tech-wa-1', ?, 'الفني أحمد', '966511111111', 2)`,
  ).run(ownerUid);
}

function seedProduct() {
  db.prepare(
    `INSERT INTO products (
       id, owner_uid, name, product_type, catalog_visible, is_available
     ) VALUES ('product-wa-1', ?, 'تركيب فلتر جولدن', 'install_maintenance', 1, 1)`,
  ).run(ownerUid);
}

function seedExistingCustomer() {
  db.prepare(
    `INSERT INTO customers (
       id, owner_uid, name, phone, city, address, customer_address, source
     ) VALUES ('customer-wa-1', ?, 'عميل واتساب', ?, 'الرياض', 'حي النرجس',
               'الرياض، حي النرجس', 'manual')`,
  ).run(ownerUid, existingPhone);
  db.prepare(
    `INSERT INTO installations (
       id, owner_uid, customer_id, customer_name, customer_phone,
       product_id, product_name, status, source, customer_address
     ) VALUES ('installation-wa-1', ?, 'customer-wa-1', 'عميل واتساب', ?,
               'product-wa-1', 'فلتر جولدن', 'active', 'manual', 'الرياض، حي النرجس')`,
  ).run(ownerUid, existingPhone);
}

function seedIssuedInvoice(input: {
  id?: string;
  number?: string;
  sequence?: number;
  issueDate?: string;
} = {}) {
  db.prepare(
    `INSERT INTO invoices (
       id, owner_uid, invoice_number, document_kind, sequence_no, issued_at,
       idempotency_key, customer_name, customer_phone, status, issue_date,
       total_with_vat, currency, items, created_at, updated_at
     ) VALUES (
       ?, ?, ?, 'invoice', ?, ?,
       ?, 'عميل واتساب', ?, 'issued', ?,
       230, 'SAR', '[]', ?, ?
     )`,
  ).run(
    input.id || "invoice-wa-1",
    ownerUid,
    input.number || "INV-WA-001",
    input.sequence || 1,
    now.toISOString(),
    `invoice:wa:${input.sequence || 1}`,
    existingPhone,
    input.issueDate || "2026-07-27",
    now.toISOString(),
    now.toISOString(),
  );
}

function seedStoreOrder(input: {
  id?: string;
  owner?: string;
  phone?: string;
  number?: string;
  status?: string;
}) {
  const id = input.id || "store-order-wa-1";
  db.prepare(
    `INSERT INTO store_orders (
       id, owner_uid, customer_phone, order_number, store_order_id,
       remote_status_name, remote_status_slug, shipping_company,
       tracking_number, tracking_link, order_created_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'in_progress', 'شركة الشحن',
               'TRACK-123', 'https://tracking.example.test/TRACK-123',
               '2026-07-27T05:00:00.000Z', ?, ?)`,
  ).run(
    id,
    input.owner || ownerUid,
    input.phone || existingPhone,
    input.number || "S-1001",
    input.number || "S-1001",
    input.status || "قيد التجهيز",
    now.toISOString(),
    now.toISOString(),
  );
}

function seedCampaign(id = "camp_action_test") {
  db.prepare(
    `INSERT INTO communication_campaigns (
       id, owner_uid, name, template_name, status, audience_filter, template_vars
     ) VALUES (?, ?, 'عرض فلاتر واتساب', 'campaign_offer_image', 'completed', '{}', '{}')`,
  ).run(id, ownerUid);
  return id;
}

function seedReminderCampaign(id = "camp_reminder_test") {
  db.prepare(
    `INSERT INTO communication_campaigns (
       id, owner_uid, name, template_name, status, audience_filter, template_vars,
       media_type, media_url, order_url
     ) VALUES (?, ?, 'عرض مع تذكير', 'campaign_offer_image_reminder', 'completed',
               '{}', '{"offer_text":"عرض خاص"}', 'image',
               'https://cdn.example.test/offer.jpg',
               'https://goldenksa.store/offers/filter')`,
  ).run(id, ownerUid);
  db.prepare(
    `INSERT INTO communication_preferences (
       owner_uid, phone, channel, purpose, status, source, evidence, captured_at
     ) VALUES (?, ?, 'whatsapp', 'marketing', 'granted', 'test', 'documented opt-in', ?)`,
  ).run(ownerUid, existingPhone, now.toISOString());
  return id;
}

test.beforeEach(() => {
  delete process.env.WHATSAPP_COMMERCE_ENABLED;
  delete process.env.WHATSAPP_AI_ENABLED;
  delete process.env.DEEPSEEK_API_KEY;
  clearCommerceFixtures();
  seedTechnician();
  seedProduct();
});

test("the isolated commerce kill switch leaves the generic conversation router available", async () => {
  process.env.WHATSAPP_COMMERCE_ENABLED = "false";
  const result = await handleWhatsAppCommerceConversation({
    ownerUid,
    fromPhone: existingPhone,
    text: "حجز",
  });
  assert.deepEqual(result, { handled: false, reason: "commerce_disabled" });
});

test("campaign remind-week and opt-out buttons work even when payment commerce is disabled", async () => {
  process.env.WHATSAPP_COMMERCE_ENABLED = "false";
  const campaignId = seedReminderCampaign();
  const reminder = await handleWhatsAppCommerceConversation(
    {
      ownerUid,
      fromPhone: existingPhone,
      text: `campaign:remind_week:${campaignId}`,
    },
    { now: () => now },
  );
  assert.equal(reminder.kind, "campaign_week_reminder_scheduled");
  const job = db.prepare(
    `SELECT kind, status, available_at, campaign_id
       FROM communication_jobs
      WHERE owner_uid = ? AND event_key = ?`,
  ).get(
    ownerUid,
    `campaign-followup:${campaignId}:${existingPhone}:2026-07-27`,
  ) as Record<string, unknown>;
  assert.equal(job.kind, "whatsapp_campaign_followup");
  assert.equal(job.status, "pending");
  assert.equal(job.available_at, "2026-08-03T06:00:00.000Z");
  assert.equal(job.campaign_id, campaignId);

  const stopped = await handleWhatsAppCommerceConversation(
    {
      ownerUid,
      fromPhone: existingPhone,
      text: `campaign:stop_marketing:${campaignId}`,
    },
    { now: () => now },
  );
  assert.equal(stopped.kind, "campaign_marketing_stopped");
  const suppression = db.prepare(
    `SELECT reason, active FROM communication_suppressions
      WHERE owner_uid = ? AND phone = ?`,
  ).get(ownerUid, existingPhone) as Record<string, unknown>;
  assert.equal(suppression.reason, "campaign_button_opt_out");
  assert.equal(suppression.active, 1);
});

test("commerce replies never fall back to an SMS queue when WhatsApp is unavailable", async () => {
  const before = db.prepare(
    "SELECT COUNT(*) AS count FROM gateway_outbox WHERE owner_uid = ?",
  ).get(ownerUid) as { count: number };
  const result = await dispatchMessage(
    ownerUid,
    existingPhone,
    "اختبار واتساب فقط",
    { role: "customer", allowSmsFallback: false },
  );
  const after = db.prepare(
    "SELECT COUNT(*) AS count FROM gateway_outbox WHERE owner_uid = ?",
  ).get(ownerUid) as { count: number };

  assert.equal(result.channel, "whatsapp");
  assert.equal(result.accepted, false);
  assert.equal(result.status, "unavailable");
  assert.equal(after.count, before.count);
});

test("WhatsApp creates an idempotent payment link for the latest payable invoice", async () => {
  seedExistingCustomer();
  seedIssuedInvoice();
  const calls: Array<Record<string, string>> = [];

  const result = await handleWhatsAppCommerceConversation(
    {
      ownerUid,
      fromPhone: existingPhone,
      text: "أريد دفع الفاتورة",
    },
    {
      now: () => now,
      createPaymentLink: async (input) => {
        calls.push(input);
        return {
          success: true,
          id: "pay_whatsapp_test_1",
          payment_id: "pay_whatsapp_test_1",
          invoice_id: input.invoiceId,
          tap_charge_id: "chg_whatsapp_test_1",
          amount: 230,
          currency: "SAR",
          redirect_url: "https://tap.test/pay/whatsapp-1",
          status: "pending",
          created_at: now.toISOString(),
        };
      },
    },
  );

  assert.equal(result.handled, true);
  assert.equal(result.kind, "payment_link");
  assert.equal(result.paymentId, "pay_whatsapp_test_1");
  assert.match(String(result.reply), /INV-WA-001/);
  assert.match(String(result.reply), /https:\/\/tap\.test\/pay\/whatsapp-1/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].invoiceId, "invoice-wa-1");
  assert.equal(calls[0].ownerUid, ownerUid);
  assert.match(calls[0].idempotencyKey, /^wa:[a-f0-9]{48}$/);

  await handleWhatsAppCommerceConversation(
    { ownerUid, fromPhone: existingPhone, text: "دفع" },
    {
      now: () => now,
      createPaymentLink: async (input) => {
        calls.push(input);
        return {
          success: true,
          id: "pay_whatsapp_test_1",
          payment_id: "pay_whatsapp_test_1",
          invoice_id: input.invoiceId,
          tap_charge_id: "chg_whatsapp_test_1",
          amount: 230,
          currency: "SAR",
          redirect_url: "https://tap.test/pay/whatsapp-1",
          status: "pending",
          created_at: now.toISOString(),
          idempotent_replay: true,
        };
      },
    },
  );
  assert.equal(calls[1].idempotencyKey, calls[0].idempotencyKey);
});

test("DeepSeek classification can route free-form Arabic to the existing payment tool without generating a URL", async () => {
  seedExistingCustomer();
  seedIssuedInvoice({
    id: "invoice-wa-ai-2",
    number: "INV-WA-AI-002",
    sequence: 2,
    issueDate: "2026-07-28",
  });
  let classifierCalls = 0;
  const result = await handleWhatsAppCommerceConversation(
    {
      ownerUid,
      fromPhone: existingPhone,
      text: "أرسل لي الشيء اللي أقدر أكمل الحساب منه",
    },
    {
      now: () => now,
      classifyIntent: async () => {
        classifierCalls += 1;
        return {
          attempted: true,
          status: "ok",
          intent: "payment_link",
          confidence: 0.94,
        };
      },
      createPaymentLink: async (input) => ({
        success: true,
        id: "pay_ai_1",
        payment_id: "pay_ai_1",
        invoice_id: input.invoiceId,
        tap_charge_id: "chg_ai_1",
        amount: 230,
        currency: "SAR",
        redirect_url: "https://tap.test/pay/from-crm-only",
        status: "pending",
        created_at: now.toISOString(),
      }),
    },
  );
  assert.equal(classifierCalls, 1);
  assert.equal(result.kind, "payment_link");
  assert.match(String(result.reply), /https:\/\/tap\.test\/pay\/from-crm-only/);
});

test("order status is returned only for the sender phone and current owner", async () => {
  seedStoreOrder({});
  seedStoreOrder({
    id: "store-order-other-customer",
    phone: "966599999999",
    number: "S-SECRET-CUSTOMER",
    status: "طلب عميل آخر",
  });
  seedStoreOrder({
    id: "store-order-other-owner",
    owner: "another-owner",
    number: "S-SECRET-TENANT",
    status: "طلب متجر آخر",
  });

  const latest = await handleWhatsAppCommerceConversation(
    {
      ownerUid,
      fromPhone: existingPhone,
      text: "خبرني وين وصلت الشغلة اللي طلبتها",
    },
    {
      now: () => now,
      classifyIntent: async () => ({
        attempted: true,
        status: "ok",
        intent: "order_status",
        confidence: 0.96,
      }),
    },
  );
  assert.equal(latest.kind, "order_status");
  assert.match(String(latest.reply), /S-1001/);
  assert.match(String(latest.reply), /قيد التجهيز/);
  assert.match(String(latest.reply), /tracking\.example\.test/);
  assert.doesNotMatch(String(latest.reply), /SECRET/);

  const forged = await handleWhatsAppCommerceConversation(
    {
      ownerUid,
      fromPhone: existingPhone,
      text: "تابع S-SECRET-CUSTOMER",
    },
    {
      now: () => now,
      classifyIntent: async () => ({
        attempted: true,
        status: "ok",
        intent: "order_status",
        orderNumber: "S-SECRET-CUSTOMER",
        confidence: 0.99,
      }),
    },
  );
  assert.equal(forged.kind, "order_not_found");
  assert.doesNotMatch(String(forged.reply), /طلب عميل آخر/);

  let directClassifierCalls = 0;
  const directForged = await handleWhatsAppCommerceConversation(
    {
      ownerUid,
      fromPhone: existingPhone,
      text: "ما حالة الطلب S-SECRET-CUSTOMER؟",
    },
    {
      now: () => now,
      classifyIntent: async () => {
        directClassifierCalls += 1;
        throw new Error("the deterministic status command must not call AI");
      },
    },
  );
  assert.equal(directForged.kind, "order_not_found");
  assert.equal(directClassifierCalls, 0);
  assert.doesNotMatch(String(directForged.reply), /طلب عميل آخر/);

  const crossTenant = await handleWhatsAppCommerceConversation(
    {
      ownerUid,
      fromPhone: existingPhone,
      text: "تابع S-SECRET-TENANT",
    },
    {
      now: () => now,
      classifyIntent: async () => ({
        attempted: true,
        status: "ok",
        intent: "order_status",
        orderNumber: "S-SECRET-TENANT",
        confidence: 0.99,
      }),
    },
  );
  assert.equal(crossTenant.kind, "order_not_found");
  assert.doesNotMatch(String(crossTenant.reply), /طلب متجر آخر/);
});

test("human handoff creates one high-priority CRM task and safely reuses it", async () => {
  seedExistingCustomer();
  db.prepare(
    `INSERT INTO ivr_departments (id, owner_uid, digit, name, active, sort_order)
     VALUES ('dept-sales-wa', ?, '1', 'المبيعات', 1, 1)`,
  ).run(ownerUid);
  db.prepare(
    `INSERT INTO ivr_department_agents (
       id, department_id, owner_uid, user_id, name, phone, active, sort_order
     ) VALUES ('agent-sales-wa', 'dept-sales-wa', ?, 'sales-user-1', 'موظف المبيعات',
               '966511111112', 1, 1)`,
  ).run(ownerUid);
  const dependencies = {
    now: () => now,
    classifyIntent: async () => ({
      attempted: true as const,
      status: "ok" as const,
      intent: "human_handoff" as const,
      department: "sales" as const,
      confidence: 0.93,
    }),
  };
  const first = await handleWhatsAppCommerceConversation(
    {
      ownerUid,
      fromPhone: existingPhone,
      text: "ودي أحد يفهم مشكلتي ويتابعها معي",
    },
    dependencies,
  );
  let directClassifierCalls = 0;
  const second = await handleWhatsAppCommerceConversation(
    {
      ownerUid,
      fromPhone: existingPhone,
      text: "حولني لموظف المبيعات",
    },
    {
      now: () => now,
      classifyIntent: async () => {
        directClassifierCalls += 1;
        throw new Error("explicit handoff must not call AI");
      },
    },
  );
  assert.equal(first.kind, "human_handoff");
  assert.equal(second.kind, "human_handoff");
  assert.equal(first.reason, second.reason);
  assert.equal(directClassifierCalls, 0);
  const tasks = db.prepare(
    `SELECT priority, customer_id, related_type, assigned_to, notes
       FROM crm_tasks
      WHERE owner_uid = ? AND related_type = 'whatsapp_ai_handoff'`,
  ).all(ownerUid) as Array<Record<string, unknown>>;
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].priority, "high");
  assert.equal(tasks[0].customer_id, "customer-wa-1");
  assert.equal(tasks[0].assigned_to, "sales-user-1");
  assert.match(String(tasks[0].notes), /المبيعات/);
});

test("an active booking data-entry session never calls the AI classifier", async () => {
  let classifierCalls = 0;
  saveWhatsAppCommerceSession(db, {
    ownerUid,
    phone: newPhone,
    step: "awaiting_name",
    now: now.toISOString(),
    context: {},
  });
  const result = await handleWhatsAppCommerceConversation(
    {
      ownerUid,
      fromPhone: newPhone,
      text: "عبدالله محمد",
    },
    {
      now: () => now,
      classifyIntent: async () => {
        classifierCalls += 1;
        throw new Error("AI must not run during booking data entry");
      },
    },
  );
  assert.equal(result.kind, "booking_address_required");
  assert.equal(classifierCalls, 0);
});

test("AI failures and unknown output fall back to the deterministic menu without inventing an action", async () => {
  const failed = await handleWhatsAppCommerceConversation(
    {
      ownerUid,
      fromPhone: existingPhone,
      text: "ممكن تساعدني",
    },
    {
      now: () => now,
      classifyIntent: async () => ({
        attempted: true,
        status: "failed",
        intent: "unknown",
        reason: "invalid_response",
      }),
    },
  );
  assert.equal(failed.kind, "ai_fallback_menu");
  assert.match(String(failed.reply), /1 - رابط دفع فاتورة/);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM payments").get() as { count: number }).count,
    0,
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM bookings").get() as { count: number }).count,
    0,
  );
});

test("a cart reply answers catalog facts and escalates unknown product questions without inventing an answer", async () => {
  db.prepare(
    `INSERT INTO salla_abandoned_carts (
       owner_uid, cart_id, customer_name, customer_phone, checkout_url, items_json,
       status, outreach_status, first_seen_at, last_event_at, created_at, updated_at
     ) VALUES (?, 'cart-wa-1', 'عميل السلة', ?, 'https://store.example/checkout/cart-wa-1', '[]',
               'active', 'sent', ?, ?, ?, ?)`,
  ).run(ownerUid, existingPhone, now.toISOString(), now.toISOString(), now.toISOString(), now.toISOString());
  saveWhatsAppCommerceSession(db, {
    ownerUid,
    phone: existingPhone,
    step: "awaiting_cart_question",
    now: now.toISOString(),
    ttlMinutes: 1440,
    context: {
      cart: {
        cartId: "cart-wa-1",
        checkoutUrl: "https://store.example/checkout/cart-wa-1",
        products: [{
          productId: "product-wa-1",
          name: "فلتر جولدن",
          quantity: 1,
          price: 199,
          currency: "SAR",
          description: "فلتر منزلي متعدد المراحل.",
          productType: "install_maintenance",
          storeUrl: "https://store.example/products/filter",
          isAvailable: true,
          stockQuantity: 5,
        }],
      },
    },
  });

  const price = await handleWhatsAppCommerceConversation(
    { ownerUid, fromPhone: existingPhone, text: "كم سعر الفلتر؟" },
    { now: () => now },
  );
  assert.equal(price.kind, "cart_product_price");
  assert.match(String(price.reply), /(?:199|١٩٩)/);

  const checkout = await handleWhatsAppCommerceConversation(
    { ownerUid, fromPhone: existingPhone, text: "أرسل رابط إكمال السلة" },
    { now: () => now },
  );
  assert.equal(checkout.kind, "cart_checkout_link");
  assert.match(String(checkout.reply), /https:\/\/store\.example\/checkout\/cart-wa-1/);

  const warranty = await handleWhatsAppCommerceConversation(
    { ownerUid, fromPhone: existingPhone, text: "كم مدة الضمان؟" },
    { now: () => now },
  );
  assert.equal(warranty.kind, "cart_question_escalated");
  assert.doesNotMatch(String(warranty.reply), /\d+\s*(?:سنة|سنوات|شهر)/);
  const task = db.prepare(
    "SELECT * FROM crm_tasks WHERE owner_uid = ? AND related_type = 'salla_abandoned_cart'",
  ).get(ownerUid) as Record<string, unknown>;
  assert.match(String(task.notes), /كم مدة الضمان/);
  assert.equal(
    (db.prepare("SELECT last_question FROM salla_abandoned_carts WHERE owner_uid = ? AND cart_id = 'cart-wa-1'")
      .get(ownerUid) as { last_question: string }).last_question,
    "كم مدة الضمان؟",
  );
});

test("an existing customer can reserve a real technician slot without duplicate booking", async () => {
  seedExistingCustomer();
  const dependencies = {
    now: () => now,
    queueFieldTechSync: () => undefined,
  };

  const menu = await handleWhatsAppCommerceConversation(
    { ownerUid, fromPhone: existingPhone, text: "السلام عليكم" },
    dependencies,
  );
  assert.equal(menu.kind, "commerce_menu");

  const bookingKind = await handleWhatsAppCommerceConversation(
    { ownerUid, fromPhone: existingPhone, text: "2" },
    dependencies,
  );
  assert.equal(bookingKind.kind, "booking_kind");

  const slots = await handleWhatsAppCommerceConversation(
    { ownerUid, fromPhone: existingPhone, text: "1" },
    dependencies,
  );
  assert.equal(slots.kind, "booking_slots");
  assert.match(String(slots.reply), /14:00/);

  const confirmation = await handleWhatsAppCommerceConversation(
    { ownerUid, fromPhone: existingPhone, text: "1" },
    dependencies,
  );
  assert.equal(confirmation.kind, "booking_confirmed");
  assert.ok(confirmation.bookingId);

  const booking = db.prepare(
    `SELECT id, technician_id, date, scheduled_time, status, source
       FROM bookings WHERE owner_uid = ?`,
  ).get(ownerUid) as Record<string, unknown>;
  assert.equal(booking.id, confirmation.bookingId);
  assert.equal(booking.technician_id, "tech-wa-1");
  assert.equal(booking.date, "2026-07-27");
  assert.equal(booking.scheduled_time, "14:00");
  assert.equal(booking.status, "confirmed");
  assert.equal(booking.source, "whatsapp");
  const technicianJob = db.prepare(
    `SELECT recipient_phone, template_name, role, payload
       FROM communication_jobs
      WHERE owner_uid = ? AND event_key = ?`,
  ).get(ownerUid, `booking:${confirmation.bookingId}:technician-assignment:1`) as Record<string, unknown>;
  assert.equal(technicianJob.recipient_phone, "966511111111");
  assert.equal(technicianJob.template_name, "technician_assigned");
  assert.equal(technicianJob.role, "agent");
  assert.match(String(technicianJob.payload), /whatsapp_booking_technician_assignment/);
  const technicianNotification = db.prepare(
    `SELECT status, booking_id, technician_id, customer_phone
       FROM technician_notifications
      WHERE owner_uid = ? AND booking_id = ?`,
  ).get(ownerUid, confirmation.bookingId) as Record<string, unknown>;
  assert.equal(technicianNotification.status, "queued");
  assert.equal(technicianNotification.technician_id, "tech-wa-1");
  assert.equal(technicianNotification.customer_phone, existingPhone);

  const repeatedChoice = await handleWhatsAppCommerceConversation(
    { ownerUid, fromPhone: existingPhone, text: "1" },
    dependencies,
  );
  assert.equal(repeatedChoice.handled, false);
  const count = db.prepare(
    "SELECT COUNT(*) AS count FROM bookings WHERE owner_uid = ?",
  ).get(ownerUid) as { count: number };
  assert.equal(count.count, 1);
});

test("a new WhatsApp customer is created, addressed, and booked against a selected service", async () => {
  const dependencies = {
    now: () => now,
    queueFieldTechSync: () => undefined,
  };

  const nameRequest = await handleWhatsAppCommerceConversation(
    { ownerUid, fromPhone: newPhone, text: "حجز موعد" },
    dependencies,
  );
  assert.equal(nameRequest.kind, "booking_name_required");

  const addressRequest = await handleWhatsAppCommerceConversation(
    { ownerUid, fromPhone: newPhone, text: "عبدالله محمد" },
    dependencies,
  );
  assert.equal(addressRequest.kind, "booking_address_required");

  const products = await handleWhatsAppCommerceConversation(
    { ownerUid, fromPhone: newPhone, text: "الرياض حي الياسمين شارع أنس" },
    dependencies,
  );
  assert.equal(products.kind, "booking_products");

  const slots = await handleWhatsAppCommerceConversation(
    { ownerUid, fromPhone: newPhone, text: "1" },
    dependencies,
  );
  assert.equal(slots.kind, "booking_slots");

  const confirmation = await handleWhatsAppCommerceConversation(
    { ownerUid, fromPhone: newPhone, text: "1" },
    dependencies,
  );
  assert.equal(confirmation.kind, "booking_confirmed");

  const customer = db.prepare(
    "SELECT name, phone, source, customer_address FROM customers WHERE owner_uid = ? AND phone = ?",
  ).get(ownerUid, newPhone) as Record<string, unknown>;
  assert.equal(customer.name, "عبدالله محمد");
  assert.equal(customer.source, "whatsapp");
  assert.match(String(customer.customer_address), /حي الياسمين/);

  const installation = db.prepare(
    "SELECT product_id, status, source FROM installations WHERE owner_uid = ? AND customer_id = (SELECT id FROM customers WHERE phone = ?)",
  ).get(ownerUid, newPhone) as Record<string, unknown>;
  assert.equal(installation.product_id, "product-wa-1");
  assert.equal(installation.status, "pending_installation");
  assert.equal(installation.source, "whatsapp");
});

test("the change-filters campaign button collects details into a high-priority CRM task", async () => {
  seedExistingCustomer();
  const campaignId = seedCampaign();

  const prompt = await handleWhatsAppCommerceConversation(
    {
      ownerUid,
      fromPhone: existingPhone,
      text: `campaign:change_filters:${campaignId}`,
    },
    { now: () => now },
  );
  assert.equal(prompt.kind, "campaign_filter_details_required");

  const submitted = await handleWhatsAppCommerceConversation(
    {
      ownerUid,
      fromPhone: existingPhone,
      text: "أحتاج فلتر 7 مراحل مع ثلاث شمعات إضافية",
    },
    { now: () => now },
  );
  assert.equal(submitted.kind, "campaign_filter_request_created");
  const task = db.prepare(
    `SELECT priority, related_type, related_id, customer_id, notes
       FROM crm_tasks WHERE id = ?`,
  ).get(submitted.reason) as Record<string, unknown>;
  assert.equal(task.priority, "high");
  assert.equal(task.related_type, "whatsapp_campaign");
  assert.equal(task.related_id, campaignId);
  assert.equal(task.customer_id, "customer-wa-1");
  assert.match(String(task.notes), /7 مراحل/);
});

test("the book-appointment campaign button enters the existing self-service booking flow", async () => {
  seedExistingCustomer();
  const campaignId = seedCampaign();
  const result = await handleWhatsAppCommerceConversation(
    {
      ownerUid,
      fromPhone: existingPhone,
      text: `campaign:book_appointment:${campaignId}`,
    },
    { now: () => now },
  );
  assert.equal(result.kind, "booking_kind");
  assert.match(String(result.reply), /ما نوع الموعد/);
});
