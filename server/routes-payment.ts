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
  tap_charge_id: string | null;
  amount: number;
  currency: string;
  status: "pending" | "completed" | "failed" | "cancelled";
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
}

type PaymentStatus = PaymentRow["status"];

// ── Config ─────────────────────────────────────────────────

const TAP_SECRET_KEY = process.env.TAP_SECRET_KEY || "";
const TAP_WEBHOOK_SECRET = process.env.TAP_WEBHOOK_SECRET || "";
const TAP_BASE_URL = process.env.TAP_BASE_URL || "https://api.tap.company/v2";
const APP_URL = process.env.APP_URL || "http://localhost:3000";

function asyncRoute(
  handler: (req: Request, res: Response) => Promise<unknown>,
) {
  return (req: Request, res: Response) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      logError("payment.unhandled", err);
      res.status(500).json({ error: "حدث خطأ داخلي في بوابة الدفع." });
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
              total_with_vat, currency, status, paid_at
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

function insertPayment(row: Omit<PaymentRow, "created_at" | "updated_at">): void {
  const now = nowIso();
  db.prepare(
    `INSERT INTO payments (id, invoice_id, owner_uid, tap_charge_id, amount, currency,
       status, redirect_url, tap_response, webhook_data, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.invoice_id,
    row.owner_uid,
    row.tap_charge_id,
    row.amount,
    row.currency,
    row.status,
    row.redirect_url,
    row.tap_response,
    row.webhook_data,
    now,
    now,
  );
}

function updatePaymentStatus(
  paymentId: string,
  status: PaymentStatus,
  tapResponse?: Record<string, unknown>,
  webhookData?: Record<string, unknown>,
): void {
  const now = nowIso();
  const stmt = db.prepare(
    `UPDATE payments SET status = ?, tap_response = COALESCE(?, tap_response),
       webhook_data = COALESCE(?, webhook_data), updated_at = ? WHERE id = ?`,
  );
  stmt.run(
    status,
    tapResponse ? JSON.stringify(tapResponse) : null,
    webhookData ? JSON.stringify(webhookData) : null,
    now,
    paymentId,
  );
}

function markInvoicePaid(invoiceId: string): void {
  const now = nowIso();
  db.prepare(
    `UPDATE invoices SET status = 'paid', paid_at = ?, payment_method = 'Tap',
       updated_at = ? WHERE id = ? AND status != 'paid'`,
  ).run(now, now, invoiceId);
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

async function createTapCharge(params: {
  amount: number;
  currency: string;
  customerName: string;
  customerPhone: string;
  invoiceId: string;
  invoiceNumber: string;
  ownerUid: string;
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
    },
    reference: {
      transaction: `inv-${params.invoiceId.slice(0, 20)}`,
      order: params.invoiceNumber,
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
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${TAP_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const raw = await response.json() as Record<string, unknown>;

  if (!response.ok) {
    const tapErrors = raw.errors as Array<{ description?: string }> | undefined;
    const message = tapErrors?.map((e) => e.description).join("; ") || (raw as any).message || "فشل إنشاء الدفعة في Tap";
    throw new Error(message);
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

function verifyTapWebhookSignature(rawBody: Buffer, signatureHeader: string): boolean {
  if (!TAP_WEBHOOK_SECRET) {
    // No webhook secret configured — skip verification (dev only)
    console.warn("[payments] TAP_WEBHOOK_SECRET not set — webhook signature verification skipped");
    return true;
  }

  if (!signatureHeader) {
    console.error("[payments] Missing X-Tap-Signature header in webhook");
    return false;
  }

  const expected = crypto
    .createHmac("sha256", TAP_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(signatureHeader, "hex"),
    );
  } catch {
    return false;
  }
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
      const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
      const signature = String(req.get("x-tap-signature") || "").trim();

      // Verify HMAC signature
      if (rawBody && !verifyTapWebhookSignature(rawBody, signature)) {
        logError("payment.webhook_invalid_signature", null, {
          signature,
          bodyPreview: rawBody?.toString().slice(0, 200),
        });
        res.status(403).json({ error: "توقيع غير صالح." });
        return;
      }

      const payload = req.body as Record<string, unknown>;
      const tapChargeId = payload.id as string | undefined;
      const chargeStatus = payload.status as string | undefined;

      if (!tapChargeId) {
        res.status(400).json({ error: "معرف الدفعة (id) مفقود في جسم الطلب." });
        return;
      }

      // Find the payment record by tap_charge_id
      const payment = getPaymentByTapChargeId(tapChargeId);
      if (!payment) {
        // Payment not found — could be from a different tenant or test
        console.warn(`[payments] Webhook received for unknown charge: ${tapChargeId}`);
        res.json({ received: true });
        return;
      }

      // Map Tap status to our status
      let ourStatus: PaymentStatus = "pending";
      const tapStatus = (chargeStatus || "").toUpperCase();

      switch (tapStatus) {
        case "CAPTURED":
        case "PAID":
          ourStatus = "completed";
          break;
        case "DECLINED":
        case "FAILED":
        case "ABANDONED":
        case "CANCELLED":
        case "VOID":
          ourStatus = "failed";
          break;
        case "REFUNDED":
        case "REVERSED":
          ourStatus = "cancelled";
          break;
        default:
          ourStatus = "pending";
      }

      // Update payment record
      updatePaymentStatus(payment.id, ourStatus, payload, payload);

      // If payment completed, mark invoice as paid
      if (ourStatus === "completed") {
        markInvoicePaid(payment.invoice_id);
      }

      logEvent("info", "payment.webhook_received", {
        paymentId: payment.id,
        tapChargeId,
        tapStatus: chargeStatus,
        ourStatus,
        invoiceId: payment.invoice_id,
      });

      res.json({ received: true });
    }),
  );
}

/** Register authenticated payment routes (create + status). Call AFTER Firebase auth middleware. */
export function registerPaymentRoutes(app: Express) {
  // ── POST /api/payments/create — create a Tap charge for an invoice ──
  app.post(
    "/api/payments/create",
    asyncRoute(async (req: Request, res: Response) => {
      const uid = userId(req);
      const { invoice_id } = req.body || {};

      if (!invoice_id) {
        res.status(400).json({ error: "invoice_id مطلوب." });
        return;
      }

      // Fetch the invoice — must belong to this user
      const invoice = getInvoiceById(String(invoice_id), uid);
      if (!invoice) {
        res.status(404).json({ error: "الفاتورة غير موجودة أو لا تملك صلاحية الوصول إليها." });
        return;
      }

      if (invoice.status === "paid") {
        res.status(400).json({ error: "الفاتورة مدفوعة بالفعل." });
        return;
      }

      if (invoice.status === "cancelled" || invoice.status === "refunded") {
        res.status(400).json({ error: `لا يمكن الدفع لفاتورة بحالة "${invoice.status}".` });
        return;
      }

      const base = publicBaseUrl(req);
      const host = req.get("host") || "";
      const proto = req.get("x-forwarded-proto") || req.protocol || "http";
      const derivedBase = host ? `${proto}://${host}` : base;

      const paymentId = `pay_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
      const redirectUrl = `${derivedBase}/app/invoices`;
      const webhookUrl = `${derivedBase}/api/payments/webhook`;

      const amount = Math.round(Number(invoice.total_with_vat) * 100) / 100;
      if (amount <= 0) {
        res.status(400).json({ error: "مبلغ الفاتورة يجب أن يكون أكبر من صفر." });
        return;
      }

      let tapResult: {
        tapChargeId: string;
        redirectUrl: string;
        status: string;
        raw: Record<string, unknown>;
      };

      try {
        tapResult = await createTapCharge({
          amount,
          currency: invoice.currency || "SAR",
          customerName: invoice.customer_name || "عميل",
          customerPhone: invoice.customer_phone || "",
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoice_number || invoice.id,
          ownerUid: uid,
          description: `دفع الفاتورة ${invoice.invoice_number || invoice.id}`,
          redirectUrl,
          webhookUrl,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "فشل الاتصال ببوابة الدفع Tap.";
        logError("payment.create_charge_failed", err);
        res.status(502).json({ error: message });
        return;
      }

      // Insert payment record
      insertPayment({
        id: paymentId,
        invoice_id: invoice.id,
        owner_uid: uid,
        tap_charge_id: tapResult.tapChargeId,
        amount,
        currency: invoice.currency || "SAR",
        status: "pending",
        redirect_url: tapResult.redirectUrl,
        tap_response: JSON.stringify(tapResult.raw),
        webhook_data: null,
      });

      logEvent("info", "payment.charge_created", {
        paymentId,
        invoiceId: invoice.id,
        tapChargeId: tapResult.tapChargeId,
        amount,
      });

      res.json({
        success: true,
        payment_id: paymentId,
        tap_charge_id: tapResult.tapChargeId,
        redirect_url: tapResult.redirectUrl,
        status: tapResult.status,
      });
    }),
  );

  // ── POST /api/payments/webhook — Tap webhook receiver ──
  app.post(
    "/api/payments/webhook",
    asyncRoute(async (req: Request, res: Response) => {
      const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
      const signature = String(req.get("x-tap-signature") || "").trim();

      // Verify HMAC signature
      if (rawBody && !verifyTapWebhookSignature(rawBody, signature)) {
        logError("payment.webhook_invalid_signature", null, {
          signature,
          bodyPreview: rawBody?.toString().slice(0, 200),
        });
        res.status(403).json({ error: "توقيع غير صالح." });
        return;
      }

      const payload = req.body as Record<string, unknown>;
      const tapChargeId = payload.id as string | undefined;
      const chargeStatus = payload.status as string | undefined;

      if (!tapChargeId) {
        res.status(400).json({ error: "معرف الدفعة (id) مفقود في جسم الطلب." });
        return;
      }

      // Find the payment record by tap_charge_id
      const payment = getPaymentByTapChargeId(tapChargeId);
      if (!payment) {
        // Payment not found — could be from a different tenant or test
        console.warn(`[payments] Webhook received for unknown charge: ${tapChargeId}`);
        res.json({ received: true });
        return;
      }

      // Map Tap status to our status
      let ourStatus: PaymentStatus = "pending";
      const tapStatus = (chargeStatus || "").toUpperCase();

      switch (tapStatus) {
        case "CAPTURED":
        case "PAID":
          ourStatus = "completed";
          break;
        case "DECLINED":
        case "FAILED":
        case "ABANDONED":
        case "CANCELLED":
        case "VOID":
          ourStatus = "failed";
          break;
        case "REFUNDED":
        case "REVERSED":
          ourStatus = "cancelled";
          break;
        default:
          ourStatus = "pending";
      }

      // Update payment record
      updatePaymentStatus(payment.id, ourStatus, payload, payload);

      // If payment completed, mark invoice as paid
      if (ourStatus === "completed") {
        markInvoicePaid(payment.invoice_id);
      }

      logEvent("info", "payment.webhook_received", {
        paymentId: payment.id,
        tapChargeId,
        tapStatus: chargeStatus,
        ourStatus,
        invoiceId: payment.invoice_id,
      });

      res.json({ received: true });
    }),
  );

  // ── GET /api/payments/:id/status — check payment status ──
  app.get(
    "/api/payments/:id/status",
    asyncRoute(async (req: Request, res: Response) => {
      const uid = userId(req);
      const paymentId = String(req.params.id);

      const payment = getPaymentById(paymentId);
      if (!payment || payment.owner_uid !== uid) {
        res.status(404).json({ error: "الدفعة غير موجودة." });
        return;
      }

      // Optionally sync with Tap for current status
      let tapStatus: Record<string, unknown> | null = null;
      if (payment.tap_charge_id && TAP_SECRET_KEY) {
        try {
          tapStatus = await getTapChargeStatus(payment.tap_charge_id);

          // Update our local status if Tap has changed
          const tapCurrentStatus = (tapStatus.status as string || "").toUpperCase();
          const statusMap: Record<string, PaymentStatus> = {
            CAPTURED: "completed",
            PAID: "completed",
            DECLINED: "failed",
            FAILED: "failed",
            ABANDONED: "failed",
            CANCELLED: "failed",
            VOID: "failed",
            REFUNDED: "cancelled",
            REVERSED: "cancelled",
          };

          const mappedStatus = statusMap[tapCurrentStatus] || "pending";
          if (mappedStatus !== payment.status) {
            updatePaymentStatus(payment.id, mappedStatus, tapStatus);
            if (mappedStatus === "completed") {
              markInvoicePaid(payment.invoice_id);
            }
          }
        } catch (err) {
          // Tap status check failed — return what we have locally
          logError("payment.status_sync_failed", err, { paymentId });
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
