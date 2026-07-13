import type { Express, Request, Response } from "express";
import crypto from "crypto";
import { randomUUID } from "crypto";
import db from "./db";
import type { AuthedRequest } from "./auth";
import { logError, logEvent } from "./logger";

// ── Types ─────────────────────────────────────────────────

interface PaymentRow {
  id: string;
  invoice_id: string;
  owner_uid: string;
  idempotency_key: string | null;
  lease_token: string | null;
  reservation_expires_at: string | null;
  tap_charge_id: string | null;
  amount: number;
  currency: string;
  status: "creating" | "pending" | "completed" | "failed" | "cancelled";
  redirect_url: string | null;
  tap_response: string | null;
  webhook_data: string | null;
  created_at: string;
  updated_at: string;
}

interface InvoiceRow {
  id: string;
  owner_uid: string;
  invoice_number: string;
  customer_name: string;
  customer_phone: string;
  total_with_vat: number;
  currency: string;
  status: string;
  paid_at: string | null;
  document_kind: "invoice" | "credit_note";
  issued_at: string | null;
  has_full_credit: number;
}

type PaymentStatus = PaymentRow["status"];

// ── Config ─────────────────────────────────────────────────

const TAP_SECRET_KEY = process.env.TAP_SECRET_KEY || "";
const TAP_BASE_URL = process.env.TAP_BASE_URL || "https://api.tap.company/v2";
const APP_URL = process.env.APP_URL || "http://localhost:3000";
const PAYMENT_RESERVATION_LEASE_MS = 30_000;

export function paymentStoreSupported(provider = process.env.DATA_PROVIDER || process.env.DB_PROVIDER || "firebase") {
  return String(provider).trim().toLowerCase() === "sqlite";
}

const PAYMENT_STORE_SUPPORTED = paymentStoreSupported();
const PAYMENT_CONFIGURED = Boolean(TAP_SECRET_KEY);

function paymentError(status: number, message: string) {
  const error = new Error(message) as Error & { status?: number };
  error.status = status;
  return error;
}

function asyncRoute(
  handler: (req: Request, res: Response) => Promise<unknown>,
) {
  return (req: Request, res: Response) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      const status = Number((err as { status?: unknown })?.status);
      const responseStatus = Number.isInteger(status) && status >= 400 && status < 600 ? status : 500;
      if (responseStatus >= 500) logError("payment.unhandled", err);
      res.status(responseStatus).json({
        error: responseStatus < 500
          ? (err instanceof Error ? err.message : String(err))
          : "حدث خطأ داخلي في بوابة الدفع.",
      });
    });
  };
}

function userId(req: Request): string {
  return (req as AuthedRequest).user.uid;
}

function nowIso(): string {
  return new Date().toISOString();
}

// ── Helpers ────────────────────────────────────────────────

function getInvoiceById(invoiceId: string, ownerUid: string): InvoiceRow | undefined {
  return db
    .prepare(
      `SELECT id, owner_uid, invoice_number, customer_name, customer_phone,
              total_with_vat, currency, status, paid_at, document_kind, issued_at,
              EXISTS(
                SELECT 1 FROM invoices credit
                WHERE credit.owner_uid = invoices.owner_uid
                  AND credit.source_invoice_id = invoices.id
                  AND credit.document_kind = 'credit_note'
                  AND credit.adjustment_scope = 'full'
              ) AS has_full_credit
       FROM invoices WHERE id = ? AND owner_uid = ?`,
    )
    .get(invoiceId, ownerUid) as InvoiceRow | undefined;
}

function getPaymentById(paymentId: string): PaymentRow | undefined {
  return db
    .prepare("SELECT * FROM payments WHERE id = ?")
    .get(paymentId) as PaymentRow | undefined;
}

function getPaymentByTapChargeId(tapChargeId: string): PaymentRow | undefined {
  return db
    .prepare("SELECT * FROM payments WHERE tap_charge_id = ?")
    .get(tapChargeId) as PaymentRow | undefined;
}

function getPaymentByIdempotency(ownerUid: string, idempotencyKey: string): PaymentRow | undefined {
  return db.prepare(
    "SELECT * FROM payments WHERE owner_uid = ? AND idempotency_key = ? LIMIT 1",
  ).get(ownerUid, idempotencyKey) as PaymentRow | undefined;
}

function getInflightPayment(invoiceId: string, ownerUid: string): PaymentRow | undefined {
  return db.prepare(
    `SELECT * FROM payments
     WHERE invoice_id = ? AND owner_uid = ? AND status IN ('creating', 'pending')
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  ).get(invoiceId, ownerUid) as PaymentRow | undefined;
}

function mapTapPaymentStatus(value: unknown): PaymentStatus {
  const status = String(value || "").toUpperCase();
  if (status === "CAPTURED" || status === "PAID") return "completed";
  if (["DECLINED", "FAILED", "ABANDONED", "CANCELLED", "VOID", "RESTRICTED", "TIMEDOUT"].includes(status)) {
    return "failed";
  }
  if (status === "REFUNDED" || status === "REVERSED") return "cancelled";
  return "pending";
}

function monotonicPaymentStatus(current: PaymentStatus, incoming: PaymentStatus): PaymentStatus {
  const rank: Record<PaymentStatus, number> = {
    creating: 0,
    pending: 1,
    failed: 2,
    completed: 3,
    cancelled: 4,
  };
  return rank[incoming] < rank[current] ? current : incoming;
}

const THREE_DECIMAL_CURRENCIES = new Set(["BHD", "KWD", "OMR", "JOD"]);

function tapCurrency(value: unknown): string {
  return String(value || "").trim().toUpperCase();
}

export function formatTapAmount(value: unknown, currencyValue: unknown): string {
  const amount = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isFinite(amount) || amount < 0) throw paymentError(400, "مبلغ Tap غير صالح.");
  const currency = tapCurrency(currencyValue);
  if (!/^[A-Z]{3}$/.test(currency)) throw paymentError(400, "عملة Tap غير صالحة.");
  return amount.toFixed(THREE_DECIMAL_CURRENCIES.has(currency) ? 3 : 2);
}

type TapChargePayload = Record<string, unknown> & {
  metadata?: Record<string, unknown>;
  reference?: Record<string, unknown>;
  transaction?: Record<string, unknown>;
};

function requiredTapText(value: unknown, label: string): string {
  const text = String(value ?? "").trim();
  if (!text) throw paymentError(400, `حقل Tap ${label} مفقود.`);
  return text;
}

export function buildTapChargeHashString(payload: TapChargePayload): string {
  const id = requiredTapText(payload.id, "id");
  const currency = requiredTapText(payload.currency, "currency").toUpperCase();
  const amount = formatTapAmount(payload.amount, currency);
  const gatewayReference = String(payload.reference?.gateway ?? "").trim();
  const paymentReference = requiredTapText(payload.reference?.payment, "reference.payment");
  const status = requiredTapText(payload.status, "status");
  const created = requiredTapText(payload.transaction?.created, "transaction.created");
  return `x_id${id}x_amount${amount}x_currency${currency}x_gateway_reference${gatewayReference}x_payment_reference${paymentReference}x_status${status}x_created${created}`;
}

function verifyTapWebhookSignature(payload: TapChargePayload, signatureHeader: string): boolean {
  if (!TAP_SECRET_KEY || !/^[a-fA-F0-9]{64}$/.test(signatureHeader)) return false;
  let canonical: string;
  try {
    canonical = buildTapChargeHashString(payload);
  } catch {
    return false;
  }
  const expected = crypto.createHmac("sha256", TAP_SECRET_KEY).update(canonical).digest("hex");
  return crypto.timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(signatureHeader.toLowerCase(), "hex"),
  );
}

function updatePaymentStatus(
  paymentId: string,
  status: PaymentStatus,
  tapResponse?: Record<string, unknown>,
  webhookData?: Record<string, unknown>,
): void {
  const current = getPaymentById(paymentId);
  if (!current) throw paymentError(409, "سجل الدفع غير موجود.");
  const nextStatus = monotonicPaymentStatus(current.status, status);
  const now = nowIso();
  const stmt = db.prepare(
    `UPDATE payments SET status = ?, tap_response = COALESCE(?, tap_response),
       webhook_data = COALESCE(?, webhook_data), updated_at = ? WHERE id = ?`,
  );
  stmt.run(
    nextStatus,
    tapResponse ? JSON.stringify(tapResponse) : null,
    webhookData ? JSON.stringify(webhookData) : null,
    now,
    paymentId,
  );
}

function markInvoicePaid(invoiceId: string): boolean {
  const now = nowIso();
  const result = db.prepare(
    `UPDATE invoices SET status = 'paid', paid_at = ?, updated_at = ?
     WHERE id = ?
       AND document_kind = 'invoice'
       AND issued_at IS NOT NULL
       AND status IN ('issued', 'sent')
       AND NOT EXISTS (
         SELECT 1 FROM invoices credit
         WHERE credit.owner_uid = invoices.owner_uid
           AND credit.source_invoice_id = invoices.id
           AND credit.document_kind = 'credit_note'
           AND credit.adjustment_scope = 'full'
       )`,
  ).run(now, now, invoiceId);
  return result.changes === 1;
}

type PaymentReservation = {
  payment: PaymentRow;
  invoice: InvoiceRow;
  leaseToken: string | null;
  replay: boolean;
};

function assertInvoicePayable(invoice: InvoiceRow | undefined) {
  if (!invoice) throw paymentError(404, "الفاتورة غير موجودة أو لا تملك صلاحية الوصول إليها.");
  if (invoice.document_kind !== "invoice" || !invoice.issued_at || invoice.status === "draft") {
    throw paymentError(409, "لا يمكن إنشاء دفعة لمسودة أو إشعار دائن.");
  }
  if (invoice.has_full_credit) {
    throw paymentError(409, "لا يمكن الدفع لفاتورة أُلغيَت أو استُردت بإشعار دائن كامل.");
  }
  if (invoice.status === "paid") throw paymentError(409, "الفاتورة مدفوعة بالفعل.");
  if (invoice.status !== "issued" && invoice.status !== "sent") {
    throw paymentError(409, `لا يمكن الدفع لفاتورة بحالة "${invoice.status}".`);
  }
  if (!(Math.round(Number(invoice.total_with_vat) * 100) / 100 > 0)) {
    throw paymentError(400, "مبلغ الفاتورة يجب أن يكون أكبر من صفر.");
  }
}

function reservePayment(invoiceId: string, ownerUid: string, requestedKey: string): PaymentReservation {
  const reserve = db.transaction(() => {
    const invoice = getInvoiceById(invoiceId, ownerUid);
    assertInvoicePayable(invoice);
    let payment = getPaymentByIdempotency(ownerUid, requestedKey);
    if (payment && payment.invoice_id !== invoiceId) {
      throw paymentError(409, "مفتاح منع التكرار مستخدم لعملية دفع أخرى.");
    }
    payment ||= getInflightPayment(invoiceId, ownerUid);
    if (payment?.status === "pending" || payment?.status === "completed") {
      return { payment, invoice: invoice!, leaseToken: null, replay: true };
    }

    const now = nowIso();
    if (
      payment?.status === "creating"
      && payment.reservation_expires_at
      && Date.parse(payment.reservation_expires_at) > Date.now()
    ) {
      throw paymentError(409, "يجري الآن إنشاء رابط الدفع لهذه الفاتورة؛ انتظر لحظات ثم أعد المحاولة.");
    }

    const leaseToken = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + PAYMENT_RESERVATION_LEASE_MS).toISOString();
    if (payment) {
      db.prepare(
        `UPDATE payments
         SET status = 'creating', lease_token = ?, reservation_expires_at = ?, updated_at = ?
         WHERE id = ?`,
      ).run(leaseToken, expiresAt, now, payment.id);
    } else {
      const paymentId = `pay_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
      db.prepare(
        `INSERT INTO payments (
           id, invoice_id, owner_uid, idempotency_key, lease_token, reservation_expires_at,
           tap_charge_id, amount, currency, status, redirect_url, tap_response,
           webhook_data, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 'creating', NULL, NULL, NULL, ?, ?)`,
      ).run(
        paymentId,
        invoiceId,
        ownerUid,
        requestedKey,
        leaseToken,
        expiresAt,
        Math.round(Number(invoice!.total_with_vat) * 100) / 100,
        invoice!.currency || "SAR",
        now,
        now,
      );
      payment = getPaymentById(paymentId);
    }
    if (!payment) throw new Error("Payment reservation disappeared after creation.");
    return { payment, invoice: invoice!, leaseToken, replay: false };
  });

  try {
    return reserve();
  } catch (error) {
    if (!/SQLITE_CONSTRAINT|unique constraint/i.test(error instanceof Error ? error.message : String(error))) throw error;
    // A different process won the same unique reservation. Re-read its state.
    return reserve();
  }
}

function providerIdempotencyKey(ownerUid: string, idempotencyKey: string) {
  return `pay_${crypto.createHash("sha256").update(`${ownerUid}\0${idempotencyKey}`).digest("hex").slice(0, 48)}`;
}

function paymentApiResponse(payment: PaymentRow) {
  return {
    success: payment.status === "pending" || payment.status === "completed",
    id: payment.id,
    payment_id: payment.id,
    invoice_id: payment.invoice_id,
    tap_charge_id: payment.tap_charge_id,
    amount: payment.amount,
    currency: payment.currency,
    redirect_url: payment.redirect_url,
    status: payment.status,
    created_at: payment.created_at,
  };
}

function publicBaseUrl(req: Request): string {
  const host = req.get("host") || "";
  const proto = req.get("x-forwarded-proto") || req.protocol || "https";
  // If APP_URL is explicitly configured, prefer that for consistency
  if (APP_URL && APP_URL !== "http://localhost:3000") return APP_URL;
  if (host) return `${proto}://${host}`;
  return APP_URL;
}

// ── Tap API Client ─────────────────────────────────────────

class TapChargeRequestError extends Error {
  constructor(message: string, readonly definitive: boolean) {
    super(message);
    this.name = "TapChargeRequestError";
  }
}

async function createTapCharge(params: {
  amount: number;
  currency: string;
  customerName: string;
  customerPhone: string;
  invoiceId: string;
  invoiceNumber: string;
  ownerUid: string;
  paymentId: string;
  idempotencyKey: string;
  description: string;
  redirectUrl: string;
  webhookUrl: string;
}): Promise<{
  tapChargeId: string;
  redirectUrl: string;
  status: string;
  raw: Record<string, unknown>;
}> {
  if (!TAP_SECRET_KEY) {
    throw new Error("TAP_SECRET_KEY غير مضبوط. الرجاء ضبط مفتاح Tap في ملف البيئة.");
  }

  const body = {
    amount: params.amount,
    currency: params.currency,
    customer_initiated: true,
    threeDSecure: true,
    save_card: false,
    description: params.description,
    statement_descriptor: `فاتورة ${params.invoiceNumber}`,
    metadata: {
      invoice_id: params.invoiceId,
      invoice_number: params.invoiceNumber,
      owner_uid: params.ownerUid,
      payment_id: params.paymentId,
    },
    reference: {
      transaction: `inv-${params.invoiceId.slice(0, 20)}`,
      order: params.invoiceNumber,
      idempotent: params.idempotencyKey,
    },
    receipt: {
      email: false,
      sms: false,
    },
    customer: {
      first_name: params.customerName,
      phone: {
        country_code: "966",
        number: params.customerPhone.replace(/^\+966/, "").replace(/^966/, "").replace(/^0/, ""),
      },
    },
    source: {
      id: "src_all",
    },
    post: {
      url: params.webhookUrl,
    },
    redirect: {
      url: params.redirectUrl,
    },
  };

  const url = `${TAP_BASE_URL}/charges`;
  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${TAP_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new TapChargeRequestError(
      error instanceof Error ? error.message : "تعذر الوصول إلى Tap؛ حالة العملية غير مؤكدة.",
      false,
    );
  }

  let raw: Record<string, unknown>;
  try {
    raw = await response.json() as Record<string, unknown>;
  } catch {
    throw new TapChargeRequestError("أعادت Tap استجابة غير مفهومة؛ حالة العملية غير مؤكدة.", false);
  }

  if (!response.ok) {
    const tapErrors = raw.errors as Array<{ description?: string }> | undefined;
    const message = tapErrors?.map((e) => e.description).join("; ") || (raw as any).message || "فشل إنشاء الدفعة في Tap";
    throw new TapChargeRequestError(message, response.status >= 400 && response.status < 500);
  }

  return {
    tapChargeId: raw.id as string,
    redirectUrl: (raw.transaction as { url?: string } | undefined)?.url || (raw as any).url || "",
    status: raw.status as string,
    raw,
  };
}

async function getTapChargeStatus(chargeId: string): Promise<Record<string, unknown>> {
  if (!TAP_SECRET_KEY) {
    throw new Error("TAP_SECRET_KEY غير مضبوط.");
  }
  const url = `${TAP_BASE_URL}/charges/${encodeURIComponent(chargeId)}`;
  const response = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${TAP_SECRET_KEY}`,
    },
  });
  const raw = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    const message = (raw as any).message || "فشل الاستعلام عن حالة الدفعة";
    throw new Error(message);
  }
  return raw;
}

function finalizeReservedPayment(
  paymentId: string,
  leaseToken: string,
  tapResult: Awaited<ReturnType<typeof createTapCharge>>,
) {
  return db.transaction(() => {
    const current = getPaymentById(paymentId);
    if (!current) throw new Error("Payment disappeared while finalizing the Tap charge.");
    if (current.tap_charge_id && current.tap_charge_id !== tapResult.tapChargeId) {
      throw paymentError(409, "تعارض معرّف Tap مع سجل الدفع المحجوز.");
    }
    const status = monotonicPaymentStatus(current.status, mapTapPaymentStatus(tapResult.status));
    const now = nowIso();
    const updated = db.prepare(
      `UPDATE payments
       SET tap_charge_id = ?, redirect_url = ?, tap_response = ?, status = ?,
           lease_token = NULL, reservation_expires_at = NULL, updated_at = ?
       WHERE id = ? AND lease_token = ?`,
    ).run(
      tapResult.tapChargeId,
      tapResult.redirectUrl || null,
      JSON.stringify(tapResult.raw),
      status,
      now,
      paymentId,
      leaseToken,
    );
    const payment = getPaymentById(paymentId);
    if (!payment) throw new Error("Payment disappeared while finalizing the Tap charge.");
    if (updated.changes !== 1) throw paymentError(409, "انتهى حجز الدفع قبل تثبيت نتيجة Tap.");
    if (payment.status === "completed") {
      const invoice = getInvoiceById(payment.invoice_id, payment.owner_uid);
      if (invoice?.status !== "paid" && !markInvoicePaid(payment.invoice_id)) {
        logError("payment.invoice_paid_transition_failed", null, { paymentId, invoiceId: payment.invoice_id });
      }
    }
    return payment;
  })();
}

function releasePaymentReservation(
  paymentId: string,
  leaseToken: string,
  error: unknown,
  definitive: boolean,
) {
  db.transaction(() => {
    const payment = getPaymentById(paymentId);
    if (!payment || payment.lease_token !== leaseToken) return;
    const now = nowIso();
    const status = monotonicPaymentStatus(payment.status, definitive ? "failed" : "creating");
    db.prepare(
      `UPDATE payments
       SET status = ?, lease_token = NULL, reservation_expires_at = ?, tap_response = ?, updated_at = ?
       WHERE id = ? AND lease_token = ?`,
    ).run(
      status,
      now,
      JSON.stringify({ error: error instanceof Error ? error.message : String(error), definitive }),
      now,
      paymentId,
      leaseToken,
    );
  })();
}

function assertTapPayloadMatchesPayment(payment: PaymentRow, payload: TapChargePayload) {
  const payloadCurrency = tapCurrency(payload.currency);
  const paymentCurrency = tapCurrency(payment.currency);
  if (payloadCurrency !== paymentCurrency) throw paymentError(409, "عملة Tap لا تطابق سجل الدفع.");
  if (formatTapAmount(payload.amount, payloadCurrency) !== formatTapAmount(payment.amount, paymentCurrency)) {
    throw paymentError(409, "مبلغ Tap لا يطابق سجل الدفع.");
  }
}

function applyTapChargePayload(
  payload: TapChargePayload,
  options: { expectedPaymentId?: string; webhook?: boolean } = {},
): PaymentRow {
  const tapChargeId = requiredTapText(payload.id, "id");
  const metadataPaymentId = requiredTapText(payload.metadata?.payment_id, "metadata.payment_id");
  if (options.expectedPaymentId && metadataPaymentId !== options.expectedPaymentId) {
    throw paymentError(409, "معرّف الدفع في Tap لا يطابق طلب المطابقة.");
  }

  return db.transaction(() => {
    const byCharge = getPaymentByTapChargeId(tapChargeId);
    if (byCharge && byCharge.id !== metadataPaymentId) {
      throw paymentError(409, "معرّف Tap مرتبط بسجل دفع مختلف.");
    }
    let payment = byCharge || getPaymentById(metadataPaymentId);
    if (!payment) {
      // A non-2xx response is intentional: Tap will retry a signed webhook that
      // beats the local reservation commit instead of us acknowledging data loss.
      throw paymentError(409, "سجل الدفع غير جاهز بعد؛ أعد إرسال الإشعار.");
    }
    if (payment.tap_charge_id && payment.tap_charge_id !== tapChargeId) {
      throw paymentError(409, "سجل الدفع مرتبط بمعرّف Tap مختلف.");
    }
    assertTapPayloadMatchesPayment(payment, payload);

    if (!payment.tap_charge_id) {
      const bound = db.prepare(
        `UPDATE payments SET tap_charge_id = ?, updated_at = ?
         WHERE id = ? AND tap_charge_id IS NULL`,
      ).run(tapChargeId, nowIso(), payment.id);
      if (bound.changes !== 1) throw paymentError(409, "تعذر ربط معرّف Tap بسجل الدفع ذريًا.");
      payment = getPaymentById(payment.id)!;
    }

    const mappedStatus = mapTapPaymentStatus(payload.status);
    updatePaymentStatus(payment.id, mappedStatus, payload, options.webhook ? payload : undefined);
    const updated = getPaymentById(payment.id);
    if (!updated) throw new Error("Payment disappeared while applying the Tap charge.");
    if (updated.status === "completed") {
      const invoice = getInvoiceById(updated.invoice_id, updated.owner_uid);
      if (invoice?.status !== "paid" && !markInvoicePaid(updated.invoice_id)) {
        logError("payment.invoice_paid_transition_failed", null, {
          paymentId: updated.id,
          invoiceId: updated.invoice_id,
        });
      }
    }
    return getPaymentById(updated.id) || updated;
  })();
}

// ── Route Registration ────────────────────────────────────

/**
 * Register ONLY the unauthenticated webhook route.
 * Call this BEFORE the Firebase auth middleware so Tap can post webhooks.
 */
export function registerPaymentWebhookRoute(app: Express) {
  // ── POST /api/payments/webhook — Tap webhook receiver (NO auth) ──
  app.post(
    "/api/payments/webhook",
    asyncRoute(async (req: Request, res: Response) => {
      if (!PAYMENT_STORE_SUPPORTED || !PAYMENT_CONFIGURED) {
        res.status(503).json({ error: "تكامل Tap غير متاح أو غير مكتمل الإعداد على مزود البيانات الحالي." });
        return;
      }
      const payload = req.body as TapChargePayload;
      const signature = String(req.get("hashstring") || "").trim();
      if (!verifyTapWebhookSignature(payload, signature)) {
        logError("payment.webhook_invalid_signature", null);
        res.status(403).json({ error: "توقيع غير صالح." });
        return;
      }

      const payment = applyTapChargePayload(payload, { webhook: true });

      logEvent("info", "payment.webhook_received", {
        paymentId: payment.id,
        tapChargeId: payment.tap_charge_id,
        tapStatus: payload.status,
        ourStatus: payment.status,
        invoiceId: payment.invoice_id,
      });

      res.json({ received: true });
    }),
  );
}

/** Register authenticated payment routes (create + status). Call AFTER Firebase auth middleware. */
export function registerPaymentRoutes(app: Express) {
  app.get("/api/payments/capabilities", (_req, res) => {
    const available = PAYMENT_STORE_SUPPORTED && PAYMENT_CONFIGURED;
    res.json({
      available,
      configured: PAYMENT_CONFIGURED,
      provider_supported: PAYMENT_STORE_SUPPORTED,
      reason: available
        ? null
        : !PAYMENT_STORE_SUPPORTED
          ? "بوابة الدفع متاحة حاليًا مع تخزين SQLite فقط."
          : "يلزم ضبط TAP_SECRET_KEY.",
    });
  });

  // ── POST /api/payments/create — create a Tap charge for an invoice ──
  app.post(
    "/api/payments/create",
    asyncRoute(async (req: Request, res: Response) => {
      if (!PAYMENT_STORE_SUPPORTED) {
        throw paymentError(503, "بوابة الدفع معطلة لهذا المزود حتى يتوفر مستودع دفع ذري متوافق معه.");
      }
      if (!PAYMENT_CONFIGURED) {
        throw paymentError(503, "إعداد Tap غير مكتمل؛ اضبط مفتاح API السري.");
      }
      const uid = userId(req);
      const { invoice_id } = req.body || {};
      if (!invoice_id) {
        res.status(400).json({ error: "invoice_id مطلوب." });
        return;
      }
      const idempotencyKey = String(req.get("Idempotency-Key") || "").trim();
      if (!/^[A-Za-z0-9:_-]{8,160}$/.test(idempotencyKey)) {
        throw paymentError(400, "مفتاح منع تكرار الدفع مفقود أو غير صالح.");
      }
      const reservation = reservePayment(String(invoice_id), uid, idempotencyKey);
      if (reservation.replay) {
        res.status(200).json({ ...paymentApiResponse(reservation.payment), idempotent_replay: true });
        return;
      }
      if (!reservation.leaseToken) throw new Error("Payment reservation has no active lease.");

      const base = publicBaseUrl(req);
      const host = req.get("host") || "";
      const proto = req.get("x-forwarded-proto") || req.protocol || "http";
      const derivedBase = host ? `${proto}://${host}` : base;
      const redirectUrl = `${derivedBase}/app/invoices?payment_id=${encodeURIComponent(reservation.payment.id)}`;
      const webhookUrl = `${derivedBase}/api/payments/webhook`;

      try {
        const tapResult = await createTapCharge({
          amount: reservation.payment.amount,
          currency: reservation.payment.currency || "SAR",
          customerName: reservation.invoice.customer_name || "عميل",
          customerPhone: reservation.invoice.customer_phone || "",
          invoiceId: reservation.invoice.id,
          invoiceNumber: reservation.invoice.invoice_number || reservation.invoice.id,
          ownerUid: uid,
          paymentId: reservation.payment.id,
          idempotencyKey: providerIdempotencyKey(uid, reservation.payment.idempotency_key || idempotencyKey),
          description: `دفع الفاتورة ${reservation.invoice.invoice_number || reservation.invoice.id}`,
          redirectUrl,
          webhookUrl,
        });
        const payment = finalizeReservedPayment(reservation.payment.id, reservation.leaseToken, tapResult);
        logEvent("info", "payment.charge_created", {
          paymentId: payment.id,
          invoiceId: payment.invoice_id,
          tapChargeId: payment.tap_charge_id,
          amount: payment.amount,
          status: payment.status,
        });
        if (payment.status === "failed" || payment.status === "cancelled") {
          res.status(409).json({ ...paymentApiResponse(payment), error: "رفضت بوابة Tap عملية الدفع." });
          return;
        }
        res.json(paymentApiResponse(payment));
      } catch (err) {
        const definitive = err instanceof TapChargeRequestError && err.definitive;
        releasePaymentReservation(reservation.payment.id, reservation.leaseToken, err, definitive);
        const message = err instanceof Error ? err.message : "فشل الاتصال ببوابة الدفع Tap.";
        logError("payment.create_charge_failed", err, {
          paymentId: reservation.payment.id,
          ambiguous: !definitive,
        });
        throw paymentError(502, definitive ? message : `${message} أعد المحاولة بنفس الطلب؛ لن تُنشأ مطالبة مكررة.`);
      }
    }),
  );

  // ── GET /api/payments/:id/status — check payment status ──
  app.get(
    "/api/payments/:id/status",
    asyncRoute(async (req: Request, res: Response) => {
      if (!PAYMENT_STORE_SUPPORTED || !PAYMENT_CONFIGURED) {
        throw paymentError(503, "تكامل Tap غير متاح أو غير مكتمل الإعداد على مزود البيانات الحالي.");
      }
      const uid = userId(req);
      const paymentId = String(req.params.id);

      const payment = getPaymentById(paymentId);
      if (!payment || payment.owner_uid !== uid) {
        res.status(404).json({ error: "الدفعة غير موجودة." });
        return;
      }

      const redirectTapId = String(req.query.tap_id || "").trim();
      if (redirectTapId && !/^chg_[A-Za-z0-9_-]{3,180}$/.test(redirectTapId)) {
        throw paymentError(400, "معرّف Tap في رابط العودة غير صالح.");
      }
      if (redirectTapId && payment.tap_charge_id && payment.tap_charge_id !== redirectTapId) {
        throw paymentError(409, "معرّف Tap في رابط العودة لا يطابق سجل الدفع.");
      }

      // Reconcile the redirect with Retrieve Charge. The redirect's tap_id can
      // close the webhook-before-finalize race even before tap_charge_id is saved.
      let tapStatus: Record<string, unknown> | null = null;
      const chargeId = redirectTapId || payment.tap_charge_id;
      if (chargeId && TAP_SECRET_KEY) {
        try {
          tapStatus = await getTapChargeStatus(chargeId);
          if (String(tapStatus.id || "") !== chargeId) {
            throw paymentError(409, "استجابة Tap لا تطابق معرّف رابط العودة.");
          }
          applyTapChargePayload(tapStatus as TapChargePayload, { expectedPaymentId: paymentId });
        } catch (err) {
          logError("payment.status_sync_failed", err, { paymentId });
          if (redirectTapId) throw err;
        }
      }

      // Re-read to get the latest local state
      const fresh = getPaymentById(paymentId);

      res.json({
        payment_id: paymentId,
        invoice_id: fresh?.invoice_id,
        tap_charge_id: fresh?.tap_charge_id,
        amount: fresh?.amount,
        currency: fresh?.currency,
        status: fresh?.status,
        tap_status: tapStatus ? (tapStatus as any).status : null,
        created_at: fresh?.created_at,
        updated_at: fresh?.updated_at,
      });
    }),
  );
}
