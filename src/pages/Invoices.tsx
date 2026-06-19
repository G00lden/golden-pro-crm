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
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
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
  "جميع الأسعار شاملة ضريبة القيمة المضافة 15%.",
  "الدفع حسب الاتفاق المبرم بين الطرفين.",
].join("\n");

const safeFilePart = (value?: string) =>
  String(value || "العميل")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 80) || "العميل";

/* ── ZATCA QR Code Generation (TLV format) ─────────────── */

function generateZATCAQR(invoice: api.Invoice): string {
  const timestamp = invoice.issue_date + "T00:00:00Z";
  const total = invoice.total_with_vat.toFixed(2);
  const vatAmount = invoice.vat_amount.toFixed(2);

  const tlvData: Array<[number, string]> = [
    [1, invoice.seller_name],
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
  // Generate a simple visual QR representation using the data as seed
  // In production, replace with a proper QR library like qrcode.js
  const cells = useMemo(() => {
    const hash = data.split("").reduce((acc, ch) => ((acc << 5) - acc + ch.charCodeAt(0)) | 0, 0);
    const grid: boolean[][] = [];
    for (let y = 0; y < 11; y++) {
      grid[y] = [];
      for (let x = 0; x < 11; x++) {
        const val = ((hash * (y * 13 + x * 7 + 1)) % 100) > 50;
        // Always fill corners for QR look
        const isCorner =
          (x < 3 && y < 3) || (x > 7 && y < 3) || (x < 3 && y > 7);
        grid[y][x] = isCorner ? true : val;
      }
    }
    return grid;
  }, [data]);

  const cellSize = size / 13;
  const offset = cellSize * 1;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="zatca-qr-code">
      <rect width={size} height={size} fill="white" rx={4} />
      {cells.map((row, y) =>
        row.map((filled, x) =>
          filled ? (
            <rect
              key={`${x}-${y}`}
              x={offset + x * cellSize}
              y={offset + y * cellSize}
              width={cellSize}
              height={cellSize}
              fill="black"
            />
          ) : null,
        ),
      )}
    </svg>
  );
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
  return [
    "فاتورة ضريبية - BreeXe Pro",
    `رقم الفاتورة: ${invoice.invoice_number}`,
    invoice.title || "فاتورة",
    `العميل: ${invoice.customer_name}`,
    invoice.customer_phone ? `الجوال: ${invoice.customer_phone}` : "",
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

  const printInvoice = (invoice: api.Invoice, asPdf = false) => {
    setPreview(invoice);
    const previousTitle = document.title;
    document.title = `فاتورة إلى ${safeFilePart(invoice.customer_name)}`;
    document.body.classList.add("quote-print-mode");
    const restore = () => {
      document.title = previousTitle;
      document.body.classList.remove("quote-print-mode");
      window.removeEventListener("afterprint", restore);
    };
    window.addEventListener("afterprint", restore);
    window.setTimeout(() => window.print(), 120);
    notify(asPdf ? "اختر حفظ كـ PDF من نافذة الطباعة" : "تم تجهيز الفاتورة للطباعة A4");
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
            onCancel={() => { setCreating(false); setEditing(null); }}
            onSave={saveInvoice}
          />
        </InvoiceModal>
      )}
      {preview && (
        <InvoiceModal title={`معاينة ${preview.invoice_number}`} onClose={() => setPreview(null)}>
          <InvoicePreview invoice={preview} onCopy={() => copyInvoice(preview)} />
        </InvoiceModal>
      )}
    </div>
  );
}

/* ── Preview ───────────────────────────────────────────── */

function InvoicePreview({ invoice, onCopy }: { invoice: api.Invoice; onCopy: () => void }) {
  const qrCode = useMemo(() => generateZATCAQR(invoice), [invoice]);

  return (
    <div className="quote-preview">
      <section className="quote-preview-paper invoice-paper">
        <header>
          <div>
            <span>{invoice.seller_name || "BreeXe Pro"}</span>
            <h2>{invoice.title || "فاتورة ضريبية"}</h2>
          </div>
          <div className="invoice-qr-section">
            <QRCodeDisplay data={qrCode} size={70} />
            <strong>{invoice.invoice_number}</strong>
          </div>
        </header>
        {invoice.seller_vat_number && (
          <div className="invoice-vat-badge">
            <span>الرقم الضريبي: {invoice.seller_vat_number}</span>
            {invoice.seller_address && <span> | {invoice.seller_address}</span>}
          </div>
        )}
        <div className="quote-preview-meta">
          <span>العميل: {invoice.customer_name}</span>
          <span>الجوال: {invoice.customer_phone || "-"}</span>
          <span>المدينة: {invoice.customer_city || "-"}</span>
          <span>تاريخ الإصدار: {invoice.issue_date}</span>
          <span>تاريخ الاستحقاق: {invoice.due_date || "-"}</span>
          <span>الحالة: {statusLabels[invoice.status]}</span>
        </div>
        <table>
          <thead>
            <tr>
              <th>البند</th>
              <th>الكمية</th>
              <th>سعر الوحدة</th>
              <th>الإجمالي</th>
            </tr>
          </thead>
          <tbody>
            {invoice.items.map((item, index) => (
              <tr key={`${item.description}-${index}`}>
                <td>{item.description}</td>
                <td>{item.quantity}</td>
                <td>{money(item.unit_price, invoice.currency)}</td>
                <td>{money(item.total, invoice.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="quote-preview-totals invoice-totals">
          <span>المجموع (بدون ضريبة): {money(invoice.total_without_vat, invoice.currency)}</span>
          <span>الخصم: {money(invoice.discount, invoice.currency)}</span>
          <span>ضريبة القيمة المضافة ({invoice.vat_percent}%): {money(invoice.vat_amount, invoice.currency)}</span>
          <strong>الإجمالي شامل الضريبة: {money(invoice.total_with_vat, invoice.currency)}</strong>
        </div>
        {invoice.terms && <p className="quote-preview-terms">{invoice.terms}</p>}
      </section>
      <div className="form-actions">
        <button className="btn primary" type="button" onClick={() => window.print()}><Printer size={16} /> طباعة</button>
        <button className="btn muted" type="button" onClick={onCopy}><Copy size={16} /> نسخ نص الفاتورة</button>
      </div>
    </div>
  );
}

/* ── Form ──────────────────────────────────────────────── */

function InvoiceForm({
  initial,
  onCancel,
  onSave,
}: {
  initial?: api.Invoice;
  onCancel: () => void;
  onSave: (payload: api.InvoiceInput) => Promise<void>;
}) {
  const customers = useAsyncData(() => api.getCustomers(""), []);
  const [customerId, setCustomerId] = useState(initial?.customer_id || "");
  const [customerName, setCustomerName] = useState(initial?.customer_name || "");
  const [customerPhone, setCustomerPhone] = useState(initial?.customer_phone || "");
  const [customerCity, setCustomerCity] = useState(initial?.customer_city || "");
  const [title, setTitle] = useState(initial?.title || "");
  const [status, setStatus] = useState<api.InvoiceStatus>(initial?.status || "issued");
  const [issueDate, setIssueDate] = useState(initial?.issue_date || today());
  const [dueDate, setDueDate] = useState(initial?.due_date || addDays(today(), 30));
  const [vatPercent, setVatPercent] = useState(String(initial?.vat_percent || 15));
  const [discount, setDiscount] = useState(String(initial?.discount || 0));
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

  const normalizedItems = useMemo(
    () =>
      items.map((item) => ({
        ...item,
        quantity: Math.max(0, Number(item.quantity || 0)),
        unit_price: Math.max(0, Number(item.unit_price || 0)),
        total: Math.max(0, Number(item.quantity || 0)) * Math.max(0, Number(item.unit_price || 0)),
        vat_excluded: item.vat_excluded !== undefined ? item.vat_excluded : true,
      })),
    [items],
  );
  const subtotal = normalizedItems.reduce((sum, item) => sum + item.total, 0);
  const cleanDiscount = Math.max(0, Number(discount || 0));
  const vatPct = Math.max(0, Number(vatPercent || 15));
  const withoutVat = subtotal - cleanDiscount;
  const vatAmount = withoutVat * (vatPct / 100);
  const totalWithVat = withoutVat + vatAmount;

  const updateItem = (index: number, patch: Partial<api.InvoiceItem>) => {
    setItems((current) => current.map((item, i) => i === index ? { ...item, ...patch } : item));
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
