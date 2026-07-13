import {
  Check,
  CircleAlert,
  ClipboardList,
  Edit3,
  RefreshCcw,
  Save,
  Send,
  Trash2,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import * as api from "./api";

/* ── Types ───────────────────────────────────────────────── */

export type Page =
  | "dash"
  | "customers"
  | "quotes"
  | "invoices"
  | "odooCrm"
  | "products"
  | "assets"
  | "installations"
  | "bookings"
  | "storeOrders"
  | "care"
  | "technicians"
  | "messages"
  | "callSystem"
  | "settings"
  | "adminUsers";

export type ModalState = { title: string; content: ReactNode; wide?: boolean } | null;
export type Toast = { message: string; ok: boolean } | null;

/* ── Utilities ───────────────────────────────────────────── */

export const today = () => new Date().toLocaleDateString("en-CA");
export const addMonths = (date: string, months: number) => {
  const d = new Date(`${date}T00:00:00`);
  d.setMonth(d.getMonth() + Number(months || 0));
  return d.toLocaleDateString("en-CA");
};

export const fmtDate = (value?: string | null) =>
  value ? new Date(`${value.length === 10 ? `${value}T00:00:00` : value}`).toLocaleDateString("ar-SA") : "-";

export const phoneLabel = (phone?: string) => {
  const clean = String(phone || "").replace(/\D/g, "");
  if (clean.length === 10 && clean.startsWith("05")) return clean.replace(/(\d{4})(\d{3})(\d{3})/, "$1 $2 $3");
  return phone || "-";
};

export const moneyLabel = (value?: number | null) =>
  typeof value === "number" && Number.isFinite(value) ? `${value.toLocaleString("en-US")} ر.س` : "غير محدد";

export const statusLabel = (status?: string) => {
  if (status === "pending_installation") return "بانتظار التركيب";
  if (status === "pending_external_service") return "صيانة خارجية بانتظار الجدولة";
  if (status === "completed") return "مكتمل";
  if (status === "cancelled") return "ملغي";
  return "نشط";
};

export const storeOrderTypeLabel = (type?: string) => {
  if (type === "sale_only") return "بيع فقط";
  if (type === "install_maintenance") return "تركيب وصيانة";
  if (type === "maintenance_existing") return "صيانة منتج سابق";
  if (type === "external_maintenance") return "صيانة جهاز خارجي";
  if (type === "needs_review") return "يحتاج مراجعة";
  return "غير محدد";
};

export const effectiveStoreOrderType = (item?: api.StoreOrderItem) => item?.manual_type || item?.order_type || "needs_review";

export const journeyLabel = (status?: string) => {
  if (status === "sale_recorded") return "بيع محفوظ";
  if (status === "installation_created") return "تم إنشاء تركيب";
  if (status === "awaiting_schedule") return "بانتظار الجدولة";
  if (status === "booking_created") return "تم إنشاء حجز";
  if (status === "maintenance_matched") return "تم ربط الصيانة";
  if (status === "needs_review") return "يحتاج مراجعة";
  if (status === "completed") return "مكتمل";
  if (status === "cancelled") return "ملغي";
  return "مستلم";
};

export const journeyTone = (status?: string): "muted" | "danger" | "success" | "warn" => {
  if (status === "completed" || status === "booking_created" || status === "sale_recorded") return "success";
  if (status === "needs_review" || status === "cancelled") return "danger";
  if (status === "awaiting_schedule" || status === "maintenance_matched") return "warn";
  return "muted";
};

export const careReasonLabel = (reason?: string) => {
  if (reason === "no_activity") return "عميل بلا متابعة";
  if (reason === "never_contacted") return "لم يتم استهدافه";
  if (reason === "not_targeted") return "مستحق ولم يرسل له";
  if (reason === "due_soon") return "موعد قريب";
  if (reason === "overdue_maintenance") return "صيانة متأخرة";
  return "متابعة";
};

export const careTone = (priority?: string): "muted" | "danger" | "success" | "warn" => {
  if (priority === "high") return "danger";
  if (priority === "medium") return "warn";
  if (priority === "low") return "muted";
  return "muted";
};

export const reminderLabel = (type?: string | null) => {
  if (type === "first") return "تذكير أول";
  if (type === "second") return "تذكير ثان";
  if (type === "last") return "تذكير أخير";
  return "لا يوجد";
};

export const daysLabel = (days?: number) => {
  if (typeof days !== "number") return "-";
  if (days < 0) return `متأخر ${Math.abs(days)} يوم`;
  if (days === 0) return "اليوم";
  return `بعد ${days} يوم`;
};

/* ── Hooks ───────────────────────────────────────────────── */

export function useData<T>(fetcher: () => Promise<T>, deps: unknown[] = [], enabled = true) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    setError("");
    try {
      setData(await fetcher());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [enabled, ...deps]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { data, loading, error, refresh, setData };
}

/* ── Shared Components ──────────────────────────────────── */

export function Button({
  children,
  tone = "primary",
  type = "button",
  disabled,
  loading,
  onClick,
}: {
  children: ReactNode;
  tone?: "primary" | "muted" | "danger" | "success";
  type?: "button" | "submit";
  disabled?: boolean;
  loading?: boolean;
  onClick?: () => void;
}) {
  return (
    <button className={`btn ${tone}`} type={type} disabled={disabled || loading} onClick={onClick}>
      {loading ? <RefreshCcw size={15} className="spin" /> : children}
    </button>
  );
}

export function IconButton({
  title,
  children,
  tone = "muted",
  onClick,
  disabled,
}: {
  title: string;
  children: ReactNode;
  tone?: "muted" | "danger" | "success";
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button className={`icon-btn ${tone}`} title={title} aria-label={title} type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className="input" {...props} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className="input textarea" {...props} />;
}

export function SelectInput(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className="input" {...props} />;
}

export function Badge({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "danger" | "success" | "warn" }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function Empty({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <ClipboardList size={30} />
      <p>{title}</p>
      {action}
    </div>
  );
}

export function Loading() {
  return (
    <div className="empty">
      <RefreshCcw size={26} className="spin" />
      <p>جاري التحميل...</p>
    </div>
  );
}

export function ErrorBlock({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div className="error-box">
      <CircleAlert size={18} />
      <span>{message}</span>
      {retry && <Button onClick={retry} tone="muted">إعادة المحاولة</Button>}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      <div className="actions">{actions}</div>
    </div>
  );
}

export function Stat({ title, value, icon, tone = "default", onClick }: { title: string; value: number; icon: ReactNode; tone?: string; onClick?: () => void }) {
  return (
    <article className={`stat ${tone}`} onClick={onClick} style={onClick ? { cursor: "pointer" } : undefined}>
      <span>{icon}</span>
      <div>
        <strong>{value}</strong>
        <p>{title}</p>
      </div>
    </article>
  );
}

export function InstallationCard({
  installation,
  onRemind,
  onComplete,
  onEdit,
  onDelete,
}: {
  installation: api.Installation;
  onRemind?: () => void;
  onComplete?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const danger = Number(installation.days_until) < 0;
  return (
    <article className="row-card">
      <div className="row-main">
        <strong>{installation.customer_name}</strong>
        <span>
          {installation.product_name} · {fmtDate(installation.next_maintenance)} · {phoneLabel(installation.customer_phone)}
        </span>
        <div className="chips">
          <Badge tone={danger ? "danger" : "muted"}>{daysLabel(installation.days_until)}</Badge>
          <Badge>{statusLabel(installation.status)}</Badge>
          <Badge>{installation.remind_count || 0}/3</Badge>
          {installation.next_remind_type && <Badge tone="warn">{reminderLabel(installation.next_remind_type)}</Badge>}
        </div>
      </div>
      <div className="row-actions">
        {onRemind && installation.status === "active" && installation.next_remind_type && (
          <IconButton title="إرسال تذكير" tone="success" onClick={onRemind}>
            <Send size={15} />
          </IconButton>
        )}
        {onComplete && installation.status === "active" && (
          <IconButton title="إكمال" tone="success" onClick={onComplete}>
            <Check size={15} />
          </IconButton>
        )}
        {onEdit && (
          <IconButton title="تعديل" onClick={onEdit}>
            <Edit3 size={15} />
          </IconButton>
        )}
        {onDelete && (
          <IconButton title="حذف" tone="danger" onClick={onDelete}>
            <Trash2 size={15} />
          </IconButton>
        )}
      </div>
    </article>
  );
}

export function AccessDenied() {
  return (
    <div className="empty">
      <CircleAlert size={26} />
      <p>هذه الصفحة مخصصة للمسؤولين فقط.</p>
    </div>
  );
}
