import assert from "node:assert/strict";
import test from "node:test";
import express from "express";

process.env.DATA_PROVIDER = "sqlite";
process.env.DB_PROVIDER = "sqlite";
process.env.DB_PATH = ":memory:";
process.env.ENABLE_DAILY_CRON = "false";

const db = (await import("./db")).default;
const {
  invoicePaymentOverview,
  invoiceOutstandingAmount,
  registerInvoicePaymentRoutes,
  reverseInvoiceCollection,
  syncCancelledTapPayment,
  syncCompletedTapPayment,
} = await import("./invoicePaymentLedger");

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const ownerUid = String(req.get("x-test-owner") || "payment-ledger-owner");
  (req as express.Request & { user: { uid: string } }).user = { uid: ownerUid };
  next();
});
registerInvoicePaymentRoutes(app);

const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
  const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("Payment ledger test server did not bind.");
const baseUrl = `http://127.0.0.1:${address.port}`;
let invoiceSequence = 100;

test.after(() => new Promise<void>((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve());
}));

function insertInvoice(ownerUid: string, id: string, amount: number, status = "issued") {
  invoiceSequence += 1;
  db.prepare(`
    INSERT INTO invoices (
      id, owner_uid, invoice_number, document_kind, sequence_no, issued_at,
      customer_name, customer_phone, status, issue_date, paid_at,
      total_with_vat, currency, items, created_at, updated_at
    ) VALUES (?, ?, ?, 'invoice', ?, ?, ?, '0500000000', ?, '2026-07-29', NULL, ?, 'SAR', '[]', ?, ?)
  `).run(
    id,
    ownerUid,
    `INV-${id}`,
    invoiceSequence,
    "2026-07-29T00:00:00.000Z",
    `Customer ${id}`,
    status,
    amount,
    "2026-07-29T00:00:00.000Z",
    "2026-07-29T00:00:00.000Z",
  );
}

async function api(
  ownerUid: string,
  path: string,
  init: RequestInit & { idempotencyKey?: string } = {},
) {
  const { idempotencyKey, ...requestInit } = init;
  const response = await fetch(`${baseUrl}${path}`, {
    ...requestInit,
    headers: {
      "x-test-owner": ownerUid,
      ...(requestInit.body ? { "content-type": "application/json" } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      ...(requestInit.headers || {}),
    },
  });
  return {
    response,
    body: await response.json() as Record<string, any>,
  };
}

test("cash collections from separate invoices accumulate in one wallet balance", async () => {
  const owner = "cash-wallet-owner";
  insertInvoice(owner, "cash-85", 85);
  insertInvoice(owner, "cash-100", 100);

  const first = await api(owner, "/api/invoices/cash-85/payments", {
    method: "POST",
    idempotencyKey: "cash-wallet-85",
    body: JSON.stringify({ amount: 85, method: "cash", reference: "R-85" }),
  });
  const second = await api(owner, "/api/invoices/cash-100/payments", {
    method: "POST",
    idempotencyKey: "cash-wallet-100",
    body: JSON.stringify({ amount: 100, method: "cash", reference: "R-100" }),
  });

  assert.equal(first.response.status, 201);
  assert.equal(second.response.status, 201);
  assert.equal(first.body.invoice.status, "paid");
  assert.equal(second.body.invoice.status, "paid");

  const overview = await api(owner, "/api/invoice-payments");
  assert.equal(overview.response.status, 200);
  assert.equal(overview.body.summary.balance, 185);
  assert.equal(overview.body.summary.by_method.cash, 185);
  assert.equal(overview.body.summary.transaction_count, 2);
  assert.equal(overview.body.invoice_totals["cash-85"].outstanding, 0);
  assert.equal(overview.body.invoice_totals["cash-100"].collected, 100);
});

test("partial collections retain the outstanding amount and reject overpayment", async () => {
  const owner = "partial-wallet-owner";
  insertInvoice(owner, "partial-100", 100);
  const first = await api(owner, "/api/invoices/partial-100/payments", {
    method: "POST",
    idempotencyKey: "partial-wallet-40",
    body: JSON.stringify({ amount: 40, method: "bank_transfer" }),
  });
  assert.equal(first.response.status, 201);
  assert.equal(first.body.invoice.status, "issued");
  assert.equal(first.body.invoice.collected, 40);
  assert.equal(first.body.invoice.outstanding, 60);
  assert.equal(invoiceOutstandingAmount(owner, "partial-100"), 60);

  const overpayment = await api(owner, "/api/invoices/partial-100/payments", {
    method: "POST",
    idempotencyKey: "partial-wallet-over",
    body: JSON.stringify({ amount: 60.01, method: "cash" }),
  });
  assert.equal(overpayment.response.status, 409);
  assert.match(String(overpayment.body.error), /المتبقي/);

  const final = await api(owner, "/api/invoices/partial-100/payments", {
    method: "POST",
    idempotencyKey: "partial-wallet-60",
    body: JSON.stringify({ amount: 60, method: "card" }),
  });
  assert.equal(final.response.status, 201);
  assert.equal(final.body.invoice.status, "paid");
  assert.equal(final.body.invoice.outstanding, 0);
});

test("manual collection waits while a Tap payment is creating or pending", async () => {
  const owner = "tap-inflight-wallet-owner";
  insertInvoice(owner, "tap-inflight-100", 100);
  db.prepare(`
    INSERT INTO payments (
      id, owner_uid, invoice_id, idempotency_key, amount, currency, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'SAR', 'pending', ?, ?)
  `).run(
    "pay_tap_inflight_wallet",
    owner,
    "tap-inflight-100",
    "tap-inflight-key",
    100,
    "2026-07-29T10:00:00.000Z",
    "2026-07-29T10:00:00.000Z",
  );

  const blocked = await api(owner, "/api/invoices/tap-inflight-100/payments", {
    method: "POST",
    idempotencyKey: "tap-inflight-manual",
    body: JSON.stringify({ amount: 10, method: "cash" }),
  });
  assert.equal(blocked.response.status, 409);
  assert.match(String(blocked.body.error), /Tap قيد المعالجة/);
  assert.equal(invoicePaymentOverview(owner).summary.balance, 0);
});

test("collection idempotency is stable and cannot be reused for another payload", async () => {
  const owner = "idempotent-wallet-owner";
  insertInvoice(owner, "idempotent-100", 100);
  const request = {
    method: "POST",
    idempotencyKey: "invoice-payment-stable-key",
    body: JSON.stringify({ amount: 30, method: "cash" }),
  };
  const first = await api(owner, "/api/invoices/idempotent-100/payments", request);
  const replay = await api(owner, "/api/invoices/idempotent-100/payments", request);
  const conflict = await api(owner, "/api/invoices/idempotent-100/payments", {
    ...request,
    body: JSON.stringify({ amount: 31, method: "cash" }),
  });
  assert.equal(first.response.status, 201);
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.idempotent_replay, true);
  assert.equal(replay.body.entry.id, first.body.entry.id);
  assert.equal(conflict.response.status, 409);
  assert.equal(invoicePaymentOverview(owner).summary.balance, 30);
});

test("invoice ownership scopes both collection writes and wallet visibility", async () => {
  const owner = "isolated-wallet-owner";
  const other = "isolated-wallet-other";
  insertInvoice(owner, "isolated-85", 85);
  const denied = await api(other, "/api/invoices/isolated-85/payments", {
    method: "POST",
    idempotencyKey: "isolated-wallet-denied",
    body: JSON.stringify({ amount: 85, method: "cash" }),
  });
  assert.equal(denied.response.status, 404);
  assert.equal(invoicePaymentOverview(other).summary.balance, 0);
  assert.equal(invoicePaymentOverview(owner).summary.balance, 0);
});

test("reversal is append-only, reopens a paid invoice, and cannot run twice", async () => {
  const owner = "reversal-wallet-owner";
  insertInvoice(owner, "reversal-85", 85);
  const collection = await api(owner, "/api/invoices/reversal-85/payments", {
    method: "POST",
    idempotencyKey: "reversal-wallet-collection",
    body: JSON.stringify({ amount: 85, method: "cash" }),
  });
  const entryId = String(collection.body.entry.id);
  const reversed = await api(owner, `/api/invoice-payments/${entryId}/reverse`, {
    method: "POST",
    idempotencyKey: "reversal-wallet-action",
    body: JSON.stringify({ reason: "تصحيح تسجيل تجريبي" }),
  });
  assert.equal(reversed.response.status, 200);
  assert.equal(reversed.body.invoice.status, "issued");
  assert.equal(reversed.body.invoice.collected, 0);
  assert.equal(invoicePaymentOverview(owner).summary.balance, 0);
  assert.equal(invoicePaymentOverview(owner).data.length, 2);
  assert.equal(invoicePaymentOverview(owner).data[0].signed_amount, -85);

  const replay = await api(owner, `/api/invoice-payments/${entryId}/reverse`, {
    method: "POST",
    idempotencyKey: "reversal-wallet-action",
    body: JSON.stringify({ reason: "تصحيح تسجيل تجريبي" }),
  });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.idempotent_replay, true);

  const duplicate = await api(owner, `/api/invoice-payments/${entryId}/reverse`, {
    method: "POST",
    idempotencyKey: "reversal-wallet-action-2",
    body: JSON.stringify({ reason: "محاولة عكس ثانية" }),
  });
  assert.equal(duplicate.response.status, 409);
});

test("completed Tap payments appear once and cannot be manually reversed", () => {
  const owner = "tap-wallet-owner";
  insertInvoice(owner, "tap-115", 115);
  const payment = {
    id: "pay_tap_wallet_1",
    owner_uid: owner,
    invoice_id: "tap-115",
    amount: 115,
    currency: "SAR",
    tap_charge_id: "chg_wallet_1",
    status: "completed",
    created_at: "2026-07-29T10:00:00.000Z",
    updated_at: "2026-07-29T10:01:00.000Z",
  };
  assert.equal(syncCompletedTapPayment(payment), true);
  assert.equal(syncCompletedTapPayment(payment), false);
  const overview = invoicePaymentOverview(owner);
  assert.equal(overview.summary.balance, 115);
  assert.equal(overview.summary.by_method.tap, 115);
  assert.equal(overview.data.length, 1);
  assert.equal(overview.data[0].reversible, false);
  assert.throws(
    () => reverseInvoiceCollection({
      ownerUid: owner,
      entryId: overview.data[0].id,
      reason: "لا يسمح يدوياً",
      idempotencyKey: "tap-wallet-reversal",
      recordedBy: owner,
    }),
    /Tap/,
  );
});

test("a refunded Tap payment appends one provider reversal and reopens the invoice", () => {
  const owner = "tap-refund-wallet-owner";
  insertInvoice(owner, "tap-refund-115", 115);
  const completed = {
    id: "pay_tap_refund_wallet_1",
    owner_uid: owner,
    invoice_id: "tap-refund-115",
    amount: 115,
    currency: "SAR",
    tap_charge_id: "chg_refund_wallet_1",
    status: "completed",
    created_at: "2026-07-29T11:00:00.000Z",
    updated_at: "2026-07-29T11:01:00.000Z",
  };
  assert.equal(syncCompletedTapPayment(completed), true);
  db.prepare(`
    UPDATE invoices
    SET status = 'paid', paid_at = ?, updated_at = ?
    WHERE owner_uid = ? AND id = ?
  `).run(completed.updated_at, completed.updated_at, owner, completed.invoice_id);

  const cancelled = {
    ...completed,
    status: "cancelled",
    updated_at: "2026-07-29T12:00:00.000Z",
  };
  assert.equal(syncCancelledTapPayment(cancelled), true);
  assert.equal(syncCancelledTapPayment(cancelled), false);

  const overview = invoicePaymentOverview(owner);
  assert.equal(overview.summary.balance, 0);
  assert.equal(overview.summary.by_method.tap, 0);
  assert.equal(overview.data.length, 2);
  assert.equal(overview.data[0].entry_type, "reversal");
  assert.equal(overview.data[0].source, "tap");
  assert.equal(overview.data[0].signed_amount, -115);
  assert.equal(
    (db.prepare("SELECT status FROM invoices WHERE owner_uid = ? AND id = ?").get(
      owner,
      completed.invoice_id,
    ) as { status: string }).status,
    "issued",
  );
});

test("a collected amount blocks a credit note until the manual collection is reversed", async () => {
  const owner = "credit-guard-owner";
  insertInvoice(owner, "credit-guard-100", 100);
  const collection = await api(owner, "/api/invoices/credit-guard-100/payments", {
    method: "POST",
    idempotencyKey: "credit-guard-payment",
    body: JSON.stringify({ amount: 25, method: "cash" }),
  });
  assert.equal(collection.response.status, 201);
  const insertCredit = () => db.prepare(`
    INSERT INTO invoices (
      id, owner_uid, invoice_number, document_kind, sequence_no, issued_at,
      source_invoice_id, adjustment_kind, adjustment_scope, adjustment_reason,
      customer_name, status, issue_date, total_with_vat, currency, items
    ) VALUES (
      'credit-guard-note', ?, 'CN-CREDIT-GUARD', 'credit_note', 2, ?,
      'credit-guard-100', 'cancellation', 'full', 'اختبار',
      'Customer', 'issued', '2026-07-29', 100, 'SAR', '[]'
    )
  `).run(owner, "2026-07-29T12:00:00.000Z");
  assert.throws(insertCredit, /INVOICE_PAYMENT_REQUIRES_PROVIDER_RESOLUTION/);

  const reversed = await api(owner, `/api/invoice-payments/${collection.body.entry.id}/reverse`, {
    method: "POST",
    idempotencyKey: "credit-guard-reversal",
    body: JSON.stringify({ reason: "إلغاء التحصيل قبل التصحيح" }),
  });
  assert.equal(reversed.response.status, 200);
  assert.doesNotThrow(insertCredit);
});
