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
import { createPortal, flushSync } from "react-dom";
import * as api from "../api";
import { calculateDocumentLineAmounts, calculateDocumentTotals } from "../../shared/financial";
import { cleanInvoiceTerms, generateZatcaQrBase64, resolveInvoiceTaxType } from "../../shared/zatca";

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
const sellerEnglishName = "BreeXe Pro Co.";
const sellerCrNumber = "7016449519";
const sellerPhone = "+966533971168";

const invoiceKind = (invoice: api.Invoice) => {
  const type = resolveInvoiceTaxType({
    requested: invoice.invoice_type,
    buyerVat: invoice.customer_vat,
    taxableAmount: invoice.total_without_vat,
  });
  return type === "tax"
    ? { type, ar: "فاتورة ضريبية", en: "Tax Invoice" }
    : { type, ar: "فاتورة ضريبية مبسطة", en: "Simplified Tax Invoice" };
};
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
  try {
    return generateZatcaQrBase64({
      sellerName: invoice.seller_name || sellerEnglishName,
      vatNumber: invoice.seller_vat_number,
      timestamp: invoiceTimestamp(invoice),
      total: invoice.total_with_vat,
      vatTotal: invoice.vat_amount,
    });
  } catch {
    return "";
  }
}

/* ── QR Code component ─────────────────────────────────── */

function QRCodeDisplay({ data, size = 80 }: { data: string; size?: number }) {
  const [src, setSrc] = useState("");

  useEffect(() => {
    let active = true;
    if (!data) {
      setSrc("");
      return () => { active = false; };
    }
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
    ? <img src={src} width={size} height={size} className="zatca-qr-code" alt="رمز الفاتورة الضريبية" />
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
  .invoice-parties { grid-template-columns: minmax(0, 1fr) auto !important; align-items: stretch !important; }
  .invoice-bottom-grid { display: flex !important; justify-content: flex-end !important; align-items: start !important; }
  .invoice-doc-totals { width: min(100%, 300px) !important; }
  .invoice-doc-table { display: table !important; }
  .invoice-doc-table thead {
    position: static !important;
    width: auto !important;
    height: auto !important;
    overflow: visible !important;
    clip: auto !important;
    clip-path: none !important;
    white-space: normal !important;
  }
  .invoice-doc-table tbody { display: table-row-group !important; }
  .invoice-doc-table tbody tr { display: table-row !important; padding: 0 !important; }
  .invoice-doc-table td,
  .invoice-doc-table td:nth-child(2) {
    display: table-cell !important;
    padding: 7px 5px !important;
    border-bottom: 1px solid #d7e0ea !important;
    text-align: center !important;
  }
  .invoice-doc-table td:nth-child(2) { text-align: right !important; }
  .invoice-doc-table td::before { display: none !important; content: none !important; }
  .invoice-doc-head,
  .invoice-identity-grid,
  .invoice-parties,
  .invoice-bottom-grid { gap: 7px !important; }
  .invoice-parties,
  .invoice-doc-table,
  .invoice-bottom-grid { margin-bottom: 8px !important; }
  .invoice-doc-head { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  .invoice-brand-logo { width: 194px !important; height: 61px !important; object-fit: contain !important; flex-shrink: 0 !important; }
`;

async function replaceInvoiceQrInClone(clone: HTMLElement, invoice: api.Invoice) {
  const qrTarget = clone.querySelector<HTMLElement>(".zatca-qr-code");
  if (!qrTarget) return;
  const qrData = generateZATCAQR(invoice);
  if (!qrData) return;
  const qrSrc = await QRCode.toDataURL(qrData, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 104,
    color: { dark: "#000000", light: "#ffffff" },
  });
  if (qrTarget instanceof HTMLImageElement) {
    qrTarget.src = qrSrc;
    qrTarget.width = 104;
    qrTarget.height = 104;
    return;
  }
  const qrImage = document.createElement("img");
  qrImage.src = qrSrc;
  qrImage.width = 104;
  qrImage.height = 104;
  qrImage.className = "zatca-qr-code";
  qrImage.alt = "رمز الفاتورة الضريبية";
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

function addInvoiceCanvasPages(pdf: jsPDF, canvas: HTMLCanvasElement, invoiceNode: HTMLElement) {
  const pageWidthMm = 210;
  const pageHeightMm = 297;
  const pageHeightPx = canvas.width * pageHeightMm / pageWidthMm;
  const rootTop = invoiceNode.getBoundingClientRect().top;
  const canvasScale = canvas.width / invoiceNode.scrollWidth;
  const safeBreaks = Array.from(invoiceNode.querySelectorAll<HTMLElement>(
    ".invoice-doc-table tbody tr, .invoice-parties, .invoice-bottom-grid, .invoice-doc-terms",
  ))
    .flatMap((element) => {
      const rect = element.getBoundingClientRect();
      return [rect.top - rootTop, rect.bottom - rootTop];
    })
    .map((value) => Math.round(value * canvasScale))
    .filter((value) => value > 0 && value < canvas.height)
    .sort((left, right) => left - right);

  let start = 0;
  let page = 0;
  while (start < canvas.height) {
    const maximum = Math.min(canvas.height, Math.floor(start + pageHeightPx));
    const minimumUseful = start + Math.floor(pageHeightPx * 0.35);
    const safe = safeBreaks.filter((value) => value >= minimumUseful && value <= maximum - 4).at(-1);
    const end = maximum < canvas.height ? (safe || maximum) : canvas.height;
    const slice = document.createElement("canvas");
    slice.width = canvas.width;
    slice.height = Math.max(1, end - start);
    const context = slice.getContext("2d");
    if (!context) throw new Error("Invoice PDF canvas is unavailable.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, slice.width, slice.height);
    context.drawImage(canvas, 0, start, canvas.width, slice.height, 0, 0, canvas.width, slice.height);
    if (page > 0) pdf.addPage();
    const heightMm = slice.height * pageWidthMm / slice.width;
    pdf.addImage(slice.toDataURL("image/png"), "PNG", 0, 0, pageWidthMm, heightMm, undefined, "FAST");
    start = end;
    page += 1;
  }
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
    addInvoiceCanvasPages(pdf, canvas, invoiceNode);
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
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="modal wide invoice-modal" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" type="button" title="إغلاق" aria-label="إغلاق" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        {children}
      </section>
    </div>,
    document.body,
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
    `${invoiceKind(invoice).ar} - ${invoice.seller_name || sellerEnglishName}`,
    `رقم الفاتورة: ${invoice.invoice_number}`,
    invoice.title || "فاتورة",
    `العميل: ${invoice.customer_name}`,
    invoice.customer_phone ? `الجوال: ${invoice.customer_phone}` : "",
    invoice.customer_vat ? `الرقم الضريبي للعميل: ${invoice.customer_vat}` : "",
    "",
    ...lines,
    "",
    `المجموع قبل الخصم والضريبة: ${money(invoice.subtotal, invoice.currency)}`,
    invoice.discount ? `الخصم: ${money(invoice.discount, invoice.currency)}` : "",
    `الخاضع للضريبة بعد الخصم: ${money(invoice.total_without_vat, invoice.currency)}`,
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
        window.open(result.redirect_url, "_blank", "noopener,noreferrer");
        notify("جاري توجيهك لبوابة الدفع…");
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
          <h1>الفواتير الضريبية</h1>
          <p>إصدار الفواتير وإدارتها وطباعتها ومشاركتها مع العملاء.</p>
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
          name="invoice_search"
          autoComplete="off"
          aria-label="بحث في الفواتير"
          placeholder="بحث برقم الفاتورة أو العميل أو الجوال…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select className="input" name="invoice_status_filter" autoComplete="off" aria-label="تصفية الفواتير حسب الحالة" value={status} onChange={(event) => setStatus(event.target.value)}>
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
          <p>جاري تحميل الفواتير…</p>
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
                <button className="icon-btn success" type="button" title="تأكيد الدفع" aria-label="تأكيد الدفع" onClick={() => setInvoiceStatus(invoice, "paid")} disabled={invoice.status === "paid"}>
                  <CheckCircle2 size={15} />
                </button>
                <button className="icon-btn" type="button" title="تعليم كمرسلة" aria-label="تعليم الفاتورة كمرسلة" onClick={() => setInvoiceStatus(invoice, "sent")} disabled={invoice.status === "sent" || invoice.status === "paid"}>
                  <Send size={15} />
                </button>
                <button className="icon-btn" type="button" title="طباعة" aria-label="طباعة الفاتورة" onClick={() => printInvoice(invoice)}>
                  <Printer size={15} />
                </button>
                <button className="icon-btn" type="button" title="معاينة" aria-label="معاينة الفاتورة" onClick={() => setPreview(invoice)}>
                  <Eye size={15} />
                </button>
                <button className="icon-btn" type="button" title="نسخ" aria-label="نسخ نص الفاتورة" onClick={() => copyInvoice(invoice)}>
                  <Copy size={15} />
                </button>
                <button className="icon-btn" type="button" title="تعديل" aria-label="تعديل الفاتورة" onClick={() => setEditing(invoice)}>
                  <Edit3 size={15} />
                </button>
                {invoice.customer_phone && (
                  <button
                    className="icon-btn"
                    type="button"
                    title="إرسال واتساب"
                    aria-label="إرسال الفاتورة عبر واتساب"
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
                    aria-label="دفع الفاتورة الآن"
                    onClick={() => handlePayInvoice(invoice)}
                  >
                    <CreditCard size={15} />
                  </button>
                )}
                <button className="icon-btn danger" type="button" title="إلغاء" aria-label="إلغاء الفاتورة" onClick={() => setInvoiceStatus(invoice, "cancelled")} disabled={invoice.status === "cancelled"}>
                  <X size={15} />
                </button>
                <button className="icon-btn danger" type="button" title="مستردة" aria-label="تعليم الفاتورة كمستردة" onClick={() => setInvoiceStatus(invoice, "refunded")} disabled={invoice.status === "refunded"}>
                  <RefreshCcw size={15} />
                </button>
                <button className="icon-btn danger" type="button" title="حذف" aria-label="حذف الفاتورة" onClick={() => remove(invoice)}>
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

function invoiceBreakdown(invoice: api.Invoice) {
  return calculateDocumentLineAmounts({
    lines: invoice.items,
    discountValue: invoice.discount_value ?? invoice.discount,
    discountMode: invoice.discount_mode === "percent" ? "percent" : "fixed",
    vatPercent: invoice.vat_percent,
  });
}

function InvoicePreview({ invoice, onCopy, onPrint }: { invoice: api.Invoice; onCopy: () => void; onPrint: (asPdf?: boolean) => void }) {
  const qrCode = useMemo(() => generateZATCAQR(invoice), [invoice]);
  const kind = invoiceKind(invoice);
  const breakdown = useMemo(() => invoiceBreakdown(invoice), [invoice]);
  const visibleTerms = cleanInvoiceTerms(invoice.terms);
  const [sellerOption, setSellerOption] = useState<string>(invoiceSellerOptions[0]);
  const [customSeller, setCustomSeller] = useState("");
  const exportSellerName = sellerOption === "custom" ? customSeller.trim() : sellerOption;

  return (
    <div className="quote-preview">
      <section className="invoice-a4-doc" dir="rtl">
        <header className="invoice-doc-head">
          <div className="invoice-brand-block">
            <img className="invoice-brand-logo" src="/brand/logo-full.png" alt="BreeXe Pro" width={194} height={61} />
            <div className="invoice-brand-copy">
              <strong>{sellerLegalName}</strong>
              <small>{invoice.seller_address || "الرياض، المملكة العربية السعودية"}</small>
              <small><bdi dir="ltr">{sellerPhone}</bdi></small>
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
            <span>تاريخ الإصدار</span>
            <strong>{invoice.issue_date}</strong>
          </article>
          <article>
            <span>الرقم الضريبي للبائع</span>
            <strong>{invoice.seller_vat_number || "-"}</strong>
          </article>
          <article>
            <span>السجل التجاري</span>
            <strong>{sellerCrNumber}</strong>
          </article>
          <article>
            <span>المندوب</span>
            <strong>{exportSellerName || "-"}</strong>
          </article>
        </section>

        <section className="invoice-parties">
          <article className="invoice-customer-card">
            <h3>بيانات العميل</h3>
            <dl className="invoice-party-facts">
              <div><dt>الاسم</dt><dd>{invoice.customer_name || "-"}</dd></div>
              <div><dt>الجوال</dt><dd><bdi dir="ltr">{invoice.customer_phone || "-"}</bdi></dd></div>
              <div><dt>المدينة</dt><dd>{invoice.customer_city || "-"}</dd></div>
              <div><dt>الرقم الضريبي</dt><dd>{invoice.customer_vat || "-"}</dd></div>
            </dl>
          </article>
          <aside className="invoice-zatca-card" aria-label="رمز الفاتورة الضريبية">
            <QRCodeDisplay data={qrCode} size={96} />
          </aside>
        </section>

        <table className="invoice-doc-table">
          <thead>
            <tr>
              <th>#</th>
              <th>البيان</th>
              <th>الكمية</th>
              <th>سعر الوحدة قبل الضريبة</th>
              <th>خصم البند</th>
              <th>الخاضع بعد الخصم</th>
              <th>VAT</th>
              <th>الإجمالي شامل الضريبة</th>
            </tr>
          </thead>
          <tbody>
            {invoice.items.map((item, index) => {
              const line = breakdown.lines[index];
              const quantity = Math.max(0, Number(item.quantity || 0));
              const unitNet = quantity ? line.netBeforeDiscount / quantity : 0;
              return (
                <tr key={`${item.description}-${index}`}>
                  <td data-label="البند">{index + 1}</td>
                  <td className="invoice-line-description" data-label="البيان">
                    {item.description}
                    {item.product_sku && (
                      <small style={{ display: "block", opacity: 0.6, fontSize: "0.85em", direction: "ltr", textAlign: "right" }}>
                        {item.product_sku}
                      </small>
                    )}
                  </td>
                  <td data-label="الكمية">{quantity}</td>
                  <td data-label="سعر الوحدة قبل الضريبة">{money(unitNet, invoice.currency)}</td>
                  <td data-label="خصم البند">{money(line.discount, invoice.currency)}</td>
                  <td data-label="الخاضع بعد الخصم">{money(line.taxableAmount, invoice.currency)}</td>
                  <td data-label="الضريبة">{money(line.vat, invoice.currency)}</td>
                  <td data-label="الإجمالي شامل الضريبة">{money(line.gross, invoice.currency)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <section className="invoice-bottom-grid">
          <div className="invoice-doc-totals">
            <p><span>المجموع قبل الخصم والضريبة</span><strong>{money(invoice.subtotal, invoice.currency)}</strong></p>
            <p><span>الخصم</span><strong>{money(invoice.discount, invoice.currency)}</strong></p>
            <p><span>الخاضع للضريبة بعد الخصم</span><strong>{money(invoice.total_without_vat, invoice.currency)}</strong></p>
            <p><span>ضريبة القيمة المضافة ({invoice.vat_percent}%)</span><strong>{money(invoice.vat_amount, invoice.currency)}</strong></p>
            <p className="grand"><span>الإجمالي شامل الضريبة</span><strong>{money(invoice.total_with_vat, invoice.currency)}</strong></p>
          </div>
        </section>

        {visibleTerms && <p className="invoice-doc-terms">{visibleTerms}</p>}
      </section>
      <div className="form-actions">
        <div className="invoice-export-options">
          <label>
            <span>المندوب (يظهر على الفاتورة)</span>
            <select className="input" name="invoice_representative" autoComplete="off" value={sellerOption} onChange={(event) => setSellerOption(event.target.value)}>
              {invoiceSellerOptions.map((name) => <option key={name} value={name}>{name}</option>)}
              <option value="custom">إضافة جديد</option>
            </select>
          </label>
          {sellerOption === "custom" && (
            <label>
              <span>اسم جديد</span>
              <input className="input" name="custom_invoice_representative" autoComplete="off" value={customSeller} onChange={(event) => setCustomSeller(event.target.value)} placeholder="اكتب اسم المندوب…" />
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
  const [invoiceType, setInvoiceType] = useState<api.InvoiceTaxType | "auto">(initial?.invoice_type || "auto");
  const [issueDate, setIssueDate] = useState(initial?.issue_date || today());
  const [dueDate, setDueDate] = useState(initial?.due_date || addDays(today(), 30));
  const [vatPercent, setVatPercent] = useState(String(initial?.vat_percent ?? 15));
  const [discountMode, setDiscountMode] = useState<api.DiscountMode>(initial?.discount_mode || "fixed");
  const [discountValue, setDiscountValue] = useState(String(initial?.discount_value ?? initial?.discount ?? 0));
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
  const financialTotals = useMemo(() => calculateDocumentTotals({
    lines: normalizedItems,
    discountValue: Number(discountValue || 0),
    discountMode,
    vatPercent: Number(vatPercent || 0),
  }), [normalizedItems, discountValue, discountMode, vatPercent]);
  const vatRate = financialTotals.vatPercent / 100;
  const resolvedInvoiceType = resolveInvoiceTaxType({
    requested: invoiceType,
    buyerVat: customerVat,
    taxableAmount: financialTotals.totalWithoutVat,
  });

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
        invoice_type: invoiceType,
        status,
        issue_date: issueDate,
        due_date: dueDate || null,
        vat_percent: Number(vatPercent || 15),
        discount: financialTotals.discountAmount,
        discount_mode: discountMode,
        discount_value: Number(discountValue || 0),
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
          <select className="input" name="customer_id" autoComplete="off" value={customerId} onChange={(event) => setCustomerId(event.target.value)}>
            <option value="">عميل جديد / إدخال يدوي</option>
            {(customers.data?.data || []).map((customer) => (
              <option key={customer.id} value={customer.id}>{customer.name} - {customer.phone}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>عنوان الفاتورة</span>
          <input className="input" name="invoice_title" autoComplete="off" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="مثال: توريد وتركيب…" />
        </label>
      </div>

      <div className="form-grid">
        <label className="field">
          <span>اسم العميل</span>
          <input className="input" name="customer_name" autoComplete="name" value={customerName} onChange={(event) => setCustomerName(event.target.value)} required />
        </label>
        <label className="field">
          <span>الجوال</span>
          <input className="input" name="customer_phone" autoComplete="tel" type="tel" inputMode="tel" value={customerPhone} onChange={(event) => setCustomerPhone(event.target.value)} placeholder="مثال: 05xxxxxxxx…" />
        </label>
      </div>

      <div className="form-grid">
        <label className="field">
          <span>المدينة</span>
          <input className="input" name="customer_city" autoComplete="address-level2" value={customerCity} onChange={(event) => setCustomerCity(event.target.value)} />
        </label>
        <label className="field">
          <span>الرقم الضريبي للعميل (اختياري)</span>
          <input className="input" name="customer_vat" autoComplete="off" inputMode="numeric" value={customerVat} onChange={(event) => setCustomerVat(event.target.value.replace(/\D/g, "").slice(0, 15))} placeholder="مثال: 15 رقمًا…" />
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
            <input className="input" name="seller_name" autoComplete="organization" value={sellerName} onChange={(event) => setSellerName(event.target.value)} placeholder={`${sellerEnglishName}…`} required />
          </label>
          <label className="field">
            <span>الرقم الضريبي للبائع</span>
            <input className="input" name="seller_vat" autoComplete="off" inputMode="numeric" value={sellerVat} onChange={(event) => setSellerVat(event.target.value.replace(/\D/g, "").slice(0, 15))} placeholder="15 رقمًا…" required />
          </label>
        </div>
        <label className="field">
          <span>عنوان البائع</span>
          <input className="input" name="seller_address" autoComplete="street-address" value={sellerAddress} onChange={(event) => setSellerAddress(event.target.value)} placeholder={`${sellerLegalName} - الرياض…`} />
        </label>
      </div>

      <div className="form-grid">
        <label className="field">
          <span>حالة الفاتورة</span>
          <select className="input" name="invoice_status" autoComplete="off" value={status} onChange={(event) => setStatus(event.target.value as api.InvoiceStatus)}>
            <option value="issued">مصدرة</option>
            <option value="sent">مرسلة</option>
            <option value="draft">مسودة</option>
            <option value="paid">مدفوعة</option>
            <option value="cancelled">ملغية</option>
            <option value="refunded">مستردة</option>
          </select>
        </label>
        <label className="field">
          <span>نوع الفاتورة</span>
          <select className="input" name="invoice_type" autoComplete="off" value={invoiceType} onChange={(event) => setInvoiceType(event.target.value as api.InvoiceTaxType | "auto")}>
            <option value="auto">تلقائي حسب العميل والمبلغ</option>
            <option value="simplified">فاتورة ضريبية مبسطة (B2C)</option>
            <option value="tax">فاتورة ضريبية (B2B)</option>
          </select>
          <small>النوع الناتج: {resolvedInvoiceType === "tax" ? "فاتورة ضريبية" : "فاتورة ضريبية مبسطة"}</small>
        </label>
      </div>

      <div className="form-grid">
        <label className="field">
          <span>تاريخ الإصدار</span>
          <input className="input" name="issue_date" autoComplete="off" type="date" value={issueDate} onChange={(event) => setIssueDate(event.target.value)} />
        </label>
        <label className="field">
          <span>تاريخ الاستحقاق</span>
          <input className="input" name="due_date" autoComplete="off" type="date" value={dueDate || ""} onChange={(event) => setDueDate(event.target.value)} />
        </label>
      </div>

      <div className="form-grid">
        <label className="field">
          <span>نسبة الضريبة (%)</span>
          <input className="input" name="vat_percent" autoComplete="off" inputMode="decimal" type="number" min={0} max={100} step="0.01" value={vatPercent} onChange={(event) => setVatPercent(event.target.value)} />
        </label>
        <label className="field">
          <span>{discountMode === "percent" ? "نسبة الخصم (%)" : "قيمة الخصم"}</span>
          <input
            className="input"
            name="discount_value"
            autoComplete="off"
            inputMode="decimal"
            type="number"
            min={0}
            max={discountMode === "percent" ? 100 : undefined}
            step={discountMode === "percent" ? "0.01" : "0.01"}
            value={discountValue}
            onChange={(event) => setDiscountValue(event.target.value)}
          />
        </label>
      </div>

      <div className="quote-price-mode" aria-label="طريقة الخصم">
        <span>طريقة الخصم</span>
        <button type="button" className={discountMode === "fixed" ? "active" : ""} onClick={() => setDiscountMode("fixed")}>مبلغ ثابت</button>
        <button type="button" className={discountMode === "percent" ? "active" : ""} onClick={() => setDiscountMode("percent")}>نسبة مئوية</button>
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
              name={`invoice_item_${index}_product`}
              autoComplete="off"
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
              name={`invoice_item_${index}_description`}
              autoComplete="off"
              value={item.description}
              onChange={(event) => updateItem(index, { description: event.target.value })}
              placeholder="وصف البند…"
              required={index === 0}
            />
            <input
              className="input"
              type="number"
              name={`invoice_item_${index}_quantity`}
              autoComplete="off"
              inputMode="decimal"
              min={0}
              step="1"
              value={item.quantity}
              onChange={(event) => updateItem(index, { quantity: Number(event.target.value) })}
              aria-label="الكمية"
            />
            <input
              className="input"
              type="number"
              name={`invoice_item_${index}_unit_price`}
              autoComplete="off"
              inputMode="decimal"
              min={0}
              step="0.01"
              value={item.unit_price}
              onChange={(event) => updateItem(index, { unit_price: Number(event.target.value) })}
              aria-label="سعر الوحدة"
            />
            <select
              className="input line-tax-mode"
              name={`invoice_item_${index}_tax_mode`}
              autoComplete="off"
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
              aria-label={`حذف البند ${index + 1}`}
              onClick={() => setItems((current) => current.filter((_, i) => i !== index))}
              disabled={items.length === 1}
            >
              <X size={15} />
            </button>
          </div>
        ))}
      </div>

      <div className="quote-total-summary">
        <article>
          <span>المجموع قبل الخصم والضريبة</span>
          <strong>{money(financialTotals.subtotal)}</strong>
        </article>
        <article>
          <span>الخصم</span>
          <strong>{money(financialTotals.discountAmount)}</strong>
        </article>
        <article className="vat-summary">
          <span>الخاضع للضريبة بعد الخصم</span>
          <strong>{money(financialTotals.totalWithoutVat)}</strong>
        </article>
        <article>
          <span>ضريبة {financialTotals.vatPercent}%</span>
          <strong>{money(financialTotals.vatAmount)}</strong>
        </article>
        <article className="total">
          <span>الإجمالي شامل الضريبة</span>
          <strong>{money(financialTotals.total)}</strong>
        </article>
      </div>

      <label className="field">
        <span>ملاحظات داخلية</span>
        <textarea className="input textarea" name="invoice_notes" autoComplete="off" value={notes} onChange={(event) => setNotes(event.target.value)} />
      </label>

      <label className="field">
        <span>الشروط التي تظهر في الفاتورة</span>
        <textarea className="input textarea" name="invoice_terms" autoComplete="off" value={terms} onChange={(event) => setTerms(event.target.value)} />
      </label>

      <div className="form-actions">
        <button className="btn primary" type="submit" disabled={saving}>
          <FileText size={16} /> {saving ? "جاري الحفظ…" : "حفظ الفاتورة"}
        </button>
        <button className="btn muted" type="button" onClick={onCancel}>إلغاء</button>
      </div>
    </form>
  );
}

export default InvoicesPage;
