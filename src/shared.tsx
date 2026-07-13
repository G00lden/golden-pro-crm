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
  useRef,
  useState,
  type FormEvent,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import * as api from "./api";
import { addCalendarMonths } from "../shared/date";

/* ── Types ───────────────────────────────────────────────── */

export type Page =
  | "dash"
  | "customers"
  | "quotes"
  | "invoices"
  | "odooCrm"
  | "products"
  | "installations"
  | "bookings"
  | "storeOrders"
  | "care"
  | "technicians"
  | "messages"
  | "campaigns"
  | "callSystem"
  | "settings"
  | "adminUsers";

export type ModalState = { title: string; content: ReactNode; wide?: boolean } | null;
export type Toast = { message: string; ok: boolean } | null;

/* ── Utilities ───────────────────────────────────────────── */

export const today = () => new Date().toLocaleDateString("en-CA");
export const addMonths = addCalendarMonths;

export const fmtDate = (value?: string | null) =>
  value ? new Date(`${value.length === 10 ? `${value}T00:00:00` : value}`).toLocaleDateString("ar-SA") : "-";

const gregorianDateFormatter = new Intl.DateTimeFormat("ar-SA-u-ca-gregory", {
  dateStyle: "medium",
});
const storeDateTimeFormatters = new Map<string, Intl.DateTimeFormat>();
const storeDatePartFormatters = new Map<string, Intl.DateTimeFormat>();

function validTimeZone(value?: string | null) {
  const candidate = String(value || "").trim();
  if (!candidate) return "";
  try {
    new Intl.DateTimeFormat("en", { timeZone: candidate }).format(0);
    return candidate;
  } catch {
    return "";
  }
}

function datePartsFormatter(timeZone: string) {
  const cached = storeDatePartFormatters.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US-u-ca-gregory", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  storeDatePartFormatters.set(timeZone, formatter);
  return formatter;
}

function timeZoneOffsetAt(epoch: number, timeZone: string) {
  const values: Record<string, number> = {};
  for (const part of datePartsFormatter(timeZone).formatToParts(new Date(epoch))) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  const represented = Date.UTC(
    values.year,
    values.month - 1,
    values.day,
    values.hour,
    values.minute,
    values.second,
  );
  return represented - Math.floor(epoch / 1_000) * 1_000;
}

function sallaWallClockDate(value: string, timeZone: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?$/);
  if (!match) return null;
  const milliseconds = Number(String(match[7] || "").slice(0, 3).padEnd(3, "0"));
  const wallClock = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6] || 0),
    milliseconds,
  );
  let instant = wallClock - timeZoneOffsetAt(wallClock, timeZone);
  const correctedOffset = timeZoneOffsetAt(instant, timeZone);
  instant = wallClock - correctedOffset;
  const parsed = new Date(instant);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function storeDateTimeFormatter(timeZone: string) {
  const key = timeZone || "local";
  const cached = storeDateTimeFormatters.get(key);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("ar-SA-u-ca-gregory", {
    dateStyle: "medium",
    timeStyle: "short",
    ...(timeZone ? { timeZone } : {}),
  });
  storeDateTimeFormatters.set(key, formatter);
  return formatter;
}

export function fmtStoreOrderDateTime(
  createdAt?: string | null,
  orderTimeZone?: string | null,
  fallbackDate?: string | null,
) {
  const value = String(createdAt || "").trim();
  const timeZone = validTimeZone(orderTimeZone);
  if (value) {
    const hasExplicitOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
    const parsed = !hasExplicitOffset && timeZone
      ? sallaWallClockDate(value, timeZone)
      : new Date(value.replace(" ", "T"));
    if (parsed && !Number.isNaN(parsed.getTime())) {
      return storeDateTimeFormatter(timeZone).format(parsed);
    }
  }

  const date = String(fallbackDate || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "-";
  const parsedDate = new Date(`${date}T00:00:00`);
  return Number.isNaN(parsedDate.getTime()) ? "-" : gregorianDateFormatter.format(parsedDate);
}

export function storeOrderDateKey(
  createdAt?: string | null,
  orderTimeZone?: string | null,
  fallbackDate?: string | null,
) {
  const fallback = String(fallbackDate || "").slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(fallback)) {
    const parsedFallback = new Date(`${fallback}T00:00:00.000Z`);
    if (!Number.isNaN(parsedFallback.getTime()) && parsedFallback.toISOString().slice(0, 10) === fallback) {
      return fallback;
    }
  }

  const value = String(createdAt || "").trim();
  if (!value) return "";
  const timeZone = validTimeZone(orderTimeZone) || "Asia/Riyadh";
  const hasExplicitOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  if (!hasExplicitOffset) {
    const wallClockDate = value.match(/^(\d{4}-\d{2}-\d{2})(?:[ T]|$)/)?.[1] || "";
    if (wallClockDate) return wallClockDate;
  }

  const parsed = new Date(value.replace(" ", "T"));
  if (Number.isNaN(parsed.getTime())) return "";
  const parts: Record<string, string> = {};
  for (const part of datePartsFormatter(timeZone).formatToParts(parsed)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return parts.year && parts.month && parts.day ? `${parts.year}-${parts.month}-${parts.day}` : "";
}

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
  const requestGeneration = useRef(0);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const generation = ++requestGeneration.current;
    setLoading(true);
    setError("");
    try {
      const next = await fetcher();
      if (generation === requestGeneration.current) setData(next);
    } catch (err) {
      if (generation === requestGeneration.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }, [enabled, ...deps]);

  useEffect(() => {
    refresh();
    return () => {
      requestGeneration.current += 1;
    };
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
    <button className={`btn ${tone}`} type={type} disabled={disabled || loading} aria-busy={loading || undefined} onClick={onClick}>
      {loading ? <RefreshCcw size={15} className="spin" aria-hidden="true" /> : children}
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
      <ClipboardList size={30} aria-hidden="true" />
      <p>{title}</p>
      {action}
    </div>
  );
}

export function Loading() {
  return (
    <div className="empty" role="status" aria-live="polite">
      <RefreshCcw size={26} className="spin" aria-hidden="true" />
      <p>جاري التحميل…</p>
    </div>
  );
}

export function ErrorBlock({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div className="error-box" role="alert">
      <CircleAlert size={18} aria-hidden="true" />
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
  const content = (
    <>
      <span aria-hidden="true">{icon}</span>
      <div>
        <strong>{value}</strong>
        <p>{title}</p>
      </div>
    </>
  );

  if (onClick) {
    return (
      <button className={`stat stat-button ${tone}`} type="button" onClick={onClick}>
        {content}
      </button>
    );
  }

  return (
    <article className={`stat ${tone}`}>
      {content}
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
