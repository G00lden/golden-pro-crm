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
  QrCode,
  RefreshCcw,
  ReceiptText,
  Search,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import QRCode from "qrcode";
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
  account: "Breexe Pro",
  iban: "",
  note: "يرجى إرسال إيصال التحويل بعد الدفع لتأكيد الطلب.",
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

const paymentForQuote = (quote: api.Quote) => ({
  method: quote.payment_method || defaultPayment.method,
  downPercent: Number(quote.payment_down_percent ?? defaultPayment.downPercent),
  finalPercent: Number(quote.payment_final_percent ?? defaultPayment.finalPercent),
  downText: quote.payment_down_text || defaultPayment.downText,
  finalText: quote.payment_final_text || defaultPayment.finalText,
  bank: quote.payment_bank || defaultPayment.bank,
  account: quote.payment_account || defaultPayment.account,
  iban: quote.payment_iban || defaultPayment.iban,
  note: quote.payment_note || defaultPayment.note,
});

const sellerDefaults = {
  name: import.meta.env.VITE_ZATCA_SELLER_NAME || "Breexe Pro",
  vatNumber: import.meta.env.VITE_ZATCA_VAT_NUMBER || "",
};

const roundMoney = (value: number) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

const invoiceNumber = (quote: api.Quote) => {
  const source = quote.quote_number.replace(/^QT-/, "");
  return `INV-${source || new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
};

const toDatetimeLocal = (value = new Date().toISOString()) => {
  const d = new Date(value);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

const zatcaTimestamp = (value?: string) => new Date(value || Date.now()).toISOString().replace(/\.\d{3}Z$/, "Z");

function zatcaTlvBase64(fields: Array<[number, string]>) {
  const bytes = fields.flatMap(([tag, value]) => {
    const encoded = Array.from(new TextEncoder().encode(value));
    if (encoded.length > 255) throw new Error("قيمة QR أطول من الحد المسموح في TLV.");
    return [tag, encoded.length, ...encoded];
  });
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function buildZatcaQrPayload(data: {
  sellerName: string;
  vatNumber: string;
  issuedAt: string;
  total: number;
  vatAmount: number;
}) {
  return zatcaTlvBase64([
    [1, data.sellerName],
    [2, data.vatNumber],
    [3, zatcaTimestamp(data.issuedAt)],
    [4, roundMoney(data.total).toFixed(2)],
    [5, roundMoney(data.vatAmount).toFixed(2)],
  ]);
}

function useQrDataUrl(payload?: string) {
  const [dataUrl, setDataUrl] = useState("");

  useEffect(() => {
    let cancelled = false;
    if (!payload) {
      setDataUrl("");
      return;
    }
    QRCode.toDataURL(payload, { width: 180, margin: 1, errorCorrectionLevel: "M" })
      .then((value) => {
        if (!cancelled) setDataUrl(value);
      })
      .catch(() => {
        if (!cancelled) setDataUrl("");
      });
    return () => {
      cancelled = true;
    };
  }, [payload]);

  return dataUrl;
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
  const isInvoice = quote.invoice_status === "issued";
  const lines = quote.items.map((item) => `- ${item.description} × ${item.quantity}: ${money(item.total, quote.currency)}`);
  const payment = paymentForQuote(quote);
  return [
    `${isInvoice ? "فاتورة ضريبية" : "عرض سعر"} من Breexe Pro`,
    `${isInvoice ? "رقم الفاتورة" : "رقم العرض"}: ${isInvoice ? quote.invoice_number || invoiceNumber(quote) : quote.quote_number}`,
    quote.title || "عرض سعر",
    `العميل: ${quote.customer_name}`,
    isInvoice && quote.invoice_vat_number ? `الرقم الضريبي: ${quote.invoice_vat_number}` : "",
    isInvoice && quote.invoice_issued_at ? `تاريخ الفاتورة: ${zatcaTimestamp(quote.invoice_issued_at)}` : "",
    !isInvoice && quote.valid_until ? `صالح حتى: ${quote.valid_until}` : "",
    "",
    ...lines,
    "",
    `الإجمالي: ${money(quote.total, quote.currency)}`,
    isInvoice ? `ضريبة القيمة المضافة: ${money(quote.invoice_vat_amount || quote.tax || 0, quote.currency)}` : "",
    `طريقة الدفع: ${payment.method}`,
    `الدفعة الأولى ${payment.downPercent}%: ${money((quote.total || 0) * payment.downPercent / 100, quote.currency)}`,
    `الدفعة النهائية ${payment.finalPercent}%: ${money((quote.total || 0) * payment.finalPercent / 100, quote.currency)}`,
    quote.terms ? `الشروط: ${quote.terms}` : "",
  ].filter(Boolean).join("\n");
}

export function QuotesPage({ notify, refreshStats }: QuotesPageProps) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [editing, setEditing] = useState<api.Quote | null>(null);
  const [preview, setPreview] = useState<api.Quote | null>(null);
  const [issuingInvoice, setIssuingInvoice] = useState<api.Quote | null>(null);
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

  const printQuote = (quote: api.Quote, asPdf = false) => {
    setPreview(quote);
    const previousTitle = document.title;
    document.title = `${quote.invoice_status === "issued" ? "فاتورة ضريبية" : "عرض سعر"} إلى ${safeFilePart(quote.customer_name)}`;
    document.body.classList.add("quote-print-mode");
    const restore = () => {
      document.title = previousTitle;
      document.body.classList.remove("quote-print-mode");
      window.removeEventListener("afterprint", restore);
    };
    window.addEventListener("afterprint", restore);
    window.setTimeout(() => window.print(), 120);
    notify(asPdf ? "اختر حفظ كـ PDF من نافذة الطباعة" : "تم تجهيز عرض السعر للطباعة A4");
  };

  const issueTaxInvoice = async (quote: api.Quote, input: TaxInvoiceInput) => {
    const base = Math.max(0, Number(quote.subtotal || 0) - Number(quote.discount || 0));
    const vatRate = Number(input.vatRate || 15);
    const vatAmount = roundMoney(input.keepExistingTax && quote.tax > 0 ? Number(quote.tax) : base * vatRate / 100);
    const totalWithVat = roundMoney(base + vatAmount);
    const issuedAt = new Date(input.issuedAt).toISOString();
    const qrPayload = buildZatcaQrPayload({
      sellerName: input.sellerName.trim(),
      vatNumber: input.vatNumber.trim(),
      issuedAt,
      total: totalWithVat,
      vatAmount,
    });

    await api.updateQuote(quote.id, {
      ...quote,
      status: "confirmed",
      tax: vatAmount,
      invoice_status: "issued",
      invoice_number: input.invoiceNumber.trim(),
      invoice_issued_at: issuedAt,
      invoice_seller_name: input.sellerName.trim(),
      invoice_vat_number: input.vatNumber.trim(),
      invoice_vat_rate: vatRate,
      invoice_vat_amount: vatAmount,
      invoice_qr_payload: qrPayload,
      invoice_phase: "zatca_phase1_tlv_tags_1_5",
    });
    notify("تم تحويل عرض السعر إلى فاتورة ضريبية مع QR");
    setIssuingInvoice(null);
    await refreshAll();
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
                  {quote.invoice_status === "issued" && <span className="badge success"><ReceiptText size={12} /> {quote.invoice_number}</span>}
                </div>
              </div>
              <div className="quote-total-box">
                <span>الإجمالي</span>
                <strong>{money(quote.total, quote.currency)}</strong>
              </div>
              <div className="row-actions">
                <button className="icon-btn success" type="button" title="تأكيد" onClick={() => setQuoteStatus(quote, "confirmed")}>
                  <CheckCircle2 size={15} />
                </button>
                <button className="icon-btn success" type="button" title="تحويل لفاتورة ضريبية" onClick={() => setIssuingInvoice(quote)}>
                  <ReceiptText size={15} />
                </button>
                <button className="icon-btn" type="button" title="متابعة" onClick={() => setQuoteStatus(quote, "follow_up")}>
                  <Clock3 size={15} />
                </button>
                <button className="icon-btn" type="button" title="طباعة A4" onClick={() => printQuote(quote)}>
                  <Printer size={15} />
                </button>
                <button className="icon-btn" type="button" title="تصدير PDF" onClick={() => printQuote(quote, true)}>
                  <Download size={15} />
                </button>
                <button className="icon-btn success" type="button" title="إرسال واتساب" onClick={() => sendQuoteWhatsApp(quote)} disabled={sendingQuoteId === quote.id}>
                  <MessageCircle size={15} />
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
      {issuingInvoice && (
        <QuoteModal title={`تحويل ${issuingInvoice.quote_number} إلى فاتورة ضريبية`} onClose={() => setIssuingInvoice(null)}>
          <TaxInvoiceForm
            quote={issuingInvoice}
            onCancel={() => setIssuingInvoice(null)}
            onIssue={(input) => issueTaxInvoice(issuingInvoice, input)}
          />
        </QuoteModal>
      )}
      {preview && (
        <QuoteModal title={`معاينة ${preview.quote_number}`} onClose={() => setPreview(null)}>
          <QuotePreview
            quote={preview}
            onCopy={() => copyQuote(preview)}
            onPrint={() => printQuote(preview)}
            onExport={() => printQuote(preview, true)}
            onWhatsApp={() => sendQuoteWhatsApp(preview)}
            sending={sendingQuoteId === preview.id}
          />
        </QuoteModal>
      )}
    </div>
  );
}

type TaxInvoiceInput = {
  sellerName: string;
  vatNumber: string;
  invoiceNumber: string;
  issuedAt: string;
  vatRate: number;
  keepExistingTax: boolean;
};

function TaxInvoiceForm({
  quote,
  onCancel,
  onIssue,
}: {
  quote: api.Quote;
  onCancel: () => void;
  onIssue: (input: TaxInvoiceInput) => Promise<void>;
}) {
  const base = Math.max(0, Number(quote.subtotal || 0) - Number(quote.discount || 0));
  const [sellerName, setSellerName] = useState(quote.invoice_seller_name || sellerDefaults.name);
  const [vatNumber, setVatNumber] = useState(quote.invoice_vat_number || sellerDefaults.vatNumber);
  const [number, setNumber] = useState(quote.invoice_number || invoiceNumber(quote));
  const [issuedAt, setIssuedAt] = useState(toDatetimeLocal(quote.invoice_issued_at || new Date().toISOString()));
  const [vatRate, setVatRate] = useState(String(quote.invoice_vat_rate ?? 15));
  const [keepExistingTax, setKeepExistingTax] = useState(Boolean(quote.tax > 0));
  const [saving, setSaving] = useState(false);
  const computedVat = roundMoney(keepExistingTax && quote.tax > 0 ? Number(quote.tax) : base * Number(vatRate || 0) / 100);
  const invoiceTotal = roundMoney(base + computedVat);
  const vatValid = /^\d{15}$/.test(vatNumber.trim());

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!sellerName.trim() || !vatValid || !number.trim()) return;
    setSaving(true);
    try {
      await onIssue({
        sellerName,
        vatNumber,
        invoiceNumber: number,
        issuedAt,
        vatRate: Number(vatRate || 15),
        keepExistingTax,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="form tax-invoice-form" onSubmit={submit}>
      <div className="invoice-issue-note">
        <QrCode size={18} />
        <div>
          <strong>QR الزكاة والضريبة</strong>
          <p>سيتم توليد TLV Base64 للحقول الأساسية: اسم البائع، الرقم الضريبي، وقت الفاتورة، الإجمالي شامل الضريبة، وقيمة الضريبة.</p>
        </div>
      </div>
      <div className="form-grid">
        <label className="field">
          <span>اسم البائع المسجل</span>
          <input className="input" value={sellerName} onChange={(event) => setSellerName(event.target.value)} required />
        </label>
        <label className="field">
          <span>الرقم الضريبي VAT / TRN</span>
          <input className="input" dir="ltr" value={vatNumber} onChange={(event) => setVatNumber(event.target.value.replace(/\D/g, "").slice(0, 15))} placeholder="15 digits" required />
          {!vatValid && <small className="field-error">يجب أن يكون الرقم الضريبي 15 رقماً.</small>}
        </label>
      </div>
      <div className="form-grid">
        <label className="field">
          <span>رقم الفاتورة</span>
          <input className="input" dir="ltr" value={number} onChange={(event) => setNumber(event.target.value)} required />
        </label>
        <label className="field">
          <span>تاريخ ووقت الإصدار</span>
          <input className="input" type="datetime-local" value={issuedAt} onChange={(event) => setIssuedAt(event.target.value)} required />
        </label>
      </div>
      <div className="form-grid">
        <label className="field">
          <span>نسبة الضريبة</span>
          <input className="input" type="number" min={0} step="0.01" value={vatRate} onChange={(event) => setVatRate(event.target.value)} disabled={keepExistingTax && quote.tax > 0} />
        </label>
        <label className="field checkbox-field">
          <span>استخدام الضريبة الموجودة في العرض</span>
          <input type="checkbox" checked={keepExistingTax} disabled={!quote.tax} onChange={(event) => setKeepExistingTax(event.target.checked)} />
        </label>
      </div>
      <div className="invoice-total-preview">
        <article>
          <span>المبلغ قبل الضريبة</span>
          <strong>{money(base, quote.currency)}</strong>
        </article>
        <article>
          <span>ضريبة القيمة المضافة</span>
          <strong>{money(computedVat, quote.currency)}</strong>
        </article>
        <article>
          <span>الإجمالي شامل الضريبة</span>
          <strong>{money(invoiceTotal, quote.currency)}</strong>
        </article>
      </div>
      <div className="form-actions">
        <button className="btn success" type="submit" disabled={saving || !vatValid}>
          <ReceiptText size={16} /> {saving ? "جاري الإصدار..." : "إصدار الفاتورة الضريبية"}
        </button>
        <button className="btn muted" type="button" onClick={onCancel}>إلغاء</button>
      </div>
    </form>
  );
}

function QuotePreview({
  quote,
  onCopy,
  onPrint,
  onExport,
  onWhatsApp,
  sending,
}: {
  quote: api.Quote;
  onCopy: () => void;
  onPrint: () => void;
  onExport: () => void;
  onWhatsApp: () => void;
  sending: boolean;
}) {
  const isInvoice = quote.invoice_status === "issued";
  const documentTitle = isInvoice ? "فاتورة ضريبية مبسطة" : "عرض سعر رسمي";
  const documentNumber = isInvoice ? quote.invoice_number || invoiceNumber(quote) : quote.quote_number;
  const issuedDate = isInvoice ? (quote.invoice_issued_at ? zatcaTimestamp(quote.invoice_issued_at) : quote.issue_date) : quote.issue_date;
  const qrDataUrl = useQrDataUrl(isInvoice ? quote.invoice_qr_payload : undefined);
  const payment = paymentForQuote(quote);
  const invoiceVat = Number(quote.invoice_vat_amount ?? quote.tax ?? 0);
  const invoiceRate = Number(quote.invoice_vat_rate ?? 15);
  const downAmount = (quote.total || 0) * payment.downPercent / 100;
  const finalAmount = (quote.total || 0) * payment.finalPercent / 100;
  const terms = String(quote.terms || defaultTerms).split(/\n+/).map((line) => line.trim()).filter(Boolean);

  return (
    <div className="quote-preview">
      <div className="quote-document-stage">
        <section className="quote-a4-doc quote-cover-page">
          <div className="quote-cover-top">
            <div>
              <strong>Breexe Pro</strong>
              <span>Water, cooling and maintenance solutions</span>
            </div>
            <div className="quote-logo-mark">BP</div>
          </div>
          <div className="quote-cover-body">
            <div className="quote-cover-logo">BP</div>
            <span className="quote-cover-badge">{documentTitle}</span>
            <h2>{quote.title || "عرض سعر"}</h2>
            <p>مقدم إلى {quote.customer_name || "العميل"}</p>
          </div>
          <div className="quote-cover-foot">
            <span>{isInvoice ? "رقم الفاتورة" : "رقم العرض"}: <strong>{documentNumber}</strong></span>
            <span>تاريخ الإصدار: <strong>{issuedDate}</strong></span>
            <span>{isInvoice ? "الرقم الضريبي" : "صالح حتى"}: <strong>{isInvoice ? quote.invoice_vat_number || "-" : quote.valid_until || "-"}</strong></span>
          </div>
        </section>

        <section className="quote-a4-doc quote-detail-page">
          <header className="quote-doc-head">
            <div>
              <strong>Breexe Pro</strong>
              <span>الرياض - المملكة العربية السعودية</span>
              <span>عروض، توريد، تركيب، صيانة، ومتابعة عملاء</span>
            </div>
            <div className="quote-logo-mark">BP</div>
          </header>

          <div className="quote-doc-title">
            <h2>{documentTitle} - {documentNumber}</h2>
            <p>{quote.title || "عرض سعر"} | العميل: {quote.customer_name} | التاريخ: {issuedDate}</p>
          </div>

          <div className="quote-client-grid">
            <span>العميل: <strong>{quote.customer_name || "-"}</strong></span>
            <span>الجوال: <strong dir="ltr">{quote.customer_phone || "-"}</strong></span>
            <span>المدينة: <strong>{quote.customer_city || "-"}</strong></span>
            <span>{isInvoice ? "حالة الفاتورة" : "حالة العرض"}: <strong>{isInvoice ? "مصدرة" : statusLabels[quote.status]}</strong></span>
          </div>

          {isInvoice && (
            <div className="invoice-header-grid">
              <article>
                <span>اسم البائع</span>
                <strong>{quote.invoice_seller_name || "Breexe Pro"}</strong>
              </article>
              <article>
                <span>الرقم الضريبي</span>
                <strong dir="ltr">{quote.invoice_vat_number || "-"}</strong>
              </article>
              <article>
                <span>ضريبة القيمة المضافة</span>
                <strong>{invoiceRate}% · {money(invoiceVat, quote.currency)}</strong>
              </article>
              <article className="zatca-qr-card">
                {qrDataUrl ? <img src={qrDataUrl} alt="ZATCA QR Code" /> : <QrCode size={58} />}
                <span>QR TLV Tags 1-5</span>
              </article>
            </div>
          )}

          <table className="quote-doc-table">
            <thead>
              <tr>
                <th>#</th>
                <th>الوصف</th>
                <th>الكمية</th>
                <th>سعر الوحدة</th>
                <th>الإجمالي</th>
              </tr>
            </thead>
            <tbody>
              {quote.items.length ? quote.items.map((item, index) => (
                <tr key={`${item.description}-${index}`}>
                  <td>{index + 1}</td>
                  <td>{item.description}</td>
                  <td>{item.quantity}</td>
                  <td>{money(item.unit_price, quote.currency)}</td>
                  <td>{money(item.total, quote.currency)}</td>
                </tr>
              )) : (
                <tr>
                  <td colSpan={5}>لا توجد بنود في هذا العرض</td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={4}>{isInvoice ? "الإجمالي شامل ضريبة القيمة المضافة" : "الإجمالي شامل الخصم والرسوم"}</td>
                <td>{money(quote.total, quote.currency)}</td>
              </tr>
            </tfoot>
          </table>

          <section className="quote-payment-block">
            <h3>طريقة الدفع</h3>
            <div className="quote-payment-summary">
              <article>
                <span>إجمالي العرض</span>
                <strong>{money(quote.total, quote.currency)}</strong>
              </article>
              <article>
                <span>الدفعة الأولى {payment.downPercent}%</span>
                <strong>{money(downAmount, quote.currency)}</strong>
              </article>
              <article>
                <span>الدفعة النهائية {payment.finalPercent}%</span>
                <strong>{money(finalAmount, quote.currency)}</strong>
              </article>
            </div>
            <div className="quote-payment-grid">
              <p><strong>الدفعة الأولى:</strong> {payment.downText}</p>
              <p><strong>الدفعة النهائية:</strong> {payment.finalText}</p>
            </div>
            <div className="quote-bank-box">
              <span>طريقة الدفع: <strong>{payment.method}</strong></span>
              {payment.bank && <span>البنك: <strong>{payment.bank}</strong></span>}
              {payment.account && <span>المستفيد: <strong>{payment.account}</strong></span>}
              {payment.iban && <span>IBAN: <strong dir="ltr">{payment.iban}</strong></span>}
              {payment.note && <p>{payment.note}</p>}
            </div>
          </section>

          <section className="quote-terms-block">
            <h3>الشروط والأحكام</h3>
            <ol>
              {terms.map((term) => <li key={term}>{term}</li>)}
            </ol>
          </section>

          <footer className="quote-doc-foot">
            <p>مع التحية،<br /><strong>Breexe Pro</strong><br />حلول التكييف، تنقية المياه، المضخات، أنظمة الرذاذ وخدمات التركيب.</p>
            <div className="quote-foot-seal">BREEXE<br />PRO</div>
          </footer>
        </section>
      </div>
      <div className="form-actions">
        <button className="btn primary" type="button" onClick={onPrint}><Printer size={16} /> طباعة A4</button>
        <button className="btn muted" type="button" onClick={onExport}><Download size={16} /> تصدير PDF</button>
        <button className="btn success" type="button" onClick={onWhatsApp} disabled={sending}><MessageCircle size={16} /> {sending ? "جاري الإرسال..." : "إرسال واتساب"}</button>
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
  const [tax, setTax] = useState(String(initial?.tax || 0));
  const [notes, setNotes] = useState(initial?.notes || "");
  const [terms, setTerms] = useState(initial?.terms || defaultTerms);
  const [paymentMethod, setPaymentMethod] = useState(initial?.payment_method || defaultPayment.method);
  const [paymentDownPercent, setPaymentDownPercent] = useState(String(initial?.payment_down_percent ?? defaultPayment.downPercent));
  const [paymentFinalPercent, setPaymentFinalPercent] = useState(String(initial?.payment_final_percent ?? defaultPayment.finalPercent));
  const [paymentDownText, setPaymentDownText] = useState(initial?.payment_down_text || defaultPayment.downText);
  const [paymentFinalText, setPaymentFinalText] = useState(initial?.payment_final_text || defaultPayment.finalText);
  const [paymentBank, setPaymentBank] = useState(initial?.payment_bank || defaultPayment.bank);
  const [paymentAccount, setPaymentAccount] = useState(initial?.payment_account || defaultPayment.account);
  const [paymentIban, setPaymentIban] = useState(initial?.payment_iban || defaultPayment.iban);
  const [paymentNote, setPaymentNote] = useState(initial?.payment_note || defaultPayment.note);
  const [items, setItems] = useState<api.QuoteItem[]>(
    initial?.items?.length
      ? initial.items
      : [{ description: "", quantity: 1, unit_price: 0, total: 0 }],
  );
  const [saving, setSaving] = useState(false);

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
      })),
    [items],
  );
  const subtotal = normalizedItems.reduce((sum, item) => sum + item.total, 0);
  const total = Math.max(0, subtotal - Number(discount || 0) + Number(tax || 0));

  const updateItem = (index: number, patch: Partial<api.QuoteItem>) => {
    setItems((current) => current.map((item, i) => i === index ? { ...item, ...patch } : item));
  };

  const applyTemplate = (template: (typeof quoteTemplates)[number]) => {
    setTitle(template.title);
    setItems(template.items.map((item) => ({ ...item })));
    if (!terms.trim() || terms === defaultTerms) setTerms(defaultTerms);
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
        tax: Number(tax || 0),
        currency: "SAR",
        payment_method: paymentMethod.trim(),
        payment_down_percent: Number(paymentDownPercent || 0),
        payment_final_percent: Number(paymentFinalPercent || 0),
        payment_down_text: paymentDownText.trim(),
        payment_final_text: paymentFinalText.trim(),
        payment_bank: paymentBank.trim(),
        payment_account: paymentAccount.trim(),
        payment_iban: paymentIban.trim(),
        payment_note: paymentNote.trim(),
        items: normalizedItems.filter((item) => item.description.trim()),
        notes: notes.trim(),
        terms: terms.trim(),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="form quote-form" onSubmit={submit}>
      <div className="quote-template-panel">
        <strong>قوالب جاهزة من ملف عروض الأسعار</strong>
        <div>
          {quoteTemplates.map((template) => (
            <button className="btn muted" type="button" key={template.key} onClick={() => applyTemplate(template)}>
              {template.label}
            </button>
          ))}
        </div>
      </div>

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
            onClick={() => setItems((current) => [...current, { description: "", quantity: 1, unit_price: 0, total: 0 }])}
          >
            <Plus size={16} /> بند
          </button>
        </div>
        {items.map((item, index) => (
          <div className="quote-line" key={index}>
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
        <label className="field">
          <span>خصم</span>
          <input className="input" type="number" min={0} step="0.01" value={discount} onChange={(event) => setDiscount(event.target.value)} />
        </label>
        <label className="field">
          <span>ضريبة / رسوم</span>
          <input className="input" type="number" min={0} step="0.01" value={tax} onChange={(event) => setTax(event.target.value)} />
        </label>
        <article>
          <span>الإجمالي</span>
          <strong>{money(total)}</strong>
        </article>
      </div>

      <div className="quote-payment-form">
        <div className="quote-lines-head">
          <strong>الدفع والتصدير</strong>
          <span>تظهر هذه البيانات في ملف A4 ونص واتساب</span>
        </div>
        <div className="form-grid">
          <label className="field">
            <span>طريقة الدفع</span>
            <input className="input" value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)} />
          </label>
          <label className="field">
            <span>اسم المستفيد</span>
            <input className="input" value={paymentAccount} onChange={(event) => setPaymentAccount(event.target.value)} />
          </label>
        </div>
        <div className="form-grid">
          <label className="field">
            <span>نسبة الدفعة الأولى</span>
            <input className="input" type="number" min={0} max={100} value={paymentDownPercent} onChange={(event) => setPaymentDownPercent(event.target.value)} />
          </label>
          <label className="field">
            <span>نسبة الدفعة النهائية</span>
            <input className="input" type="number" min={0} max={100} value={paymentFinalPercent} onChange={(event) => setPaymentFinalPercent(event.target.value)} />
          </label>
        </div>
        <div className="form-grid">
          <label className="field">
            <span>البنك</span>
            <input className="input" value={paymentBank} onChange={(event) => setPaymentBank(event.target.value)} />
          </label>
          <label className="field">
            <span>IBAN</span>
            <input className="input" dir="ltr" value={paymentIban} onChange={(event) => setPaymentIban(event.target.value)} />
          </label>
        </div>
        <div className="form-grid">
          <label className="field">
            <span>نص الدفعة الأولى</span>
            <textarea className="input textarea compact" value={paymentDownText} onChange={(event) => setPaymentDownText(event.target.value)} />
          </label>
          <label className="field">
            <span>نص الدفعة النهائية</span>
            <textarea className="input textarea compact" value={paymentFinalText} onChange={(event) => setPaymentFinalText(event.target.value)} />
          </label>
        </div>
        <label className="field">
          <span>ملاحظة الدفع</span>
          <textarea className="input textarea compact" value={paymentNote} onChange={(event) => setPaymentNote(event.target.value)} />
        </label>
      </div>

      <label className="field">
        <span>ملاحظات داخلية</span>
        <textarea className="input textarea" value={notes} onChange={(event) => setNotes(event.target.value)} />
      </label>

      <label className="field">
        <span>الشروط التي تظهر في العرض</span>
        <textarea className="input textarea" value={terms} onChange={(event) => setTerms(event.target.value)} />
      </label>

      <div className="form-actions">
        <button className="btn primary" type="submit" disabled={saving}>
          <FileText size={16} /> {saving ? "جاري الحفظ..." : "حفظ العرض"}
        </button>
        <button className="btn muted" type="button" onClick={onCancel}>إلغاء</button>
      </div>
    </form>
  );
}

export default QuotesPage;
