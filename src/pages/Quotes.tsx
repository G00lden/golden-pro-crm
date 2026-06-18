import {
  CalendarDays,
  CheckCircle2,
  Clock3,
  Copy,
  Edit3,
  Eye,
  FileText,
  Plus,
  Printer,
  RefreshCcw,
  Search,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
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
  return [
    `عرض سعر ${quote.quote_number}`,
    quote.title || "عرض سعر",
    `العميل: ${quote.customer_name}`,
    quote.valid_until ? `صالح حتى: ${quote.valid_until}` : "",
    "",
    ...lines,
    "",
    `الإجمالي: ${money(quote.total, quote.currency)}`,
    quote.terms ? `الشروط: ${quote.terms}` : "",
  ].filter(Boolean).join("\n");
}

export function QuotesPage({ notify, refreshStats }: QuotesPageProps) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [editing, setEditing] = useState<api.Quote | null>(null);
  const [preview, setPreview] = useState<api.Quote | null>(null);
  const [creating, setCreating] = useState(false);
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
                <button className="icon-btn success" type="button" title="تأكيد" onClick={() => setQuoteStatus(quote, "confirmed")}>
                  <CheckCircle2 size={15} />
                </button>
                <button className="icon-btn" type="button" title="متابعة" onClick={() => setQuoteStatus(quote, "follow_up")}>
                  <Clock3 size={15} />
                </button>
                <button className="icon-btn" type="button" title="طباعة" onClick={() => window.print()}>
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
          <QuotePreview quote={preview} onCopy={() => copyQuote(preview)} />
        </QuoteModal>
      )}
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
  const [terms, setTerms] = useState(initial?.terms || "العرض صالح حسب التاريخ الموضح، والأسعار بالريال السعودي.");
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
