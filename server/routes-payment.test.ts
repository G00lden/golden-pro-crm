import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import express from "express";

process.env.DATA_PROVIDER = "sqlite";
process.env.DB_PROVIDER = "sqlite";
process.env.DB_PATH = ":memory:";
process.env.ENABLE_DAILY_CRON = "false";
process.env.TAP_SECRET_KEY = "sk_test_payment_route";
delete process.env.TAP_WEBHOOK_SECRET;

const uid = "payment-route-owner";
const db = (await import("./db")).default;
const {
  buildTapChargeHashString,
  formatTapAmount,
  paymentStoreSupported,
  registerPaymentRoutes,
  registerPaymentWebhookRoute,
} = await import("./routes-payment");

const app = express();
app.use(express.json());
registerPaymentWebhookRoute(app);
app.use((req, _res, next) => {
  (req as express.Request & { user: { uid: string } }).user = { uid };
  next();
});
registerPaymentRoutes(app);

const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
  const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("Payment test server did not bind.");
const baseUrl = `http://127.0.0.1:${address.port}`;

test.after(() => new Promise<void>((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve());
}));

async function api(path: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers || {}),
    },
  });
  return { response, body: await response.json() as Record<string, any> };
}

function insertIssuedInvoice(id: string, sequence: number, amount = 115, currency = "SAR") {
  db.prepare(`
    INSERT INTO invoices (
      id, owner_uid, invoice_number, document_kind, sequence_no, issued_at,
      idempotency_key, customer_name, customer_phone, status, issue_date,
      total_with_vat, currency, items, created_at, updated_at
    ) VALUES (?, ?, ?, 'invoice', ?, ?, ?, ?, ?, 'issued', '2026-07-13', ?, ?, '[]', ?, ?)
  `).run(
    id,
    uid,
    `INV-20260713-${String(sequence).padStart(3, "0")}`,
    sequence,
    "2026-07-13T18:00:00.000Z",
    `invoice:${id}`,
    `Customer ${id}`,
    "+966500000000",
    amount,
    currency,
    "2026-07-13T18:00:00.000Z",
    "2026-07-13T18:00:00.000Z",
  );
}

type ChargePayload = Record<string, any>;

function chargePayload(options: {
  id: string;
  paymentId: string;
  status?: string;
  amount?: number;
  currency?: string;
  gateway?: string;
}): ChargePayload {
  return {
    id: options.id,
    status: options.status || "CAPTURED",
    amount: options.amount ?? 115,
    currency: options.currency || "SAR",
    metadata: { payment_id: options.paymentId },
    reference: {
      gateway: options.gateway ?? "",
      payment: `payment-ref-${options.id}`,
    },
    transaction: { created: "1783970000123" },
  };
}

function webhookHash(payload: ChargePayload) {
  return crypto
    .createHmac("sha256", process.env.TAP_SECRET_KEY!)
    .update(buildTapChargeHashString(payload))
    .digest("hex");
}

async function postWebhook(payload: ChargePayload, signature = webhookHash(payload)) {
  return api("/api/payments/webhook", {
    method: "POST",
    headers: { hashstring: signature },
    body: JSON.stringify(payload),
  });
}

test("payment provider support and Tap canonical hash formatting are explicit", async () => {
  assert.equal(paymentStoreSupported("sqlite"), true);
  assert.equal(paymentStoreSupported("supabase"), false);
  assert.equal(paymentStoreSupported("firebase"), false);
  assert.equal(formatTapAmount(1, "SAR"), "1.00");
  assert.equal(formatTapAmount("1", "BHD"), "1.000");
  assert.equal(
    buildTapChargeHashString(chargePayload({
      id: "chg_hash_test",
      paymentId: "pay_hash_test",
      amount: 1,
      currency: "SAR",
      gateway: "",
    })),
    "x_idchg_hash_testx_amount1.00x_currencySARx_gateway_referencex_payment_referencepayment-ref-chg_hash_testx_statusCAPTUREDx_created1783970000123",
  );

  const capabilities = await api("/api/payments/capabilities");
  assert.equal(capabilities.response.status, 200, JSON.stringify(capabilities.body));
  assert.equal(capabilities.body.available, true, "TAP_SECRET_KEY alone configures hashstring verification");
});

test("Tap payments are idempotent, race-safe, monotonic, signed, and redirect-reconciled", async () => {
  insertIssuedInvoice("payment-invoice-a", 1);
  insertIssuedInvoice("payment-invoice-ambiguous", 2);
  insertIssuedInvoice("payment-invoice-race", 3);
  insertIssuedInvoice("payment-invoice-redirect", 4);

  const nativeFetch = globalThis.fetch;
  let postTapCalls = 0;
  let retrieveTapCalls = 0;
  let releaseFirst!: () => void;
  let enteredFirst!: () => void;
  const firstEntered = new Promise<void>((resolve) => { enteredFirst = resolve; });
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let blockFirst = true;
  const tapBodies: Array<Record<string, any>> = [];
  const retrievePayloads = new Map<string, ChargePayload>();
  let mode: "success" | "network-error" | "webhook-before-finalize" = "success";

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("https://api.tap.company/")) return nativeFetch(input, init);
    const method = String(init?.method || "GET").toUpperCase();
    if (method === "GET") {
      retrieveTapCalls += 1;
      const chargeId = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
      const payload = retrievePayloads.get(chargeId);
      return new Response(JSON.stringify(payload || { message: "missing test charge" }), {
        status: payload ? 200 : 404,
        headers: { "content-type": "application/json" },
      });
    }

    postTapCalls += 1;
    const body = JSON.parse(String(init?.body || "{}")) as Record<string, any>;
    tapBodies.push(body);
    if (blockFirst) {
      blockFirst = false;
      enteredFirst();
      await firstGate;
    }
    if (mode === "network-error") throw new TypeError("simulated connection reset");

    const tapChargeId = `chg_test_${postTapCalls}`;
    if (mode === "webhook-before-finalize") {
      const earlyWebhook = await postWebhook(chargePayload({
        id: tapChargeId,
        paymentId: String(body.metadata.payment_id),
        amount: Number(body.amount),
        currency: String(body.currency),
      }));
      assert.equal(earlyWebhook.response.status, 200, JSON.stringify(earlyWebhook.body));
    }
    return new Response(JSON.stringify({
      id: tapChargeId,
      status: "INITIATED",
      transaction: { url: `https://tap.test/pay/${postTapCalls}` },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const key = "payment:invoice-a:stable-key";
    const firstPromise = api("/api/payments/create", {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: JSON.stringify({ invoice_id: "payment-invoice-a" }),
    });
    await firstEntered;
    const duplicateWhileCreating = await api("/api/payments/create", {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: JSON.stringify({ invoice_id: "payment-invoice-a" }),
    });
    assert.equal(duplicateWhileCreating.response.status, 409, JSON.stringify(duplicateWhileCreating.body));
    assert.equal(postTapCalls, 1);

    releaseFirst();
    const first = await firstPromise;
    assert.equal(first.response.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.redirect_url, "https://tap.test/pay/1");
    assert.match(String(tapBodies[0].reference?.idempotent || ""), /^pay_[a-f0-9]{48}$/);
    assert.match(String(tapBodies[0].redirect?.url || ""), new RegExp(`payment_id=${first.body.id}$`));

    const replay = await api("/api/payments/create", {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: JSON.stringify({ invoice_id: "payment-invoice-a" }),
    });
    assert.equal(replay.response.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.id, first.body.id);
    assert.equal(replay.body.idempotent_replay, true);
    assert.equal(postTapCalls, 1, "a pending reservation must not call Tap twice");

    assert.throws(() => db.prepare(`
      INSERT INTO invoices (
        id, owner_uid, invoice_number, document_kind, sequence_no, issued_at,
        source_invoice_id, adjustment_kind, adjustment_scope, adjustment_reason,
        idempotency_key, status, total_with_vat
      ) VALUES (
        'credit-during-payment', ?, 'CN-20260713-005', 'credit_note', 5, ?,
        'payment-invoice-a', 'cancellation', 'full', 'blocked',
        'credit:payment-invoice-a:cancellation', 'issued', 115
      )
    `).run(uid, "2026-07-13T18:05:00.000Z"), /INVOICE_PAYMENT_REQUIRES_PROVIDER_RESOLUTION/);

    const capturedPayload = chargePayload({ id: "chg_test_1", paymentId: first.body.id });
    const webhook = await postWebhook(capturedPayload);
    assert.equal(webhook.response.status, 200, JSON.stringify(webhook.body));
    assert.equal((db.prepare("SELECT status FROM invoices WHERE id = ?").get("payment-invoice-a") as any)?.status, "paid");
    assert.equal((db.prepare("SELECT status FROM payments WHERE id = ?").get(first.body.id) as any)?.status, "completed");

    for (const delayedStatus of ["INITIATED", "FAILED"]) {
      const delayed = await postWebhook({ ...capturedPayload, status: delayedStatus });
      assert.equal(delayed.response.status, 200, JSON.stringify(delayed.body));
      assert.equal(
        (db.prepare("SELECT status FROM payments WHERE id = ?").get(first.body.id) as any)?.status,
        "completed",
        `${delayedStatus} must not downgrade a captured payment`,
      );
    }

    const badSignature = await postWebhook(capturedPayload, "00");
    assert.equal(badSignature.response.status, 403, JSON.stringify(badSignature.body));

    const unknownSigned = await postWebhook(chargePayload({
      id: "chg_unknown_signed",
      paymentId: "pay_unknown_signed",
    }));
    assert.equal(unknownSigned.response.status, 409, "unknown signed webhooks must remain retryable via non-2xx");

    const wrongAmount = await postWebhook({ ...capturedPayload, amount: 116 });
    assert.equal(wrongAmount.response.status, 409, "signed payload still must match the reserved amount");

    mode = "webhook-before-finalize";
    const raced = await api("/api/payments/create", {
      method: "POST",
      headers: { "Idempotency-Key": "payment:race:stable-key" },
      body: JSON.stringify({ invoice_id: "payment-invoice-race" }),
    });
    assert.equal(raced.response.status, 200, JSON.stringify(raced.body));
    assert.equal(raced.body.status, "completed", "slow create finalization must not downgrade the early CAPTURED webhook");
    assert.equal((db.prepare("SELECT status FROM invoices WHERE id = ?").get("payment-invoice-race") as any)?.status, "paid");
    assert.equal((db.prepare("SELECT tap_charge_id FROM payments WHERE id = ?").get(raced.body.id) as any)?.tap_charge_id, raced.body.tap_charge_id);

    mode = "network-error";
    const ambiguous = await api("/api/payments/create", {
      method: "POST",
      headers: { "Idempotency-Key": "payment:ambiguous:first" },
      body: JSON.stringify({ invoice_id: "payment-invoice-ambiguous" }),
    });
    assert.equal(ambiguous.response.status, 502, JSON.stringify(ambiguous.body));
    assert.equal((db.prepare("SELECT status FROM payments WHERE invoice_id = ?").get("payment-invoice-ambiguous") as any)?.status, "creating");

    const originalProviderKey = tapBodies.at(-1)?.reference?.idempotent;
    mode = "success";
    const recovered = await api("/api/payments/create", {
      method: "POST",
      headers: { "Idempotency-Key": "payment:ambiguous:new-client-key" },
      body: JSON.stringify({ invoice_id: "payment-invoice-ambiguous" }),
    });
    assert.equal(recovered.response.status, 200, JSON.stringify(recovered.body));
    assert.equal(tapBodies.at(-1)?.reference?.idempotent, originalProviderKey, "ambiguous retry must reuse Tap idempotency identity");

    const redirectPayment = await api("/api/payments/create", {
      method: "POST",
      headers: { "Idempotency-Key": "payment:redirect:stable-key" },
      body: JSON.stringify({ invoice_id: "payment-invoice-redirect" }),
    });
    assert.equal(redirectPayment.response.status, 200, JSON.stringify(redirectPayment.body));
    const redirectTapId = String(redirectPayment.body.tap_charge_id);
    retrievePayloads.set(redirectTapId, chargePayload({
      id: redirectTapId,
      paymentId: redirectPayment.body.id,
    }));
    db.prepare("UPDATE payments SET tap_charge_id = NULL WHERE id = ?").run(redirectPayment.body.id);

    const reconciled = await api(`/api/payments/${encodeURIComponent(redirectPayment.body.id)}/status?tap_id=${encodeURIComponent(redirectTapId)}`);
    assert.equal(reconciled.response.status, 200, JSON.stringify(reconciled.body));
    assert.equal(reconciled.body.status, "completed");
    assert.equal(reconciled.body.tap_charge_id, redirectTapId, "redirect reconciliation must atomically bind tap_id");
    assert.equal(retrieveTapCalls, 1, "redirect reconciliation must call Retrieve Charge once");
    assert.equal((db.prepare("SELECT status FROM invoices WHERE id = ?").get("payment-invoice-redirect") as any)?.status, "paid");

    const refunded = await postWebhook({ ...capturedPayload, status: "REFUNDED" });
    assert.equal(refunded.response.status, 200, JSON.stringify(refunded.body));
    const lateAfterRefund = await postWebhook({ ...capturedPayload, status: "CAPTURED" });
    assert.equal(lateAfterRefund.response.status, 200, JSON.stringify(lateAfterRefund.body));
    assert.equal(
      (db.prepare("SELECT status FROM payments WHERE id = ?").get(first.body.id) as any)?.status,
      "cancelled",
      "no event may regress a provider-refunded payment",
    );
  } finally {
    globalThis.fetch = nativeFetch;
  }
});
