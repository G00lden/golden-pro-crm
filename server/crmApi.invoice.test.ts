import assert from "node:assert/strict";
import test from "node:test";
import express from "express";

process.env.DATA_PROVIDER = "sqlite";
process.env.DB_PROVIDER = "sqlite";
process.env.DB_PATH = ":memory:";
process.env.ENABLE_DAILY_CRON = "false";

const uid = "invoice-route-owner";
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
if (!address || typeof address === "string") throw new Error("Invoice test server did not bind to TCP.");
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

function invoiceBody(name: string, status: "draft" | "issued" = "issued") {
  return {
    customer_name: name,
    status,
    issue_date: "2026-07-13",
    vat_percent: 15,
    items: [{ description: "Lifecycle line", quantity: 1, unit_price: 100, total: 100, vat_excluded: true }],
    seller_name: "BreeXe Pro Co.",
    seller_vat_number: "313049114100003",
  };
}

test("invoice create/update routes keep header totals and QR fields on one canonical calculation", async () => {
  const created = await api("/api/invoices", {
    method: "POST",
    body: JSON.stringify({
      customer_name: "Route customer",
      status: "draft",
      issue_date: "2026-07-10",
      discount_mode: "fixed",
      discount_value: 10,
      vat_percent: 15,
      additional_fee: 5,
      items: [{
        description: "Exclusive item",
        quantity: 2,
        unit_price: 50,
        total: 9999,
        vat_excluded: true,
      }],
      seller_name: "BreeXe Pro Co.",
      seller_vat_number: "313049114100003",
    }),
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  const invoiceId = String(created.body.id);
  assert.equal(created.body.invoice.subtotal, 100);
  assert.equal(created.body.invoice.discount, 10);
  assert.equal(created.body.invoice.total_without_vat, 90);
  assert.equal(created.body.invoice.vat_amount, 13.5);
  assert.equal(created.body.invoice.additional_fee, 5);
  assert.equal(created.body.invoice.total_with_vat, 108.5);
  assert.equal(created.body.invoice.items[0].total, 100, "client-supplied item.total must not override quantity x unit price");
  assert.equal(created.body.invoice.status, "draft");
  assert.equal(created.body.invoice.sequence_no, null);

  const createdQr = await api(`/api/invoices/${invoiceId}/qr`);
  assert.equal(createdQr.response.status, 409, JSON.stringify(createdQr.body));

  const updated = await api(`/api/invoices/${invoiceId}`, {
    method: "PUT",
    body: JSON.stringify({
      customer_name: "Route customer",
      issue_date: "2026-07-11",
      discount_mode: "percent",
      discount_value: 10,
      vat_percent: 15,
      additional_fee: 7,
      items: [{
        description: "VAT-inclusive item",
        quantity: 1,
        unit_price: 115,
        total: 1,
        vat_excluded: false,
      }],
      seller_name: "BreeXe Pro Co.",
      seller_vat_number: "313049114100003",
    }),
  });
  assert.equal(updated.response.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.invoice.subtotal, 100);
  assert.equal(updated.body.invoice.discount, 10);
  assert.equal(updated.body.invoice.discount_value, 10);
  assert.equal(updated.body.invoice.total_without_vat, 90);
  assert.equal(updated.body.invoice.vat_amount, 13.5);
  assert.equal(updated.body.invoice.additional_fee, 7);
  assert.equal(updated.body.invoice.total_with_vat, 110.5);

  const issued = await api(`/api/invoices/${invoiceId}/status`, {
    method: "POST",
    body: JSON.stringify({ status: "issued" }),
  });
  assert.equal(issued.response.status, 200, JSON.stringify(issued.body));
  assert.equal(issued.body.invoice.status, "issued");
  assert.equal(Number.isSafeInteger(issued.body.invoice.sequence_no), true);
  assert.match(String(issued.body.invoice.invoice_number), /^INV-\d{8}-\d+$/);

  const updatedQr = await api(`/api/invoices/${invoiceId}/qr`);
  assert.equal(updatedQr.response.status, 200, JSON.stringify(updatedQr.body));
  const updatedFields = decodeTlv(updatedQr.body.qr_base64);
  assert.match(updatedFields.get(3) || "", /^2026-07-11T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(updatedFields.get(4), "110.50");
  assert.equal(updatedFields.get(5), "13.50");
});

test("legacy percent discount_value=0 stays zero instead of reusing a stale monetary discount", async () => {
  const id = "invoice-percent-zero";
  await adminDb.collection("invoices").doc(id).set({
    createdBy: uid,
    invoice_number: "INV-PERCENT-ZERO",
    customer_name: "Percent zero customer",
    status: "issued",
    issue_date: "2026-07-09",
    items: [{ description: "No discount", quantity: 2, unit_price: 100, total: 200, vat_excluded: true }],
    subtotal: 200,
    discount_mode: "percent",
    discount_value: 0,
    discount: 25,
    vat_percent: 15,
    vat_amount: 25,
    total_without_vat: 175,
    total_with_vat: 200,
    seller_name: "BreeXe Pro Co.",
    seller_vat_number: "313049114100003",
    createdAt: "2026-07-09T08:30:45Z",
  });

  const result = await api(`/api/invoices/${id}`);
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.discount_mode, "percent");
  assert.equal(result.body.discount_value, 0);
  assert.equal(result.body.discount, 0);
  assert.equal(result.body.vat_amount, 30);
  assert.equal(result.body.total_with_vat, 230);

  const qr = await api(`/api/invoices/${id}/qr`);
  assert.equal(qr.response.status, 200, JSON.stringify(qr.body));
  const fields = decodeTlv(qr.body.qr_base64);
  assert.equal(fields.get(3), "2026-07-09T08:30:45Z");
  assert.equal(fields.get(4), "230.00");
  assert.equal(fields.get(5), "30.00");
});

test("quote conversion persists the quote tax as an additional post-VAT fee", async () => {
  const quoteId = "quote-route-convert";
  await adminDb.collection("quotes").doc(quoteId).set({
    createdBy: uid,
    quote_number: "QT-ROUTE-CONVERT",
    customer_name: "Quote customer",
    customer_vat: "",
    title: "Converted quote",
    status: "confirmed",
    issue_date: "2026-07-08",
    items: [{ description: "Quoted line", quantity: 1, unit_price: 200, total: 200, vat_excluded: true }],
    subtotal: 200,
    discount_mode: "fixed",
    discount_value: 20,
    discount: 20,
    vat_percent: 15,
    vat_amount: 27,
    total_without_vat: 180,
    tax: 8,
    total: 215,
    currency: "SAR",
  });

  const converted = await api(`/api/quotes/${quoteId}/convert-to-invoice`, {
    method: "POST",
    body: JSON.stringify({
      seller_name: "BreeXe Pro Co.",
      seller_vat_number: "313049114100003",
    }),
  });
  assert.equal(converted.response.status, 201, JSON.stringify(converted.body));
  assert.equal(converted.body.invoice.quote_id, quoteId);
  assert.equal(converted.body.invoice.subtotal, 200);
  assert.equal(converted.body.invoice.discount, 20);
  assert.equal(converted.body.invoice.vat_amount, 27);
  assert.equal(converted.body.invoice.additional_fee, 8);
  assert.equal(converted.body.invoice.total_with_vat, 215);

  const qr = await api(`/api/invoices/${converted.body.id}/qr`);
  assert.equal(qr.response.status, 200, JSON.stringify(qr.body));
  const fields = decodeTlv(qr.body.qr_base64);
  assert.equal(fields.get(4), "215.00");
  assert.equal(fields.get(5), "27.00");
});

test("invoice save and QR routes fail closed with clear validation errors", async () => {
  const oversizedSeller = await api("/api/invoices", {
    method: "POST",
    body: JSON.stringify({
      customer_name: "Invalid seller customer",
      issue_date: "2026-07-10",
      items: [{ description: "Line", quantity: 1, unit_price: 100, total: 100, vat_excluded: true }],
      seller_name: "س".repeat(128),
      seller_vat_number: "313049114100003",
    }),
  });
  assert.equal(oversizedSeller.response.status, 400, JSON.stringify(oversizedSeller.body));
  assert.match(JSON.stringify(oversizedSeller.body), /255 UTF-8 bytes/);

  const invalidId = "invoice-invalid-qr";
  await adminDb.collection("invoices").doc(invalidId).set({
    createdBy: uid,
    invoice_number: "INV-INVALID-QR",
    customer_name: "Invalid QR customer",
    status: "issued",
    issue_date: "2026-02-30",
    items: [{ description: "Line", quantity: 1, unit_price: 100, total: 100, vat_excluded: true }],
    discount_mode: "fixed",
    discount_value: 0,
    discount: 0,
    vat_percent: 15,
    additional_fee: 0,
    seller_name: "BreeXe Pro Co.",
    seller_vat_number: "123",
    createdAt: "2026-07-09T08:30:45Z",
  });
  const invalidQr = await api(`/api/invoices/${invalidId}/qr`);
  assert.equal(invalidQr.response.status, 422, JSON.stringify(invalidQr.body));
  assert.match(String(invalidQr.body.error), /تعذر إنشاء رمز QR للفاتورة/);
  assert.match(String(invalidQr.body.error), /تاريخ إصدار الفاتورة/);

  const emptyId = "invoice-empty-qr";
  await adminDb.collection("invoices").doc(emptyId).set({
    createdBy: uid,
    invoice_number: "INV-EMPTY-QR",
    customer_name: "Empty invoice customer",
    status: "issued",
    issue_date: "2026-07-10",
    items: [],
    total_with_vat: 115,
    vat_amount: 15,
    seller_name: "BreeXe Pro Co.",
    seller_vat_number: "313049114100003",
  });
  const emptyQr = await api(`/api/invoices/${emptyId}/qr`);
  assert.equal(emptyQr.response.status, 422, JSON.stringify(emptyQr.body));
  assert.match(String(emptyQr.body.error), /بند واحد على الأقل/);
});

test("issued invoices are immutable and draft deletion never consumes or reuses a tax number", async () => {
  const first = await api("/api/invoices", {
    method: "POST",
    headers: { "Idempotency-Key": "lifecycle-issued-first" },
    body: JSON.stringify(invoiceBody("Immutable invoice")),
  });
  assert.equal(first.response.status, 201, JSON.stringify(first.body));
  const firstSequence = Number(first.body.invoice.sequence_no);

  const editIssued = await api(`/api/invoices/${first.body.id}`, {
    method: "PUT",
    body: JSON.stringify({ ...invoiceBody("Tampered invoice"), status: "draft" }),
  });
  assert.equal(editIssued.response.status, 409, JSON.stringify(editIssued.body));

  const deleteIssued = await api(`/api/invoices/${first.body.id}`, { method: "DELETE" });
  assert.equal(deleteIssued.response.status, 409, JSON.stringify(deleteIssued.body));
  await assert.rejects(
    () => adminDb.collection("invoices").doc(first.body.id).update({ total_with_vat: 1 }),
    /ISSUED_INVOICE_IMMUTABLE/,
  );
  await assert.rejects(
    () => adminDb.collection("invoices").doc(first.body.id).delete(),
    /ISSUED_INVOICE_DELETE_FORBIDDEN/,
  );

  const draft = await api("/api/invoices", {
    method: "POST",
    headers: { "Idempotency-Key": "lifecycle-disposable-draft" },
    body: JSON.stringify(invoiceBody("Disposable draft", "draft")),
  });
  assert.equal(draft.response.status, 201, JSON.stringify(draft.body));
  assert.equal(draft.body.invoice.sequence_no, null);
  assert.match(String(draft.body.invoice.invoice_number), /^DRAFT-/);
  const deleteDraft = await api(`/api/invoices/${draft.body.id}`, { method: "DELETE" });
  assert.equal(deleteDraft.response.status, 200, JSON.stringify(deleteDraft.body));

  const second = await api("/api/invoices", {
    method: "POST",
    headers: { "Idempotency-Key": "lifecycle-issued-second" },
    body: JSON.stringify(invoiceBody("Second issued invoice")),
  });
  assert.equal(second.response.status, 201, JSON.stringify(second.body));
  assert.ok(Number(second.body.invoice.sequence_no) > firstSequence);
  assert.notEqual(second.body.invoice.invoice_number, first.body.invoice.invoice_number);
});

test("cancellation creates one linked full credit note and leaves the original stored row unchanged", async () => {
  const created = await api("/api/invoices", {
    method: "POST",
    headers: { "Idempotency-Key": "credit-note-source-invoice" },
    body: JSON.stringify(invoiceBody("Credit source")),
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  const sourceId = String(created.body.id);
  const before = await adminDb.collection("invoices").doc(sourceId).get();
  const beforeData = before.data();

  const cancelled = await api(`/api/invoices/${sourceId}/status`, {
    method: "POST",
    body: JSON.stringify({ status: "cancelled", reason: "Customer cancelled the full order" }),
  });
  assert.equal(cancelled.response.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.invoice.status, "cancelled");
  assert.equal(cancelled.body.credit_note.document_kind, "credit_note");
  assert.equal(cancelled.body.credit_note.source_invoice_id, sourceId);
  assert.equal(cancelled.body.credit_note.adjustment_kind, "cancellation");
  assert.equal(cancelled.body.credit_note.adjustment_scope, "full");
  assert.equal(cancelled.body.credit_note.total_with_vat, created.body.invoice.total_with_vat);
  assert.match(String(cancelled.body.credit_note.invoice_number), /^CN-\d{8}-\d+$/);

  const after = await adminDb.collection("invoices").doc(sourceId).get();
  assert.deepEqual(after.data(), beforeData, "credit creation must not rewrite the source row");

  const replay = await api(`/api/invoices/${sourceId}/status`, {
    method: "POST",
    body: JSON.stringify({ status: "cancelled", reason: "Repeated request" }),
  });
  assert.equal(replay.response.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.credit_note.id, cancelled.body.credit_note.id);

  const source = await api(`/api/invoices/${sourceId}`);
  assert.equal(source.response.status, 200, JSON.stringify(source.body));
  assert.equal(source.body.status, "cancelled", "status is derived from the linked credit note");

  const editCredit = await api(`/api/invoices/${cancelled.body.credit_note.id}`, {
    method: "PUT",
    body: JSON.stringify(invoiceBody("Changed credit")),
  });
  assert.equal(editCredit.response.status, 409, JSON.stringify(editCredit.body));
  const deleteCredit = await api(`/api/invoices/${cancelled.body.credit_note.id}`, { method: "DELETE" });
  assert.equal(deleteCredit.response.status, 409, JSON.stringify(deleteCredit.body));
});

test("idempotency and concurrent issuance return stable unique ledger identities", async () => {
  const sharedKey = "invoice-create-retry-stable-key";
  const retries = await Promise.all([
    api("/api/invoices", {
      method: "POST",
      headers: { "Idempotency-Key": sharedKey },
      body: JSON.stringify(invoiceBody("Retry-safe invoice")),
    }),
    api("/api/invoices", {
      method: "POST",
      headers: { "Idempotency-Key": sharedKey },
      body: JSON.stringify(invoiceBody("Retry-safe invoice")),
    }),
  ]);
  assert.ok(retries.every(({ response }) => response.status === 200 || response.status === 201));
  assert.equal(retries[0].body.id, retries[1].body.id);
  assert.equal(retries[0].body.invoice.invoice_number, retries[1].body.invoice.invoice_number);

  const batch = await Promise.all(Array.from({ length: 12 }, (_, index) => api("/api/invoices", {
    method: "POST",
    headers: { "Idempotency-Key": `concurrent-invoice-${index}-key` },
    body: JSON.stringify(invoiceBody(`Concurrent invoice ${index}`)),
  })));
  assert.ok(batch.every(({ response }) => response.status === 201), JSON.stringify(batch.map(({ body }) => body)));
  const sequences = batch.map(({ body }) => Number(body.invoice.sequence_no));
  const numbers = batch.map(({ body }) => String(body.invoice.invoice_number));
  assert.equal(new Set(sequences).size, sequences.length);
  assert.equal(new Set(numbers).size, numbers.length);
});

test("payment status and cancellation serialize so exactly one financial outcome wins", async () => {
  const created = await api("/api/invoices", {
    method: "POST",
    headers: { "Idempotency-Key": "status-credit-race-source" },
    body: JSON.stringify(invoiceBody("Status-credit race")),
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  const id = String(created.body.id);

  const [paid, cancelled] = await Promise.all([
    api(`/api/invoices/${id}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "paid" }),
    }),
    api(`/api/invoices/${id}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "cancelled", reason: "Concurrent cancellation request" }),
    }),
  ]);

  assert.deepEqual(
    [paid.response.status, cancelled.response.status].sort((left, right) => left - right),
    [200, 409],
    JSON.stringify({ paid: paid.body, cancelled: cancelled.body }),
  );
  const final = await api(`/api/invoices/${id}`);
  assert.equal(final.response.status, 200, JSON.stringify(final.body));
  if (paid.response.status === 200) {
    assert.equal(final.body.status, "paid");
  } else {
    assert.equal(final.body.status, "cancelled");
    assert.equal(cancelled.body.credit_note.source_invoice_id, id);
  }
});

test("a full refund blocks every later operational status replay", async () => {
  const created = await api("/api/invoices", {
    method: "POST",
    headers: { "Idempotency-Key": "refund-blocks-status-source" },
    body: JSON.stringify(invoiceBody("Refund source")),
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  const id = String(created.body.id);

  const paid = await api(`/api/invoices/${id}/status`, {
    method: "POST",
    body: JSON.stringify({ status: "paid" }),
  });
  assert.equal(paid.response.status, 200, JSON.stringify(paid.body));
  const refunded = await api(`/api/invoices/${id}/status`, {
    method: "POST",
    body: JSON.stringify({ status: "refunded", reason: "Full customer refund" }),
  });
  assert.equal(refunded.response.status, 200, JSON.stringify(refunded.body));
  assert.equal(refunded.body.invoice.status, "refunded");

  const replayPaid = await api(`/api/invoices/${id}/status`, {
    method: "POST",
    body: JSON.stringify({ status: "paid" }),
  });
  assert.equal(replayPaid.response.status, 409, JSON.stringify(replayPaid.body));
  const final = await api(`/api/invoices/${id}`);
  assert.equal(final.body.status, "refunded");
});
