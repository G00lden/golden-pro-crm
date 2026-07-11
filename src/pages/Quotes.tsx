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
  Receipt,
  RefreshCcw,
  Search,
  Send,
  Trash2,
  X,
} from "lucide-react";
import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import * as api from "../api";

type Notifier = (message: string, ok?: boolean) => void;

type QuotesPageProps = {
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
const quoteSellerEnglishName = "Breexe Pro Co.";
const quoteSellerLegalName = "شركة بريكس برو شخص واحد ذات مسؤولية محدودة";

const statusLabels: Record<api.QuoteStatus, string> = {
  draft: "مسودة",
  issued: "مصدر",
  confirmed: "مؤكد",
  declined: "مرفوض",
  expired: "منتهي",
  follow_up: "متابعة",
};

const statusTone: Record<api.QuoteStatus, "muted" | "success" | "danger" | "warn"> = {
  draft: "muted",
  issued: "warn",
  confirmed: "success",
  declined: "danger",
  expired: "danger",
  follow_up: "warn",
};

const defaultTerms = [
  "الأسعار سارية لمدة 7 أيام من تاريخ العرض ما لم يذكر خلاف ذلك.",
  "أي أعمال إضافية خارج البنود المذكورة يتم تسعيرها بشكل مستقل قبل التنفيذ.",
  "مدة التنفيذ تبدأ بعد اعتماد العرض واستلام الدفعة الأولى وتوفر الموقع.",
  "الضمان يخضع لشروط الشركة والمورد ولا يشمل سوء الاستخدام أو التعديل من طرف آخر.",
  "التركيب داخل نطاق الخدمة المعتمد، وأي مواقع خارج النطاق قد يضاف عليها تكلفة نقل.",
].join("\n");

const defaultPayment = {
  method: "تحويل بنكي",
  downPercent: 70,
  finalPercent: 30,
  downText: "عند اعتماد العرض وبدء تنفيذ الطلب.",
  finalText: "بعد التوريد أو التركيب والتشغيل حسب نطاق العمل.",
  bank: "",
  account: "BreeXe Pro",
  iban: "",
  note: "يرجى إرسال إيصال التحويل بعد الدفع لتأكيد الطلب.",
  installments: [
    { percent: 70, label: "عند اعتماد العرض وبدء تنفيذ الطلب." },
    { percent: 30, label: "بعد التوريد أو التركيب والتشغيل حسب نطاق العمل." },
  ] as api.QuoteInstallment[],
};

const quoteTemplates = [
  {
    key: "ac",
    label: "تكييف صحراوي",
    title: "عرض سعر توريد وتركيب مكيفات تكييف صحراوي",
    items: [
      { description: "مكيف مركزي صحراوي مطور نطاق التبريد واسع\n2 حصان", quantity: 3, unit_price: 5950, total: 17850 },
      { description: "خدمة التركيب وتشمل رفع المكيف، تفصيل الدكت، العزل، قاعدة المكيف، والتركيب على المنافذ", quantity: 3, unit_price: 3700, total: 11100 },
      { description: "خدمة تشغيل الوحدات وتشمل مواسير التغذية، التمديدات الكهربائية، الصرف، والتشغيل", quantity: 3, unit_price: 799, total: 2397 },
      { description: "فلتر تنقية جامبو 20 إنش لمعالجة الماء الداخل للمكيف", quantity: 3, unit_price: 299, total: 897 },
    ],
  },
  {
    key: "water",
    label: "تنقية مياه",
    title: "عرض سعر توريد وتركيب منظومة تنقية مياه",
    items: [
      { description: "منظومة تنقية مياه 7 مراحل RO مع خزان 8 لتر", quantity: 1, unit_price: 1200, total: 1200 },
      { description: "خدمة التركيب والتوصيل بشبكة المياه", quantity: 1, unit_price: 300, total: 300 },
      { description: "فلاتر استبدال - طقم سنوي كامل", quantity: 1, unit_price: 250, total: 250 },
    ],
  },
  {
    key: "fog",
    label: "رذاذ وضباب",
    title: "عرض سعر توريد وتركيب نظام رذاذ وضباب",
    items: [
      { description: "نظام رذاذ ضباب ضغط عالي مع مضخة 70 بار", quantity: 1, unit_price: 4500, total: 4500 },
      { description: "خراطيم ونوزل نحاس بالمتر الطولي", quantity: 20, unit_price: 85, total: 1700 },
      { description: "خدمة التركيب والبرمجة والتشغيل", quantity: 1, unit_price: 800, total: 800 },
    ],
  },
  {
    key: "pump",
    label: "مضخة مياه",
    title: "عرض سعر توريد وتركيب مضخة مياه",
    items: [
      { description: "مضخة مياه غاطسة 2 حصان", quantity: 1, unit_price: 1800, total: 1800 },
      { description: "أعمال التمديدات وتركيب المضخة والتشغيل", quantity: 1, unit_price: 500, total: 500 },
    ],
  },
  {
    key: "filter",
    label: "فلاتر شاور",
    title: "عرض سعر توريد فلاتر شاور",
    items: [
      { description: "فلتر شاور كروم لتنقية مياه الاستحمام", quantity: 5, unit_price: 180, total: 900 },
      { description: "فلتر شاور بلاستيك اقتصادي", quantity: 5, unit_price: 95, total: 475 },
    ],
  },
];

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

const paymentForQuote = (quote: api.Quote) => {
  const installments = quote.installments?.length
    ? quote.installments
    : [
        { percent: Number(quote.payment_down_percent ?? defaultPayment.downPercent), label: quote.payment_down_text || defaultPayment.downText },
        { percent: Number(quote.payment_final_percent ?? defaultPayment.finalPercent), label: quote.payment_final_text || defaultPayment.finalText },
      ];
  return {
    method: quote.payment_method || defaultPayment.method,
    downPercent: Number(quote.payment_down_percent ?? defaultPayment.downPercent),
    finalPercent: Number(quote.payment_final_percent ?? defaultPayment.finalPercent),
    downText: quote.payment_down_text || defaultPayment.downText,
    finalText: quote.payment_final_text || defaultPayment.finalText,
    bank: quote.payment_bank || defaultPayment.bank,
    account: quote.payment_account || defaultPayment.account,
    iban: quote.payment_iban || defaultPayment.iban,
    note: quote.payment_note || defaultPayment.note,
    installments,
  };
};

const quoteStandaloneCss = `
  @page { size: A4; margin: 0; }
  html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
  body { width: 210mm !important; overflow: visible !important; }
  .quote-print-shell { width: 210mm !important; margin: 0 !important; padding: 0 !important; background: #fff !important; }
  .quote-document-stage {
    display: block !important;
    max-height: none !important;
    overflow: visible !important;
    padding: 0 !important;
    border-radius: 0 !important;
    background: #fff !important;
  }
  .quote-a4-doc {
    width: 210mm !important;
    min-height: 297mm !important;
    margin: 0 !important;
    border: 0 !important;
    border-radius: 0 !important;
    box-shadow: none !important;
    page-break-after: always !important;
    break-after: page !important;
  }
  .quote-a4-doc:last-child { page-break-after: auto !important; break-after: auto !important; }
  .quote-cover-page,
  .quote-doc-head,
  .quote-doc-title,
  .quote-doc-table th,
  .quote-payment-block h3,
  .quote-terms-block h3 {
    print-color-adjust: exact;
    -webkit-print-color-adjust: exact;
  }
`;

function quoteStylesMarkup() {
  return Array.from(document.querySelectorAll<HTMLLinkElement | HTMLStyleElement>('link[rel="stylesheet"], style'))
    .map((element) => element.outerHTML)
    .join("\n");
}

function waitForQuoteDocumentAssets(doc: Document) {
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

function buildQuoteDocumentHtml(quote: api.Quote) {
  const quoteNode = document.querySelector<HTMLElement>(".quote-document-stage");
  if (!quoteNode) throw new Error("Quote preview is not ready.");
  const clone = quoteNode.cloneNode(true) as HTMLElement;
  const title = `عرض سعر إلى ${safeFilePart(quote.customer_name)}`;
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <base href="${window.location.origin}/" />
  <title>${escapeHtml(title)}</title>
  ${quoteStylesMarkup()}
  <style>${quoteStandaloneCss}</style>
</head>
<body class="quote-print-body">
  <main class="quote-print-shell">${clone.outerHTML}</main>
</body>
</html>`;
}

async function writeQuoteHtmlToFrame(frame: HTMLIFrameElement, html: string) {
  const doc = frame.contentDocument;
  if (!doc) throw new Error("Quote frame is not available.");
  await new Promise<void>((resolve) => {
    frame.onload = () => resolve();
    doc.open();
    doc.write(html);
    doc.close();
    window.setTimeout(resolve, 500);
  });
  await waitForQuoteDocumentAssets(doc);
  return doc;
}

async function saveQuotePdfFile(quote: api.Quote) {
  const html = buildQuoteDocumentHtml(quote);
  const frame = document.createElement("iframe");
  frame.title = "quote-pdf-frame";
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
    const doc = await writeQuoteHtmlToFrame(frame, html);
    const pages = Array.from(doc.querySelectorAll<HTMLElement>(".quote-a4-doc"));
    if (!pages.length) throw new Error("Quote PDF pages are not available.");
    const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    for (const [index, page] of pages.entries()) {
      const canvas = await html2canvas(page, {
        backgroundColor: "#ffffff",
        logging: false,
        scale: 2,
        useCORS: true,
        windowWidth: page.scrollWidth,
        windowHeight: page.scrollHeight,
      });
      if (index > 0) pdf.addPage();
      pdf.addImage(canvas.toDataURL("image/jpeg", 0.85), "JPEG", 0, 0, 210, 297);
    }
    pdf.save(`${safeFilePart(quote.quote_number)}-${safeFilePart(quote.customer_name)}.pdf`);
  } finally {
    frame.remove();
  }
}

async function printQuoteInNewWindow(quote: api.Quote, printWindow: Window | null) {
  if (!printWindow) throw new Error("Popup blocked.");
  const html = buildQuoteDocumentHtml(quote);
  const doc = printWindow.document;
  doc.open();
  doc.write(html);
  doc.close();
  await waitForQuoteDocumentAssets(doc);
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

function QuoteBadge({ status }: { status: api.QuoteStatus }) {
  return <span className={`badge ${statusTone[status]}`}>{statusLabels[status]}</span>;
}

function QuoteModal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
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

function quoteSummaryRows(stats: api.QuoteStats) {
  return [
    { label: "كل العروض", value: stats.total, icon: <FileText size={18} /> },
    { label: "مصدرة", value: stats.issued, icon: <Send size={18} /> },
    { label: "مؤكدة", value: stats.confirmed, icon: <CheckCircle2 size={18} /> },
    { label: "متابعة", value: stats.follow_up, icon: <Clock3 size={18} /> },
  ];
}

function quoteShareText(quote: api.Quote) {
  const lines = quote.items.map((item) => `- ${item.description} × ${item.quantity}: ${money(item.total, quote.currency)}`);
  const payment = paymentForQuote(quote);
  const instLines = payment.installments.map(
    (inst, i) => `${i === 0 ? "الدفعة الأولى" : i === payment.installments.length - 1 ? "الدفعة النهائية" : `الدفعة ${i + 1}`} ${inst.percent}%: ${money((quote.total || 0) * inst.percent / 100, quote.currency)}`,
  );
  return [
    "عرض سعر من BreeXe Pro",
    `رقم العرض: ${quote.quote_number}`,
    quote.title || "عرض سعر",
    `العميل: ${quote.customer_name}`,
    quote.valid_until ? `صالح حتى: ${quote.valid_until}` : "",
    "",
    ...lines,
    "",
    `الإجمالي: ${money(quote.total, quote.currency)}`,
    `طريقة الدفع: ${payment.method}`,
    ...instLines,
    quote.terms ? `الشروط: ${quote.terms}` : "",
  ].filter(Boolean).join("\n");
}

export function QuotesPage({ notify, refreshStats }: QuotesPageProps) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [editing, setEditing] = useState<api.Quote | null>(null);
  const [preview, setPreview] = useState<api.Quote | null>(null);
  const [creating, setCreating] = useState(false);
  const [sendingQuoteId, setSendingQuoteId] = useState("");
  const quotes = useAsyncData(() => api.getQuotes({ search, status }), [search, status]);
  const stats = quotes.data?.stats || {
    total: 0,
    draft: 0,
    issued: 0,
    confirmed: 0,
    follow_up: 0,
    declined: 0,
    expired: 0,
    total_value: 0,
    confirmed_value: 0,
  };

  const refreshAll = async () => {
    await Promise.all([quotes.refresh(), refreshStats()]);
  };

  const saveQuote = async (payload: api.QuoteInput) => {
    try {
      if (editing) {
        await api.updateQuote(editing.id, payload);
        notify("تم حفظ عرض السعر");
      } else {
        await api.createQuote(payload);
        notify("تم إصدار عرض السعر");
      }
      setCreating(false);
      setEditing(null);
      await refreshAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : "فشل حفظ العرض", false);
      throw err;
    }
  };

  const setQuoteStatus = async (quote: api.Quote, nextStatus: api.QuoteStatus) => {
    try {
      await api.setQuoteStatus(
        quote.id,
        nextStatus,
        nextStatus === "follow_up" ? quote.follow_up_date || today() : undefined,
      );
      notify(nextStatus === "confirmed" ? "تم تأكيد العرض" : "تم تحديث حالة العرض");
      await refreshAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : "تعذر تحديث العرض", false);
    }
  };

  const remove = async (quote: api.Quote) => {
    if (!window.confirm(`حذف عرض السعر ${quote.quote_number}؟`)) return;
    try {
      await api.deleteQuote(quote.id);
      notify("تم حذف عرض السعر");
      await refreshAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : "تعذر حذف العرض", false);
    }
  };

  const copyQuote = async (quote: api.Quote) => {
    try {
      await navigator.clipboard.writeText(quoteShareText(quote));
      notify("تم نسخ نص عرض السعر");
    } catch {
      notify("تعذر نسخ عرض السعر", false);
    }
  };

  const openQuotePrintDialog = async (quote: api.Quote, asPdf = false, printWindow: Window | null = null) => {
    const previousTitle = document.title;
    document.title = `عرض سعر إلى ${safeFilePart(quote.customer_name)}`;
    try {
      if (asPdf) {
        await saveQuotePdfFile(quote);
        notify("تم حفظ ملف PDF لعرض السعر فقط");
      } else {
        await printQuoteInNewWindow(quote, printWindow);
        notify("تم فتح مستند طباعة مستقل لعرض السعر فقط");
      }
    } catch {
      printWindow?.close();
      notify(asPdf ? "تعذر حفظ PDF لعرض السعر." : "تعذر فتح مستند الطباعة. اسمح بفتح النوافذ المنبثقة ثم حاول مرة أخرى.", false);
    } finally {
      document.title = previousTitle;
    }
  };

  const printQuote = (quote: api.Quote, asPdf = false) => {
    const printWindow = asPdf ? null : window.open("", "_blank");
    flushSync(() => setPreview(quote));
    void openQuotePrintDialog(quote, asPdf, printWindow);
  };

  const sendQuoteWhatsApp = async (quote: api.Quote) => {
    if (!quote.customer_phone) {
      notify("أضف رقم جوال العميل قبل إرسال عرض السعر واتساب", false);
      return;
    }
    setSendingQuoteId(quote.id);
    try {
      await api.sendQuoteWhatsApp(quote, quoteShareText(quote));
      notify("تم إرسال عرض السعر عبر واتساب");
    } catch (err) {
      notify(err instanceof Error ? err.message : "تعذر إرسال عرض السعر واتساب", false);
    } finally {
      setSendingQuoteId("");
    }
  };

  return (
    <div className="quotes-workspace cloud-design">
      <section className="cloud-hero quotes-hero">
        <div className="cloud-hero-copy">
          <span className="eyebrow">Quotations</span>
          <h1>عروض الأسعار</h1>
          <p>إصدار عروض سعر، متابعة حالتها، وربطها ببيانات العملاء داخل نفس النظام.</p>
          <div className="hero-actions">
            <button className="btn primary" type="button" onClick={() => setCreating(true)}>
              <Plus size={16} /> إصدار عرض سعر
            </button>
            <button className="btn muted" type="button" onClick={quotes.refresh}>
              <RefreshCcw size={16} /> تحديث
            </button>
          </div>
        </div>
        <div className="hero-status-grid">
          <article>
            <span>قيمة العروض</span>
            <strong>{money(stats.total_value)}</strong>
          </article>
          <article>
            <span>قيمة مؤكدة</span>
            <strong>{money(stats.confirmed_value)}</strong>
          </article>
          <article>
            <span>تحتاج متابعة</span>
            <strong>{stats.follow_up}</strong>
          </article>
        </div>
      </section>

      <div className="stats-grid metric-grid quote-metrics">
        {quoteSummaryRows(stats).map((item) => (
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
          placeholder="بحث برقم العرض أو العميل أو الجوال"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select className="input" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="all">كل الحالات</option>
          <option value="issued">مصدرة</option>
          <option value="confirmed">مؤكدة</option>
          <option value="follow_up">متابعة</option>
          <option value="draft">مسودة</option>
          <option value="declined">مرفوضة</option>
          <option value="expired">منتهية</option>
        </select>
      </div>

      {quotes.loading ? (
        <div className="empty">
          <RefreshCcw size={26} className="spin" />
          <p>جاري تحميل عروض الأسعار...</p>
        </div>
      ) : quotes.error ? (
        <div className="error-box">
          <span>{quotes.error}</span>
          <button className="btn muted" type="button" onClick={quotes.refresh}>إعادة المحاولة</button>
        </div>
      ) : quotes.data?.data.length ? (
        <div className="quotes-list">
          {quotes.data.data.map((quote) => (
            <article className="quote-card" key={quote.id}>
              <div className="quote-card-main">
                <div className="quote-title-line">
                  <strong>{quote.quote_number}</strong>
                  <QuoteBadge status={quote.status} />
                </div>
                <h3>{quote.title || "عرض سعر"}</h3>
                <p>{quote.customer_name} · {quote.customer_phone || "بدون جوال"} · {quote.customer_city || "بدون مدينة"}</p>
                <div className="chips">
                  <span className="badge muted"><CalendarDays size={12} /> {quote.issue_date}</span>
                  {quote.valid_until && <span className="badge muted">صالح حتى {quote.valid_until}</span>}
                  {quote.follow_up_date && <span className="badge warn">متابعة {quote.follow_up_date}</span>}
                </div>
              </div>
              <div className="quote-total-box">
                <span>الإجمالي</span>
                <strong>{money(quote.total, quote.currency)}</strong>
              </div>
              <div className="row-actions">
                <button className="icon-btn gold" type="button" title="تحويل إلى فاتورة" onClick={async () => {
                  try {
                    const id = await api.convertQuoteToInvoice(quote.id);
                    notify("تم تحويل عرض السعر إلى فاتورة ✓");
                    await refreshAll();
                  } catch (err) {
                    notify(err instanceof Error ? err.message : "فشل تحويل عرض السعر", false);
                  }
                }}>
                  <Receipt size={15} />
                </button>
                <button className="icon-btn success" type="button" title="تأكيد" onClick={() => setQuoteStatus(quote, "confirmed")}>
                  <CheckCircle2 size={15} />
                </button>
                <button className="icon-btn" type="button" title="متابعة" onClick={() => setQuoteStatus(quote, "follow_up")}>
                  <Clock3 size={15} />
                </button>
                <button className="icon-btn" type="button" title="طباعة" onClick={() => printQuote(quote)}>
                  <Printer size={15} />
                </button>
                <button className="icon-btn" type="button" title="معاينة" onClick={() => setPreview(quote)}>
                  <Eye size={15} />
                </button>
                <button className="icon-btn" type="button" title="نسخ العرض" onClick={() => copyQuote(quote)}>
                  <Copy size={15} />
                </button>
                <button className="icon-btn" type="button" title="تعديل" onClick={() => setEditing(quote)}>
                  <Edit3 size={15} />
                </button>
                <button className="icon-btn danger" type="button" title="حذف" onClick={() => remove(quote)}>
                  <Trash2 size={15} />
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="empty">
          <FileText size={30} />
          <p>لا توجد عروض أسعار بعد</p>
          <button className="btn primary" type="button" onClick={() => setCreating(true)}>
            <Plus size={16} /> إصدار أول عرض
          </button>
        </div>
      )}

      {(creating || editing) && (
        <QuoteModal title={editing ? "تعديل عرض السعر" : "إصدار عرض سعر"} onClose={() => { setCreating(false); setEditing(null); }}>
          <QuoteForm
            initial={editing || undefined}
            onCancel={() => { setCreating(false); setEditing(null); }}
            onSave={saveQuote}
          />
        </QuoteModal>
      )}
      {preview && (
        <QuoteModal title={`معاينة ${preview.quote_number}`} onClose={() => setPreview(null)}>
          <QuotePreview
            quote={preview}
            onCopy={() => copyQuote(preview)}
            onPrint={(asPdf) => {
              const printWindow = asPdf ? null : window.open("", "_blank");
              void openQuotePrintDialog(preview, asPdf, printWindow);
            }}
          />
        </QuoteModal>
      )}
    </div>
  );
}

function QuotePreview({ quote, onCopy, onPrint }: { quote: api.Quote; onCopy: () => void; onPrint: (asPdf?: boolean) => void }) {
  const payment = paymentForQuote(quote);
  const terms = String(quote.terms || defaultTerms).split(/\n+/).map((line) => line.trim()).filter(Boolean);

  return (
    <div className="quote-preview">
      <div className="quote-document-stage">
        <section className="quote-a4-doc quote-cover-page" dir="rtl">
          <header className="quote-cover-top">
            <div>
              <strong>{quoteSellerEnglishName}</strong>
              <span>{quoteSellerLegalName}</span>
            </div>
            <img src="/brand/logo-social.png" alt="BreeXe Pro" className="quote-logo-mark" />
          </header>
          <div className="quote-cover-body">
            <img src="/brand/logo-social.png" alt="BreeXe Pro" className="quote-cover-logo" />
            <span className="quote-cover-badge">{quote.quote_number}</span>
            <h2>{quote.title || "عرض سعر"}</h2>
            <p>{quote.customer_name} · {quote.issue_date}</p>
          </div>
          <footer className="quote-cover-foot">
            <span>قيمة العرض: <strong>{money(quote.total, quote.currency)}</strong></span>
            <span>صالح حتى: <strong>{quote.valid_until || "-"}</strong></span>
          </footer>
        </section>

        <section className="quote-a4-doc quote-detail-page" dir="rtl">
          <header className="quote-doc-head">
            <div>
              <strong>{quoteSellerEnglishName}</strong>
              <span>{quoteSellerLegalName}</span>
            </div>
            <img src="/brand/logo-social.png" alt="BreeXe Pro" className="quote-logo-mark" />
          </header>

          <div className="quote-doc-title">
            <h2>{quote.title || "عرض سعر"}</h2>
            <p>{quote.quote_number}</p>
          </div>

          <div className="quote-client-grid">
            <span>العميل<br /><strong>{quote.customer_name}</strong></span>
            <span>الجوال<br /><strong>{quote.customer_phone || "-"}</strong></span>
            <span>المدينة<br /><strong>{quote.customer_city || "-"}</strong></span>
            <span>الصلاحية<br /><strong>{quote.valid_until || "-"}</strong></span>
          </div>

          <table className="quote-doc-table">
          <thead>
            <tr>
              <th>#</th>
              <th>البند</th>
              <th>الكمية</th>
              <th>السعر</th>
              <th>الإجمالي</th>
            </tr>
          </thead>
          <tbody>
            {quote.items.map((item, index) => (
              <tr key={`${item.description}-${index}`}>
                <td>{index + 1}</td>
                <td>{item.description}</td>
                <td>{item.quantity}</td>
                <td>{money(item.unit_price, quote.currency)}</td>
                <td>{money(item.total, quote.currency)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={2}>الإجمالي قبل الضريبة</td>
              <td colSpan={3}>{money(quote.total_without_vat ?? (quote.subtotal - quote.discount), quote.currency)}</td>
            </tr>
            {quote.discount > 0 && (
              <tr>
                <td colSpan={2}>الخصم {quote.discount_mode === "percent" ? `(${quote.discount}%)` : ""}</td>
                <td colSpan={3}>{money(quote.discount, quote.currency)}</td>
              </tr>
            )}
            {quote.vat_amount ? (
              <tr>
                <td colSpan={2}>ضريبة القيمة المضافة ({quote.vat_percent ?? 15}%)</td>
                <td colSpan={3}>{money(quote.vat_amount, quote.currency)}</td>
              </tr>
            ) : null}
            <tr>
              <td colSpan={2}>الإجمالي النهائي</td>
              <td colSpan={3}>{money(quote.total, quote.currency)}</td>
            </tr>
          </tfoot>
          </table>

          <section className="quote-payment-block">
            <h3>طريقة الدفع</h3>
            <div className="quote-payment-summary">
              <article><span>الطريقة</span><strong>{payment.method}</strong></article>
              {payment.installments.map((inst, i) => (
                <article key={i}><span>{i === 0 ? "الدفعة الأولى" : i === payment.installments.length - 1 ? "الدفعة النهائية" : `الدفعة ${i + 1}`}</span><strong>{inst.percent}% · {money((quote.total || 0) * inst.percent / 100, quote.currency)}</strong></article>
              ))}
            </div>
            <div className="quote-payment-grid">
              {payment.installments.map((inst, i) => (
                <p key={i}><strong>{i === 0 ? "الدفعة الأولى:" : i === payment.installments.length - 1 ? "الدفعة النهائية:" : `الدفعة ${i + 1}:`}</strong><br />{inst.label}{inst.deadline_days ? ` (خلال ${inst.deadline_days} يوم)` : ""}</p>
              ))}
            </div>
            {(payment.bank || payment.account || payment.iban || payment.note) && (
              <div className="quote-bank-box">
                <span>البنك: <strong>{payment.bank || "-"}</strong></span>
                <span>الحساب: <strong>{payment.account || "-"}</strong></span>
                <span>IBAN: <strong>{payment.iban || "-"}</strong></span>
                <p>{payment.note}</p>
              </div>
            )}
          </section>

          <section className="quote-terms-block">
            <h3>الشروط والأحكام</h3>
            <ol>
              {terms.map((term) => <li key={term}>{term}</li>)}
            </ol>
          </section>

          <footer className="quote-doc-foot">
            <p>{quoteSellerLegalName}</p>
            <div className="quote-foot-seal">Breexe<br />Pro</div>
          </footer>
        </section>
      </div>
      <div className="form-actions">
        <button className="btn primary" type="button" onClick={() => onPrint(false)}><Printer size={16} /> طباعة A4</button>
        <button className="btn muted" type="button" onClick={() => onPrint(true)}><Download size={16} /> حفظ PDF</button>
        <button className="btn muted" type="button" onClick={onCopy}><Copy size={16} /> نسخ نص العرض</button>
      </div>
    </div>
  );
}

function QuoteForm({
  initial,
  onCancel,
  onSave,
}: {
  initial?: api.Quote;
  onCancel: () => void;
  onSave: (payload: api.QuoteInput) => Promise<void>;
}) {
  const customers = useAsyncData(() => api.getCustomers(""), []);
  const products = useAsyncData(() => api.getProducts(), []);
  const [customerId, setCustomerId] = useState(initial?.customer_id || "");
  const [customerName, setCustomerName] = useState(initial?.customer_name || "");
  const [customerPhone, setCustomerPhone] = useState(initial?.customer_phone || "");
  const [customerCity, setCustomerCity] = useState(initial?.customer_city || "");
  const [title, setTitle] = useState(initial?.title || "");
  const [status, setStatus] = useState<api.QuoteStatus>(initial?.status || "issued");
  const [issueDate, setIssueDate] = useState(initial?.issue_date || today());
  const [validUntil, setValidUntil] = useState(initial?.valid_until || addDays(today(), 7));
  const [followUpDate, setFollowUpDate] = useState(initial?.follow_up_date || addDays(today(), 2));
  const [discount, setDiscount] = useState(String(initial?.discount || 0));
  const [discountMode, setDiscountMode] = useState<api.DiscountMode>(initial?.discount_mode || "fixed");
  const [vatPercent, setVatPercent] = useState(String(initial?.vat_percent ?? 15));
  const [tax, setTax] = useState(String(initial?.tax || 0));
  const [notes, setNotes] = useState(initial?.notes || "");
  const [terms, setTerms] = useState(initial?.terms || "العرض صالح حسب التاريخ الموضح، والأسعار بالريال السعودي.");
  const [items, setItems] = useState<api.QuoteItem[]>(
    initial?.items?.length
      ? initial.items
      : [{ description: "", quantity: 1, unit_price: 0, total: 0, vat_excluded: true }],
  );
  const [saving, setSaving] = useState(false);

  // Payment fields
  const [paymentMethod, setPaymentMethod] = useState(initial?.payment_method || defaultPayment.method);
  const [paymentBank, setPaymentBank] = useState(initial?.payment_bank || defaultPayment.bank);
  const [paymentAccount, setPaymentAccount] = useState(initial?.payment_account || defaultPayment.account);
  const [paymentIban, setPaymentIban] = useState(initial?.payment_iban || defaultPayment.iban);
  const [paymentNote, setPaymentNote] = useState(initial?.payment_note || defaultPayment.note);
  const [installments, setInstallments] = useState<api.QuoteInstallment[]>(
    initial?.installments?.length ? initial.installments : [...defaultPayment.installments],
  );

  const installmentsTotal = installments.reduce((s, i) => s + i.percent, 0);
  const canAddInstallment = installments.length < 6;
  const installmentsValid = installmentsTotal === 100;

  const selectedCustomer = customers.data?.data.find((item) => item.id === customerId);

  useEffect(() => {
    if (!selectedCustomer) return;
    setCustomerName(selectedCustomer.name);
    setCustomerPhone(selectedCustomer.phone);
    setCustomerCity(selectedCustomer.city || "");
  }, [selectedCustomer]);

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
  const subtotal = normalizedItems.reduce((sum, item) => sum + item.total, 0);
  const vatRate = Math.max(0, Number(vatPercent || 0)) / 100;
  // Calculate base (VAT-exclusive) subtotal
  const baseSubtotal = normalizedItems.reduce((sum, item) => {
    if (item.vat_excluded === false && vatRate > 0) {
      // Price includes VAT — extract base
      return sum + item.total / (1 + vatRate);
    }
    return sum + item.total;
  }, 0);
  const discountAmount = discountMode === "percent"
    ? baseSubtotal * Math.min(100, Math.max(0, Number(discount || 0))) / 100
    : Math.max(0, Number(discount || 0));
  const afterDiscount = Math.max(0, baseSubtotal - discountAmount);
  const vatAmount = afterDiscount * vatRate;
  const total = Math.round((afterDiscount + vatAmount + Math.max(0, Number(tax || 0))) * 100) / 100;

  const updateItem = (index: number, patch: Partial<api.QuoteItem>) => {
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
        customer_id: customerId || null,
        customer_name: customerName.trim(),
        customer_phone: customerPhone.trim(),
        customer_city: customerCity.trim(),
        title: title.trim(),
        status,
        issue_date: issueDate,
        valid_until: validUntil || null,
        follow_up_date: followUpDate || null,
        discount: Number(discount || 0),
        discount_mode: discountMode,
        tax: Number(tax || 0),
        vat_percent: Number(vatPercent || 15),
        currency: "SAR",
        items: normalizedItems.filter((item) => item.description.trim()),
        notes: notes.trim(),
        terms: terms.trim(),
        payment_method: paymentMethod,
        payment_bank: paymentBank,
        payment_account: paymentAccount,
        payment_iban: paymentIban,
        payment_note: paymentNote,
        installments,
      });
    } catch (err) { // error already notified by parent onSave
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
          <span>عنوان العرض</span>
          <input className="input" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="مثال: عرض فلاتر وصيانة" />
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
          <span>حالة العرض</span>
          <select className="input" value={status} onChange={(event) => setStatus(event.target.value as api.QuoteStatus)}>
            <option value="issued">مصدر</option>
            <option value="draft">مسودة</option>
            <option value="follow_up">متابعة</option>
            <option value="confirmed">مؤكد</option>
            <option value="declined">مرفوض</option>
            <option value="expired">منتهي</option>
          </select>
        </label>
      </div>

      <div className="form-grid">
        <label className="field">
          <span>تاريخ الإصدار</span>
          <input className="input" type="date" value={issueDate} onChange={(event) => setIssueDate(event.target.value)} />
        </label>
        <label className="field">
          <span>صالح حتى</span>
          <input className="input" type="date" value={validUntil || ""} onChange={(event) => setValidUntil(event.target.value)} />
        </label>
      </div>

      <label className="field">
        <span>تاريخ المتابعة</span>
        <input className="input" type="date" value={followUpDate || ""} onChange={(event) => setFollowUpDate(event.target.value)} />
      </label>

      <div className="quote-lines">
        <div className="quote-lines-head">
          <strong>بنود العرض</strong>
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
            <strong>{money(normalizedItems[index]?.total || 0)}</strong>
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
        <div className="quote-price-mode">
          <span>الخصم</span>
          <button type="button" className={discountMode === "fixed" ? "active" : ""} onClick={() => setDiscountMode("fixed")}>مبلغ</button>
          <button type="button" className={discountMode === "percent" ? "active" : ""} onClick={() => setDiscountMode("percent")}>نسبة %</button>
        </div>
        <label className="field">
          <span>{discountMode === "percent" ? "نسبة الخصم (%)" : "الخصم"}</span>
          <input className="input" type="number" min={0} step={discountMode === "percent" ? "1" : "0.01"} max={discountMode === "percent" ? 100 : undefined}
            value={discount} onChange={(event) => setDiscount(event.target.value)} />
        </label>
        <label className="field">
          <span>نسبة الضريبة (%)</span>
          <input className="input" type="number" min={0} max={100} step="1" value={vatPercent} onChange={(event) => setVatPercent(event.target.value)} />
        </label>
        <label className="field">
          <span>ضريبة / رسوم إضافية</span>
          <input className="input" type="number" min={0} step="0.01" value={tax} onChange={(event) => setTax(event.target.value)} />
        </label>
        {vatRate > 0 && (
          <article>
            <span>الضريبة ({vatPercent}%)</span>
            <strong>{money(vatAmount)}</strong>
          </article>
        )}
        <article>
          <span>الإجمالي</span>
          <strong>{money(total)}</strong>
        </article>
      </div>

      <label className="field">
        <span>ملاحظات داخلية</span>
        <textarea className="input textarea" value={notes} onChange={(event) => setNotes(event.target.value)} />
      </label>

      <label className="field">
        <span>الشروط التي تظهر في العرض</span>
        <textarea className="input textarea" value={terms} onChange={(event) => setTerms(event.target.value)} />
      </label>

      <fieldset className="quote-payment-form">
        <legend>طريقة الدفع</legend>

        <div className="form-grid">
          <label className="field">
            <span>طريقة الدفع</span>
            <select className="input" value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}>
              <option value="تحويل بنكي">تحويل بنكي</option>
              <option value="نقدي">نقدي</option>
              <option value="بطاقة ائتمان">بطاقة ائتمان</option>
              <option value="مدى">مدى</option>
              <option value="شيك">شيك</option>
              <option value="أخرى">أخرى</option>
            </select>
          </label>
        </div>

        <div className="quote-installments-section">
          <div className="quote-installments-head">
            <strong>جدول الدفعات</strong>
            <span className="muted">المجموع: {installmentsTotal}% {installmentsTotal !== 100 ? <b className="warn">(يجب أن يساوي 100%)</b> : <b className="ok">✓</b>}</span>
          </div>

          {installments.map((inst, i) => (
            <div className="quote-installment-row" key={i}>
              <span className="inst-num">الدفعة {i + 1}</span>
              <label className="inst-pct">
                <span>%</span>
                <input className="input" type="number" min={1} max={100} value={inst.percent}
                  onChange={(e) => {
                    const v = Math.max(1, Math.min(100, Number(e.target.value) || 1));
                    setInstallments((prev) => prev.map((x, j) => j === i ? { ...x, percent: v } : x));
                  }} />
              </label>
              <label className="inst-label">
                <span>وصف / شرط الدفعة</span>
                <input className="input" value={inst.label}
                  onChange={(e) => setInstallments((prev) => prev.map((x, j) => j === i ? { ...x, label: e.target.value } : x))}
                  placeholder="مثال: عند التوقيع" />
              </label>
              <label className="inst-deadline">
                <span>مهلة (أيام)</span>
                <input className="input" type="number" min={0} value={inst.deadline_days ?? ""}
                  onChange={(e) => setInstallments((prev) => prev.map((x, j) => j === i ? { ...x, deadline_days: e.target.value ? Number(e.target.value) : undefined } : x))}
                  placeholder="اختياري" />
              </label>
              <button className="icon-btn danger" type="button" title="حذف الدفعة"
                onClick={() => setInstallments((prev) => prev.filter((_, j) => j !== i))}
                disabled={installments.length <= 1}>
                <X size={15} />
              </button>
            </div>
          ))}

          <div className="quote-installments-actions">
            <button className="btn muted" type="button" disabled={!canAddInstallment}
              onClick={() => setInstallments((prev) => [...prev, { percent: 0, label: "" }])}>
              <Plus size={14} /> إضافة دفعة
            </button>
          </div>
        </div>

        <div className="form-grid">
          <label className="field">
            <span>البنك</span>
            <input className="input" value={paymentBank} onChange={(e) => setPaymentBank(e.target.value)} placeholder="اسم البنك" />
          </label>
          <label className="field">
            <span>اسم الحساب</span>
            <input className="input" value={paymentAccount} onChange={(e) => setPaymentAccount(e.target.value)} placeholder="صاحب الحساب" />
          </label>
        </div>

        <div className="form-grid">
          <label className="field">
            <span>IBAN</span>
            <input className="input" value={paymentIban} onChange={(e) => setPaymentIban(e.target.value)} placeholder="رقم الآيبان" />
          </label>
          <label className="field">
            <span>ملاحظة الدفع</span>
            <input className="input" value={paymentNote} onChange={(e) => setPaymentNote(e.target.value)} placeholder="تظهر في أسفل العرض" />
          </label>
        </div>
      </fieldset>

      <div className="form-actions">
        <button className="btn primary" type="submit" disabled={saving || !installmentsValid}>
          <FileText size={16} /> {saving ? "جاري الحفظ..." : !installmentsValid ? "مجموع الدفعات ≠ 100%" : "حفظ العرض"}
        </button>
        <button className="btn muted" type="button" onClick={onCancel}>إلغاء</button>
      </div>
    </form>
  );
}

export default QuotesPage;
