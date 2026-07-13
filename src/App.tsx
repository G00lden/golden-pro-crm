import {
  CalendarDays,
  Check,
  CircleAlert,
  ClipboardList,
  FileText,
  LogIn,
  LogOut,
  Menu,
  Megaphone,
  MessageCircle,
  Package,
  PhoneCall,
  Plus,
  Receipt,
  RefreshCcw,
  Settings,
  Smartphone,
  UserPlus,
  UserRoundCog,
  Users,
  Wrench,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
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
import { InvoicesPage } from "./pages/Invoices";
import { QuotesPage } from "./pages/Quotes";
import { WhatsAppConsole } from "./pages/WhatsAppConsole";
import { CampaignsPage } from "./pages/Campaigns";
import { ReminderDashboard } from "./components/ReminderDashboard";
import Dashboard from "./pages/Dashboard";
import CustomersPage from "./pages/Customers";
import ProductsPage from "./pages/Products";
import InstallationsPage from "./pages/Installations";
import BookingsPage from "./pages/Bookings";
import StoreOrdersPage from "./pages/StoreOrders";
import CustomerCarePage from "./pages/CustomerCare";
import OdooCrmPage from "./pages/OdooCrm";
import TechniciansPage from "./pages/Technicians";
import SettingsPage from "./pages/Settings";
import CallSystemPage from "./pages/CallSystem";
import { hasAppCapability, normalizeAppRole } from "../shared/accessControl";
import { useDialogAccessibility } from "./dialogAccessibility";
import {
  AccessDenied,
  Button,
  Field,
  IconButton,
  Loading,
  TextInput,
  today,
  useData,
  type Page,
  type ModalState,
  type Toast,
  fmtDate,
} from "./shared";

type AuthMode = "login" | "register";

const pageIds = new Set<Page>([
  "dash",
  "customers",
  "quotes",
  "invoices",
  "odooCrm",
  "products",
  "installations",
  "bookings",
  "storeOrders",
  "care",
  "technicians",
  "messages",
  "campaigns",
  "callSystem",
  "settings",
  "adminUsers",
]);

function pageFromLocation(): Page {
  if (typeof window === "undefined") return "dash";
  const requested = new URL(window.location.href).searchParams.get("section");
  return requested && pageIds.has(requested as Page) ? requested as Page : "dash";
}

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
        <small
          className="app-version"
          title={`بناء ${__BUILD_COMMIT__} في ${__BUILD_TIME__}`}
          style={{ direction: "rtl", opacity: 0.65 }}
        >
          الإصدار {__APP_VERSION__} — {__APP_RELEASE_NAME__}
        </small>

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

function Modal({ modal, onClose }: { modal: Exclude<ModalState, null>; onClose: () => void }) {
  const dialogRef = useRef<HTMLElement>(null);
  const titleId = useId();
  useDialogAccessibility(dialogRef, onClose);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className={`modal ${modal.wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-head">
          <h2 id={titleId}>{modal.title}</h2>
          <IconButton title="إغلاق" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </IconButton>
        </header>
        {modal.content}
      </section>
    </div>
  );
}

export default function App() {
  const [page, setPage] = useState<Page>(pageFromLocation);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isMobileLayout, setIsMobileLayout] = useState(() => window.matchMedia("(max-width: 820px)").matches);
  const [modal, setModal] = useState<ModalState>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [lightMode, setLightMode] = useState(() => localStorage.getItem("gp_light_mode") !== "false");
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    document.documentElement.classList.toggle("light-mode", lightMode);
    localStorage.setItem("gp_light_mode", String(lightMode));
  }, [lightMode]);

  useEffect(() => {
    const restorePageFromUrl = () => setPage(pageFromLocation());
    window.addEventListener("popstate", restorePageFromUrl);
    return () => window.removeEventListener("popstate", restorePageFromUrl);
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 820px)");
    const updateLayout = () => {
      setIsMobileLayout(media.matches);
      if (!media.matches) setSidebarOpen(false);
    };
    updateLayout();
    media.addEventListener("change", updateLayout);
    return () => media.removeEventListener("change", updateLayout);
  }, []);

  useEffect(() => {
    if (!sidebarOpen || !isMobileLayout) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setSidebarOpen(false);
      window.requestAnimationFrame(() => menuButtonRef.current?.focus());
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [isMobileLayout, sidebarOpen]);

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
  const currentRole = normalizeAppRole(me.data?.role);
  const canManageUsers = hasAppCapability(currentRole, "users.manage");
  const canManageWhatsApp = hasAppCapability(currentRole, "whatsapp.manage");
  const canManageCampaigns = hasAppCapability(currentRole, "campaigns.manage");
  const canManageCalls = hasAppCapability(currentRole, "calls.manage");
  const canManagePublicLeads = hasAppCapability(currentRole, "public_leads.manage");
  const canPrepareOperations = hasAppCapability(currentRole, "operations.prepare");
  const canSeedDemoData = hasAppCapability(currentRole, "demo.seed");
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
    { id: "invoices" as Page, label: "الفواتير", icon: Receipt },
    { id: "odooCrm" as Page, label: "CRM Odoo", icon: ClipboardList },
    { id: "products" as Page, label: "المنتجات", icon: Package },
    { id: "installations" as Page, label: "الصيانة", icon: Wrench, badge: summary.overdue },
    { id: "bookings" as Page, label: "الحجوزات", icon: CalendarDays },
    { id: "storeOrders" as Page, label: "طلبات المتجر", icon: ClipboardList },
    { id: "care" as Page, label: "رعاية العملاء", icon: UserPlus, badge: summary.care },
    { id: "technicians" as Page, label: "الفنيون", icon: UserRoundCog },
    ...(canManageWhatsApp
      ? [{ id: "messages" as Page, label: "واتساب والسجل", icon: MessageCircle }]
      : []),
    ...(canManageCampaigns
      ? [
          { id: "campaigns" as Page, label: "الحملات", icon: Megaphone },
        ]
      : []),
    ...(canManageCalls
      ? [{ id: "callSystem" as Page, label: "نظام المكالمات", icon: PhoneCall }]
      : []),
    ...(canManageUsers
      ? [{ id: "adminUsers" as Page, label: "إدارة المستخدمين", icon: UserRoundCog }]
      : []),
    { id: "settings" as Page, label: "الإعدادات", icon: Settings },
  ];

  if (!authReady) return <Loading />;
  if (!authed) return <EmailAuthPage notify={notify} />;

  const openPage = (nextPage: Page) => {
    setPage(nextPage);
    setSidebarOpen(false);
    const url = new URL(window.location.href);
    if (nextPage === "dash") url.searchParams.delete("section");
    else url.searchParams.set("section", nextPage);
    if (url.href !== window.location.href) window.history.pushState({}, "", url);
    window.requestAnimationFrame(() => document.getElementById("main-content")?.focus());
  };

  const closeMobileSidebar = () => {
    setSidebarOpen(false);
    window.requestAnimationFrame(() => menuButtonRef.current?.focus());
  };

  const pages: Record<Page, ReactNode> = {
    dash: (
      <Dashboard
        stats={summary}
        notify={notify}
        refreshStats={stats.refresh}
        go={openPage}
        canManageCalls={canManageCalls}
        canSeedDemoData={canSeedDemoData}
      />
    ),
    customers: <CustomersPage notify={notify} refreshStats={stats.refresh} setModal={setModal} />,
    quotes: <QuotesPage notify={notify} refreshStats={stats.refresh} />,
    invoices: <InvoicesPage notify={notify} refreshStats={stats.refresh} />,
    odooCrm: <OdooCrmPage notify={notify} go={openPage} canManagePublicLeads={canManagePublicLeads} />,
    products: <ProductsPage notify={notify} refreshStats={stats.refresh} setModal={setModal} />,
    installations: <InstallationsPage notify={notify} refreshStats={stats.refresh} setModal={setModal} />,
    bookings: <BookingsPage notify={notify} refreshStats={stats.refresh} setModal={setModal} />,
    storeOrders: <StoreOrdersPage notify={notify} refreshStats={stats.refresh} setModal={setModal} />,
    care: <CustomerCarePage notify={notify} refreshStats={stats.refresh} />,
    technicians: <TechniciansPage notify={notify} refreshStats={stats.refresh} setModal={setModal} />,
    messages: canManageWhatsApp ? <WhatsAppConsole notify={notify} /> : <AccessDenied />,
    campaigns: canManageCampaigns ? <CampaignsPage notify={notify} /> : <AccessDenied />,
    callSystem: canManageCalls ? <CallSystemPage notify={notify} /> : <AccessDenied />,
    settings: (
      <SettingsPage
        notify={notify}
        canPrepareOperations={canPrepareOperations}
        canSeedDemoData={canSeedDemoData}
      />
    ),
    adminUsers: canManageUsers
      ? <AdminUsersPage notify={notify} currentUid={currentUid} />
      : <AccessDenied />,
  };

  return (
    <div className="app-shell" dir="rtl">
      <a className="skip-link" href="#main-content">تجاوز القائمة والانتقال إلى المحتوى</a>
      <button
        ref={menuButtonRef}
        className="mobile-menu"
        type="button"
        onClick={() => setSidebarOpen(true)}
        aria-label="فتح القائمة"
        aria-controls="primary-sidebar"
        aria-expanded={sidebarOpen}
      >
        <Menu size={20} aria-hidden="true" />
      </button>

      {sidebarOpen && <button className="sidebar-scrim" type="button" aria-label="إغلاق القائمة" onClick={closeMobileSidebar} />}

      <aside
        id="primary-sidebar"
        className={`sidebar ${sidebarOpen ? "open" : ""}`}
        aria-hidden={isMobileLayout && !sidebarOpen ? "true" : undefined}
        inert={isMobileLayout && !sidebarOpen}
      >
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
              <button key={item.id} className={page === item.id ? "active" : ""} type="button" aria-current={page === item.id ? "page" : undefined} onClick={() => openPage(item.id)}>
                <Icon size={18} aria-hidden="true" />
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
        <div className="theme-toggle">
          <button className="btn-ghost" type="button" onClick={() => setLightMode((prev) => !prev)} aria-label={lightMode ? "الوضع الليلي" : "الوضع النهاري"}>
            {lightMode ? "🌙" : "☀️"} {lightMode ? "ليلي" : "نهاري"}
          </button>
        </div>
        <div
          className="app-version"
          title={`بناء ${__BUILD_COMMIT__} — بُني ${__BUILD_TIME__}`}
          style={{ marginTop: "auto", padding: "8px 4px 2px", fontSize: 10, opacity: 0.55, textAlign: "center", lineHeight: 1.5 }}
        >
          <span dir="rtl">{__APP_RELEASE_NAME__}</span><br />
          <span dir="ltr">v{__APP_VERSION__} · {__BUILD_COMMIT__} · {new Date(__BUILD_TIME__).toLocaleDateString("en-CA")}</span>
        </div>
      </aside>

      <main id="main-content" tabIndex={-1}>{pages[page]}</main>

      {modal && <Modal modal={modal} onClose={() => setModal(null)} />}

      {toast && (
        <div className={`toast ${toast.ok ? "ok" : "bad"}`} role={toast.ok ? "status" : "alert"} aria-live="polite">
          {toast.ok ? <Check size={16} aria-hidden="true" /> : <CircleAlert size={16} aria-hidden="true" />}
          {toast.message}
        </div>
      )}
    </div>
  );
}
