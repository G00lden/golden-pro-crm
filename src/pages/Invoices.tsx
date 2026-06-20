import {
  CalendarDays,
  CheckCircle2,
  Clock3,
  Copy,
  Download,
  Edit3,
  Eye,
  FileText,
  MessageCircle,
  Plus,
  Printer,
  RefreshCcw,
  Search,
  Send,
  Trash2,
  X,
} from "lucide-react";
import QRCode from "qrcode";
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import * as api from "../api";

type Notifier = (message: string, ok?: boolean) => void;

type InvoicesPageProps = {
  notify: Notifier;
  refreshStats: () => Promise<void>;
};

const today = () => new Date().toLocaleDateString("en-CA");

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA");
};

const money = (value?: number, currency = "SAR") =>
  `${Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;

type PriceMode = "inclusive" | "exclusive";

const productPrice = (product?: api.Product) => Number(product?.sale_price ?? product?.price ?? 0);
const sellerLegalName = "شركة بريكس برو شخص واحد ذات مسؤولية محدودة";
const sellerEnglishName = "Breexe Pro Co.";

const statusLabels: Record<api.InvoiceStatus, string> = {
  draft: "مسودة",
  issued: "مصدرة",
  paid: "مدفوعة",
  cancelled: "ملغية",
  refunded: "مستردة",
};

const statusTone: Record<api.InvoiceStatus, "muted" | "success" | "danger" | "warn"> = {
  draft: "muted",
  issued: "warn",
  paid: "success",
  cancelled: "danger",
  refunded: "danger",
};

const defaultTerms = [
  "فاتورة ضريبية مبسطة - متوافقة مع متطلبات هيئة الزكاة والضريبة والجمارك.",
  "تحتسب ضريبة القيمة المضافة حسب طريقة إدخال السعر الموضحة في بنود الفاتورة.",
  "الدفع حسب الاتفاق المبرم بين الطرفين.",
].join("\n");

const safeFilePart = (value?: string) =>
  String(value || "العميل")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 80) || "العميل";

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/* ── ZATCA QR Code Generation (TLV format) ─────────────── */

const zatcaFieldLabels: Record<number, string> = {
  1: "اسم البائع",
  2: "الرقم الضريبي",
  3: "وقت إصدار الفاتورة",
  4: "الإجمالي شامل الضريبة",
  5: "إجمالي ضريبة القيمة المضافة",
};

function invoiceTimestamp(invoice: api.Invoice): string {
  const source = invoice.createdAt || `${invoice.issue_date}T00:00:00Z`;
  const parsed = new Date(source);
  if (Number.isNaN(parsed.getTime())) return `${invoice.issue_date}T00:00:00Z`;
  return parsed.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function generateZATCAQR(invoice: api.Invoice): string {
  const timestamp = invoiceTimestamp(invoice);
  const total = invoice.total_with_vat.toFixed(2);
  const vatAmount = invoice.vat_amount.toFixed(2);

  const tlvData: Array<[number, string]> = [
    [1, invoice.seller_name || sellerEnglishName],
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
}

function decodeZATCAQR(base64: string) {
  try {
    const raw = atob(base64);
    const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
    const decoder = new TextDecoder();
    const fields: Array<{ tag: number; label: string; value: string }> = [];
    for (let index = 0; index < bytes.length;) {
      const tag = bytes[index++];
      const length = bytes[index++];
      const valueBytes = bytes.slice(index, index + length);
      index += length;
      fields.push({ tag, label: zatcaFieldLabels[tag] || `Tag ${tag}`, value: decoder.decode(valueBytes) });
    }
    return fields;
  } catch {
    return [];
  }
}

function zatcaChecklist(invoice: api.Invoice) {
  return [
    { label: "اسم البائع داخل QR", ok: Boolean(invoice.seller_name) },
    { label: "رقم ضريبي 15 رقم", ok: /^\d{15}$/.test(invoice.seller_vat_number || "") },
    { label: "وقت إصدار بصيغة ISO", ok: Boolean(invoiceTimestamp(invoice)) },
    { label: "الإجمالي شامل الضريبة", ok: Number(invoice.total_with_vat || 0) > 0 },
    { label: "إجمالي الضريبة", ok: Number(invoice.vat_amount || 0) >= 0 },
  ];
}

/* ── QR Code component ─────────────────────────────────── */

function QRCodeDisplay({ data, size = 80 }: { data: string; size?: number }) {
  const [src, setSrc] = useState("");

  useEffect(() => {
    let active = true;
    QRCode.toDataURL(data, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: size,
      color: { dark: "#000000", light: "#ffffff" },
    }).then((value) => {
      if (active) setSrc(value);
    }).catch(() => {
      if (active) setSrc("");
    });
    return () => {
      active = false;
    };
  }, [data, size]);

  return src
    ? <img src={src} width={size} height={size} className="zatca-qr-code" alt="ZATCA QR code" />
    : <div className="zatca-qr-code qr-fallback" style={{ width: size, height: size }}>QR</div>;
}

/* ── Data hook ─────────────────────────────────────────── */

function useAsyncData<T>(fetcher: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(await fetcher());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, deps);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { data, loading, error, refresh };
}

/* ── Badge ─────────────────────────────────────────────── */

function InvoiceBadge({ status }: { status: api.InvoiceStatus }) {
  return <span className={`badge ${statusTone[status]}`}>{statusLabels[status]}</span>;
}

/* ── Modal ─────────────────────────────────────────────── */

function InvoiceModal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="modal wide" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" type="button" title="إغلاق" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

/* ── Summary rows ──────────────────────────────────────── */

function invoiceSummaryRows(stats: api.InvoiceStats) {
  return [
    { label: "كل الفواتير", value: stats.total, icon: <FileText size={18} /> },
    { label: "مصدرة", value: stats.issued, icon: <Send size={18} /> },
    { label: "مدفوعة", value: stats.paid, icon: <CheckCircle2 size={18} /> },
    { label: "ملغية", value: stats.cancelled, icon: <X size={18} /> },
  ];
}

/* ── Share text ────────────────────────────────────────── */

function invoiceShareText(invoice: api.Invoice) {
  const lines = invoice.items.map((item) => `- ${item.description} × ${item.quantity}: ${money(item.total, invoice.currency)}`);
  const qrFields = decodeZATCAQR(generateZATCAQR(invoice))
    .map((field) => `${field.label}: ${field.value}`);
  return [
    `فاتورة ضريبية - ${invoice.seller_name || sellerEnglishName}`,
    `رقم الفاتورة: ${invoice.invoice_number}`,
    invoice.title || "فاتورة",
    `العميل: ${invoice.customer_name}`,
    invoice.customer_phone ? `الجوال: ${invoice.customer_phone}` : "",
    invoice.customer_vat ? `الرقم الضريبي للعميل: ${invoice.customer_vat}` : "",
    "",
    ...lines,
    "",
    `المجموع (بدون ضريبة): ${money(invoice.total_without_vat, invoice.currency)}`,
    `ضريبة القيمة المضافة (${invoice.vat_percent}%): ${money(invoice.vat_amount, invoice.currency)}`,
    `الإجمالي شامل الضريبة: ${money(invoice.total_with_vat, invoice.currency)}`,
    "",
    "بيانات QR عند المسح بتطبيق زاتكا:",
    ...qrFields,
    invoice.terms ? `الشروط: ${invoice.terms}` : "",
  ].filter(Boolean).join("\n");
}

/* ── Main Page ─────────────────────────────────────────── */

export function InvoicesPage({ notify, refreshStats }: InvoicesPageProps) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [editing, setEditing] = useState<api.Invoice | null>(null);
  const [preview, setPreview] = useState<api.Invoice | null>(null);
  const [creating, setCreating] = useState(false);
  const [sendingInvoiceId, setSendingInvoiceId] = useState("");
  const invoices = useAsyncData(() => api.getInvoices({ search, status }), [search, status]);
  const stats = invoices.data?.stats || {
    total: 0,
    draft: 0,
    issued: 0,
    paid: 0,
    cancelled: 0,
    total_value: 0,
    paid_value: 0,
  };

  const refreshAll = async () => {
    await Promise.all([invoices.refresh(), refreshStats()]);
  };

  const saveInvoice = async (payload: api.InvoiceInput) => {
    try {
      if (editing) {
        await api.updateInvoice(editing.id, payload);
        notify("تم حفظ الفاتورة");
      } else {
        await api.createInvoice(payload);
        notify("تم إصدار الفاتورة");
      }
      setCreating(false);
      setEditing(null);
      await refreshAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : "فشل حفظ الفاتورة", false);
    }
  };

  const setInvoiceStatus = async (invoice: api.Invoice, nextStatus: api.InvoiceStatus) => {
    try {
      await api.setInvoiceStatus(invoice.id, nextStatus);
      notify(nextStatus === "paid" ? "تم تأكيد الدفع" : nextStatus === "cancelled" ? "تم إلغاء الفاتورة" : "تم تحديث حالة الفاتورة");
      await refreshAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : "تعذر تحديث الفاتورة", false);
    }
  };

  const remove = async (invoice: api.Invoice) => {
    if (!window.confirm(`حذف الفاتورة ${invoice.invoice_number}؟`)) return;
    try {
      await api.deleteInvoice(invoice.id);
      notify("تم حذف الفاتورة");
      await refreshAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : "تعذر حذف الفاتورة", false);
    }
  };

  const copyInvoice = async (invoice: api.Invoice) => {
    try {
      await navigator.clipboard.writeText(invoiceShareText(invoice));
      notify("تم نسخ نص الفاتورة");
    } catch {
      notify("تعذر نسخ الفاتورة", false);
    }
  };

  const openInvoicePrintDialog = async (invoice: api.Invoice, asPdf = false) => {
    const previousTitle = document.title;
    document.title = `فاتورة إلى ${safeFilePart(invoice.customer_name)}`;
    document.body.classList.add("quote-print-mode");
    let printFrame: HTMLIFrameElement | null = null;
    const restore = () => {
      document.title = previousTitle;
      document.body.classList.remove("quote-print-mode");
      printFrame?.remove();
    };
    try {
      const invoiceNode = document.querySelector<HTMLElement>(".invoice-a4-doc");
      if (!invoiceNode) throw new Error("Invoice preview is not ready.");
      const clone = invoiceNode.cloneNode(true) as HTMLElement;
      const qrTarget = clone.querySelector<HTMLElement>(".zatca-qr-code");
      if (qrTarget) {
        const qrSrc = await QRCode.toDataURL(generateZATCAQR(invoice), {
          errorCorrectionLevel: "M",
          margin: 1,
          width: 120,
          color: { dark: "#000000", light: "#ffffff" },
        });
        if (qrTarget instanceof HTMLImageElement) {
          qrTarget.src = qrSrc;
        } else {
          const qrImage = document.createElement("img");
          qrImage.src = qrSrc;
          qrImage.width = 120;
          qrImage.height = 120;
          qrImage.className = "zatca-qr-code";
          qrImage.alt = "ZATCA QR code";
          qrTarget.replaceWith(qrImage);
        }
      }
      const styles = Array.from(document.querySelectorAll<HTMLLinkElement | HTMLStyleElement>('link[rel="stylesheet"], style'))
        .map((element) => element.outerHTML)
        .join("\n");
      printFrame = document.createElement("iframe");
      printFrame.title = "invoice-print-frame";
      Object.assign(printFrame.style, {
        position: "fixed",
        inset: "auto 0 0 auto",
        width: "0",
        height: "0",
        border: "0",
        opacity: "0",
      });
      document.body.appendChild(printFrame);
      const frameDoc = printFrame.contentDocument;
      const frameWindow = printFrame.contentWindow;
      if (!frameDoc || !frameWindow) throw new Error("Print frame is not available.");
      frameDoc.open();
      frameDoc.write(`<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <base href="${window.location.origin}/" />
  <title>${escapeHtml(document.title)}</title>
  ${styles}
  <style>
    @page { size: A4; margin: 0; }
    html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
    body { width: 210mm !important; min-height: 297mm !important; overflow: visible !important; }
    .invoice-print-shell { width: 210mm !important; margin: 0 !important; padding: 0 !important; background: #fff !important; }
    .invoice-a4-doc { width: 210mm !important; min-height: 297mm !important; margin: 0 !important; padding: 10mm 12mm !important; border: 0 !important; border-radius: 0 !important; box-shadow: none !important; }
  </style>
</head>
<body class="quote-print-mode">
  <main class="invoice-print-shell">${clone.outerHTML}</main>
</body>
</html>`);
      frameDoc.close();
      frameWindow.addEventListener("afterprint", restore, { once: true });
      const runPrint = () => {
        frameWindow.focus();
        frameWindow.print();
        window.setTimeout(restore, 3000);
      };
      if (frameDoc.readyState === "complete") {
        window.setTimeout(runPrint, 150);
      } else {
        printFrame.addEventListener("load", () => window.setTimeout(runPrint, 150), { once: true });
      }
      notify(asPdf ? "اختر حفظ كـ PDF من نافذة الطباعة" : "تم تجهيز الفاتورة للطباعة A4");
    } catch {
      restore();
      notify("تعذر تجهيز الفاتورة للطباعة. افتح المعاينة ثم حاول مرة أخرى.", false);
    }
  };

  const printInvoice = (invoice: api.Invoice, asPdf = false) => {
    flushSync(() => setPreview(invoice));
    openInvoicePrintDialog(invoice, asPdf);
  };

  const sendInvoiceWhatsApp = async (invoice: api.Invoice) => {
    if (!invoice.customer_phone) {
      notify("أضف رقم جوال العميل قبل إرسال الفاتورة واتساب", false);
      return;
    }
    setSendingInvoiceId(invoice.id);
    try {
      await api.sendInvoiceWhatsApp(invoice, invoiceShareText(invoice));
      notify("تم إرسال الفاتورة عبر واتساب");
    } catch (err) {
      notify(err instanceof Error ? err.message : "تعذر إرسال الفاتورة واتساب", false);
    } finally {
      setSendingInvoiceId("");
    }
  };

  return (
    <div className="quotes-workspace cloud-design">
      <section className="cloud-hero quotes-hero">
        <div className="cloud-hero-copy">
          <span className="eyebrow">Tax Invoices</span>
          <h1>الفواتير الضريبية (ZATCA)</h1>
          <p>إصدار فواتير ضريبية مبسطة متوافقة مع هيئة الزكاة والضريبة والجمارك مع QR code.</p>
          <div className="hero-actions">
            <button className="btn primary" type="button" onClick={() => setCreating(true)}>
              <Plus size={16} /> إصدار فاتورة
            </button>
            <button className="btn muted" type="button" onClick={invoices.refresh}>
              <RefreshCcw size={16} /> تحديث
            </button>
          </div>
        </div>
        <div className="hero-status-grid">
          <article>
            <span>قيمة الفواتير</span>
            <strong>{money(stats.total_value)}</strong>
          </article>
          <article>
            <span>قيمة مدفوعة</span>
            <strong>{money(stats.paid_value)}</strong>
          </article>
          <article>
            <span>مصدرة</span>
            <strong>{stats.issued}</strong>
          </article>
        </div>
      </section>

      <div className="stats-grid metric-grid quote-metrics">
        {invoiceSummaryRows(stats).map((item) => (
          <article className="stat" key={item.label}>
            <span>{item.icon}</span>
            <div>
              <strong>{item.value}</strong>
              <p>{item.label}</p>
            </div>
          </article>
        ))}
      </div>

      <div className="toolbar quotes-toolbar">
        <Search size={16} />
        <input
          className="input"
          placeholder="بحث برقم الفاتورة أو العميل أو الجوال"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select className="input" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="all">كل الحالات</option>
          <option value="issued">مصدرة</option>
          <option value="paid">مدفوعة</option>
          <option value="draft">مسودة</option>
          <option value="cancelled">ملغية</option>
          <option value="refunded">مستردة</option>
        </select>
      </div>

      {invoices.loading ? (
        <div className="empty">
          <RefreshCcw size={26} className="spin" />
          <p>جاري تحميل الفواتير...</p>
        </div>
      ) : invoices.error ? (
        <div className="error-box">
          <span>{invoices.error}</span>
          <button className="btn muted" type="button" onClick={invoices.refresh}>إعادة المحاولة</button>
        </div>
      ) : invoices.data?.data.length ? (
        <div className="quotes-list">
          {invoices.data.data.map((invoice) => (
            <article className="quote-card" key={invoice.id}>
              <div className="quote-card-main">
                <div className="quote-title-line">
                  <strong>{invoice.invoice_number}</strong>
                  <InvoiceBadge status={invoice.status} />
                </div>
                <h3>{invoice.title || "فاتورة"}</h3>
                <p>{invoice.customer_name} · {invoice.customer_phone || "بدون جوال"} · {invoice.customer_city || "بدون مدينة"}</p>
                <div className="chips">
                  <span className="badge muted"><CalendarDays size={12} /> {invoice.issue_date}</span>
                  {invoice.due_date && <span className="badge warn">مستحق {invoice.due_date}</span>}
                  {invoice.paid_at && <span className="badge success">تم الدفع</span>}
                  {invoice.seller_vat_number && <span className="badge muted">VAT: {invoice.seller_vat_number}</span>}
                </div>
              </div>
              <div className="quote-total-box">
                <span>شامل الضريبة</span>
                <strong>{money(invoice.total_with_vat, invoice.currency)}</strong>
                <small>ضريبة {money(invoice.vat_amount, invoice.currency)}</small>
              </div>
              <div className="row-actions">
                <button className="icon-btn success" type="button" title="تأكيد الدفع" onClick={() => setInvoiceStatus(invoice, "paid")} disabled={invoice.status === "paid"}>
                  <CheckCircle2 size={15} />
                </button>
                <button className="icon-btn" type="button" title="طباعة" onClick={() => printInvoice(invoice)}>
                  <Printer size={15} />
                </button>
                <button className="icon-btn" type="button" title="معاينة" onClick={() => setPreview(invoice)}>
                  <Eye size={15} />
                </button>
                <button className="icon-btn" type="button" title="نسخ" onClick={() => copyInvoice(invoice)}>
                  <Copy size={15} />
                </button>
                <button className="icon-btn" type="button" title="تعديل" onClick={() => setEditing(invoice)}>
                  <Edit3 size={15} />
                </button>
                {invoice.customer_phone && (
                  <button
                    className="icon-btn"
                    type="button"
                    title="إرسال واتساب"
                    disabled={sendingInvoiceId === invoice.id}
                    onClick={() => sendInvoiceWhatsApp(invoice)}
                  >
                    <MessageCircle size={15} />
                  </button>
                )}
                <button className="icon-btn danger" type="button" title="إلغاء" onClick={() => setInvoiceStatus(invoice, "cancelled")} disabled={invoice.status === "cancelled"}>
                  <X size={15} />
                </button>
                <button className="icon-btn danger" type="button" title="حذف" onClick={() => remove(invoice)}>
                  <Trash2 size={15} />
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="empty">
          <FileText size={30} />
          <p>لا توجد فواتير بعد</p>
          <button className="btn primary" type="button" onClick={() => setCreating(true)}>
            <Plus size={16} /> إصدار أول فاتورة
          </button>
        </div>
      )}

      {(creating || editing) && (
        <InvoiceModal title={editing ? "تعديل الفاتورة" : "إصدار فاتورة ضريبية"} onClose={() => { setCreating(false); setEditing(null); }}>
          <InvoiceForm
            initial={editing || undefined}
            notify={notify}
            onCancel={() => { setCreating(false); setEditing(null); }}
            onSave={saveInvoice}
          />
        </InvoiceModal>
      )}
      {preview && (
        <InvoiceModal title={`معاينة ${preview.invoice_number}`} onClose={() => setPreview(null)}>
          <InvoicePreview invoice={preview} onCopy={() => copyInvoice(preview)} onPrint={(asPdf) => void openInvoicePrintDialog(preview, asPdf)} />
        </InvoiceModal>
      )}
    </div>
  );
}

/* ── Preview ───────────────────────────────────────────── */

function invoiceLineAmounts(item: api.InvoiceItem, vatPercent: number) {
  const rate = Math.max(0, Number(vatPercent || 0)) / 100;
  const quantity = Math.max(0, Number(item.quantity || 0));
  const enteredTotal = Math.max(0, Number(item.total || quantity * Number(item.unit_price || 0)));
  const net = item.vat_excluded === false && rate > 0 ? enteredTotal / (1 + rate) : enteredTotal;
  const gross = item.vat_excluded === false ? enteredTotal : enteredTotal * (1 + rate);
  return {
    quantity,
    net: Math.round(net * 100) / 100,
    unitNet: quantity ? Math.round((net / quantity) * 100) / 100 : 0,
    vat: Math.round((gross - net) * 100) / 100,
    gross: Math.round(gross * 100) / 100,
  };
}

function InvoicePreview({ invoice, onCopy, onPrint }: { invoice: api.Invoice; onCopy: () => void; onPrint: (asPdf?: boolean) => void }) {
  const qrCode = useMemo(() => generateZATCAQR(invoice), [invoice]);
  const qrFields = useMemo(() => decodeZATCAQR(qrCode), [qrCode]);
  const checks = useMemo(() => zatcaChecklist(invoice), [invoice]);
  const issueTime = invoiceTimestamp(invoice).replace("T", " ").replace("Z", " UTC");

  return (
    <div className="quote-preview">
      <section className="invoice-a4-doc" dir="rtl">
        <header className="invoice-doc-head">
          <div className="invoice-brand-block">
            <div className="quote-logo-mark">BP</div>
            <div>
              <span dir="ltr">{invoice.seller_name || sellerEnglishName}</span>
              <strong>{sellerLegalName}</strong>
              <small>{invoice.seller_address || "الرياض، المملكة العربية السعودية"}</small>
            </div>
          </div>
          <div className="invoice-title-block">
            <span>Tax Invoice</span>
            <h2>{invoice.title || "فاتورة ضريبية"}</h2>
            <strong>{invoice.invoice_number}</strong>
          </div>
        </header>

        <section className="invoice-identity-grid">
          <article>
            <span>رقم الفاتورة</span>
            <strong>{invoice.invoice_number}</strong>
          </article>
          <article>
            <span>تاريخ الإصدار</span>
            <strong>{invoice.issue_date}</strong>
            <small>{issueTime}</small>
          </article>
          <article>
            <span>الرقم الضريبي للبائع</span>
            <strong>{invoice.seller_vat_number || "-"}</strong>
          </article>
          <article>
            <span>الحالة</span>
            <strong>{statusLabels[invoice.status]}</strong>
          </article>
        </section>

        <section className="invoice-parties">
          <article>
            <h3>بيانات البائع</h3>
            <p><span>الاسم:</span> <bdi>{invoice.seller_name || sellerEnglishName}</bdi></p>
            <p><span>السجل/الاسم القانوني:</span> {sellerLegalName}</p>
            <p><span>الرقم الضريبي:</span> {invoice.seller_vat_number || "-"}</p>
            <p><span>العنوان:</span> {invoice.seller_address || "-"}</p>
          </article>
          <article>
            <h3>بيانات العميل</h3>
            <p><span>الاسم:</span> {invoice.customer_name}</p>
            <p><span>الجوال:</span> {invoice.customer_phone || "-"}</p>
            <p><span>المدينة:</span> {invoice.customer_city || "-"}</p>
            <p><span>الرقم الضريبي:</span> {invoice.customer_vat || "-"}</p>
          </article>
          <aside className="invoice-zatca-card">
            <QRCodeDisplay data={qrCode} size={138} />
            <strong>رمز QR متوافق مع ZATCA</strong>
            <span>TLV Base64 - Tags 1 to 5</span>
          </aside>
        </section>

        <table className="invoice-doc-table">
          <thead>
            <tr>
              <th>#</th>
              <th>البيان</th>
              <th>الكمية</th>
              <th>سعر الوحدة قبل الضريبة</th>
              <th>الخاضع للضريبة</th>
              <th>VAT</th>
              <th>الإجمالي شامل الضريبة</th>
            </tr>
          </thead>
          <tbody>
            {invoice.items.map((item, index) => {
              const line = invoiceLineAmounts(item, invoice.vat_percent);
              return (
                <tr key={`${item.description}-${index}`}>
                  <td>{index + 1}</td>
                  <td>{item.description}</td>
                  <td>{line.quantity}</td>
                  <td>{money(line.unitNet, invoice.currency)}</td>
                  <td>{money(line.net, invoice.currency)}</td>
                  <td>{money(line.vat, invoice.currency)}</td>
                  <td>{money(line.gross, invoice.currency)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <section className="invoice-bottom-grid">
          <div className="invoice-zatca-data">
            <h3>البيانات التي تظهر عند مسح QR</h3>
            {qrFields.map((field) => (
              <p key={field.tag}><span>{field.label}</span><strong><bdi>{field.value}</bdi></strong></p>
            ))}
          </div>
          <div className="invoice-compliance-box">
            <h3>فحص المتطلبات الأساسية</h3>
            {checks.map((check) => (
              <p key={check.label} className={check.ok ? "ok" : "bad"}>
                <span>{check.ok ? "✓" : "!"}</span>{check.label}
              </p>
            ))}
          </div>
          <div className="invoice-doc-totals">
            <p><span>الإجمالي غير شامل الضريبة</span><strong>{money(invoice.total_without_vat, invoice.currency)}</strong></p>
            <p><span>الخصم</span><strong>{money(invoice.discount, invoice.currency)}</strong></p>
            <p><span>ضريبة القيمة المضافة ({invoice.vat_percent}%)</span><strong>{money(invoice.vat_amount, invoice.currency)}</strong></p>
            <p className="grand"><span>الإجمالي شامل الضريبة</span><strong>{money(invoice.total_with_vat, invoice.currency)}</strong></p>
          </div>
        </section>

        {invoice.terms && <p className="invoice-doc-terms">{invoice.terms}</p>}
        <footer className="invoice-doc-foot">
          <p>هذه الفاتورة مولدة إلكترونيا، ورمز QR يحتوي بيانات TLV Base64 الأساسية المطلوبة لفواتير ZATCA المبسطة.</p>
          <strong>{sellerEnglishName}</strong>
        </footer>
      </section>
      <div className="form-actions">
        <button className="btn primary" type="button" onClick={() => onPrint(false)}><Printer size={16} /> طباعة A4</button>
        <button className="btn muted" type="button" onClick={() => onPrint(true)}><Download size={16} /> حفظ PDF</button>
        <button className="btn muted" type="button" onClick={onCopy}><Copy size={16} /> نسخ نص الفاتورة</button>
      </div>
    </div>
  );
}

/* ── Form ──────────────────────────────────────────────── */

function InvoiceForm({
  initial,
  notify,
  onCancel,
  onSave,
}: {
  initial?: api.Invoice;
  notify: Notifier;
  onCancel: () => void;
  onSave: (payload: api.InvoiceInput) => Promise<void>;
}) {
  const customers = useAsyncData(() => api.getCustomers(""), []);
  const products = useAsyncData(() => api.getProducts(), []);
  const settings = useAsyncData(() => api.getSettings(), []);
  const [customerId, setCustomerId] = useState(initial?.customer_id || "");
  const [customerName, setCustomerName] = useState(initial?.customer_name || "");
  const [customerPhone, setCustomerPhone] = useState(initial?.customer_phone || "");
  const [customerCity, setCustomerCity] = useState(initial?.customer_city || "");
  const [customerVat, setCustomerVat] = useState(initial?.customer_vat || "");
  const [title, setTitle] = useState(initial?.title || "");
  const [status, setStatus] = useState<api.InvoiceStatus>(initial?.status || "issued");
  const [issueDate, setIssueDate] = useState(initial?.issue_date || today());
  const [dueDate, setDueDate] = useState(initial?.due_date || addDays(today(), 30));
  const [vatPercent, setVatPercent] = useState(String(initial?.vat_percent || 15));
  const [discount, setDiscount] = useState(String(initial?.discount || 0));
  const [sellerName, setSellerName] = useState(initial?.seller_name || "");
  const [sellerVat, setSellerVat] = useState(initial?.seller_vat_number || "");
  const [sellerAddress, setSellerAddress] = useState(initial?.seller_address || "");
  const [priceMode, setPriceMode] = useState<PriceMode>(
    initial?.items?.some((item) => item.vat_excluded === false) ? "inclusive" : "exclusive",
  );
  const [notes, setNotes] = useState(initial?.notes || "");
  const [terms, setTerms] = useState(initial?.terms || defaultTerms);
  const [items, setItems] = useState<api.InvoiceItem[]>(
    initial?.items?.length
      ? initial.items
      : [{ description: "", quantity: 1, unit_price: 0, total: 0, vat_excluded: true }],
  );
  const [saving, setSaving] = useState(false);

  const selectedCustomer = customers.data?.data.find((item) => item.id === customerId);
  const vatExcluded = priceMode === "exclusive";

  useEffect(() => {
    if (!selectedCustomer) return;
    setCustomerName(selectedCustomer.name);
    setCustomerPhone(selectedCustomer.phone);
    setCustomerCity(selectedCustomer.city || "");
  }, [selectedCustomer]);

  useEffect(() => {
    if (!settings.data || initial) return;
    setSellerName(settings.data.seller_name || sellerEnglishName);
    setSellerVat(settings.data.seller_vat_number || "");
    setSellerAddress(settings.data.seller_address || `${sellerLegalName} - الرياض`);
  }, [settings.data, initial]);

  const normalizedItems = useMemo(
    () =>
      items.map((item) => ({
        ...item,
        quantity: Math.max(0, Number(item.quantity || 0)),
        unit_price: Math.max(0, Number(item.unit_price || 0)),
        total: Math.max(0, Number(item.quantity || 0)) * Math.max(0, Number(item.unit_price || 0)),
        vat_excluded: vatExcluded,
      })),
    [items, vatExcluded],
  );
  const cleanDiscount = Math.max(0, Number(discount || 0));
  const vatPct = Math.max(0, Number(vatPercent || 15));
  const vatRate = vatPct / 100;
  const subtotal = normalizedItems.reduce((sum, item) => (
    sum + (item.vat_excluded === false && vatRate > 0 ? item.total / (1 + vatRate) : item.total)
  ), 0);
  const withoutVat = Math.max(0, subtotal - cleanDiscount);
  const vatAmount = withoutVat * (vatPct / 100);
  const totalWithVat = withoutVat + vatAmount;

  const updateItem = (index: number, patch: Partial<api.InvoiceItem>) => {
    setItems((current) => current.map((item, i) => i === index ? { ...item, ...patch } : item));
  };

  const applyProduct = (index: number, productId: string) => {
    const product = products.data?.find((item) => item.id === productId);
    if (!product) {
      updateItem(index, { product_id: null, product_sku: "" });
      return;
    }
    updateItem(index, {
      product_id: product.id,
      product_sku: product.sku || "",
      description: product.name,
      unit_price: productPrice(product),
    });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await onSave({
        quote_id: initial?.quote_id || null,
        customer_id: customerId || null,
        customer_name: customerName.trim(),
        customer_phone: customerPhone.trim(),
        customer_city: customerCity.trim(),
        customer_vat: customerVat.trim(),
        title: title.trim(),
        status,
        issue_date: issueDate,
        due_date: dueDate || null,
        vat_percent: Number(vatPercent || 15),
        discount: Number(discount || 0),
        currency: "SAR",
        items: normalizedItems.filter((item) => item.description.trim()),
        notes: notes.trim(),
        terms: terms.trim(),
        seller_name: sellerName.trim() || sellerEnglishName,
        seller_vat_number: sellerVat.trim(),
        seller_address: sellerAddress.trim(),
      });
    } catch (err) {
      notify(err instanceof Error ? err.message : "فشل حفظ الفاتورة", false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="form quote-form" onSubmit={submit}>
      <div className="form-grid">
        <label className="field">
          <span>عميل موجود</span>
          <select className="input" value={customerId} onChange={(event) => setCustomerId(event.target.value)}>
            <option value="">عميل جديد / إدخال يدوي</option>
            {(customers.data?.data || []).map((customer) => (
              <option key={customer.id} value={customer.id}>{customer.name} - {customer.phone}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>عنوان الفاتورة</span>
          <input className="input" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="فاتورة ضريبية" />
        </label>
      </div>

      <div className="form-grid">
        <label className="field">
          <span>اسم العميل</span>
          <input className="input" value={customerName} onChange={(event) => setCustomerName(event.target.value)} required />
        </label>
        <label className="field">
          <span>الجوال</span>
          <input className="input" value={customerPhone} onChange={(event) => setCustomerPhone(event.target.value)} placeholder="05xxxxxxxx" />
        </label>
      </div>

      <div className="form-grid">
        <label className="field">
          <span>المدينة</span>
          <input className="input" value={customerCity} onChange={(event) => setCustomerCity(event.target.value)} />
        </label>
        <label className="field">
          <span>الرقم الضريبي للعميل (اختياري)</span>
          <input className="input" inputMode="numeric" value={customerVat} onChange={(event) => setCustomerVat(event.target.value.replace(/\D/g, "").slice(0, 15))} placeholder="15 رقم" />
        </label>
      </div>

      <div className="invoice-seller-form">
        <div className="quote-lines-head">
          <strong>بيانات المنشأة على الفاتورة</strong>
          <span>تظهر في QR والفاتورة المطبوعة</span>
        </div>
        <div className="form-grid">
          <label className="field">
            <span>اسم البائع</span>
            <input className="input" value={sellerName} onChange={(event) => setSellerName(event.target.value)} placeholder={sellerEnglishName} required />
          </label>
          <label className="field">
            <span>الرقم الضريبي للبائع</span>
            <input className="input" inputMode="numeric" value={sellerVat} onChange={(event) => setSellerVat(event.target.value.replace(/\D/g, "").slice(0, 15))} placeholder="15 رقم" required />
          </label>
        </div>
        <label className="field">
          <span>عنوان البائع</span>
          <input className="input" value={sellerAddress} onChange={(event) => setSellerAddress(event.target.value)} placeholder={`${sellerLegalName} - الرياض`} />
        </label>
      </div>

      <div className="form-grid">
        <label className="field">
          <span>حالة الفاتورة</span>
          <select className="input" value={status} onChange={(event) => setStatus(event.target.value as api.InvoiceStatus)}>
            <option value="issued">مصدرة</option>
            <option value="draft">مسودة</option>
            <option value="paid">مدفوعة</option>
            <option value="cancelled">ملغية</option>
            <option value="refunded">مستردة</option>
          </select>
        </label>
      </div>

      <div className="form-grid">
        <label className="field">
          <span>تاريخ الإصدار</span>
          <input className="input" type="date" value={issueDate} onChange={(event) => setIssueDate(event.target.value)} />
        </label>
        <label className="field">
          <span>تاريخ الاستحقاق</span>
          <input className="input" type="date" value={dueDate || ""} onChange={(event) => setDueDate(event.target.value)} />
        </label>
      </div>

      <div className="form-grid">
        <label className="field">
          <span>نسبة الضريبة (%)</span>
          <input className="input" type="number" min={0} max={100} step="0.01" value={vatPercent} onChange={(event) => setVatPercent(event.target.value)} />
        </label>
        <label className="field">
          <span>الخصم</span>
          <input className="input" type="number" min={0} step="0.01" value={discount} onChange={(event) => setDiscount(event.target.value)} />
        </label>
      </div>

      <div className="quote-price-mode" role="group" aria-label="طريقة إدخال السعر">
        <span>طريقة إدخال السعر</span>
        <button
          className={priceMode === "inclusive" ? "active" : ""}
          type="button"
          onClick={() => setPriceMode("inclusive")}
        >
          السعر شامل الضريبة
        </button>
        <button
          className={priceMode === "exclusive" ? "active" : ""}
          type="button"
          onClick={() => setPriceMode("exclusive")}
        >
          السعر بدون ضريبة
        </button>
        <small>
          {priceMode === "inclusive"
            ? "مثال: 5000 تبقى 5000 شامل الضريبة."
            : "مثال: 5000 يضاف عليها VAT في الإجمالي."}
        </small>
      </div>

      <div className="quote-lines">
        <div className="quote-lines-head">
          <strong>بنود الفاتورة</strong>
          <button
            className="btn muted"
            type="button"
            onClick={() => setItems((current) => [...current, { description: "", quantity: 1, unit_price: 0, total: 0, vat_excluded: vatExcluded }])}
          >
            <Plus size={16} /> بند
          </button>
        </div>
        {items.map((item, index) => (
          <div className="quote-line" key={index}>
            <select
              className="input"
              value={item.product_id || ""}
              onChange={(event) => applyProduct(index, event.target.value)}
              aria-label="اختيار منتج"
            >
              <option value="">منتج من النظام</option>
              {(products.data || []).map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name} {productPrice(product) ? `- ${money(productPrice(product), product.currency || "SAR")}` : ""}
                </option>
              ))}
            </select>
            <input
              className="input"
              value={item.description}
              onChange={(event) => updateItem(index, { description: event.target.value })}
              placeholder="وصف البند"
              required={index === 0}
            />
            <input
              className="input"
              type="number"
              min={0}
              step="1"
              value={item.quantity}
              onChange={(event) => updateItem(index, { quantity: Number(event.target.value) })}
              aria-label="الكمية"
            />
            <input
              className="input"
              type="number"
              min={0}
              step="0.01"
              value={item.unit_price}
              onChange={(event) => updateItem(index, { unit_price: Number(event.target.value) })}
              aria-label="سعر الوحدة"
            />
            <strong>{money(
              normalizedItems[index]?.vat_excluded === false
                ? normalizedItems[index]?.total || 0
                : (normalizedItems[index]?.total || 0) * (1 + vatRate),
            )}</strong>
            <button
              className="icon-btn danger"
              type="button"
              title="حذف البند"
              onClick={() => setItems((current) => current.filter((_, i) => i !== index))}
              disabled={items.length === 1}
            >
              <X size={15} />
            </button>
          </div>
        ))}
      </div>

      <div className="quote-total-summary">
        <article className="vat-summary">
          <span>المجموع (بدون ضريبة)</span>
          <strong>{money(Math.max(0, withoutVat))}</strong>
        </article>
        <article>
          <span>ضريبة {vatPct}%</span>
          <strong>{money(Math.max(0, vatAmount))}</strong>
        </article>
        <article className="total">
          <span>الإجمالي شامل الضريبة</span>
          <strong>{money(Math.max(0, totalWithVat))}</strong>
        </article>
      </div>

      <label className="field">
        <span>ملاحظات داخلية</span>
        <textarea className="input textarea" value={notes} onChange={(event) => setNotes(event.target.value)} />
      </label>

      <label className="field">
        <span>الشروط التي تظهر في الفاتورة</span>
        <textarea className="input textarea" value={terms} onChange={(event) => setTerms(event.target.value)} />
      </label>

      <div className="form-actions">
        <button className="btn primary" type="submit" disabled={saving}>
          <FileText size={16} /> {saving ? "جاري الحفظ..." : "حفظ الفاتورة"}
        </button>
        <button className="btn muted" type="button" onClick={onCancel}>إلغاء</button>
      </div>
    </form>
  );
}

export default InvoicesPage;
