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
    "technician_notifications",
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

function seedIssuedInvoice() {
  db.prepare(
    `INSERT INTO invoices (
       id, owner_uid, invoice_number, document_kind, sequence_no, issued_at,
       idempotency_key, customer_name, customer_phone, status, issue_date,
       total_with_vat, currency, items, created_at, updated_at
     ) VALUES (
       'invoice-wa-1', ?, 'INV-WA-001', 'invoice', 1, ?,
       'invoice:wa:1', 'عميل واتساب', ?, 'issued', '2026-07-27',
       230, 'SAR', '[]', ?, ?
     )`,
  ).run(ownerUid, now.toISOString(), existingPhone, now.toISOString(), now.toISOString());
}

test.beforeEach(() => {
  delete process.env.WHATSAPP_COMMERCE_ENABLED;
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
