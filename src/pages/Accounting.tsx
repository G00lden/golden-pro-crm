import {
  AlertTriangle,
  ArrowUpRight,
  Banknote,
  CalendarDays,
  CheckCircle2,
  Clock3,
  Copy,
  CreditCard,
  Download,
  Edit3,
  Eye,
  FileText,
  Landmark,
  MessageCircle,
  Plus,
  Printer,
  Receipt,
  RefreshCcw,
  Search,
  Send,
  Trash2,
  TrendingUp,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import * as api from "../api";
import { InvoicePreview } from "../components/InvoicePreview";

type Notifier = (message: string, ok?: boolean) => void;
type AccountingTab = "dashboard" | "invoices" | "payments";

const today = () => new Date().toLocaleDateString("en-CA");
const money = (value?: number, currency = "SAR") =>
  `${Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;

const statusLabels: Record<api.InvoiceStatus, string> = {
  draft: "مسودة",
  open: "مفتوحة",
  issued: "مصدرة",
  sent: "مرسلة",
  partially_paid: "مدفوعة جزئيًا",
  paid: "مدفوعة",
  cancelled: "ملغية",
  refunded: "مستردة",
};

const statusTone: Record<string, "muted" | "success" | "danger" | "warn"> = {
  draft: "muted",
  open: "muted",
  issued: "warn",
  sent: "warn",
  partially_paid: "success",
  paid: "success",
  cancelled: "danger",
  refunded: "danger",
};

// ── Data hooks ────────────────────────────────────────

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

  useEffect(() => { refresh(); }, [refresh]);
  return { data, loading, error, refresh };
}

// ── Badge ─────────────────────────────────────────────

function Badge({ children, tone }: { children: ReactNode; tone: string }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

// ── Modal ─────────────────────────────────────────────

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="modal wide" onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" type="button" title="إغلاق" onClick={onClose}><X size={16} /></button>
        </header>
        {children}
      </section>
    </div>
  );
}

// ── Payment Registration Modal ────────────────────────

function PaymentForm({
  invoice,
  notify,
  onClose,
  onDone,
}: {
  invoice: api.Invoice;
  notify: Notifier;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [amount, setAmount] = useState(String(Math.max(0, invoice.total_with_vat - (invoice as any).total_paid || 0)));
  const [method, setMethod] = useState<api.PaymentMethod>("تحويل بنكي");
  const [reference, setReference] = useState("");
  const [date, setDate] = useState(today());
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.registerPayment({
        invoice_id: invoice.id,
        amount: Math.max(0, Number(amount)),
        method,
        reference: reference.trim(),
        date,
        note: note.trim(),
      });
      notify("تم تسجيل الدفعة");
      onClose();
      await onDone();
    } catch (err) {
      notify(err instanceof Error ? err.message : "فشل تسجيل الدفعة", false);
    } finally {
      setSaving(false);
    }
  };

  const methods: api.PaymentMethod[] = ["تحويل بنكي", "نقدي", "بطاقة ائتمان", "مدى", "شيك", "أخرى"];

  return (
    <form className="form" onSubmit={submit}>
      <label className="field">
        <span>المبلغ المدفوع</span>
        <input className="input" type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} required />
        <small>المتبقي: {money(Math.max(0, invoice.total_with_vat - Number(amount || 0)))}</small>
      </label>
      <label className="field">
        <span>طريقة الدفع</span>
        <select className="input" value={method} onChange={(e) => setMethod(e.target.value as api.PaymentMethod)}>
          {methods.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </label>
      <div className="form-grid">
        <label className="field">
          <span>المرجع / رقم العملية</span>
          <input className="input" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="اختياري" />
        </label>
        <label className="field">
          <span>تاريخ الدفع</span>
          <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </label>
      </div>
      <label className="field">
        <span>ملاحظة</span>
        <textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="اختياري" />
      </label>
      <div className="form-actions">
        <button className="btn muted" type="button" onClick={onClose}>إلغاء</button>
        <button className="btn primary" type="submit" disabled={saving}>
          <Banknote size={16} /> {saving ? "جاري..." : "تسجيل الدفعة"}
        </button>
      </div>
    </form>
  );
}

// ── Invoice Create/Edit Form (simplified, reusing original logic) ──

function InvoiceFormModal({
  initial,
  notify,
  onClose,
  onDone,
}: {
  initial?: api.Invoice;
  notify: Notifier;
  onClose: () => void;
  onDone: () => Promise<void>;
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
  const [status, setStatus] = useState<api.InvoiceStatus>(initial?.status || "open");
  const [issueDate, setIssueDate] = useState(initial?.issue_date || today());
  const [dueDate, setDueDate] = useState(initial?.due_date || "");
  const [vatPercent, setVatPercent] = useState(String(initial?.vat_percent || 15));
  const [discount, setDiscount] = useState(String(initial?.discount || 0));
  const [sellerName, setSellerName] = useState(initial?.seller_name || "");
  const [sellerVat, setSellerVat] = useState(initial?.seller_vat_number || "");
  const [sellerAddress, setSellerAddress] = useState(initial?.seller_address || "");
  const [notes, setNotes] = useState(initial?.notes || "");
  const [terms, setTerms] = useState(initial?.terms || "");
  const [items, setItems] = useState<api.InvoiceItem[]>(
    initial?.items?.length ? initial.items : [{ description: "", quantity: 1, unit_price: 0, total: 0, vat_excluded: true }],
  );
  const [saving, setSaving] = useState(false);

  const selectedCustomer = customers.data?.data.find((c) => c.id === customerId);
  useEffect(() => {
    if (!selectedCustomer) return;
    setCustomerName(selectedCustomer.name);
    setCustomerPhone(selectedCustomer.phone);
    setCustomerCity(selectedCustomer.city || "");
  }, [selectedCustomer]);
  useEffect(() => {
    if (!settings.data || initial) return;
    setSellerName(settings.data.seller_name || "Breexe Pro Co.");
    setSellerVat(settings.data.seller_vat_number || "");
    setSellerAddress(settings.data.seller_address || "");
  }, [settings.data, initial]);

  const updateItem = (i: number, p: Partial<api.InvoiceItem>) =>
    setItems((cur) => cur.map((item, idx) => idx === i ? { ...item, ...p } : item));

  const applyProduct = (index: number, productId: string) => {
    const p = products.data?.find((x) => x.id === productId);
    if (!p) { updateItem(index, { product_id: null, product_sku: "" }); return; }
    const price = Number(p.sale_price ?? p.price ?? 0);
    updateItem(index, { product_id: p.id, product_sku: p.sku || "", description: p.name, unit_price: price });
  };

  const normalizedItems = useMemo(() => items.map((item) => {
    const qty = Math.max(0, Number(item.quantity || 0));
    const price = Math.max(0, Number(item.unit_price || 0));
    return { ...item, quantity: qty, unit_price: price, total: qty * price, vat_excluded: item.vat_excluded !== false };
  }), [items]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload: api.InvoiceInput = {
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
        items: normalizedItems.filter((i) => i.description.trim()),
        notes: notes.trim(),
        terms: terms.trim(),
        seller_name: sellerName.trim() || "Breexe Pro Co.",
        seller_vat_number: sellerVat.trim(),
        seller_address: sellerAddress.trim(),
      };
      if (initial) await api.updateInvoice(initial.id, payload);
      else await api.createInvoice(payload);
      notify(initial ? "تم تعديل الفاتورة" : "تم إصدار الفاتورة");
      onClose();
      await onDone();
    } catch (err) {
      notify(err instanceof Error ? err.message : "فشل الحفظ", false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="form quote-form" onSubmit={submit}>
      <div className="form-grid">
        <label className="field">
          <span>عميل موجود</span>
          <select className="input" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            <option value="">عميل جديد / إدخال يدوي</option>
            {(customers.data?.data || []).map((c) => <option key={c.id} value={c.id}>{c.name} - {c.phone}</option>)}
          </select>
        </label>
        <label className="field"><span>اسم العميل</span><input className="input" value={customerName} onChange={(e) => setCustomerName(e.target.value)} required /></label>
        <label className="field"><span>جوال العميل</span><input className="input" value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} /></label>
        <label className="field"><span>المدينة</span><input className="input" value={customerCity} onChange={(e) => setCustomerCity(e.target.value)} /></label>
        <label className="field"><span>الرقم الضريبي للعميل</span><input className="input" value={customerVat} onChange={(e) => setCustomerVat(e.target.value)} /></label>
        <label className="field"><span>عنوان الفاتورة</span><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label className="field"><span>تاريخ الإصدار</span><input className="input" type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} required /></label>
        <label className="field"><span>تاريخ الاستحقاق</span><input className="input" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></label>
        <label className="field">
          <span>الحالة</span>
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value as api.InvoiceStatus)}>
            <option value="draft">مسودة</option>
            <option value="open">مفتوحة</option>
            <option value="sent">مرسلة</option>
            <option value="paid">مدفوعة</option>
          </select>
        </label>
        <label className="field"><span>نسبة الضريبة %</span><input className="input" type="number" step="0.01" value={vatPercent} onChange={(e) => setVatPercent(e.target.value)} /></label>
        <label className="field"><span>الخصم</span><input className="input" type="number" step="0.01" value={discount} onChange={(e) => setDiscount(e.target.value)} /></label>
      </div>
      <div className="form-grid">
        <label className="field"><span>اسم البائع</span><input className="input" value={sellerName} onChange={(e) => setSellerName(e.target.value)} /></label>
        <label className="field"><span>الرقم الضريبي للبائع</span><input className="input" value={sellerVat} onChange={(e) => setSellerVat(e.target.value)} /></label>
        <label className="field"><span>عنوان البائع</span><input className="input" value={sellerAddress} onChange={(e) => setSellerAddress(e.target.value)} /></label>
      </div>
      <hr />
      <h4>بنود الفاتورة</h4>
      {items.map((item, i) => (
        <div className="form-grid" key={i} style={{ background: "var(--gray-50)", padding: "0.75rem", borderRadius: "8px", marginBottom: "0.5rem" }}>
          <label className="field">
            <span>منتج</span>
            <select className="input" value={item.product_id || ""} onChange={(e) => applyProduct(i, e.target.value)}>
              <option value="">اختيار منتج</option>
              {(products.data || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className="field"><span>البيان</span><input className="input" value={item.description} onChange={(e) => updateItem(i, { description: e.target.value })} required /></label>
          <label className="field"><span>الكمية</span><input className="input" type="number" min="0" value={item.quantity} onChange={(e) => updateItem(i, { quantity: Number(e.target.value) })} /></label>
          <label className="field"><span>سعر الوحدة</span><input className="input" type="number" min="0" step="0.01" value={item.unit_price} onChange={(e) => updateItem(i, { unit_price: Number(e.target.value) })} /></label>
          <label className="field" style={{ alignItems: "center", justifyContent: "flex-end", flexDirection: "row", gap: "4px" }}>
            <input type="checkbox" checked={item.vat_excluded !== false} onChange={(e) => updateItem(i, { vat_excluded: e.target.checked })} />
            <span style={{ margin: 0 }}>السعر غير شامل الضريبة</span>
          </label>
          <button className="btn danger" type="button" onClick={() => setItems((cur) => cur.filter((_, idx) => idx !== i))} style={{ alignSelf: "flex-end" }}>حذف</button>
        </div>
      ))}
      <button className="btn muted" type="button" onClick={() => setItems((cur) => [...cur, { description: "", quantity: 1, unit_price: 0, total: 0, vat_excluded: true }])}>
        + إضافة بند
      </button>
      <div className="form-actions" style={{ marginTop: "1rem" }}>
        <button className="btn muted" type="button" onClick={onClose}>إلغاء</button>
        <button className="btn primary" type="submit" disabled={saving}>{saving ? "جاري..." : initial ? "حفظ التعديلات" : "إصدار الفاتورة"}</button>
      </div>
    </form>
  );
}

// ══════════════════════════════════════════════════════
// MAIN PAGE
// ══════════════════════════════════════════════════════

export function AccountingPage({ notify, refreshStats }: { notify: Notifier; refreshStats: () => Promise<void> }) {
  const [tab, setTab] = useState<AccountingTab>("dashboard");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<api.Invoice | null>(null);
  const [payingInvoice, setPayingInvoice] = useState<api.Invoice | null>(null);
  const [preview, setPreview] = useState<api.Invoice | null>(null);

  const dash = useAsyncData(() => api.getAccountingDashboard(), [tab]);
  const invoices = useAsyncData(() => api.getInvoices({ search, status }), [search, status, tab]);

  const refreshAll = async () => {
    await Promise.all([dash.refresh(), invoices.refresh(), refreshStats()]);
  };

  const handleStatus = async (inv: api.Invoice, newStatus: api.InvoiceStatus) => {
    try {
      await api.setInvoiceStatus(inv.id, newStatus);
      notify(newStatus === "paid" ? "تم تأكيد الدفع" : "تم تحديث الحالة");
      await refreshAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : "فشل التحديث", false);
    }
  };

  const handleDelete = async (inv: api.Invoice) => {
    if (!window.confirm(`حذف الفاتورة ${inv.invoice_number}؟`)) return;
    try {
      await api.deleteInvoice(inv.id);
      notify("تم حذف الفاتورة");
      await refreshAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : "فشل الحذف", false);
    }
  };

  const handleCreditNote = async (inv: api.Invoice) => {
    const reason = window.prompt("سبب الإشعار الدائن:", "استرداد مبلغ");
    if (!reason) return;
    try {
      await api.createCreditNote({ invoice_id: inv.id, reason, refund_amount: inv.total_with_vat });
      notify("تم إنشاء إشعار دائن");
      await refreshAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : "فشل إنشاء الإشعار الدائن", false);
    }
  };

  const copyInvoiceText = async (inv: api.Invoice) => {
    const kind = inv.total_with_vat >= 1000 ? "فاتورة ضريبية" : "فاتورة ضريبية مبسطة";
    const text = [
      `${kind} — ${inv.invoice_number}`,
      `العميل: ${inv.customer_name}`,
      `الجوال: ${inv.customer_phone || "-"}`,
      `التاريخ: ${inv.issue_date}`,
      `الإجمالي شامل الضريبة: ${inv.total_with_vat.toFixed(2)} SAR`,
      inv.due_date ? `الاستحقاق: ${inv.due_date}` : "",
    ].filter(Boolean).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      notify("تم نسخ نص الفاتورة");
    } catch {
      notify("فشل النسخ", false);
    }
  };

  const shareInvoiceWhatsApp = (inv: api.Invoice) => {
    if (!inv.customer_phone) { notify("العميل ليس لديه رقم جوال", false); return; }
    const kind = inv.total_with_vat >= 1000 ? "فاتورة ضريبية" : "فاتورة ضريبية مبسطة";
    const msg = encodeURIComponent(
      `عزيزي ${inv.customer_name}\n` +
      `مرفق ${kind} رقم ${inv.invoice_number}\n` +
      `الإجمالي: ${inv.total_with_vat.toFixed(2)} SAR\n` +
      `التاريخ: ${inv.issue_date}`
    );
    window.open(`https://wa.me/${inv.customer_phone.replace(/^0+|\+/g, "").replace(/^966/, "")}?text=${msg}`, "_blank");
  };

  const stats = invoices.data?.stats || { total: 0, draft: 0, open: 0, issued: 0, sent: 0, partially_paid: 0, paid: 0, cancelled: 0, refunded: 0, total_value: 0, paid_value: 0, outstanding_value: 0, overdue_value: 0 };

  // ── Dashboard Tab ──────────────────────────────────
  const DashboardTab = () => (
    <div className="cloud-dash">
      <section className="cloud-hero quotes-hero">
        <div className="cloud-hero-copy">
          <span className="eyebrow">المحاسبة</span>
          <h1>لوحة المعلومات المالية</h1>
          <p>نظرة شاملة على الذمم المدينة، المدفوعات، والفواتير المستحقة</p>
          <div className="hero-actions">
            <button className="btn primary" type="button" onClick={() => { setCreating(true); setTab("invoices"); }}>
              <Plus size={16} /> إصدار فاتورة
            </button>
            <button className="btn muted" type="button" onClick={refreshAll}><RefreshCcw size={16} /> تحديث</button>
          </div>
        </div>
        <div className="hero-status-grid">
          <article>
            <span>الذمم المدينة</span>
            <strong>{money(dash.data?.total_outstanding)}</strong>
          </article>
          <article className={dash.data?.total_overdue ? "alert" : ""}>
            <span>مستحقة ومتأخرة</span>
            <strong>{money(dash.data?.total_overdue)}</strong>
          </article>
          <article>
            <span>محصلة هذا الشهر</span>
            <strong>{money(dash.data?.paid_this_month)}</strong>
          </article>
        </div>
      </section>

      <div className="stats-grid metric-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
        <article className="stat">
          <span style={{ background: "var(--blue-100)", color: "var(--blue-600)" }}><TrendingUp size={18} /></span>
          <div><strong>{dash.data?.draft_count || 0}</strong><p>مسودة</p></div>
        </article>
        <article className="stat">
          <span style={{ background: "var(--amber-100)", color: "var(--amber-600)" }}><Clock3 size={18} /></span>
          <div><strong>{dash.data?.open_count || 0}</strong><p>مفتوحة / مرسلة</p></div>
        </article>
        <article className="stat">
          <span style={{ background: "var(--red-100)", color: "var(--red-600)" }}><AlertTriangle size={18} /></span>
          <div><strong>{dash.data?.overdue_count || 0}</strong><p>متأخرة</p></div>
        </article>
        <article className="stat">
          <span style={{ background: "var(--green-100)", color: "var(--green-600)" }}><Banknote size={18} /></span>
          <div><strong>{dash.data?.paid_this_month_count || 0}</strong><p>دفعات هذا الشهر</p></div>
        </article>
      </div>

      {/* Overdue list */}
      {dash.data?.overdue_invoices?.length ? (
        <div style={{ marginTop: "1.5rem" }}>
          <h3 style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <AlertTriangle size={18} style={{ color: "var(--red-500)" }} /> فواتير متأخرة ({dash.data.overdue_count})
          </h3>
          <div className="quotes-list" style={{ marginTop: "0.75rem" }}>
            {dash.data.overdue_invoices.map((inv) => (
              <article className="quote-card" key={inv.id} style={{ borderRight: "3px solid var(--red-400)" }}>
                <div className="quote-card-main">
                  <div className="quote-title-line">
                    <strong>{inv.invoice_number}</strong>
                    <Badge tone="danger">متأخر {inv.days_overdue} يوم</Badge>
                  </div>
                  <p>{inv.customer_name} · مستحق {inv.due_date}</p>
                  <div className="chips">
                    <span className="badge muted">المبلغ: {money(inv.total)}</span>
                    {inv.paid > 0 && <span className="badge success">مدفوع: {money(inv.paid)}</span>}
                    <span className="badge warn">متبقي: {money(inv.total - inv.paid)}</span>
                  </div>
                </div>
                <div className="quote-total-box" style={{ borderColor: "var(--red-300)" }}>
                  <span>مستحق</span>
                  <strong>{money(inv.total)}</strong>
                </div>
              </article>
            ))}
          </div>
        </div>
      ) : dash.data ? (
        <div className="empty" style={{ marginTop: "1rem" }}>
          <CheckCircle2 size={30} />
          <p>لا توجد فواتير متأخرة — كل الفواتير محدثة</p>
        </div>
      ) : null}

      {/* Recent payments */}
      {dash.data?.recent_payments?.length ? (
        <div style={{ marginTop: "1.5rem" }}>
          <h3 style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <Banknote size={18} /> آخر المدفوعات
          </h3>
          <div className="quotes-list" style={{ marginTop: "0.75rem" }}>
            {dash.data.recent_payments.map((p) => (
              <article className="quote-card" key={p.id} style={{ borderRight: "3px solid var(--green-400)" }}>
                <div className="quote-card-main">
                  <strong>{p.invoice_number}</strong>
                  <p>{p.customer_name} · {p.method} · {p.date}</p>
                  {p.reference && <small>مرجع: {p.reference}</small>}
                </div>
                <div className="quote-total-box" style={{ borderColor: "var(--green-300)" }}>
                  <span>مدفوع</span>
                  <strong style={{ color: "var(--green-600)" }}>{money(p.amount)}</strong>
                </div>
              </article>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );

  // ── Invoices Tab ───────────────────────────────────
  const InvoicesTab = () => (
    <div>
      <div className="stats-grid metric-grid quote-metrics">
        <article className="stat"><span><FileText size={18} /></span><div><strong>{stats.total}</strong><p>كل الفواتير</p></div></article>
        <article className="stat"><span style={{ background: "var(--blue-100)", color: "var(--blue-600)" }}><Send size={18} /></span><div><strong>{stats.open + stats.issued + stats.sent}</strong><p>مفتوحة</p></div></article>
        <article className="stat"><span style={{ background: "var(--green-100)", color: "var(--green-600)" }}><CheckCircle2 size={18} /></span><div><strong>{stats.paid}</strong><p>مدفوعة</p></div></article>
        <article className="stat"><span style={{ background: "var(--red-100)", color: "var(--red-600)" }}><AlertTriangle size={18} /></span><div><strong>{money(stats.overdue_value)}</strong><p>متأخرة</p></div></article>
      </div>

      <div className="toolbar quotes-toolbar">
        <Search size={16} />
        <input className="input" placeholder="بحث برقم الفاتورة أو العميل" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="all">كل الحالات</option>
          <option value="draft">مسودة</option>
          <option value="open">مفتوحة</option>
          <option value="sent">مرسلة</option>
          <option value="partially_paid">مدفوعة جزئيًا</option>
          <option value="paid">مدفوعة</option>
          <option value="cancelled">ملغية</option>
          <option value="refunded">مستردة</option>
        </select>
        <button className="btn primary" type="button" onClick={() => setCreating(true)} style={{ marginRight: "auto" }}>
          <Plus size={16} /> إصدار فاتورة
        </button>
      </div>

      {invoices.loading ? (
        <div className="empty"><RefreshCcw size={26} className="spin" /><p>جاري التحميل...</p></div>
      ) : invoices.data?.data.length ? (
        <div className="quotes-list">
          {invoices.data.data.map((inv) => {
            const isOverdue = inv.due_date && inv.due_date < today() && !["paid", "cancelled", "refunded"].includes(inv.status);
            return (
              <article className="quote-card" key={inv.id} style={isOverdue ? { borderRight: "3px solid var(--red-400)" } : {}}>
                <div className="quote-card-main">
                  <div className="quote-title-line">
                    <strong>{inv.invoice_number}</strong>
                    <Badge tone={statusTone[inv.status]}>{statusLabels[inv.status]}</Badge>
                    {isOverdue && <Badge tone="danger">متأخر</Badge>}
                  </div>
                  <h3>{inv.title || "فاتورة"}</h3>
                  <p>{inv.customer_name} · {inv.customer_phone || "بدون جوال"} · {inv.customer_city || "بدون مدينة"}</p>
                  <div className="chips">
                    <span className="badge muted"><CalendarDays size={12} /> {inv.issue_date}</span>
                    {inv.due_date && <span className={`badge ${isOverdue ? "danger" : "warn"}`}>مستحق {inv.due_date}</span>}
                    {inv.paid_at && <span className="badge success">تم الدفع {inv.paid_at.slice(0, 10)}</span>}
                  </div>
                </div>
                <div className="quote-total-box">
                  <span>شامل الضريبة</span>
                  <strong>{money(inv.total_with_vat)}</strong>
                  <small>ضريبة {money(inv.vat_amount)}</small>
                </div>
                <div className="row-actions">
                  <button className="icon-btn success" type="button" title="تسجيل دفعة" onClick={() => setPayingInvoice(inv)}>
                    <Banknote size={15} />
                  </button>
                  <button className="icon-btn" type="button" title="معاينة" onClick={() => setPreview(inv)}>
                    <Eye size={15} />
                  </button>
                  <button className="icon-btn" type="button" title="طباعة" onClick={() => { setPreview(inv); }}>
                    <Printer size={15} />
                  </button>
                  <button className="icon-btn" type="button" title="نسخ" onClick={() => copyInvoiceText(inv)}>
                    <Copy size={15} />
                  </button>
                  {inv.customer_phone && (
                    <button className="icon-btn" type="button" title="واتساب" onClick={() => shareInvoiceWhatsApp(inv)}>
                      <MessageCircle size={15} />
                    </button>
                  )}
                  <button className="icon-btn success" type="button" title="تعليم كمدفوعة" onClick={() => handleStatus(inv, "paid")} disabled={inv.status === "paid"}>
                    <CheckCircle2 size={15} />
                  </button>
                  <button className="icon-btn" type="button" title="تعليم كمرسلة" onClick={() => handleStatus(inv, "sent")} disabled={inv.status === "sent" || inv.status === "paid" || inv.status === "partially_paid"}>
                    <Send size={15} />
                  </button>
                  <button className="icon-btn" type="button" title="تعديل" onClick={() => setEditing(inv)}><Edit3 size={15} /></button>
                  <button className="icon-btn danger" type="button" title="إشعار دائن" onClick={() => handleCreditNote(inv)} disabled={inv.status === "refunded"}>
                    <CreditCard size={15} />
                  </button>
                  <button className="icon-btn danger" type="button" title="إلغاء" onClick={() => handleStatus(inv, "cancelled")} disabled={inv.status === "cancelled" || inv.status === "refunded"}>
                    <X size={15} />
                  </button>
                  <button className="icon-btn danger" type="button" title="حذف" onClick={() => handleDelete(inv)}><Trash2 size={15} /></button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="empty">
          <Receipt size={30} />
          <p>لا توجد فواتير</p>
          <button className="btn primary" type="button" onClick={() => setCreating(true)}><Plus size={16} /> إصدار أول فاتورة</button>
        </div>
      )}
    </div>
  );

  // ── Payments Tab ───────────────────────────────────
  const PaymentsTab = () => {
    // Payments tab shows recent payments from dashboard data
    return (
      <div>
        <div className="toolbar quotes-toolbar">
          <h3 style={{ margin: 0, flex: 1 }}>سجل المدفوعات</h3>
          <button className="btn muted" type="button" onClick={refreshAll}><RefreshCcw size={16} /> تحديث</button>
        </div>
        {dash.loading ? (
          <div className="empty"><RefreshCcw size={26} className="spin" /><p>جاري التحميل...</p></div>
        ) : dash.data?.recent_payments?.length ? (
          <div className="quotes-list">
            {dash.data.recent_payments.map((p) => (
              <article className="quote-card" key={p.id} style={{ borderRight: "3px solid var(--green-400)" }}>
                <div className="quote-card-main">
                  <strong>{p.invoice_number} — {p.customer_name}</strong>
                  <p>{p.method} · {p.date}</p>
                  {p.reference && <span className="badge muted">مرجع: {p.reference}</span>}
                  {p.note && <small>{p.note}</small>}
                </div>
                <div className="quote-total-box">
                  <span>مدفوع</span>
                  <strong style={{ color: "var(--green-600)" }}>{money(p.amount)}</strong>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty">
            <Landmark size={30} />
            <p>لا توجد دفعات مسجلة بعد</p>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="quotes-workspace cloud-design">
      {/* Tab bar */}
      <div className="toolbar quotes-toolbar" style={{ marginBottom: "1rem", padding: "0.35rem", gap: "0.25rem", background: "var(--gray-100)", borderRadius: "10px" }}>
        <button className={`btn ${tab === "dashboard" ? "primary" : "muted"}`} type="button" onClick={() => setTab("dashboard")}>
          <TrendingUp size={14} /> لوحة المعلومات
        </button>
        <button className={`btn ${tab === "invoices" ? "primary" : "muted"}`} type="button" onClick={() => setTab("invoices")}>
          <Receipt size={14} /> فواتير العملاء
        </button>
        <button className={`btn ${tab === "payments" ? "primary" : "muted"}`} type="button" onClick={() => setTab("payments")}>
          <Landmark size={14} /> المدفوعات
        </button>
      </div>

      {tab === "dashboard" && <DashboardTab />}
      {tab === "invoices" && <InvoicesTab />}
      {tab === "payments" && <PaymentsTab />}

      {/* Modals */}
      {creating && (
        <Modal title="إصدار فاتورة جديدة" onClose={() => setCreating(false)}>
          <InvoiceFormModal notify={notify} onClose={() => setCreating(false)} onDone={refreshAll} />
        </Modal>
      )}
      {editing && (
        <Modal title={`تعديل ${editing.invoice_number}`} onClose={() => setEditing(null)}>
          <InvoiceFormModal initial={editing} notify={notify} onClose={() => setEditing(null)} onDone={refreshAll} />
        </Modal>
      )}
      {payingInvoice && (
        <Modal title={`تسجيل دفعة — ${payingInvoice.invoice_number}`} onClose={() => setPayingInvoice(null)}>
          <PaymentForm invoice={payingInvoice} notify={notify} onClose={() => setPayingInvoice(null)} onDone={refreshAll} />
        </Modal>
      )}
      {preview && (
        <Modal title={`معاينة ${preview.invoice_number}`} onClose={() => setPreview(null)}>
          <InvoicePreview
            invoice={preview}
            onCopy={() => copyInvoiceText(preview)}
            onPrint={(asPdf) => {
              const printWindow = asPdf ? null : window.open("", "_blank");
              if (!asPdf && printWindow) {
                const kind = preview.total_with_vat >= 1000 ? "فاتورة ضريبية" : "فاتورة ضريبية مبسطة";
                const doc = printWindow.document;
                const html = `<!doctype html><html dir="rtl"><head><meta charset="utf-8"><title>${kind} ${preview.invoice_number}</title></head><body><p>الرجاء استخدام زر الطباعة من المعاينة</p></body></html>`;
                doc.open();
                doc.write(html);
                doc.close();
                setTimeout(() => printWindow.print(), 500);
              }
              notify(asPdf ? "استخدم معاينة الفواتير للتصدير PDF" : "تم فتح نافذة الطباعة");
            }}
          />
        </Modal>
      )}
    </div>
  );
}
