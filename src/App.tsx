import {
  CalendarDays,
  Check,
  CircleAlert,
  ClipboardList,
  Edit3,
  FileText,
  LogIn,
  LogOut,
  Menu,
  MessageCircle,
  Package,
  Play,
  Plus,
  RefreshCcw,
  Save,
  Search,
  Send,
  Settings,
  Smartphone,
  Trash2,
  UserPlus,
  UserRoundCog,
  Users,
  Wrench,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import * as api from "./api";
import {
  login,
  loginDemoLocal,
  loginLocal,
  loginWithEmail,
  localAuthEnabled,
  onAppAuthStateChanged,
  registerLocal,
  registerWithEmail,
} from "./firebase";
import { AdminUsersPage } from "./pages/AdminUsers";
import { QuotesPage } from "./pages/Quotes";
import { WhatsAppConsole } from "./pages/WhatsAppConsole";
import { ReminderDashboard } from "./components/ReminderDashboard";

type Page =
  | "dash"
  | "customers"
  | "quotes"
  | "products"
  | "installations"
  | "bookings"
  | "storeOrders"
  | "care"
  | "technicians"
  | "messages"
  | "settings"
  | "adminUsers";
type ModalState = { title: string; content: ReactNode; wide?: boolean } | null;
type Toast = { message: string; ok: boolean } | null;

const today = () => new Date().toLocaleDateString("en-CA");
const addMonths = (date: string, months: number) => {
  const d = new Date(`${date}T00:00:00`);
  d.setMonth(d.getMonth() + Number(months || 0));
  return d.toLocaleDateString("en-CA");
};

const fmtDate = (value?: string | null) =>
  value ? new Date(`${value.length === 10 ? `${value}T00:00:00` : value}`).toLocaleDateString("ar-SA") : "-";

const phoneLabel = (phone?: string) => {
  const clean = String(phone || "").replace(/\D/g, "");
  if (clean.length === 10 && clean.startsWith("05")) return clean.replace(/(\d{4})(\d{3})(\d{3})/, "$1 $2 $3");
  return phone || "-";
};

const moneyLabel = (value?: number | null) =>
  typeof value === "number" && Number.isFinite(value) ? `${value.toLocaleString("en-US")} ر.س` : "غير محدد";

const statusLabel = (status?: string) => {
  if (status === "pending_installation") return "بانتظار التركيب";
  if (status === "pending_external_service") return "صيانة خارجية بانتظار الجدولة";
  if (status === "completed") return "مكتمل";
  if (status === "cancelled") return "ملغي";
  return "نشط";
};

const storeOrderTypeLabel = (type?: string) => {
  if (type === "sale_only") return "بيع فقط";
  if (type === "install_maintenance") return "تركيب وصيانة";
  if (type === "maintenance_existing") return "صيانة منتج سابق";
  if (type === "external_maintenance") return "صيانة جهاز خارجي";
  if (type === "needs_review") return "يحتاج مراجعة";
  return "غير محدد";
};

const effectiveStoreOrderType = (item?: api.StoreOrderItem) => item?.manual_type || item?.order_type || "needs_review";

const journeyLabel = (status?: string) => {
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

const journeyTone = (status?: string): "muted" | "danger" | "success" | "warn" => {
  if (status === "completed" || status === "booking_created" || status === "sale_recorded") return "success";
  if (status === "needs_review" || status === "cancelled") return "danger";
  if (status === "awaiting_schedule" || status === "maintenance_matched") return "warn";
  return "muted";
};

const careReasonLabel = (reason?: string) => {
  if (reason === "no_activity") return "عميل بلا متابعة";
  if (reason === "never_contacted") return "لم يتم استهدافه";
  if (reason === "not_targeted") return "مستحق ولم يرسل له";
  if (reason === "due_soon") return "موعد قريب";
  if (reason === "overdue_maintenance") return "صيانة متأخرة";
  return "متابعة";
};

const careTone = (priority?: string): "muted" | "danger" | "success" | "warn" => {
  if (priority === "high") return "danger";
  if (priority === "medium") return "warn";
  if (priority === "low") return "muted";
  return "muted";
};

const reminderLabel = (type?: string | null) => {
  if (type === "first") return "تذكير أول";
  if (type === "second") return "تذكير ثان";
  if (type === "last") return "تذكير أخير";
  return "لا يوجد";
};

const daysLabel = (days?: number) => {
  if (typeof days !== "number") return "-";
  if (days < 0) return `متأخر ${Math.abs(days)} يوم`;
  if (days === 0) return "اليوم";
  return `بعد ${days} يوم`;
};

function useData<T>(fetcher: () => Promise<T>, deps: unknown[] = [], enabled = true) {
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

function Button({
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

function IconButton({
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

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className="input" {...props} />;
}

function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className="input textarea" {...props} />;
}

function SelectInput(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className="input" {...props} />;
}

function Badge({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "danger" | "success" | "warn" }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

function Modal({ modal, onClose }: { modal: ModalState; onClose: () => void }) {
  if (!modal) return null;
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className={`modal ${modal.wide ? "wide" : ""}`} onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <h2>{modal.title}</h2>
          <IconButton title="إغلاق" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </header>
        {modal.content}
      </section>
    </div>
  );
}

function Empty({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <ClipboardList size={30} />
      <p>{title}</p>
      {action}
    </div>
  );
}

function Loading() {
  return (
    <div className="empty">
      <RefreshCcw size={26} className="spin" />
      <p>جاري التحميل...</p>
    </div>
  );
}

function AccessDenied() {
  return (
    <div className="empty">
      <CircleAlert size={26} />
      <p>هذه الصفحة مخصصة للمسؤولين فقط.</p>
    </div>
  );
}

function ErrorBlock({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div className="error-box">
      <CircleAlert size={18} />
      <span>{message}</span>
      {retry && <Button onClick={retry} tone="muted">إعادة المحاولة</Button>}
    </div>
  );
}

function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
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

export default function App() {
  const [page, setPage] = useState<Page>("dash");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [modal, setModal] = useState<ModalState>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    return onAppAuthStateChanged((user) => {
      setAuthed(!!user);
      setAuthReady(true);
    });
  }, []);

  const notify = useCallback((message: string, ok = true) => {
    setToast({ message, ok });
    window.setTimeout(() => setToast(null), 3200);
  }, []);

  const me = useData(api.getMe, [], authed && authReady);
  const currentRole = (me.data?.role || "user") as api.AppUserRole;
  const isAdmin = currentRole === "admin";
  const isManagerOrAdmin = currentRole === "admin" || currentRole === "manager";
  const currentUid = me.data?.uid || null;

  const stats = useData(api.getStats, [page], authed && authReady);
  const summary: api.DashboardStats = stats.data || {
    customers: 0,
    products: 0,
    technicians: 0,
    installations: 0,
    quotes: 0,
    confirmedQuotes: 0,
    quoteFollowUps: 0,
    overdue: 0,
    week: 0,
    sentToday: 0,
    maxDaily: 24,
    completed: 0,
    care: 0,
  };

  useEffect(() => {
    if (!authed || !authReady) return;

    let cancelled = false;
    const runAutomaticReminders = async () => {
      try {
        const result = await api.runDueReminders({ automatic: true });
        if (!cancelled && result.sent > 0) {
          notify(`تم إرسال ${result.sent} تذكير مستحق تلقائيا`);
          await stats.refresh();
        }
      } catch {
        // التذكير التلقائي لا يزعج المستخدم عند عدم اتصال واتساب؛ يظهر السبب في سجل التذكيرات عند التشغيل اليدوي.
      }
    };

    runAutomaticReminders();
    const timer = window.setInterval(runAutomaticReminders, 10 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [authed, authReady, notify, stats.refresh]);

  const nav = [
    { id: "dash" as Page, label: "الرئيسية", icon: ClipboardList },
    { id: "customers" as Page, label: "العملاء", icon: Users },
    { id: "quotes" as Page, label: "عروض الأسعار", icon: FileText, badge: summary.quoteFollowUps },
    { id: "products" as Page, label: "المنتجات", icon: Package },
    { id: "installations" as Page, label: "الصيانة", icon: Wrench, badge: summary.overdue },
    { id: "bookings" as Page, label: "الحجوزات", icon: CalendarDays },
    { id: "storeOrders" as Page, label: "طلبات المتجر", icon: ClipboardList },
    { id: "care" as Page, label: "رعاية العملاء", icon: UserPlus, badge: summary.care },
    { id: "technicians" as Page, label: "الفنيون", icon: UserRoundCog },
    { id: "messages" as Page, label: "واتساب والسجل", icon: MessageCircle },
    ...(isManagerOrAdmin
      ? [{ id: "adminUsers" as Page, label: "إدارة المستخدمين", icon: UserRoundCog }]
      : []),
    { id: "settings" as Page, label: "الإعدادات", icon: Settings },
  ];

  if (!authReady) return <Loading />;
  if (!authed) return <EmailAuthPage notify={notify} />;

  const openPage = (nextPage: Page) => {
    setPage(nextPage);
    setSidebarOpen(false);
  };

  const pages: Record<Page, ReactNode> = {
    dash: <Dashboard stats={summary} notify={notify} refreshStats={stats.refresh} go={openPage} />,
    customers: <CustomersPage notify={notify} refreshStats={stats.refresh} setModal={setModal} />,
    quotes: <QuotesPage notify={notify} refreshStats={stats.refresh} />,
    products: <ProductsPage notify={notify} refreshStats={stats.refresh} setModal={setModal} />,
    installations: <InstallationsPage notify={notify} refreshStats={stats.refresh} setModal={setModal} />,
    bookings: <BookingsPage notify={notify} refreshStats={stats.refresh} setModal={setModal} />,
    storeOrders: <StoreOrdersPage notify={notify} refreshStats={stats.refresh} setModal={setModal} />,
    care: <CustomerCarePage notify={notify} refreshStats={stats.refresh} />,
    technicians: <TechniciansPage notify={notify} refreshStats={stats.refresh} setModal={setModal} />,
    messages: <WhatsAppConsole notify={notify} />,
    settings: <SettingsPage notify={notify} />,
    adminUsers: isManagerOrAdmin
      ? <AdminUsersPage notify={notify} currentUid={currentUid} />
      : <AccessDenied />,
  };

  return (
    <div className="app-shell" dir="rtl">
      <button className="mobile-menu" type="button" onClick={() => setSidebarOpen(true)} aria-label="فتح القائمة">
        <Menu size={20} />
      </button>

      {sidebarOpen && <div className="sidebar-scrim" onClick={() => setSidebarOpen(false)} />}

      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="brand">
          <div className="brand-mark">BP</div>
          <div>
            <strong>BreeXe Pro</strong>
            <span>CRM</span>
          </div>
        </div>
        <nav>
          {nav.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.id} className={page === item.id ? "active" : ""} type="button" onClick={() => openPage(item.id)}>
                <Icon size={18} />
                <span>{item.label}</span>
                {!!item.badge && <b>{item.badge}</b>}
              </button>
            );
          })}
        </nav>
        <div className="quota">
          <span>رسائل اليوم</span>
          <strong>{summary.sentToday || 0}/{summary.maxDaily || 24}</strong>
        </div>
      </aside>

      <main>{pages[page]}</main>

      <Modal modal={modal} onClose={() => setModal(null)} />

      {toast && (
        <div className={`toast ${toast.ok ? "ok" : "bad"}`}>
          {toast.ok ? <Check size={16} /> : <CircleAlert size={16} />}
          {toast.message}
        </div>
      )}
    </div>
  );
}

type AuthMode = "login" | "register";

function authErrorMessage(error: unknown) {
  const code = typeof error === "object" && error && "code" in error ? String((error as { code?: string }).code) : "";
  const message = error instanceof Error ? error.message : String(error || "");

  if (code === "auth/operation-not-allowed") {
    return "طريقة الدخول غير مفعلة في Firebase. فعّل Email/Password أو Google من Authentication > Sign-in method.";
  }
  if (code === "auth/unauthorized-domain") {
    return "النطاق المحلي غير مصرح في Firebase Auth. أضف localhost من Authentication > Settings > Authorized domains.";
  }
  if (code === "auth/email-already-in-use") return "هذا البريد مسجل مسبقا. استخدم تسجيل الدخول.";
  if (code === "auth/invalid-credential" || code === "auth/wrong-password" || code === "auth/user-not-found") {
    return "البريد أو كلمة المرور غير صحيحة.";
  }
  if (code === "auth/local-user-not-found") return "لا يوجد حساب محلي بهذا البريد. أنشئ حسابا جديدا أولا.";
  if (code === "auth/weak-password") return "كلمة المرور يجب أن تكون 6 أحرف على الأقل.";
  if (code === "auth/invalid-email") return "صيغة البريد الإلكتروني غير صحيحة.";
  if (code === "auth/popup-blocked" || code === "auth/popup-closed-by-user") {
    return "المتصفح منع نافذة Google. استخدم الدخول بالبريد أو جرّب تسجيل الدخول بجوجل مرة أخرى.";
  }

  return message || "تعذر تنفيذ عملية الدخول.";
}

function EmailAuthPage({ notify }: { notify: (message: string, ok?: boolean) => void }) {
  const [mode, setMode] = useState<AuthMode>("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState<"email" | "google" | null>(null);
  const [feedback, setFeedback] = useState("");

  const submitEmail = async (event: FormEvent) => {
    event.preventDefault();
    setFeedback("");
    if (mode === "register" && password.length < 6) {
      setFeedback("كلمة المرور يجب أن تكون 6 أحرف على الأقل.");
      return;
    }
    setLoading("email");
    try {
      if (localAuthEnabled && mode === "register") {
        await registerLocal(name, email.trim(), password);
        notify("تم إنشاء الحساب المحلي والدخول");
      } else if (localAuthEnabled) {
        await loginLocal(email.trim(), password);
        notify("تم تسجيل الدخول محليا");
      } else if (mode === "register") {
        await registerWithEmail(name, email.trim(), password);
        notify("تم إنشاء الحساب والدخول");
      } else {
        await loginWithEmail(email.trim(), password);
        notify("تم تسجيل الدخول");
      }
    } catch (error) {
      setFeedback(authErrorMessage(error));
    } finally {
      setLoading(null);
    }
  };

  const handleGoogleLogin = async () => {
    setFeedback("");
    setLoading("google");
    try {
      await login();
    } catch (error) {
      setFeedback(authErrorMessage(error));
      setLoading(null);
    }
  };

  const handleDemoLogin = async () => {
    setFeedback("");
    setLoading("email");
    try {
      await loginDemoLocal();
      notify("تم تسجيل الدخول بحساب التجربة");
    } catch (error) {
      setFeedback(authErrorMessage(error));
    } finally {
      setLoading(null);
    }
  };

  const switchMode = () => {
    setMode((current) => (current === "login" ? "register" : "login"));
    setFeedback("");
  };

  return (
    <div className="auth-screen" dir="rtl">
      <section className="auth-card">
        <div className="brand-mark large">BP</div>
        <h1>BreeXe Pro CRM</h1>
        <p>نظام إدارة العملاء والصيانة ورسائل واتساب</p>

        <div className="auth-tabs" role="tablist" aria-label="اختيار طريقة الدخول">
          <button className={mode === "login" ? "active" : ""} type="button" onClick={() => setMode("login")}>
            دخول
          </button>
          <button className={mode === "register" ? "active" : ""} type="button" onClick={() => setMode("register")}>
            حساب جديد
          </button>
        </div>

        <form className="auth-form" onSubmit={submitEmail}>
          {mode === "register" && (
            <Field label="الاسم">
              <TextInput autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} />
            </Field>
          )}
          <Field label="البريد الإلكتروني">
            <TextInput
              required
              autoComplete="email"
              dir="ltr"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
          <Field label="كلمة المرور">
            <TextInput
              required
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              dir="ltr"
              minLength={6}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>

          {feedback && (
            <div className="inline-error" role="alert">
              <CircleAlert size={16} />
              <span>{feedback}</span>
            </div>
          )}

          <Button type="submit" loading={loading === "email"}>
            {mode === "register" ? <UserPlus size={16} /> : <LogIn size={16} />}
            {mode === "register" ? "إنشاء حساب" : "تسجيل الدخول"}
          </Button>
        </form>

        <div className="auth-divider"><span>أو</span></div>

        <Button tone="muted" loading={loading === "google"} onClick={handleGoogleLogin}>
          تسجيل الدخول بجوجل
        </Button>

        {localAuthEnabled && (
          <Button tone="muted" loading={loading === "email"} onClick={handleDemoLogin}>
            <LogIn size={16} />
            دخول تجربة
          </Button>
        )}

        <button className="text-button" type="button" onClick={switchMode}>
          {mode === "register" ? "لديك حساب؟ سجل الدخول" : "لا يوجد حساب؟ أنشئ حسابا"}
        </button>
      </section>
    </div>
  );
}

function AuthPage({ notify }: { notify: (message: string, ok?: boolean) => void }) {
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    setLoading(true);
    try {
      await login();
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر تسجيل الدخول", false);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-screen" dir="rtl">
      <section>
        <div className="brand-mark large">BP</div>
        <h1>BreeXe Pro CRM</h1>
        <p>نظام إدارة العملاء والصيانة ورسائل واتساب</p>
        <Button loading={loading} onClick={handleLogin}>
          تسجيل الدخول بجوجل
        </Button>
      </section>
    </div>
  );
}

function Dashboard({
  stats,
  notify,
  refreshStats,
  go,
}: {
  stats: any;
  notify: (message: string, ok?: boolean) => void;
  refreshStats: () => Promise<void>;
  go: (page: Page) => void;
}) {
  const installations = useData(api.getInstallations);
  const [seeding, setSeeding] = useState(false);
  const urgent = (installations.data || []).filter((item) => item.status === "active" && Number(item.days_until) <= 7);
  const upcoming = (installations.data || []).filter((item) => item.status === "active" && Number(item.days_until) > 7 && Number(item.days_until) <= 30);
  const completedRate = stats.installations ? Math.round(((stats.completed || 0) / stats.installations) * 100) : 0;
  const messageLimit = stats.maxDaily || 24;
  const messageUsage = Math.min(100, Math.round(((stats.sentToday || 0) / messageLimit) * 100));

  const sendReminder = async (installation: api.Installation) => {
    try {
      await api.remindInstallation(installation.id, installation.next_remind_type || "first");
      notify("تم إرسال التذكير");
      await Promise.all([installations.refresh(), refreshStats()]);
    } catch (error) {
      notify(error instanceof Error ? error.message : "فشل إرسال التذكير", false);
    }
  };

  const addDemoData = async () => {
    setSeeding(true);
    try {
      const result = await api.seedDemoData(10);
      notify(`تمت إضافة ${result.customers} عملاء و${result.installations} تركيبات للتجربة`);
      await Promise.all([installations.refresh(), refreshStats()]);
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر إضافة بيانات التجربة", false);
    } finally {
      setSeeding(false);
    }
  };

  return (
    <>
      <div className="dashboard-page cloud-design">
      <section className="cloud-hero dashboard-hero">
        <div className="cloud-hero-copy">
          <span className="eyebrow">Cloud Design</span>
          <h1>مركز تشغيل BreeXe Pro</h1>
          <p>المهام الحرجة، الصيانة، ورعاية العملاء في شاشة واحدة.</p>
          <div className="hero-actions">
            <Button onClick={() => go("installations")}><Plus size={16} /> إضافة صيانة</Button>
            <Button tone="muted" loading={seeding} onClick={addDemoData}><Plus size={16} /> إضافة 10 تجربة</Button>
          </div>
        </div>
        <div className="hero-status-grid">
          <article>
            <span>إجراءات عاجلة</span>
            <strong>{urgent.length}</strong>
          </article>
          <article>
            <span>رعاية العملاء</span>
            <strong>{stats.care || 0}</strong>
          </article>
          <article>
            <span>رسائل اليوم</span>
            <strong>{stats.sentToday || 0}/{messageLimit}</strong>
          </article>
        </div>
      </section>
      <PageHeader
        title="لوحة التحكم"
        subtitle={fmtDate(today())}
        actions={
          <>
            <Button onClick={() => go("installations")}><Plus size={16} /> إضافة صيانة</Button>
            <Button tone="muted" loading={seeding} onClick={addDemoData}><Plus size={16} /> إضافة 10 تجربة</Button>
          </>
        }
      />

      <div className="stats-grid metric-grid">
        <Stat title="العملاء" value={stats.customers || 0} icon={<Users size={20} />} />
        <Stat title="عروض الأسعار" value={stats.quotes || 0} icon={<FileText size={20} />} />
        <Stat title="المنتجات" value={stats.products || 0} icon={<Package size={20} />} />
        <Stat title="الفنيون" value={stats.technicians || 0} icon={<UserRoundCog size={20} />} />
        <Stat title="التركيبات" value={stats.installations || 0} icon={<Wrench size={20} />} />
        <Stat title="متأخرة" value={stats.overdue || 0} icon={<CircleAlert size={20} />} tone="danger" />
        <Stat title="خلال أسبوع" value={stats.week || 0} icon={<CalendarDays size={20} />} tone="warn" />
        <Stat title="تحتاج رعاية" value={stats.care || 0} icon={<UserPlus size={20} />} tone={stats.care ? "danger" : "success"} />
      </div>

      <section className="cloud-panel operations-strip">
        <div>
          <span>اكتمال الصيانة</span>
          <strong>{completedRate}%</strong>
          <div className="progress-track"><i style={{ width: `${completedRate}%` }} /></div>
        </div>
        <div>
          <span>استخدام الرسائل</span>
          <strong>{messageUsage}%</strong>
          <div className="progress-track"><i style={{ width: `${messageUsage}%` }} /></div>
        </div>
        <div>
          <span>خلال 30 يوم</span>
          <strong>{upcoming.length}</strong>
          <p>موعد قادم يحتاج متابعة مبكرة</p>
        </div>
      </section>

      <ReminderDashboard notify={notify} refreshStats={refreshStats} />

      <section className="panel">
        <div className="panel-head">
          <h2>تحتاج إجراء</h2>
          <Badge tone={urgent.length ? "danger" : "success"}>{urgent.length}</Badge>
        </div>
        {installations.loading ? <Loading /> : urgent.length ? (
          <div className="list">
            {urgent.slice(0, 8).map((item) => (
              <InstallationCard key={item.id} installation={item} onRemind={() => sendReminder(item)} />
            ))}
          </div>
        ) : (
          <Empty title="لا توجد صيانة عاجلة" />
        )}
      </section>

      {!!upcoming.length && (
        <section className="panel">
          <div className="panel-head">
            <h2>خلال 30 يوم</h2>
            <Badge>{upcoming.length}</Badge>
          </div>
          <div className="list">
            {upcoming.slice(0, 6).map((item) => (
              <InstallationCard key={item.id} installation={item} />
            ))}
          </div>
        </section>
      )}
      </div>
    </>
  );
}

function Stat({ title, value, icon, tone = "default" }: { title: string; value: number; icon: ReactNode; tone?: string }) {
  return (
    <article className={`stat ${tone}`}>
      <span>{icon}</span>
      <div>
        <strong>{value}</strong>
        <p>{title}</p>
      </div>
    </article>
  );
}

function InstallationCard({
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

function CustomersPage({
  notify,
  refreshStats,
  setModal,
}: {
  notify: (message: string, ok?: boolean) => void;
  refreshStats: () => Promise<void>;
  setModal: (modal: ModalState) => void;
}) {
  const [search, setSearch] = useState("");
  const customers = useData(() => api.getCustomers(search), [search]);

  const openForm = (customer?: api.Customer) => {
    setModal({
      title: customer ? "تعديل عميل" : "إضافة عميل",
      content: (
        <CustomerForm
          initial={customer}
          onCancel={() => setModal(null)}
          onSave={async (payload) => {
            if (customer) await api.updateCustomer(customer.id, payload);
            else await api.createCustomer(payload);
            notify("تم حفظ العميل");
            setModal(null);
            await Promise.all([customers.refresh(), refreshStats()]);
          }}
        />
      ),
    });
  };

  const remove = async (customer: api.Customer) => {
    if (!window.confirm(`حذف العميل ${customer.name}؟`)) return;
    try {
      await api.deleteCustomer(customer.id);
      notify("تم حذف العميل");
      await Promise.all([customers.refresh(), refreshStats()]);
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر الحذف", false);
    }
  };

  return (
    <>
      <PageHeader
        title="العملاء"
        subtitle={`${customers.data?.total || 0} عميل`}
        actions={<Button onClick={() => openForm()}><Plus size={16} /> إضافة عميل</Button>}
      />
      <div className="toolbar">
        <Search size={16} />
        <TextInput placeholder="بحث بالاسم أو الجوال أو المدينة" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {customers.loading ? <Loading /> : customers.error ? <ErrorBlock message={customers.error} retry={customers.refresh} /> : (
        <div className="list">
          {(customers.data?.data || []).map((customer) => (
            <article className="row-card" key={customer.id}>
              <div className="row-main">
                <strong>{customer.name}</strong>
                <span>{phoneLabel(customer.phone)} · {customer.city || "بدون مدينة"}</span>
              </div>
              <div className="row-actions">
                <IconButton title="تعديل" onClick={() => openForm(customer)}><Edit3 size={15} /></IconButton>
                <IconButton title="حذف" tone="danger" onClick={() => remove(customer)}><Trash2 size={15} /></IconButton>
              </div>
            </article>
          ))}
          {!customers.data?.data.length && <Empty title="لا يوجد عملاء بعد" action={<Button onClick={() => openForm()}><Plus size={16} /> إضافة أول عميل</Button>} />}
        </div>
      )}
    </>
  );
}

function CustomerForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: api.Customer;
  onSave: (payload: Omit<api.Customer, "id">) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name || "");
  const [phone, setPhone] = useState(initial?.phone || "");
  const [city, setCity] = useState(initial?.city || "");
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await onSave({ name: name.trim(), phone: phone.trim(), city: city.trim() });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="form" onSubmit={submit}>
      <Field label="الاسم"><TextInput required value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="الجوال"><TextInput required value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="05xxxxxxxx" /></Field>
      <Field label="المدينة"><TextInput value={city} onChange={(e) => setCity(e.target.value)} /></Field>
      <div className="form-actions">
        <Button type="submit" loading={saving}><Save size={16} /> حفظ</Button>
        <Button tone="muted" onClick={onCancel}>إلغاء</Button>
      </div>
    </form>
  );
}

function ProductsPage({
  notify,
  refreshStats,
  setModal,
}: {
  notify: (message: string, ok?: boolean) => void;
  refreshStats: () => Promise<void>;
  setModal: (modal: ModalState) => void;
}) {
  const products = useData(api.getProducts);

  const openForm = (product?: api.Product) => {
    setModal({
      title: product ? "تعديل منتج" : "إضافة منتج",
      content: (
        <ProductForm
          initial={product}
          onCancel={() => setModal(null)}
          onSave={async (payload) => {
            if (product) await api.updateProduct(product.id, payload);
            else await api.createProduct(payload);
            notify("تم حفظ المنتج");
            setModal(null);
            await Promise.all([products.refresh(), refreshStats()]);
          }}
        />
      ),
    });
  };

  const remove = async (product: api.Product) => {
    if (!window.confirm(`حذف المنتج ${product.name}؟`)) return;
    try {
      await api.deleteProduct(product.id);
      notify("تم حذف المنتج");
      await Promise.all([products.refresh(), refreshStats()]);
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر الحذف", false);
    }
  };

  return (
    <>
      <PageHeader title="المنتجات" actions={<Button onClick={() => openForm()}><Plus size={16} /> إضافة منتج</Button>} />
      {products.loading ? <Loading /> : products.error ? <ErrorBlock message={products.error} retry={products.refresh} /> : (
        <div className="cards-grid">
          {(products.data || []).map((product) => (
            <article className="mini-card" key={product.id}>
              <div>
                <strong>{product.name}</strong>
                <span>كل {product.interval_months} شهر · {product.category || "عام"}</span>
              </div>
              <p>{product.remind_text || "رسالة التذكير الافتراضية"}</p>
              <div className="row-actions">
                <IconButton title="تعديل" onClick={() => openForm(product)}><Edit3 size={15} /></IconButton>
                <IconButton title="حذف" tone="danger" onClick={() => remove(product)}><Trash2 size={15} /></IconButton>
              </div>
            </article>
          ))}
          {!products.data?.length && <Empty title="لا توجد منتجات بعد" action={<Button onClick={() => openForm()}><Plus size={16} /> إضافة أول منتج</Button>} />}
        </div>
      )}
    </>
  );
}

function ProductForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: api.Product;
  onSave: (payload: Omit<api.Product, "id">) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name || "");
  const [interval, setInterval] = useState(initial?.interval_months || 3);
  const [category, setCategory] = useState(initial?.category || "");
  const [sku, setSku] = useState(initial?.sku || "");
  const [remindText, setRemindText] = useState(initial?.remind_text || "");
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await onSave({
        name: name.trim(),
        interval_months: Number(interval || 1),
        category: category.trim(),
        sku: sku.trim(),
        remind_text: remindText.trim(),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="form" onSubmit={submit}>
      <Field label="اسم المنتج"><TextInput required value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <div className="form-grid">
        <Field label="فاصل الصيانة بالأشهر"><TextInput required min={1} type="number" value={interval} onChange={(e) => setInterval(Number(e.target.value))} /></Field>
        <Field label="التصنيف"><TextInput value={category} onChange={(e) => setCategory(e.target.value)} /></Field>
      </div>
      <Field label="SKU"><TextInput value={sku} onChange={(e) => setSku(e.target.value)} /></Field>
      <Field label="نص تذكير اختياري"><TextArea rows={3} value={remindText} onChange={(e) => setRemindText(e.target.value)} /></Field>
      <div className="form-actions">
        <Button type="submit" loading={saving}><Save size={16} /> حفظ</Button>
        <Button tone="muted" onClick={onCancel}>إلغاء</Button>
      </div>
    </form>
  );
}

function InstallationsPage({
  notify,
  refreshStats,
  setModal,
}: {
  notify: (message: string, ok?: boolean) => void;
  refreshStats: () => Promise<void>;
  setModal: (modal: ModalState) => void;
}) {
  const installations = useData(api.getInstallations);

  const openForm = (installation?: api.Installation) => {
    setModal({
      title: installation ? "تعديل صيانة" : "إضافة صيانة",
      wide: true,
      content: (
        <InstallationForm
          initial={installation}
          onCancel={() => setModal(null)}
          onSave={async (payload) => {
            if (installation) await api.updateInstallation(installation.id, payload);
            else await api.createInstallation(payload);
            notify("تم حفظ الصيانة");
            setModal(null);
            await Promise.all([installations.refresh(), refreshStats()]);
          }}
        />
      ),
    });
  };

  const complete = async (installation: api.Installation) => {
    try {
      await api.completeInstallation(installation.id);
      notify("تم إكمال الصيانة");
      await Promise.all([installations.refresh(), refreshStats()]);
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر الإكمال", false);
    }
  };

  const remind = async (installation: api.Installation) => {
    try {
      await api.remindInstallation(installation.id, installation.next_remind_type || "first");
      notify("تم إرسال التذكير");
      await Promise.all([installations.refresh(), refreshStats()]);
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر إرسال التذكير", false);
    }
  };

  const runDue = async () => {
    try {
      const result = await api.runDueReminders();
      if (result.blocked) {
        notify(result.error || "التذكيرات متوقفة. راجع تشخيص واتساب والجدولة.", false);
      } else if (result.sent > 0) {
        notify(`تم إرسال ${result.sent} من ${result.checked} تذكير مستحق`);
      } else if (result.failed > 0) {
        notify(`فشل إرسال ${result.failed} تذكير. راجع سجل التذكيرات لمعرفة السبب.`, false);
      } else if (result.checked > 0) {
        notify(`لم يتم إرسال أي تذكير. تم تخطي ${result.skipped || 0} حسب قواعد التكرار.`, false);
      } else {
        notify("لا توجد تذكيرات مستحقة الآن");
      }
      await Promise.all([installations.refresh(), refreshStats()]);
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر تشغيل التذكيرات", false);
    }
  };

  const remove = async (installation: api.Installation) => {
    if (!window.confirm(`حذف صيانة ${installation.customer_name}؟`)) return;
    try {
      await api.deleteInstallation(installation.id);
      notify("تم حذف الصيانة");
      await Promise.all([installations.refresh(), refreshStats()]);
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر الحذف", false);
    }
  };

  return (
    <>
      <PageHeader
        title="الصيانة"
        actions={
          <>
            <Button tone="muted" onClick={runDue}><Play size={16} /> تشغيل المستحق</Button>
            <Button onClick={() => openForm()}><Plus size={16} /> إضافة صيانة</Button>
          </>
        }
      />
      {installations.loading ? <Loading /> : installations.error ? <ErrorBlock message={installations.error} retry={installations.refresh} /> : (
        <div className="list">
          {(installations.data || []).map((installation) => (
            <InstallationCard
              key={installation.id}
              installation={installation}
              onRemind={() => remind(installation)}
              onComplete={() => complete(installation)}
              onEdit={() => openForm(installation)}
              onDelete={() => remove(installation)}
            />
          ))}
          {!installations.data?.length && <Empty title="لا توجد عمليات صيانة بعد" action={<Button onClick={() => openForm()}><Plus size={16} /> إضافة أول صيانة</Button>} />}
        </div>
      )}
    </>
  );
}

function InstallationForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: api.Installation;
  onSave: (payload: Omit<api.Installation, "id" | "remind_count" | "status">) => Promise<void>;
  onCancel: () => void;
}) {
  const customers = useData(() => api.getCustomers(""));
  const products = useData(api.getProducts);
  const [customerId, setCustomerId] = useState(initial?.customer_id || "");
  const [productId, setProductId] = useState(initial?.product_id || "");
  const [installDate, setInstallDate] = useState(initial?.install_date || today());
  const [nextMaintenance, setNextMaintenance] = useState(initial?.next_maintenance || today());
  const [label, setLabel] = useState(initial?.label || "");
  const [saving, setSaving] = useState(false);

  const selectedCustomer = useMemo(
    () => customers.data?.data.find((item) => item.id === customerId),
    [customers.data, customerId],
  );
  const selectedProduct = useMemo(
    () => products.data?.find((item) => item.id === productId),
    [products.data, productId],
  );

  useEffect(() => {
    if (!customerId && customers.data?.data[0]) setCustomerId(customers.data.data[0].id);
  }, [customers.data, customerId]);

  useEffect(() => {
    if (!productId && products.data?.[0]) setProductId(products.data[0].id);
  }, [products.data, productId]);

  useEffect(() => {
    if (!initial && selectedProduct) setNextMaintenance(addMonths(installDate, selectedProduct.interval_months));
  }, [installDate, selectedProduct, initial]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedCustomer || !selectedProduct) return;
    setSaving(true);
    try {
      await onSave({
        customer_id: selectedCustomer.id,
        customer_name: selectedCustomer.name,
        customer_phone: selectedCustomer.phone,
        product_id: selectedProduct.id,
        product_name: selectedProduct.name,
        product_sku: selectedProduct.sku || "",
        install_date: installDate,
        next_maintenance: nextMaintenance,
        next_remind_type: initial?.next_remind_type || "first",
        label: label.trim(),
      });
    } finally {
      setSaving(false);
    }
  };

  const noData = !customers.loading && !products.loading && (!customers.data?.data.length || !products.data?.length);

  if (customers.loading || products.loading) return <Loading />;
  if (noData) return <Empty title="أضف عميلا ومنتجا قبل إنشاء الصيانة" />;

  return (
    <form className="form" onSubmit={submit}>
      <div className="form-grid">
        <Field label="العميل">
          <SelectInput value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            {(customers.data?.data || []).map((customer) => <option key={customer.id} value={customer.id}>{customer.name} - {phoneLabel(customer.phone)}</option>)}
          </SelectInput>
        </Field>
        <Field label="المنتج">
          <SelectInput value={productId} onChange={(e) => setProductId(e.target.value)}>
            {(products.data || []).map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
          </SelectInput>
        </Field>
      </div>
      <div className="form-grid">
        <Field label="تاريخ التركيب"><TextInput type="date" value={installDate} onChange={(e) => setInstallDate(e.target.value)} /></Field>
        <Field label="موعد الصيانة القادم"><TextInput type="date" value={nextMaintenance} onChange={(e) => setNextMaintenance(e.target.value)} /></Field>
      </div>
      <Field label="ملاحظة"><TextInput value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
      <div className="form-actions">
        <Button type="submit" loading={saving}><Save size={16} /> حفظ</Button>
        <Button tone="muted" onClick={onCancel}>إلغاء</Button>
      </div>
    </form>
  );
}

function CustomerCarePage({
  notify,
  refreshStats,
}: {
  notify: (message: string, ok?: boolean) => void;
  refreshStats: () => Promise<void>;
}) {
  const queue = useData(api.getCustomerCareQueue);
  const [sendingId, setSendingId] = useState("");

  const sendReminder = async (item: api.CustomerCareItem) => {
    if (!item.installation_id) {
      notify("هذا العميل يحتاج تواصل يدوي أولا قبل إرسال تذكير صيانة.", false);
      return;
    }

    setSendingId(item.id);
    try {
      await api.remindInstallation(item.installation_id, "first");
      notify("تم إرسال التذكير وإخراج العميل من قائمة الإهمال");
      await Promise.all([queue.refresh(), refreshStats()]);
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر إرسال التذكير", false);
    } finally {
      setSendingId("");
    }
  };

  return (
    <>
      <PageHeader
        title="رعاية العملاء"
        subtitle="قائمة يومية لأي عميل يحتاج متابعة حتى لا يضيع بين الطلبات والحجوزات"
        actions={<Button tone="muted" onClick={queue.refresh}><RefreshCcw size={16} /> تحديث</Button>}
      />

      {queue.loading ? <Loading /> : queue.error ? <ErrorBlock message={queue.error} retry={queue.refresh} /> : (
        <div className="list">
          {(queue.data || []).map((item) => (
            <article className="row-card" key={item.id}>
              <div className="row-main">
                <strong>{item.customer_name}</strong>
                <span>{phoneLabel(item.customer_phone)} · {item.city || "بدون مدينة"} · {item.source === "salla" ? "سلة" : "يدوي"}</span>
                <div className="chips">
                  <Badge tone={careTone(item.priority)}>{careReasonLabel(item.reason)}</Badge>
                  {item.product_name && <Badge>{item.product_name}</Badge>}
                  {item.next_maintenance && <Badge>{fmtDate(item.next_maintenance)} · {daysLabel(item.days_until)}</Badge>}
                </div>
                <em>{item.next_action}</em>
              </div>
              <div className="row-actions">
                {item.installation_id ? (
                  <Button tone="success" loading={sendingId === item.id} onClick={() => sendReminder(item)}>
                    <Send size={16} /> إرسال تذكير
                  </Button>
                ) : (
                  <Button tone="muted" onClick={() => navigator.clipboard?.writeText(item.customer_phone)}>
                    <ClipboardList size={16} /> نسخ الرقم
                  </Button>
                )}
              </div>
            </article>
          ))}
          {!queue.data?.length && <Empty title="كل العملاء لديهم مسار متابعة واضح" />}
        </div>
      )}
    </>
  );
}

function StoreOrdersPage({
  notify,
  refreshStats,
  setModal,
}: {
  notify: (message: string, ok?: boolean) => void;
  refreshStats: () => Promise<void>;
  setModal: (modal: ModalState) => void;
}) {
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState("");
  const seenOrderIdsRef = useRef<Set<string>>(new Set());
  const bootstrappedRef = useRef(false);
  const orders = useData(() => api.getStoreOrders({ type: "all" }), []);
  const setOrderData = orders.setData;

  const openWorkflowForm = (order: api.StoreOrder, item?: api.StoreOrderItem) => {
    setModal({
      title: "إدارة بند الطلب",
      wide: true,
      content: (
        <StoreOrderWorkflowForm
          order={order}
          initialItemSku={item?.sku}
          onCancel={() => setModal(null)}
          onSaved={async (message) => {
            notify(message);
            setModal(null);
            await Promise.all([orders.refresh(), refreshStats()]);
          }}
          onError={(message) => notify(message, false)}
        />
      ),
    });
  };

  const openLinkForm = (order: api.StoreOrder) => {
    setModal({
      title: "ربط طلب صيانة بتركيب سابق",
      wide: true,
      content: (
        <StoreOrderLinkForm
          order={order}
          onCancel={() => setModal(null)}
          onSave={async (payload) => {
            try {
              await api.linkStoreOrderInstallation(order.id, payload);
              notify("تم ربط طلب الصيانة بالتركيب السابق");
              setModal(null);
              await Promise.all([orders.refresh(), refreshStats()]);
            } catch (error) {
              notify(error instanceof Error ? error.message : "تعذر ربط الطلب", false);
            }
          }}
        />
      ),
    });
  };

  const updateSeenOrders = useCallback((nextOrders: api.StoreOrder[], quiet = false) => {
    const nextIds = new Set(nextOrders.map((order) => order.id));
    const newOrders = nextOrders.filter((order) => !seenOrderIdsRef.current.has(order.id));

    if (bootstrappedRef.current && newOrders.length && !quiet) {
      notify(`وصل ${newOrders.length} طلب جديد من سلة`);
    }

    seenOrderIdsRef.current = nextIds;
    bootstrappedRef.current = true;
    setLastUpdated(new Date().toISOString());
  }, [notify]);

  const refreshOrders = useCallback(async (options: { sync?: boolean; background?: boolean } = {}) => {
    if (options.sync) setSyncing(true);
    if (!options.background && !options.sync) setRefreshing(true);

    try {
      if (options.sync) {
        const result = await api.syncSallaOrders();
        const products = result.products;
        const productSummary = products ? ` · المنتجات ${products.imported} جديد و${products.updated} محدث` : "";
        notify(`تحديث سلة انتهى: الطلبات ${result.imported} جديد، ${result.updated} محدث، ${result.failed} فشل${productSummary}`, result.failed === 0 && (!products || products.failed === 0));
      }

      const nextOrders = await api.getStoreOrders({ type: "all" });
      setOrderData(nextOrders);
      updateSeenOrders(nextOrders, options.background);

      if (!options.background || options.sync) {
        await refreshStats();
      }
    } catch (error) {
      if (!options.background) {
        notify(error instanceof Error ? error.message : "تعذر تحديث طلبات المتجر", false);
      }
    } finally {
      setSyncing(false);
      setRefreshing(false);
    }
  }, [notify, refreshStats, setOrderData, updateSeenOrders]);

  useEffect(() => {
    if (!orders.data) return;
    updateSeenOrders(orders.data, true);
  }, [orders.data, updateSeenOrders]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => {
      void refreshOrders({ background: true });
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, refreshOrders]);

  const allOrders = orders.data || [];
  const matchesType = useCallback((order: api.StoreOrder, value: string) => {
    if (value === "all") return true;
    if (value === "needs_review" || value === "awaiting_schedule" || value === "booking_created") {
      return order.journey_status === value || Boolean(order.items?.some((item) => item.status === value));
    }
    return Boolean(
      order.order_types?.includes(value as api.StoreItemType) ||
        order.items?.some((item) => effectiveStoreOrderType(item) === value),
    );
  }, []);

  const filteredOrders = useMemo(() => {
    const term = search.trim().toLowerCase();
    return allOrders.filter((order) => {
      if (!matchesType(order, filter)) return false;
      if (!term) return true;
      const haystack = [
        order.order_number,
        order.order_id,
        order.customer_name,
        order.customer_phone,
        order.status,
        ...(order.items || []).flatMap((item) => [item.name, item.sku]),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(term);
    });
  }, [allOrders, filter, matchesType, search]);

  const summary = useMemo(() => {
    const todayKey = today();
    return {
      total: allOrders.length,
      needsReview: allOrders.filter((order) => matchesType(order, "needs_review")).length,
      awaitingSchedule: allOrders.filter((order) => matchesType(order, "awaiting_schedule")).length,
      booked: allOrders.filter((order) => matchesType(order, "booking_created")).length,
      today: allOrders.filter((order) => String(order.imported_at || order.order_date || "").startsWith(todayKey)).length,
    };
  }, [allOrders, matchesType]);

  const tabs = [
    ["all", "الكل", summary.total],
    ["needs_review", "مراجعة", summary.needsReview],
    ["awaiting_schedule", "بانتظار الجدولة", summary.awaitingSchedule],
    ["booking_created", "محولة لفني", summary.booked],
    ["sale_only", "بيع فقط", allOrders.filter((order) => matchesType(order, "sale_only")).length],
    ["install_maintenance", "تركيب", allOrders.filter((order) => matchesType(order, "install_maintenance")).length],
    ["maintenance_existing", "صيانة سابقة", allOrders.filter((order) => matchesType(order, "maintenance_existing")).length],
    ["external_maintenance", "صيانة خارجية", allOrders.filter((order) => matchesType(order, "external_maintenance")).length],
  ] as const;

  const productsLabel = (order: api.StoreOrder) => {
    const items = order.items || [];
    if (!items.length) return "-";
    const visible = items.slice(0, 2).map((item) => `${item.name} × ${item.quantity}`);
    return items.length > 2 ? `${visible.join("، ")} +${items.length - 2}` : visible.join("، ");
  };

  const storeOrderItemTotal = (item: api.StoreOrderItem) => {
    if (typeof item.total_price === "number" && Number.isFinite(item.total_price)) return item.total_price;
    if (typeof item.unit_price === "number" && Number.isFinite(item.unit_price)) {
      return item.unit_price * Number(item.quantity || 1);
    }
    return null;
  };

  const productsLabelDetailed = (order: api.StoreOrder) => {
    const items = order.items || [];
    if (!items.length) return "-";
    const visible = items.slice(0, 2).map((item) => {
      const total = storeOrderItemTotal(item);
      const price = total !== null ? ` - ${moneyLabel(total)}` : "";
      return `${item.name} x ${item.quantity}${price}`;
    });
    return items.length > 2 ? `${visible.join(" | ")} +${items.length - 2}` : visible.join(" | ");
  };

  const orderTotal = (order: api.StoreOrder) => {
    if (typeof order.total === "number" && Number.isFinite(order.total)) return order.total;
    const itemTotal = (order.items || []).reduce((sum, item) => sum + (storeOrderItemTotal(item) || 0), 0);
    return itemTotal > 0 ? itemTotal : null;
  };

  const orderTypeLabel = (order: api.StoreOrder) => {
    const types = Array.from(new Set((order.items || []).map((item) => effectiveStoreOrderType(item))));
    if (!types.length) return storeOrderTypeLabel(order.order_types?.[0]);
    return types.map(storeOrderTypeLabel).join("، ");
  };

  return (
    <>
      <PageHeader
        title="طلبات المتجر"
        subtitle="لوحة تشغيل يومية للطلبات القادمة من سلة: مراجعة، جدولة، وتحويل للفنيين"
        actions={
          <>
            <Button loading={syncing} onClick={() => refreshOrders({ sync: true })}><RefreshCcw size={16} /> تحديث فوري</Button>
            <Button tone="muted" loading={refreshing} onClick={() => refreshOrders()}><RefreshCcw size={16} /> تحديث الجدول</Button>
          </>
        }
      />

      <section className="ops-strip">
        <article className="ops-card">
          <strong>{summary.total}</strong>
          <span>كل الطلبات</span>
        </article>
        <article className="ops-card danger">
          <strong>{summary.needsReview}</strong>
          <span>تحتاج مراجعة</span>
        </article>
        <article className="ops-card warn">
          <strong>{summary.awaitingSchedule}</strong>
          <span>بانتظار الجدولة</span>
        </article>
        <article className="ops-card success">
          <strong>{summary.booked}</strong>
          <span>محولة لفني</span>
        </article>
        <article className="ops-card">
          <strong>{summary.today}</strong>
          <span>وصلت اليوم</span>
        </article>
      </section>

      <section className="store-board">
        <div className="store-board-toolbar">
          <div className="toolbar compact">
            <Search size={16} />
            <TextInput placeholder="ابحث برقم الطلب، العميل، الجوال، المنتج أو SKU" value={search} onChange={(event) => setSearch(event.target.value)} />
          </div>
          <label className="toggle-control">
            <input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} />
            <span>تحديث تلقائي</span>
          </label>
          <span className="sync-meta">{lastUpdated ? `آخر تحديث: ${fmtDate(lastUpdated)}` : "بانتظار أول تحديث"}</span>
        </div>

        <div className="tabs table-tabs">
          {tabs.map(([value, label, count]) => (
            <button key={value} type="button" className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>
              {label} <b>{count}</b>
            </button>
          ))}
        </div>

        {orders.loading ? <Loading /> : orders.error ? <ErrorBlock message={orders.error} retry={() => refreshOrders()} /> : (
          <div className="orders-table-wrap">
            <table className="orders-table">
              <thead>
                <tr>
                  <th aria-label="تحديد"></th>
                  <th>رقم الطلب</th>
                  <th>تاريخ الطلب</th>
                  <th>الحالة</th>
                  <th>العميل</th>
                  <th>المنتجات</th>
                  <th>القيمة</th>
                  <th>نوع الرحلة</th>
                  <th>الفني/الحجز</th>
                  <th>الموعد</th>
                  <th>إجراء</th>
                </tr>
              </thead>
              <tbody>
                {filteredOrders.map((order) => {
                  const needsReview = order.journey_status === "needs_review" || order.items?.some((item) => item.status === "needs_review");
                  return (
                    <tr key={order.id}>
                      <td><input type="checkbox" aria-label={`تحديد الطلب ${order.order_number || order.order_id}`} /></td>
                      <td>
                        <div className="order-id-cell">
                          <strong>{order.order_number || order.order_id}</strong>
                          <span>{order.provider || "salla"}</span>
                        </div>
                      </td>
                      <td>{fmtDate(order.order_date || order.imported_at)}</td>
                      <td><Badge tone={journeyTone(order.journey_status)}>{journeyLabel(order.journey_status)}</Badge></td>
                      <td>
                        <div className="order-customer-cell">
                          <strong>{order.customer_name || "-"}</strong>
                          <span>{phoneLabel(order.customer_phone)}</span>
                        </div>
                      </td>
                      <td>
                        <div className="order-products-cell">
                          <span>{productsLabelDetailed(order)}</span>
                          {(order.items || []).slice(0, 2).map((item) => (
                            <button key={`${order.id}-${item.sku}`} type="button" onClick={() => openWorkflowForm(order, item)}>
                              {item.sku || "بدون SKU"} · {journeyLabel(item.status)}
                            </button>
                          ))}
                        </div>
                      </td>
                      <td>{moneyLabel(orderTotal(order))}</td>
                      <td>{orderTypeLabel(order)}</td>
                      <td>{order.booking_ids?.length ? `${order.booking_ids.length} حجز` : "لم يحول"}</td>
                      <td>{order.scheduled_date ? `${fmtDate(order.scheduled_date)} ${order.scheduled_time || ""}` : "غير مجدول"}</td>
                      <td>
                        <div className="table-actions">
                          <Button tone="muted" onClick={() => openWorkflowForm(order)}><UserRoundCog size={16} /> إدارة</Button>
                          {needsReview && <Button tone="success" onClick={() => openLinkForm(order)}><Wrench size={16} /> ربط</Button>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!filteredOrders.length && <Empty title="لا توجد طلبات مطابقة لهذا البحث أو الفلتر" />}
          </div>
        )}
      </section>
    </>
  );
}

function StoreOrderWorkflowForm({
  order,
  initialItemSku,
  onSaved,
  onError,
  onCancel,
}: {
  order: api.StoreOrder;
  initialItemSku?: string;
  onSaved: (message: string) => Promise<void>;
  onError: (message: string) => void;
  onCancel: () => void;
}) {
  const technicians = useData(api.getTechnicians);
  const installations = useData(api.getInstallations);
  const items = order.items || [];
  const [itemSku, setItemSku] = useState(initialItemSku || items[0]?.sku || "");
  const selectedItem = useMemo(
    () => items.find((item) => item.sku === itemSku) || items[0],
    [items, itemSku],
  );
  const reviewCandidates = useMemo(
    () =>
      (installations.data || []).filter(
        (installation) => installation.status === "active" && installation.customer_phone === order.customer_phone,
      ),
    [installations.data, order.customer_phone],
  );
  const [manualType, setManualType] = useState<api.StoreItemType>(effectiveStoreOrderType(selectedItem) as api.StoreItemType);
  const [technicianId, setTechnicianId] = useState("");
  const [scheduledDate, setScheduledDate] = useState(order.scheduled_date || today());
  const [scheduledTime, setScheduledTime] = useState(order.scheduled_time || "10:00");
  const [installationId, setInstallationId] = useState("");
  const [sendNow, setSendNow] = useState(true);
  const [savingMode, setSavingMode] = useState<"classify" | "assign" | "" >("");

  useEffect(() => {
    setManualType(effectiveStoreOrderType(selectedItem) as api.StoreItemType);
    setInstallationId("");
  }, [selectedItem?.sku]);

  useEffect(() => {
    if (!technicianId && technicians.data?.[0]) setTechnicianId(technicians.data[0].id);
  }, [technicianId, technicians.data]);

  useEffect(() => {
    if (!installationId && reviewCandidates[0] && manualType === "maintenance_existing") {
      setInstallationId(reviewCandidates[0].id);
    }
  }, [installationId, manualType, reviewCandidates]);

  const handleClassify = async () => {
    if (!selectedItem) return;
    setSavingMode("classify");
    try {
      if (manualType === "maintenance_existing" && !selectedItem.installation_id && installationId) {
        await api.linkStoreOrderInstallation(order.id, { installationId, itemSku: selectedItem.sku });
      }
      await api.classifyStoreOrderItem(order.id, { itemSku: selectedItem.sku, manualType });
      await onSaved("تم حفظ تصنيف بند الطلب");
    } catch (error) {
      onError(error instanceof Error ? error.message : "تعذر حفظ التصنيف");
    } finally {
      setSavingMode("");
    }
  };

  const handleAssign = async () => {
    if (!selectedItem) return;
    setSavingMode("assign");
    try {
      if (manualType === "maintenance_existing" && !selectedItem.installation_id && installationId) {
        await api.linkStoreOrderInstallation(order.id, { installationId, itemSku: selectedItem.sku });
      }
      await api.classifyStoreOrderItem(order.id, { itemSku: selectedItem.sku, manualType });
      const result = await api.assignStoreOrderTechnician(order.id, {
        itemSku: selectedItem.sku,
        technicianId,
        scheduledDate,
        scheduledTime,
        sendNow,
      });
      await onSaved(sendNow && result.notification ? "تم تحويل الطلب إلى الفني وإرسال الموعد له" : "تم تحويل الطلب إلى الفني وحفظ الحجز");
    } catch (error) {
      onError(error instanceof Error ? error.message : "تعذر تحويل الطلب إلى الفني");
    } finally {
      setSavingMode("");
    }
  };

  const selectedItemTotal =
    selectedItem && typeof selectedItem.total_price === "number"
      ? selectedItem.total_price
      : selectedItem && typeof selectedItem.unit_price === "number"
        ? selectedItem.unit_price * Number(selectedItem.quantity || 1)
        : null;
  const workflowOrderTotal =
    typeof order.total === "number" && Number.isFinite(order.total)
      ? order.total
      : (order.items || []).reduce((sum, item) => {
          if (typeof item.total_price === "number" && Number.isFinite(item.total_price)) return sum + item.total_price;
          if (typeof item.unit_price === "number" && Number.isFinite(item.unit_price)) {
            return sum + item.unit_price * Number(item.quantity || 1);
          }
          return sum;
        }, 0) || null;

  if (technicians.loading || installations.loading) return <Loading />;
  if (!selectedItem) return <Empty title="لا يوجد بند متاح داخل هذا الطلب" />;
  if (!technicians.data?.length) return <Empty title="أضف فنيًا واحدًا على الأقل قبل تحويل الطلب إليه" />;

  return (
    <form className="form" onSubmit={(event) => event.preventDefault()}>
      <div className="cards-grid">
        <article className="mini-card">
          <strong>الطلب</strong>
          <span>{order.order_number || order.order_id}</span>
          <p>{order.customer_name} · {phoneLabel(order.customer_phone)}</p>
        </article>
        <article className="mini-card">
          <strong>قيمة الطلب</strong>
          <span>{moneyLabel(workflowOrderTotal)}</span>
          <p>{fmtDate(order.order_date)}</p>
        </article>
        <article className="mini-card">
          <strong>الحالة الحالية</strong>
          <span>{journeyLabel(order.journey_status)}</span>
          <p>{selectedItem.reason || "البند جاهز للتنفيذ اليدوي."}</p>
        </article>
      </div>
      <Field label="بند الطلب">
        <SelectInput value={itemSku} onChange={(e) => setItemSku(e.target.value)}>
          {items.map((item) => (
            <option key={`${item.sku}-${item.name}`} value={item.sku}>
              {item.name} · الكمية {item.quantity} · {item.sku}
            </option>
          ))}
        </SelectInput>
      </Field>
      <div className="chips">
        {selectedItemTotal !== null && <Badge>{moneyLabel(selectedItemTotal)}</Badge>}
        <Badge>النوع الحالي: {storeOrderTypeLabel(effectiveStoreOrderType(selectedItem))}</Badge>
        {selectedItem.detected_type && <Badge tone="warn">التلقائي: {storeOrderTypeLabel(selectedItem.detected_type)}</Badge>}
        <Badge tone={journeyTone(selectedItem.status)}>رحلة البند: {journeyLabel(selectedItem.status)}</Badge>
      </div>
      <Field label="تصنيف البند">
        <SelectInput value={manualType} onChange={(e) => setManualType(e.target.value as api.StoreItemType)}>
          <option value="sale_only">بيع فقط</option>
          <option value="install_maintenance">منتج جديد يحتاج تركيب وصيانة</option>
          <option value="maintenance_existing">صيانة لمنتج سابق</option>
          <option value="external_maintenance">صيانة جهاز خارجي</option>
          <option value="needs_review">يحتاج مراجعة</option>
        </SelectInput>
      </Field>
      {manualType === "maintenance_existing" && !selectedItem.installation_id && (
        <Field label="التركيب السابق">
          <SelectInput value={installationId} onChange={(e) => setInstallationId(e.target.value)}>
            {reviewCandidates.map((installation) => (
              <option key={installation.id} value={installation.id}>
                {installation.customer_name} - {installation.product_name} - {installation.product_sku || installation.product_id}
              </option>
            ))}
          </SelectInput>
        </Field>
      )}
      {manualType !== "sale_only" && manualType !== "needs_review" && (
        <>
          <div className="form-grid">
            <Field label="الفني">
              <SelectInput value={technicianId} onChange={(e) => setTechnicianId(e.target.value)}>
                {(technicians.data || []).map((tech) => (
                  <option key={tech.id} value={tech.id}>{tech.name} - {phoneLabel(tech.phone)}</option>
                ))}
              </SelectInput>
            </Field>
            <Field label="التاريخ">
              <TextInput type="date" value={scheduledDate} onChange={(e) => setScheduledDate(e.target.value)} />
            </Field>
          </div>
          <div className="form-grid">
            <Field label="الوقت">
              <TextInput type="time" value={scheduledTime} onChange={(e) => setScheduledTime(e.target.value)} />
            </Field>
            <label className="field checkbox-field">
              <span>إرسال الموعد للفني مباشرة</span>
              <input type="checkbox" checked={sendNow} onChange={(e) => setSendNow(e.target.checked)} />
            </label>
          </div>
        </>
      )}
      <div className="form-actions">
        <Button type="button" loading={savingMode === "classify"} onClick={handleClassify}>
          <Save size={16} /> حفظ التصنيف
        </Button>
        {manualType !== "sale_only" && manualType !== "needs_review" && (
          <Button type="button" tone="success" loading={savingMode === "assign"} onClick={handleAssign}>
            <Send size={16} /> تحويل إلى الفني
          </Button>
        )}
        <Button tone="muted" onClick={onCancel}>إلغاء</Button>
      </div>
    </form>
  );
}

function StoreOrderLinkForm({
  order,
  onSave,
  onCancel,
}: {
  order: api.StoreOrder;
  onSave: (payload: { installationId: string; itemSku?: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const installations = useData(api.getInstallations);
  const reviewableItems = (order.items || []).filter((item) => item.status === "needs_review" || item.order_type === "maintenance_existing");
  const [itemSku, setItemSku] = useState(reviewableItems[0]?.sku || "");
  const [installationId, setInstallationId] = useState("");
  const [saving, setSaving] = useState(false);

  const candidates = useMemo(
    () =>
      (installations.data || []).filter(
        (item) =>
          item.status === "active" &&
          (!order.customer_phone || item.customer_phone === order.customer_phone),
      ),
    [installations.data, order.customer_phone],
  );

  useEffect(() => {
    if (!installationId && candidates[0]) setInstallationId(candidates[0].id);
  }, [installationId, candidates]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!installationId) return;
    setSaving(true);
    try {
      await onSave({ installationId, itemSku: itemSku || undefined });
    } finally {
      setSaving(false);
    }
  };

  if (installations.loading) return <Loading />;
  if (!candidates.length) return <Empty title="لا يوجد تركيب نشط بنفس رقم جوال العميل. أضف التركيب أو صحح رقم العميل ثم أعد الربط." />;

  return (
    <form className="form" onSubmit={submit}>
      <Field label="بند الطلب">
        <SelectInput value={itemSku} onChange={(e) => setItemSku(e.target.value)}>
          {reviewableItems.map((item) => (
            <option key={`${item.sku}-${item.order_type}`} value={item.sku}>{item.name} - {item.sku}</option>
          ))}
        </SelectInput>
      </Field>
      <Field label="التركيب السابق">
        <SelectInput value={installationId} onChange={(e) => setInstallationId(e.target.value)}>
          {candidates.map((installation) => (
            <option key={installation.id} value={installation.id}>
              {installation.customer_name} - {installation.product_name} - {installation.product_sku || installation.product_id}
            </option>
          ))}
        </SelectInput>
      </Field>
      <div className="form-actions">
        <Button type="submit" loading={saving}><Save size={16} /> ربط</Button>
        <Button tone="muted" onClick={onCancel}>إلغاء</Button>
      </div>
    </form>
  );
}

function TechniciansPage({
  notify,
  refreshStats,
  setModal,
}: {
  notify: (message: string, ok?: boolean) => void;
  refreshStats: () => Promise<void>;
  setModal: (modal: ModalState) => void;
}) {
  const technicians = useData(api.getTechnicians);
  const todayBookings = useData(() => api.getBookings({ date: today() }), []);

  const technicianTodayCount = (technicianId: string) =>
    (todayBookings.data || []).filter(
      (booking) => booking.technician_id === technicianId && booking.status === "confirmed",
    ).length;

  const technicianCapacityTone = (count: number, capacity: number): "success" | "warn" | "danger" => {
    if (count >= capacity) return "danger";
    if (count >= Math.max(1, capacity - 1)) return "warn";
    return "success";
  };

  const openForm = (technician?: api.Technician) => {
    setModal({
      title: technician ? "تعديل فني" : "إضافة فني",
      content: (
        <TechnicianForm
          initial={technician}
          onCancel={() => setModal(null)}
          onSave={async (payload) => {
            if (technician) await api.updateTechnician(technician.id, payload);
            else await api.createTechnician(payload);
            notify("تم حفظ الفني");
            setModal(null);
            await Promise.all([technicians.refresh(), todayBookings.refresh(), refreshStats()]);
          }}
        />
      ),
    });
  };

  const remove = async (technician: api.Technician) => {
    if (!window.confirm(`حذف الفني ${technician.name}؟`)) return;
    try {
      await api.deleteTechnician(technician.id);
      notify("تم حذف الفني");
      await Promise.all([technicians.refresh(), todayBookings.refresh(), refreshStats()]);
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر الحذف", false);
    }
  };

  return (
    <>
      <PageHeader title="الفنيون" actions={<Button onClick={() => openForm()}><Plus size={16} /> إضافة فني</Button>} />
      {technicians.loading ? <Loading /> : technicians.error ? <ErrorBlock message={technicians.error} retry={technicians.refresh} /> : (
        <div className="cards-grid">
          {(technicians.data || []).map((technician) => (
            <article className="mini-card" key={technician.id}>
              <div>
                <strong>{technician.name}</strong>
                <span>{phoneLabel(technician.phone)} · {technician.specialty || "عام"}</span>
              </div>
              <p>{technician.max_daily} زيارات يوميا</p>
              <div className="chips">
                <Badge tone={technicianCapacityTone(technicianTodayCount(technician.id), Number(technician.max_daily || 4))}>
                  {technicianTodayCount(technician.id)} / {Number(technician.max_daily || 4)} اليوم
                </Badge>
              </div>
              <div className="row-actions">
                <IconButton title="تعديل" onClick={() => openForm(technician)}><Edit3 size={15} /></IconButton>
                <IconButton title="حذف" tone="danger" onClick={() => remove(technician)}><Trash2 size={15} /></IconButton>
              </div>
            </article>
          ))}
          {!technicians.data?.length && <Empty title="لا يوجد فنيون بعد" action={<Button onClick={() => openForm()}><Plus size={16} /> إضافة أول فني</Button>} />}
        </div>
      )}
    </>
  );
}

function TechnicianForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: api.Technician;
  onSave: (payload: Omit<api.Technician, "id">) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name || "");
  const [phone, setPhone] = useState(initial?.phone || "");
  const [specialty, setSpecialty] = useState(initial?.specialty || "");
  const [maxDaily, setMaxDaily] = useState(initial?.max_daily || 4);
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await onSave({ name: name.trim(), phone: phone.trim(), specialty: specialty.trim(), max_daily: Number(maxDaily || 4) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="form" onSubmit={submit}>
      <Field label="الاسم"><TextInput required value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="الجوال"><TextInput required value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
      <div className="form-grid">
        <Field label="التخصص"><TextInput value={specialty} onChange={(e) => setSpecialty(e.target.value)} /></Field>
        <Field label="الزيارات اليومية"><TextInput type="number" min={1} value={maxDaily} onChange={(e) => setMaxDaily(Number(e.target.value))} /></Field>
      </div>
      <div className="form-actions">
        <Button type="submit" loading={saving}><Save size={16} /> حفظ</Button>
        <Button tone="muted" onClick={onCancel}>إلغاء</Button>
      </div>
    </form>
  );
}

function BookingsPage({
  notify,
  refreshStats,
  setModal,
}: {
  notify: (message: string, ok?: boolean) => void;
  refreshStats: () => Promise<void>;
  setModal: (modal: ModalState) => void;
}) {
  const [date, setDate] = useState(today());
  const bookings = useData(() => api.getBookings({ date }), [date]);

  const shouldNotifyTechnician = (previous: api.Booking | undefined, next: Omit<api.Booking, "id">) =>
    next.status === "confirmed" &&
    (!previous ||
      previous.status !== "confirmed" ||
      previous.date !== next.date ||
      previous.scheduled_time !== next.scheduled_time ||
      previous.technician_id !== next.technician_id ||
      previous.installation_id !== next.installation_id);

  const sendTechnicianNotice = async (booking: api.Booking, trigger = "manual") => {
    try {
      await api.notifyTechnicianBooking(booking.id, trigger);
      notify("تم إرسال الموعد للفني");
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر إرسال الموعد للفني", false);
    }
  };

  const complete = async (booking: api.Booking) => {
    try {
      await api.completeBooking(booking.id);
      notify("تم إكمال الحجز وتحديث موعد الصيانة القادم");
      await Promise.all([bookings.refresh(), refreshStats()]);
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر إكمال الحجز", false);
    }
  };

  const openForm = (booking?: api.Booking) => {
    setModal({
      title: booking ? "تعديل حجز" : "إضافة حجز",
      wide: true,
      content: (
        <BookingForm
          initial={booking}
          selectedDate={date}
          onCancel={() => setModal(null)}
          onSave={async (payload) => {
            const bookingId = booking ? booking.id : await api.createBooking(payload);
            if (booking) await api.updateBooking(booking.id, payload);
            const shouldNotify = shouldNotifyTechnician(booking, payload);
            if (shouldNotify) {
              try {
                await api.notifyTechnicianBooking(bookingId, booking ? "updated" : "created");
                notify("تم حفظ الحجز وإرسال الموعد للفني");
              } catch (error) {
                notify(error instanceof Error ? `تم حفظ الحجز لكن لم يرسل الموعد للفني: ${error.message}` : "تم حفظ الحجز لكن لم يرسل الموعد للفني", false);
              }
            } else {
              notify("تم حفظ الحجز");
            }
            setModal(null);
            await Promise.all([bookings.refresh(), refreshStats()]);
          }}
        />
      ),
    });
  };

  const remove = async (booking: api.Booking) => {
    if (!window.confirm(`حذف حجز ${booking.customer_name}؟`)) return;
    try {
      await api.deleteBooking(booking.id);
      notify("تم حذف الحجز");
      await Promise.all([bookings.refresh(), refreshStats()]);
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر الحذف", false);
    }
  };

  return (
    <>
      <PageHeader
        title="الحجوزات"
        actions={
          <>
            <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            <Button onClick={() => openForm()}><Plus size={16} /> إضافة حجز</Button>
          </>
        }
      />
      {bookings.loading ? <Loading /> : bookings.error ? <ErrorBlock message={bookings.error} retry={bookings.refresh} /> : (
        <div className="list">
          {(bookings.data || []).map((booking) => (
            <article className="row-card" key={booking.id}>
              <div className="row-main">
                <strong>{booking.customer_name}</strong>
                <span>{booking.product_name} · {booking.tech_name} · {booking.scheduled_time}</span>
                <div className="chips"><Badge>{statusLabel(booking.status)}</Badge></div>
              </div>
              <div className="row-actions">
                {booking.status === "confirmed" && (
                  <>
                    <IconButton title="إكمال الحجز" tone="success" onClick={() => complete(booking)}>
                      <Check size={15} />
                    </IconButton>
                    <IconButton title="إرسال الموعد للفني" tone="success" onClick={() => sendTechnicianNotice(booking)}>
                      <Send size={15} />
                    </IconButton>
                  </>
                )}
                <IconButton title="تعديل" onClick={() => openForm(booking)}><Edit3 size={15} /></IconButton>
                <IconButton title="حذف" tone="danger" onClick={() => remove(booking)}><Trash2 size={15} /></IconButton>
              </div>
            </article>
          ))}
          {!bookings.data?.length && <Empty title="لا توجد حجوزات لهذا اليوم" action={<Button onClick={() => openForm()}><Plus size={16} /> إضافة حجز</Button>} />}
        </div>
      )}
    </>
  );
}

function BookingForm({
  initial,
  selectedDate,
  onSave,
  onCancel,
}: {
  initial?: api.Booking;
  selectedDate: string;
  onSave: (payload: Omit<api.Booking, "id">) => Promise<void>;
  onCancel: () => void;
}) {
  const installations = useData(api.getInstallations);
  const technicians = useData(api.getTechnicians);
  const [installationId, setInstallationId] = useState(initial?.installation_id || "");
  const [technicianId, setTechnicianId] = useState(initial?.technician_id || "");
  const [date, setDate] = useState(initial?.date || selectedDate);
  const [time, setTime] = useState(initial?.scheduled_time || "10:00");
  const [status, setStatus] = useState<api.Booking["status"]>(initial?.status || "confirmed");
  const [saving, setSaving] = useState(false);

  const selectableInstallations = useMemo(
    () =>
      (installations.data || []).filter(
        (item) =>
          item.status === "active" ||
          item.status === "pending_installation" ||
          item.status === "pending_external_service" ||
          (initial && item.id === initial.installation_id),
      ),
    [installations.data, initial],
  );
  const selectedInstallation = selectableInstallations.find((item) => item.id === installationId);
  const selectedTechnician = technicians.data?.find((item) => item.id === technicianId);

  useEffect(() => {
    if (!installationId && selectableInstallations[0]) setInstallationId(selectableInstallations[0].id);
  }, [installationId, selectableInstallations]);

  useEffect(() => {
    if (!technicianId && technicians.data?.[0]) setTechnicianId(technicians.data[0].id);
  }, [technicianId, technicians.data]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedInstallation || !selectedTechnician) return;
    setSaving(true);
    try {
      await onSave({
        installation_id: selectedInstallation.id,
        customer_id: selectedInstallation.customer_id,
        customer_name: selectedInstallation.customer_name,
        customer_phone: selectedInstallation.customer_phone,
        product_id: selectedInstallation.product_id,
        product_name: selectedInstallation.product_name,
        technician_id: selectedTechnician.id,
        tech_name: selectedTechnician.name,
        date,
        scheduled_time: time,
        status,
      });
    } finally {
      setSaving(false);
    }
  };

  if (installations.loading || technicians.loading) return <Loading />;
  if (!selectableInstallations.length || !technicians.data?.length) return <Empty title="أضف صيانة نشطة وفنيا قبل إنشاء الحجز" />;

  return (
    <form className="form" onSubmit={submit}>
      <Field label="الصيانة">
        <SelectInput value={installationId} onChange={(e) => setInstallationId(e.target.value)}>
          {selectableInstallations.map((installation) => (
            <option key={installation.id} value={installation.id}>{installation.customer_name} - {installation.product_name}</option>
          ))}
        </SelectInput>
      </Field>
      <div className="form-grid">
        <Field label="الفني">
          <SelectInput value={technicianId} onChange={(e) => setTechnicianId(e.target.value)}>
            {(technicians.data || []).map((tech) => <option key={tech.id} value={tech.id}>{tech.name}</option>)}
          </SelectInput>
        </Field>
        <Field label="الحالة">
          <SelectInput value={status} onChange={(e) => setStatus(e.target.value as api.Booking["status"])}>
            <option value="confirmed">مؤكد</option>
            <option value="completed">مكتمل</option>
            <option value="cancelled">ملغي</option>
          </SelectInput>
        </Field>
      </div>
      <div className="form-grid">
        <Field label="التاريخ"><TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="الوقت"><TextInput type="time" value={time} onChange={(e) => setTime(e.target.value)} /></Field>
      </div>
      <div className="form-actions">
        <Button type="submit" loading={saving}><Save size={16} /> حفظ</Button>
        <Button tone="muted" onClick={onCancel}>إلغاء</Button>
      </div>
    </form>
  );
}

function MessagesPage({ notify }: { notify: (message: string, ok?: boolean) => void }) {
  const [tab, setTab] = useState<"log" | "whatsapp">("log");
  const reminders = useData(api.getReminders, [tab], tab === "log");

  return (
    <>
      <PageHeader title="واتساب والسجل" />
      <div className="tabs">
        <button type="button" className={tab === "log" ? "active" : ""} onClick={() => setTab("log")}>سجل التذكيرات</button>
        <button type="button" className={tab === "whatsapp" ? "active" : ""} onClick={() => setTab("whatsapp")}>اتصال واتساب</button>
      </div>
      {tab === "log" ? (
        reminders.loading ? <Loading /> : reminders.error ? <ErrorBlock message={reminders.error} retry={reminders.refresh} /> : (
          <div className="list">
            {(reminders.data || []).map((reminder) => (
              <article className="row-card" key={reminder.id}>
                <div className="row-main">
                  <strong>{reminder.customer_name || reminder.customer_id}</strong>
                  <span>{phoneLabel(reminder.customer_phone)} · {fmtDate(reminder.sent_at)}</span>
                  <p>{reminder.message}</p>
                  {reminder.error && <p className="note danger">{reminder.error}</p>}
                </div>
                <Badge tone={reminder.status === "sent" ? "success" : "danger"}>{reminder.status}</Badge>
              </article>
            ))}
            {!reminders.data?.length && <Empty title="لا توجد رسائل مرسلة بعد" />}
          </div>
        )
      ) : (
        <WhatsAppPanel notify={notify} />
      )}
    </>
  );
}

function WhatsAppPanel({ notify }: { notify: (message: string, ok?: boolean) => void }) {
  const status = useData(api.getWhatsAppStatus);
  const diagnostics = useData(api.getReminderDiagnostics);
  const [phone, setPhone] = useState("");
  const [message, setMessage] = useState("رسالة اختبار من نظام BreeXe Pro CRM");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (status.data?.status === "qr_pending" || status.data?.status === "connecting") {
      const timer = window.setInterval(status.refresh, 3000);
      return () => window.clearInterval(timer);
    }
  }, [status.data?.status, status.refresh]);

  const connect = async () => {
    setBusy(true);
    try {
      status.setData(await api.connectWhatsApp());
      await diagnostics.refresh();
      notify("تم بدء اتصال واتساب، امسح رمز QR");
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر بدء واتساب", false);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      status.setData(await api.disconnectWhatsApp());
      await diagnostics.refresh();
      notify("تم فصل واتساب");
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر فصل واتساب", false);
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    setBusy(true);
    try {
      await api.testWhatsApp(phone, message);
      notify("تم إرسال رسالة الاختبار");
    } catch (error) {
      notify(error instanceof Error ? error.message : "فشل الإرسال", false);
    } finally {
      setBusy(false);
    }
  };

  const state = status.data?.status || "disconnected";
  const diagnosticData = diagnostics.data;
  const outbound = status.data?.outbound;

  return (
    <div className="whatsapp-grid">
      <section className="panel">
        <div className="panel-head">
          <h2>حالة الاتصال</h2>
          <Badge tone={state === "connected" ? "success" : state === "qr_pending" || state === "connecting" ? "warn" : "danger"}>
            {state === "connected" ? "متصل" : state === "qr_pending" ? "بانتظار المسح" : state === "connecting" ? "جاري الاتصال" : "غير متصل"}
          </Badge>
        </div>
        {status.error && <ErrorBlock message={status.error} retry={status.refresh} />}
        {status.data?.qr && (
          <div className="qr-box">
            <img src={status.data.qr} alt="WhatsApp QR" />
            <span>امسح الرمز من تطبيق واتساب</span>
          </div>
        )}
        {status.data?.lastError && <p className="note danger">{status.data.lastError}</p>}
        {status.data?.user && <p className="note">الجلسة: {status.data.user}</p>}
        {outbound && (
          <p className={`note ${outbound.enabled ? "" : "danger"}`}>
            وضع الإرسال: {outbound.mode === "dry_run" ? "تجربة آمنة بدون إرسال" : outbound.mode === "code" ? "إرسال بكود تأكيد" : outbound.mode === "allowlist" ? "أرقام اختبار فقط" : "إنتاج"}.
            {!outbound.enabled && " لن يتم إرسال رسائل حقيقية للعملاء قبل الإطلاق الرسمي."}
          </p>
        )}
        <div className="actions">
          {state !== "connected" ? (
            <Button loading={busy} onClick={connect}><Smartphone size={16} /> بدء الاتصال</Button>
          ) : (
            <Button loading={busy} tone="danger" onClick={disconnect}><X size={16} /> فصل الاتصال</Button>
          )}
          <Button tone="muted" onClick={async () => { await Promise.all([status.refresh(), diagnostics.refresh()]); }}><RefreshCcw size={16} /> تحديث</Button>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>تشخيص التذكيرات</h2>
          <Badge tone={diagnosticData?.blocker ? "danger" : "success"}>{diagnosticData?.blocker ? "متوقف" : "جاهز"}</Badge>
        </div>
        {diagnostics.loading ? <Loading /> : diagnostics.error ? <ErrorBlock message={diagnostics.error} retry={diagnostics.refresh} /> : (
          <div className="mini-grid">
            <div className="mini-card">
              <span>مستحقة</span>
              <strong>{diagnosticData?.due || 0}</strong>
            </div>
            <div className="mini-card">
              <span>جاهزة للإرسال</span>
              <strong>{diagnosticData?.ready || 0}</strong>
            </div>
            <div className="mini-card">
              <span>آخر تشغيل</span>
              <strong>{(diagnosticData?.scheduler as { lastFinishedAt?: string } | undefined)?.lastFinishedAt ? fmtDate((diagnosticData?.scheduler as { lastFinishedAt?: string }).lastFinishedAt) : "-"}</strong>
            </div>
            <p className={`note ${diagnosticData?.blocker ? "danger" : ""}`}>
              {diagnosticData?.blocker || `الجدولة جاهزة. مهلة إعادة المحاولة: ${diagnosticData?.retryCooldownMinutes || 0} دقيقة.`}
            </p>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>رسالة اختبار</h2>
        </div>
        <div className="form">
          <Field label="رقم الجوال"><TextInput value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="05xxxxxxxx" /></Field>
          <Field label="الرسالة"><TextArea rows={4} value={message} onChange={(e) => setMessage(e.target.value)} /></Field>
          <Button loading={busy} disabled={state !== "connected" || !phone.trim()} onClick={sendTest}><Send size={16} /> إرسال اختبار</Button>
        </div>
      </section>
    </div>
  );
}

function SettingsPage({ notify }: { notify: (message: string, ok?: boolean) => void }) {
  const settings = useData(api.getSettings);
  const salla = useData(api.getSallaIntegrationStatus);
  const webhook = useData(api.getStoreWebhookDiagnostics);
  const [saving, setSaving] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [connectingSalla, setConnectingSalla] = useState(false);
  const [syncingSalla, setSyncingSalla] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [prepResult, setPrepResult] = useState<api.DailyPreparationResult | null>(null);
  const [values, setValues] = useState<api.Settings>({ techs: 3, jobs_per_tech: 4, response_rate: 50, maxDaily: 24 });
  const webhookUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}${webhook.data?.endpoint || "/api/store/webhook"}`
      : webhook.data?.endpoint || "/api/store/webhook";

  useEffect(() => {
    if (settings.data) setValues(settings.data);
  }, [settings.data]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await api.updateSettings(values);
      notify("تم حفظ الإعدادات");
      await settings.refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر حفظ الإعدادات", false);
    } finally {
      setSaving(false);
    }
  };

  const addDemoData = async () => {
    setSeeding(true);
    try {
      const result = await api.seedDemoData(10);
      notify(`تمت إضافة ${result.customers} عملاء و${result.installations} تركيبات للتجربة`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر إضافة بيانات التجربة", false);
    } finally {
      setSeeding(false);
    }
  };

  const startSallaConnect = async () => {
    setConnectingSalla(true);
    try {
      const result = await api.getSallaConnectUrl();
      window.location.assign(result.url);
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر بدء ربط سلة", false);
      setConnectingSalla(false);
    }
  };

  const runSallaSync = async () => {
    setSyncingSalla(true);
    try {
      const result = await api.syncSallaOrders();
      const products = result.products;
      const productSummary = products ? `، المنتجات: ${products.imported} جديد و${products.updated} محدث` : "";
      notify(`مزامنة سلة انتهت: الطلبات ${result.imported} جديد، ${result.updated} محدث، ${result.failed} فشل${productSummary}`, result.failed === 0 && (!products || products.failed === 0));
      await Promise.all([salla.refresh(), webhook.refresh()]);
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذرت مزامنة سلة", false);
    } finally {
      setSyncingSalla(false);
    }
  };

  const prepareDaily = async () => {
    setPreparing(true);
    try {
      const result = await api.prepareDailyOperations({ syncSalla: true });
      setPrepResult(result);
      const failing = result.checks.filter((check) => !check.ok).length;
      notify(failing ? `تمت التهيئة مع ${failing} تنبيه يحتاج مراجعة` : "البرنامج جاهز للتشغيل اليومي");
      await Promise.all([salla.refresh(), webhook.refresh()]);
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذرت التهيئة التشغيلية", false);
    } finally {
      setPreparing(false);
    }
  };

  return (
    <>
      <PageHeader
        title="الإعدادات"
        actions={<Button loading={preparing} onClick={prepareDaily}><RefreshCcw size={16} /> تهيئة تشغيلية</Button>}
      />
      {settings.loading ? <Loading /> : (
        <section className="panel">
          <form className="form" onSubmit={save}>
            <div className="form-grid">
              <Field label="عدد الفنيين الافتراضي"><TextInput type="number" min={1} value={values.techs} onChange={(e) => setValues({ ...values, techs: Number(e.target.value) })} /></Field>
              <Field label="زيارات لكل فني"><TextInput type="number" min={1} value={values.jobs_per_tech} onChange={(e) => setValues({ ...values, jobs_per_tech: Number(e.target.value) })} /></Field>
            </div>
            <div className="form-grid">
              <Field label="نسبة الاستجابة"><TextInput type="number" min={0} max={100} value={values.response_rate} onChange={(e) => setValues({ ...values, response_rate: Number(e.target.value) })} /></Field>
              <Field label="حد الرسائل اليومي"><TextInput type="number" min={1} value={values.maxDaily} onChange={(e) => setValues({ ...values, maxDaily: Number(e.target.value) })} /></Field>
            </div>
            <div className="form-actions">
              <Button type="submit" loading={saving}><Save size={16} /> حفظ</Button>
              <Button tone="success" loading={preparing} onClick={prepareDaily}><RefreshCcw size={16} /> تهيئة للاستخدام اليومي</Button>
              <Button tone="muted" loading={seeding} onClick={addDemoData}><Plus size={16} /> إضافة 10 بيانات تجربة</Button>
              <Button tone="danger" onClick={async () => { await api.logout(); }}><LogOut size={16} /> تسجيل الخروج</Button>
            </div>
          </form>
        </section>
      )}
      {prepResult && (
        <section className="panel ops-prep-panel">
          <div className="panel-head">
            <h2>نتيجة التهيئة التشغيلية</h2>
            <Badge tone={prepResult.checks.every((check) => check.ok) ? "success" : "warn"}>
              {prepResult.checks.every((check) => check.ok) ? "جاهز" : "يحتاج متابعة"}
            </Badge>
          </div>
          <div className="ops-strip compact">
            <article className="ops-card">
              <strong>{prepResult.summary.storeOrders}</strong>
              <span>طلبات المتجر</span>
            </article>
            <article className="ops-card danger">
              <strong>{prepResult.summary.needsReview}</strong>
              <span>مراجعة</span>
            </article>
            <article className="ops-card warn">
              <strong>{prepResult.summary.awaitingSchedule}</strong>
              <span>جدولة</span>
            </article>
            <article className="ops-card success">
              <strong>{prepResult.summary.technicians}</strong>
              <span>فنيون</span>
            </article>
            <article className="ops-card">
              <strong>{prepResult.summary.todayBookings}</strong>
              <span>حجوزات اليوم</span>
            </article>
          </div>
          <div className="prep-checks">
            {prepResult.checks.map((check) => (
              <article key={check.id} className={check.ok ? "ok" : "warn"}>
                <Badge tone={check.ok ? "success" : "warn"}>{check.ok ? "سليم" : "راجع"}</Badge>
                <div>
                  <strong>{check.label}</strong>
                  <span>{check.detail}</span>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
      <section className="panel">
        <div className="panel-head">
          <h2>ربط سلة عبر API</h2>
          <div className="chips">
            {salla.data?.configured ? <Badge tone="success">المفاتيح جاهزة</Badge> : <Badge tone="danger">ينقصه Client ID/Secret</Badge>}
            {salla.data?.linked ? <Badge tone="success">المتجر مرتبط</Badge> : <Badge tone="warn">غير مرتبط</Badge>}
            <Badge tone={salla.data?.auth_mode === "custom" ? "warn" : "success"}>
              {salla.data?.auth_mode === "custom" ? "Custom Mode" : "Easy Mode"}
            </Badge>
          </div>
        </div>
        {salla.loading ? <Loading /> : salla.error ? <ErrorBlock message={salla.error} retry={salla.refresh} /> : (
          <div className="form">
            {!salla.data?.configured && (
              <p className="note danger">
                لإكمال الربط الرسمي أضف في ملف البيئة القيم:
                {" "}
                <code>SALLA_CLIENT_ID</code>
                {" "}
                و
                {" "}
                <code>SALLA_CLIENT_SECRET</code>
                {" "}
                ويفضل أيضا
                {" "}
                <code>SALLA_REDIRECT_URI</code>
                {" "}
                بنفس الرابط الظاهر هنا، ثم أعد تشغيل السيرفر.
              </p>
            )}
            {salla.data?.configured && !salla.data?.linked && (
              <p className="note">
                {salla.data?.auth_mode === "custom"
                  ? "بعد تجهيز مفاتيح Salla Partners اضغط \"بدء ربط سلة\" مرة واحدة، وسيفتح مسار التفويض الرسمي ثم تحفظ التوكنات داخل النظام تلقائيا."
                  : "في Easy Mode لا ننتظر callback برمز code. ضع رابط Webhook الظاهر هنا داخل Salla Partners ثم ثبّت التطبيق أو وافق عليه، وعند وصول الحدث app.store.authorize سيتحوّل الربط إلى connected تلقائيا."}
              </p>
            )}
            <div className="cards-grid">
              <article className="mini-card">
                <strong>حالة التكامل</strong>
                <span>{salla.data?.status || "-"}</span>
                <p>
                  {salla.data?.auth_mode === "custom"
                    ? "المسار الحالي يعتمد على OAuth callback ثم مزامنة API مباشرة."
                    : "المسار الحالي يعتمد على Salla Easy Mode عبر Webhook التطبيق ثم مزامنة API مباشرة."}
                </p>
              </article>
              <article className="mini-card">
                <strong>{salla.data?.auth_mode === "custom" ? "Redirect URI" : "Webhook URL"}</strong>
                <span>{salla.data?.auth_mode === "custom" ? salla.data?.redirect_uri || "-" : salla.data?.webhook_url || "-"}</span>
                <p>
                  {salla.data?.auth_mode === "custom"
                    ? "هذا هو الرابط الذي يجب تسجيله داخل تطبيق Salla Partners."
                    : "ضع هذا الرابط في خانة رابط استقبال التنبيهات داخل Salla Partners لتستقبل حدث app.store.authorize."}
                </p>
              </article>
              <article className="mini-card">
                <strong>{salla.data?.auth_mode === "custom" ? "الصلاحيات" : "حماية Webhook"}</strong>
                <span>{salla.data?.auth_mode === "custom" ? salla.data?.scopes || "-" : salla.data?.webhook_secret_configured ? "Signature أو Token" : "السر غير مضبوط"}</span>
                <p>
                  {salla.data?.auth_mode === "custom"
                    ? "الافتراضي الحالي يدعم قراءة الطلبات والمنتجات وتحديث التوكن عبر refresh token."
                    : "يفضل اختيار Signature في Salla Partners، مع وضع SALLA_APP_WEBHOOK_SECRET بنفس السر الموجود في التطبيق."}
                </p>
              </article>
            </div>
            <div className="cards-grid">
              <article className="mini-card">
                <strong>المتجر</strong>
                <span>{salla.data?.store_name || "غير مرتبط بعد"}</span>
                <p>{salla.data?.merchant_id ? `Merchant ID: ${salla.data.merchant_id}` : "سيظهر بعد نجاح التفويض."}</p>
              </article>
              <article className="mini-card">
                <strong>آخر تفويض</strong>
                <span>{salla.data?.last_authorized_at ? fmtDate(salla.data.last_authorized_at) : "-"}</span>
                <p>{salla.data?.last_event_type || "بانتظار app.store.authorize"}</p>
              </article>
              <article className="mini-card">
                <strong>آخر مزامنة</strong>
                <span>{salla.data?.last_sync_at ? fmtDate(salla.data.last_sync_at) : "-"}</span>
                <p>{salla.data?.last_sync_status === "error" ? salla.data?.last_sync_error || "فشل غير محدد" : `الطلبات: ${salla.data?.last_sync_count || 0} · المنتجات: ${salla.data?.last_product_sync_count || 0}`}</p>
              </article>
              <article className="mini-card">
                <strong>الجدولة</strong>
                <span>{salla.data?.sync_enabled ? "مفعلة" : "غير مفعلة"}</span>
                <p>{salla.data?.sync_schedule || "-"}</p>
              </article>
            </div>
            {salla.data?.auth_mode !== "custom" && (
              <div className="cards-grid">
                <article className="mini-card">
                  <strong>مالك الربط</strong>
                  <span>{salla.data?.owner_uid_configured ? "مضبوط" : "ناقص"}</span>
                  <p>يجب أن يكون SALLA_APP_OWNER_UID أو STORE_WEBHOOK_OWNER_UID مضبوطًا حتى تُنسب التوكنات إلى مستخدم CRM الصحيح.</p>
                </article>
                <article className="mini-card">
                  <strong>الخطوة القادمة</strong>
                  <span>ثبّت التطبيق من سلة</span>
                  <p>بعد حفظ Webhook URL في Salla Partners، ثبّت التطبيق على متجر تجريبي أو المتجر الحقيقي ثم وافق على الصلاحيات.</p>
                </article>
                <article className="mini-card">
                  <strong>بعد الربط</strong>
                  <span>مزامنة الآن</span>
                  <p>بعد وصول حدث app.store.authorize اضغط مزامنة الآن لسحب المنتجات والطلبات من Salla API إلى النظام.</p>
                </article>
              </div>
            )}
            <div className="form-actions">
              {salla.data?.connect_supported ? (
                <Button loading={connectingSalla} disabled={!salla.data?.configured} onClick={startSallaConnect}><Smartphone size={16} /> بدء ربط سلة</Button>
              ) : (
                <Button tone="muted" disabled><Smartphone size={16} /> الربط يتم من Webhook التطبيق</Button>
              )}
              <Button tone="muted" loading={syncingSalla} disabled={!salla.data?.linked} onClick={runSallaSync}><RefreshCcw size={16} /> مزامنة المنتجات والطلبات</Button>
              <Button tone="muted" onClick={salla.refresh}><RefreshCcw size={16} /> تحديث الحالة</Button>
            </div>
            {salla.data?.last_sync_error && <p className="note danger">{salla.data.last_sync_error}</p>}
            {salla.data?.last_product_sync_error && <p className="note danger">{salla.data.last_product_sync_error}</p>}
          </div>
        )}
      </section>
      <section className="panel">
        <div className="panel-head">
          <h2>ربط المتجر عبر Webhook</h2>
          <div className="chips">
            {webhook.data?.configured ? <Badge tone="success">مفعل</Badge> : <Badge tone="warn">ينقصه إعداد</Badge>}
            {webhook.data?.ownerMatchesCurrentUser ? <Badge tone="success">مرتبط بهذا المستخدم</Badge> : <Badge tone="danger">تحقق من UID</Badge>}
          </div>
        </div>
        {webhook.loading ? <Loading /> : webhook.error ? <ErrorBlock message={webhook.error} retry={webhook.refresh} /> : (
          <div className="form">
            <Field label="رابط استقبال الطلبات">
              <TextInput value={webhookUrl} readOnly />
            </Field>
            <div className="cards-grid">
              <article className="mini-card">
                <strong>الحماية</strong>
                <span>{webhook.data?.secretHeader} أو {webhook.data?.hmacHeader}</span>
                <p>يقبل النظام secret مباشر أو توقيع HMAC SHA-256 على جسم الطلب.</p>
              </article>
              <article className="mini-card">
                <strong>الصيانة الافتراضية</strong>
                <span>{webhook.data?.defaultMaintenanceMonths || 3} شهر</span>
                <p>أي منتج جديد من المتجر سيأخذ هذه المدة ما لم يرسل المتجر maintenance_months.</p>
              </article>
              <article className="mini-card">
                <strong>الحجوزات</strong>
                <span>{webhook.data?.createBookings ? "مفعلة" : "غير مفعلة"}</span>
                <p>تُنشأ الحجوزات فقط عند تفعيلها وتوفير فني افتراضي وتاريخ موعد من المتجر.</p>
              </article>
            </div>
            <div className="panel-head">
              <h2>آخر أحداث المتجر</h2>
              <Button tone="muted" onClick={webhook.refresh}><RefreshCcw size={16} /> تحديث</Button>
            </div>
            <div className="list">
              {(webhook.data?.recentEvents || []).map((event) => (
                <article className="row-card" key={event.id}>
                  <div className="row-main">
                    <strong>{event.order_number || event.order_id || event.id}</strong>
                    <span>{event.provider || "generic"} · {event.event_type || "order"} · {fmtDate(event.received_at)}</span>
                    {event.error && <p>{event.error}</p>}
                  </div>
                  <div className="chips">
                    <Badge tone={event.status === "processed" ? "success" : event.status === "failed" ? "danger" : "warn"}>{event.status || "-"}</Badge>
                    <Badge>{event.imported?.installation_ids?.length || 0} تركيب</Badge>
                  </div>
                </article>
              ))}
              {!webhook.data?.recentEvents?.length && <Empty title="لا توجد طلبات متجر مستقبلة بعد" />}
            </div>
            <div className="panel-head">
              <h2>محاولات اتصال سلة</h2>
              <Button tone="muted" onClick={webhook.refresh}><RefreshCcw size={16} /> تحديث</Button>
            </div>
            <p className="note">
              إذا لم تظهر محاولة جديدة هنا بعد تنفيذ طلب من سلة، فالطلب لم يصل إلى البرنامج أصلا. راجع نوع الحدث والرابط المحفوظ في سلة.
            </p>
            <div className="list">
              {(webhook.data?.recentAttempts || []).map((attempt, index) => (
                <article className="row-card" key={`${attempt.at || "attempt"}-${index}`}>
                  <div className="row-main">
                    <strong>{attempt.event || "بدون نوع حدث"} · {attempt.orderId || "بدون رقم طلب"}</strong>
                    <span>{attempt.at ? fmtDate(attempt.at) : "-"} · HTTP {attempt.statusCode || "-"} · {attempt.userAgent || "-"}</span>
                    {attempt.error && <p>{attempt.error}</p>}
                  </div>
                  <div className="chips">
                    <Badge tone={attempt.accepted ? "success" : "danger"}>{attempt.accepted ? "وصل وقبل" : "وصل ورفض"}</Badge>
                    <Badge tone={attempt.hasSharedSecret ? "success" : "warn"}>{attempt.hasSharedSecret ? "secret موجود" : "secret مفقود"}</Badge>
                  </div>
                </article>
              ))}
              {!webhook.data?.recentAttempts?.length && <Empty title="لا توجد محاولات اتصال مسجلة بعد" />}
            </div>
          </div>
        )}
      </section>
    </>
  );
}
