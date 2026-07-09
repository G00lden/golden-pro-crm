import {
  CalendarDays,
  CheckCircle2,
  Clock3,
  Copy,
  CreditCard,
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
import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";
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

const productPrice = (product?: api.Product) => Number(product?.sale_price ?? product?.price ?? 0);
const sellerLegalName = "شركة بريكس برو شخص واحد ذات مسؤولية محدودة";
const sellerEnglishName = "Breexe Pro Co.";
const sellerCrNumber = "7016449519";
const sellerPhone = "+966533971168";

// نوع الفاتورة حسب الإجمالي شامل الضريبة: مبسطة ≤ 999، ضريبية (عادية) ≥ 1000
const invoiceKind = (totalWithVat?: number) =>
  Number(totalWithVat || 0) >= 1000
    ? { ar: "فاتورة ضريبية", en: "Tax Invoice" }
    : { ar: "فاتورة ضريبية مبسطة", en: "Simplified Tax Invoice" };
const invoiceSellerOptions = ["أبو عامر", "أبو سيف"] as const;

const statusLabels: Record<api.InvoiceStatus, string> = {
  draft: "مسودة",
  issued: "مصدرة",
  sent: "مرسلة",
  paid: "مدفوعة",
  cancelled: "ملغية",
  refunded: "مستردة",
};

const statusTone: Record<api.InvoiceStatus, "muted" | "success" | "danger" | "warn"> = {
  draft: "muted",
  issued: "warn",
  sent: "success",
  paid: "success",
  cancelled: "danger",
  refunded: "danger",
};

const defaultTerms = "";

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
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/* ── ZATCA QR Code Generation (TLV format) ─────────────── */

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

const invoiceStandaloneCss = `
  @page { size: A4; margin: 0; }
  html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
  body { width: 210mm !important; min-height: 297mm !important; overflow: visible !important; }
  .invoice-print-shell { width: 210mm !important; margin: 0 !important; padding: 0 !important; background: #fff !important; }
  .invoice-a4-doc {
    width: 210mm !important;
    min-height: 297mm !important;
    margin: 0 !important;
    padding: 10mm 12mm !important;
    border: 0 !important;
    border-radius: 0 !important;
    box-shadow: none !important;
  }
  .invoice-doc-head { grid-template-columns: minmax(0, 1fr) minmax(170px, auto) !important; }
  .invoice-identity-grid { grid-template-columns: repeat(4, minmax(0, 1fr)) !important; }
  .invoice-parties { grid-template-columns: minmax(0, 1fr) minmax(0, 250px) !important; align-items: stretch !important; }
  .invoice-party-side { display: grid !important; gap: 8px !important; grid-template-rows: auto 1fr !important; }
  .invoice-bottom-grid { display: flex !important; justify-content: flex-end !important; align-items: start !important; }
  .invoice-doc-totals { width: min(100%, 300px) !important; }
  .invoice-doc-head,
  .invoice-identity-grid,
  .invoice-parties,
  .invoice-bottom-grid { gap: 7px !important; }
  .invoice-parties,
  .invoice-doc-table,
  .invoice-bottom-grid { margin-bottom: 8px !important; }
  .invoice-doc-head { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
`;

async function replaceInvoiceQrInClone(clone: HTMLElement, invoice: api.Invoice) {
  const qrTarget = clone.querySelector<HTMLElement>(".zatca-qr-code");
  if (!qrTarget) return;
  const qrSrc = await QRCode.toDataURL(generateZATCAQR(invoice), {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 140,
    color: { dark: "#000000", light: "#ffffff" },
  });
  if (qrTarget instanceof HTMLImageElement) {
    qrTarget.src = qrSrc;
    qrTarget.width = 140;
    qrTarget.height = 140;
    return;
  }
  const qrImage = document.createElement("img");
  qrImage.src = qrSrc;
  qrImage.width = 140;
  qrImage.height = 140;
  qrImage.className = "zatca-qr-code";
  qrImage.alt = "ZATCA QR code";
  qrTarget.replaceWith(qrImage);
}

function invoiceStylesMarkup() {
  return Array.from(document.querySelectorAll<HTMLLinkElement | HTMLStyleElement>('link[rel="stylesheet"], style'))
    .map((element) => element.outerHTML)
    .join("\n");
}

async function buildInvoiceDocumentHtml(invoice: api.Invoice) {
  const invoiceNode = document.querySelector<HTMLElement>(".invoice-a4-doc");
  if (!invoiceNode) throw new Error("Invoice preview is not ready.");
  const clone = invoiceNode.cloneNode(true) as HTMLElement;
  await replaceInvoiceQrInClone(clone, invoice);
  const title = `فاتورة إلى ${safeFilePart(invoice.customer_name)}`;
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <base href="${window.location.origin}/" />
  <title>${escapeHtml(title)}</title>
  ${invoiceStylesMarkup()}
  <style>${invoiceStandaloneCss}</style>
</head>
<body class="invoice-print-body">
  <main class="invoice-print-shell">${clone.outerHTML}</main>
</body>
</html>`;
}

function waitForDocumentAssets(doc: Document) {
  const fontsReady = doc.fonts?.ready?.catch(() => undefined) || Promise.resolve();
  const imagesReady = Promise.all(Array.from(doc.images).map((image) => {
    if (image.complete) return Promise.resolve();
    return new Promise<void>((resolve) => {
      image.onload = () => resolve();
      image.onerror = () => resolve();
    });
  }));
  return Promise.all([fontsReady, imagesReady]);
}

async function writeInvoiceHtmlToFrame(frame: HTMLIFrameElement, html: string) {
  const doc = frame.contentDocument;
  if (!doc) throw new Error("Invoice frame is not available.");
  await new Promise<void>((resolve) => {
    frame.onload = () => resolve();
    doc.open();
    doc.write(html);
    doc.close();
    window.setTimeout(resolve, 500);
  });
  await waitForDocumentAssets(doc);
  return doc;
}

async function saveInvoicePdfFile(invoice: api.Invoice) {
  const html = await buildInvoiceDocumentHtml(invoice);
  const frame = document.createElement("iframe");
  frame.title = "invoice-pdf-frame";
  Object.assign(frame.style, {
    position: "fixed",
    left: "-10000px",
    top: "0",
    width: "210mm",
    height: "297mm",
    border: "0",
    background: "#fff",
  });
  document.body.appendChild(frame);
  try {
    const doc = await writeInvoiceHtmlToFrame(frame, html);
    const invoiceNode = doc.querySelector<HTMLElement>(".invoice-a4-doc");
    if (!invoiceNode) throw new Error("Invoice PDF node is not available.");
    const canvas = await html2canvas(invoiceNode, {
      backgroundColor: "#ffffff",
      logging: false,
      scale: Math.min(3, Math.max(2, window.devicePixelRatio || 2)),
      useCORS: true,
      windowWidth: invoiceNode.scrollWidth,
      windowHeight: invoiceNode.scrollHeight,
    });
    const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    const imageData = canvas.toDataURL("image/png");
    const pageWidth = 210;
    const pageHeight = 297;
    const imageHeight = (canvas.height * pageWidth) / canvas.width;
    if (imageHeight <= pageHeight + 2) {
      pdf.addImage(imageData, "PNG", 0, 0, pageWidth, pageHeight);
    } else {
      let offset = 0;
      pdf.addImage(imageData, "PNG", 0, offset, pageWidth, imageHeight);
      while (imageHeight + offset > pageHeight) {
        offset -= pageHeight;
        pdf.addPage();
        pdf.addImage(imageData, "PNG", 0, offset, pageWidth, imageHeight);
      }
    }
    pdf.save(`${safeFilePart(invoice.invoice_number)}-${safeFilePart(invoice.customer_name)}.pdf`);
  } finally {
    frame.remove();
  }
}

async function printInvoiceInNewWindow(invoice: api.Invoice, printWindow: Window | null) {
  if (!printWindow) throw new Error("Popup blocked.");
  const html = await buildInvoiceDocumentHtml(invoice);
  const doc = printWindow.document;
  doc.open();
  doc.write(html);
  doc.close();
  await waitForDocumentAssets(doc);
  printWindow.focus();
  window.setTimeout(() => printWindow.print(), 250);
}

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
    { label: "مرسلة", value: stats.sent, icon: <MessageCircle size={18} /> },
    { label: "مدفوعة", value: stats.paid, icon: <CheckCircle2 size={18} /> },
  ];
}

/* ── Share text ────────────────────────────────────────── */

function invoiceShareText(invoice: api.Invoice) {
  const lines = invoice.items.map((item) => `- ${item.description} × ${item.quantity}: ${money(item.total, invoice.currency)}`);
  return [
    `${invoiceKind(invoice.total_with_vat).ar} - ${invoice.seller_name || sellerEnglishName}`,
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
    sent: 0,
    paid: 0,
    cancelled: 0,
    refunded: 0,
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

  const openInvoicePrintDialog = async (invoice: api.Invoice, asPdf = false, printWindow: Window | null = null) => {
    const previousTitle = document.title;
    document.title = `فاتورة إلى ${safeFilePart(invoice.customer_name)}`;
    try {
      if (asPdf) {
        await saveInvoicePdfFile(invoice);
        notify("تم حفظ ملف PDF للفاتورة فقط");
      } else {
        await printInvoiceInNewWindow(invoice, printWindow);
        notify("تم فتح مستند طباعة مستقل للفاتورة فقط");
      }
    } catch {
      printWindow?.close();
      notify(asPdf ? "تعذر حفظ PDF للفاتورة." : "تعذر فتح مستند الطباعة. اسمح بفتح النوافذ المنبثقة ثم حاول مرة أخرى.", false);
    } finally {
      document.title = previousTitle;
    }
  };

  const printInvoice = (invoice: api.Invoice, asPdf = false) => {
    const printWindow = asPdf ? null : window.open("", "_blank");
    flushSync(() => setPreview(invoice));
    void openInvoicePrintDialog(invoice, asPdf, printWindow);
  };

  const sendInvoiceWhatsApp = async (invoice: api.Invoice) => {
    if (!invoice.customer_phone) {
      notify("أضف رقم جوال العميل قبل إرسال الفاتورة واتساب", false);
      return;
    }
    setSendingInvoiceId(invoice.id);
    try {
      await api.sendInvoiceWhatsApp(invoice, invoiceShareText(invoice));
      if (invoice.status === "draft" || invoice.status === "issued") {
        await api.setInvoiceStatus(invoice.id, "sent");
      }
      notify("تم إرسال الفاتورة عبر واتساب");
      await refreshAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : "تعذر إرسال الفاتورة واتساب", false);
    } finally {
      setSendingInvoiceId("");
    }
  };

  const handlePayInvoice = async (invoice: api.Invoice) => {
    if (invoice.status === "paid") {
      notify("الفاتورة مدفوعة مسبقاً");
      return;
    }
    try {
      const result = await api.createPayment(invoice.id);
      if (result.redirect_url) {
        window.open(result.redirect_url, "_blank");
        notify("جاري توجيهك لبوابة الدفع...");
      } else {
        notify("تعذر إنشاء جلسة دفع. تأكد من إعداد بوابة الدفع.", false);
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : "فشل الاتصال ببوابة الدفع", false);
    }
  };

  return (
    <div className="quotes-workspace cloud-design">
      <section className="cloud-hero quotes-hero">
        <div className="cloud-hero-copy">
          <span className="eyebrow">الفواتير الضريبية</span>
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
          <option value="sent">مرسلة</option>
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
                <button className="icon-btn" type="button" title="تعليم كمرسلة" onClick={() => setInvoiceStatus(invoice, "sent")} disabled={invoice.status === "sent" || invoice.status === "paid"}>
                  <Send size={15} />
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
                {invoice.status !== "paid" && invoice.status !== "cancelled" && (
                  <button
                    className="icon-btn accent"
                    type="button"
                    title="ادفع الآن"
                    onClick={() => handlePayInvoice(invoice)}
                  >
                    <CreditCard size={15} />
                  </button>
                )}
                <button className="icon-btn danger" type="button" title="إلغاء" onClick={() => setInvoiceStatus(invoice, "cancelled")} disabled={invoice.status === "cancelled"}>
                  <X size={15} />
                </button>
                <button className="icon-btn danger" type="button" title="مستردة" onClick={() => setInvoiceStatus(invoice, "refunded")} disabled={invoice.status === "refunded"}>
                  <RefreshCcw size={15} />
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
          <InvoicePreview
            invoice={preview}
            onCopy={() => copyInvoice(preview)}
            onPrint={(asPdf) => {
              const printWindow = asPdf ? null : window.open("", "_blank");
              void openInvoicePrintDialog(preview, asPdf, printWindow);
            }}
          />
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
  const kind = invoiceKind(invoice.total_with_vat);
  const issueTime = invoiceTimestamp(invoice).replace("T", " ").replace("Z", " UTC");
  const [sellerOption, setSellerOption] = useState<string>(invoiceSellerOptions[0]);
  const [customSeller, setCustomSeller] = useState("");
  const exportSellerName = sellerOption === "custom" ? customSeller.trim() : sellerOption;

  return (
    <div className="quote-preview">
      <section className="invoice-a4-doc" dir="rtl">
        <header className="invoice-doc-head">
          <div className="invoice-brand-block">
            <img src="/brand/logo-social.png" alt="BreeXe Pro" height={48} style={{ objectFit: "contain", flexShrink: 0 }} />
            <div>
              <span dir="ltr">{invoice.seller_name || sellerEnglishName}</span>
              <strong>{sellerLegalName}</strong>
              <small>{invoice.seller_address || "الرياض، المملكة العربية السعودية"}</small>
              <small dir="ltr">{sellerPhone}</small>
            </div>
          </div>
          <div className="invoice-title-block">
            <span>{kind.en}</span>
            <h2>{kind.ar}</h2>
            {invoice.title && <em style={{ display: "block", fontStyle: "normal", fontSize: "0.8em", opacity: 0.7 }}>{invoice.title}</em>}
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
            <span>المندوب</span>
            <strong>{exportSellerName || "-"}</strong>
          </article>
        </section>

        <section className="invoice-parties">
          <article>
            <h3>بيانات البائع</h3>
            <p><span>الاسم:</span> <bdi>{invoice.seller_name || sellerEnglishName}</bdi></p>
            <p><span>السجل/الاسم القانوني:</span> {sellerLegalName}</p>
            <p><span>الرقم الضريبي:</span> {invoice.seller_vat_number || "-"}</p>
            <p><span>السجل التجاري:</span> {sellerCrNumber}</p>
            <p><span>الجوال:</span> <bdi dir="ltr">{sellerPhone}</bdi></p>
            <p><span>العنوان:</span> {invoice.seller_address || "-"}</p>
          </article>
          <div className="invoice-party-side">
            <article>
              <h3>بيانات العميل</h3>
              <p><span>الاسم:</span> {invoice.customer_name}</p>
              <p><span>الجوال:</span> {invoice.customer_phone || "-"}</p>
              <p><span>المدينة:</span> {invoice.customer_city || "-"}</p>
              <p><span>الرقم الضريبي:</span> {invoice.customer_vat || "-"}</p>
            </article>
            <aside className="invoice-zatca-card">
              <QRCodeDisplay data={qrCode} size={132} />
              <span>رمز الاستجابة السريع — متوافق مع زاتكا</span>
            </aside>
          </div>
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
                  <td>
                    {item.description}
                    {item.product_sku && (
                      <small style={{ display: "block", opacity: 0.6, fontSize: "0.85em", direction: "ltr", textAlign: "right" }}>
                        {item.product_sku}
                      </small>
                    )}
                  </td>
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
          <div className="invoice-doc-totals">
            <p><span>الإجمالي غير شامل الضريبة</span><strong>{money(invoice.total_without_vat, invoice.currency)}</strong></p>
            <p><span>الخصم</span><strong>{money(invoice.discount, invoice.currency)}</strong></p>
            <p><span>ضريبة القيمة المضافة ({invoice.vat_percent}%)</span><strong>{money(invoice.vat_amount, invoice.currency)}</strong></p>
            <p className="grand"><span>الإجمالي شامل الضريبة</span><strong>{money(invoice.total_with_vat, invoice.currency)}</strong></p>
          </div>
        </section>

        {invoice.terms && <p className="invoice-doc-terms">{invoice.terms}</p>}
        <footer className="invoice-doc-foot">
          <strong>{sellerEnglishName}</strong>
        </footer>
      </section>
      <div className="form-actions">
        <div className="invoice-export-options">
          <label>
            <span>المندوب (يظهر على الفاتورة)</span>
            <select className="input" value={sellerOption} onChange={(event) => setSellerOption(event.target.value)}>
              {invoiceSellerOptions.map((name) => <option key={name} value={name}>{name}</option>)}
              <option value="custom">إضافة جديد</option>
            </select>
          </label>
          {sellerOption === "custom" && (
            <label>
              <span>اسم جديد</span>
              <input className="input" value={customSeller} onChange={(event) => setCustomSeller(event.target.value)} placeholder="اكتب اسم البائع" />
            </label>
          )}
        </div>
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
  const [vatPercent, setVatPercent] = useState(String(initial?.vat_percent ?? 15));
  const [discount, setDiscount] = useState(String(initial?.discount || 0));
  const [sellerName, setSellerName] = useState(initial?.seller_name || "");
  const [sellerVat, setSellerVat] = useState(initial?.seller_vat_number || "");
  const [sellerAddress, setSellerAddress] = useState(initial?.seller_address || "");
  const [notes, setNotes] = useState(initial?.notes || "");
  const [terms, setTerms] = useState(initial?.terms || defaultTerms);
  const [items, setItems] = useState<api.InvoiceItem[]>(
    initial?.items?.length
      ? initial.items
      : [{ description: "", quantity: 1, unit_price: 0, total: 0, vat_excluded: true }],
  );
  const [saving, setSaving] = useState(false);

  const selectedCustomer = customers.data?.data.find((item) => item.id === customerId);

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
        vat_excluded: item.vat_excluded !== false,
      })),
    [items],
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
            <option value="sent">مرسلة</option>
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

      <div className="quote-price-mode" aria-label="طريقة إدخال السعر">
        <span>طريقة إدخال السعر</span>
        <small>حدد لكل بند هل السعر المدخل شامل الضريبة أو قبل الضريبة.</small>
        <small>مثال شامل: 5000 تبقى 5000 شامل الضريبة.</small>
        <small>مثال قبل الضريبة: 5000 يضاف عليها VAT في الإجمالي.</small>
      </div>

      <div className="quote-lines">
        <div className="quote-lines-head">
          <strong>بنود الفاتورة</strong>
          <button
            className="btn muted"
            type="button"
            onClick={() => setItems((current) => [...current, { description: "", quantity: 1, unit_price: 0, total: 0, vat_excluded: true }])}
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
                  {product.name}
                  {product.sku ? ` | SKU ${product.sku}` : ""}
                  {product.source ? ` | ${product.source}` : ""}
                  {productPrice(product) ? ` - ${money(productPrice(product), product.currency || "SAR")}` : ""}
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
            <select
              className="input line-tax-mode"
              value={item.vat_excluded === false ? "inclusive" : "exclusive"}
              onChange={(event) => updateItem(index, { vat_excluded: event.target.value !== "inclusive" })}
              aria-label="طريقة ضريبة البند"
            >
              <option value="exclusive">قبل الضريبة</option>
              <option value="inclusive">شامل الضريبة</option>
            </select>
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
