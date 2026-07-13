import assert from "node:assert/strict";
import test from "node:test";
import express from "express";

process.env.DATA_PROVIDER = "sqlite";
process.env.DB_PROVIDER = "sqlite";
process.env.DB_PATH = ":memory:";
process.env.ENABLE_DAILY_CRON = "false";

const uid = "invoice-legacy-route-owner";
const { adminDb } = await import("./firebaseAdmin");
const { registerCrmApiRoutes } = await import("./crmApi");

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as express.Request & { user: { uid: string } }).user = { uid };
  next();
});
registerCrmApiRoutes(app);
app.use((error: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(error.status || 500).json({ error: error.message });
});

const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
  const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("Invoice legacy test server did not bind to TCP.");
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
  const body = await response.json() as Record<string, any>;
  return { response, body };
}

function decodeTlv(base64: string) {
  const bytes = Buffer.from(base64, "base64");
  const fields = new Map<number, string>();
  for (let offset = 0; offset < bytes.length;) {
    const tag = bytes[offset];
    const length = bytes[offset + 1];
    const start = offset + 2;
    fields.set(tag, bytes.subarray(start, start + length).toString("utf8"));
    offset = start + length;
  }
  return fields;
}

test("malformed legacy line sets preserve historical headers and cannot generate a QR", async () => {
  const fixtures = [
    { id: "invoice-description-only", subtotal: 999, items: [{ description: "Historical service" }] },
    {
      id: "invoice-mixed-lines",
      subtotal: 777,
      items: [
        { description: "Valid line", quantity: 1, unit_price: 100, vat_excluded: true },
        { description: "Incomplete line" },
      ],
    },
    {
      id: "invoice-string-numbers",
      subtotal: 666,
      items: [{ description: "String numbers", quantity: "1", unit_price: "100", vat_excluded: true }],
    },
  ];

  for (const fixture of fixtures) {
    await adminDb.collection("invoices").doc(fixture.id).set({
      createdBy: uid,
      invoice_number: fixture.id,
      customer_name: "Historical customer",
      status: "issued",
      issue_date: "2026-07-10",
      items: fixture.items,
      subtotal: fixture.subtotal,
      discount_mode: "fixed",
      discount_value: 0,
      discount: 0,
      vat_percent: 15,
      vat: fixture.subtotal,
      vat_amount: fixture.subtotal,
      total_without_vat: fixture.subtotal,
      total_with_vat: fixture.subtotal,
      seller_name: "BreeXe Pro Co.",
      seller_vat_number: "313049114100003",
      createdAt: "2026-07-10T08:30:45Z",
    });

    const fetched = await api(`/api/invoices/${fixture.id}`);
    assert.equal(fetched.response.status, 200, JSON.stringify(fetched.body));
    assert.equal(fetched.body.financials_verifiable, false);
    assert.equal(fetched.body.subtotal, fixture.subtotal);
    assert.equal(fetched.body.vat_amount, fixture.subtotal);
    assert.equal(fetched.body.total_without_vat, fixture.subtotal);
    assert.equal(fetched.body.total_with_vat, fixture.subtotal);

    const qr = await api(`/api/invoices/${fixture.id}/qr`);
    assert.equal(qr.response.status, 422, JSON.stringify(qr.body));
    assert.match(String(qr.body.error), /للتحقق المالي|التحقق المالي/);
  }
});

test("a positive-quantity zero-price line remains verifiable", async () => {
  const created = await api("/api/invoices", {
    method: "POST",
    body: JSON.stringify({
      customer_name: "Warranty customer",
      issue_date: "2026-07-10",
      vat_percent: 15,
      items: [{ description: "Free warranty service", quantity: 1, unit_price: 0, vat_excluded: true }],
      seller_name: "BreeXe Pro Co.",
      seller_vat_number: "313049114100003",
    }),
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.invoice.financials_verifiable, true);
  assert.equal(created.body.invoice.total_with_vat, 0);

  const qr = await api(`/api/invoices/${created.body.id}/qr`);
  assert.equal(qr.response.status, 200, JSON.stringify(qr.body));
  const fields = decodeTlv(qr.body.qr_base64);
  assert.equal(fields.get(4), "0.00");
  assert.equal(fields.get(5), "0.00");
});

test("quote conversion rejects line values that were only made numeric by a tolerant adapter", async () => {
  const quoteId = "quote-string-numbers";
  await adminDb.collection("quotes").doc(quoteId).set({
    createdBy: uid,
    quote_number: "QT-STRING-NUMBERS",
    customer_name: "Historical quote customer",
    status: "confirmed",
    issue_date: "2026-07-10",
    items: [{ description: "Historical line", quantity: "1", unit_price: "100", vat_excluded: true }],
    discount_mode: "fixed",
    discount_value: 0,
    vat_percent: 15,
    tax: 0,
  });

  const converted = await api(`/api/quotes/${quoteId}/convert-to-invoice`, {
    method: "POST",
    body: JSON.stringify({
      seller_name: "BreeXe Pro Co.",
      seller_vat_number: "313049114100003",
    }),
  });
  assert.equal(converted.response.status, 400, JSON.stringify(converted.body));
  assert.match(String(converted.body.error), /صحّح الوصف والكمية والسعر/);
});
