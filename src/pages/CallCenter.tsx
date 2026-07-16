import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardCopy,
  Cloud,
  Download,
  ExternalLink,
  Filter,
  LoaderCircle,
  MessageCircle,
  PhoneCall,
  RefreshCcw,
  Search,
  Send,
  Settings2,
  Smartphone,
  UserRoundPlus,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import * as api from "../api";
import { Badge, Button, Field, Loading, SelectInput, TextArea, TextInput } from "../shared";
import { WhatsAppConsole } from "./WhatsAppConsole";
import { CallSystemPage } from "./CallSystem";
import MobileOperationsPage from "./MobileOperations";

type Notifier = (message: string, ok?: boolean) => void;
type Tab = "calls" | "contacts" | "devices" | "whatsapp" | "settings";

type Props = {
  notify: Notifier;
  initialTab?: Tab;
  canManageWhatsApp: boolean;
  canPairDevices: boolean;
  canManageDevices: boolean;
  canManageSims: boolean;
  canExecuteCalls: boolean;
  canViewCalls: boolean;
  canManageCallSystem: boolean;
  canManagePolicy: boolean;
  canSendTests: boolean;
  canSendWhatsApp: boolean;
  canManageContacts: boolean;
  canExportCalls: boolean;
  canBulkCalls: boolean;
  canSyncContacts: boolean;
};

const DISPOSITIONS: Array<{ value: string; label: string }> = [
  { value: "answered", label: "تم الرد" },
  { value: "no_answer", label: "لم يرد" },
  { value: "busy", label: "مشغول" },
  { value: "rejected", label: "مرفوض" },
  { value: "unreachable", label: "مغلق أو خارج التغطية" },
  { value: "after_hours", label: "خارج الدوام" },
  { value: "outgoing", label: "صادر" },
  { value: "blocked", label: "محظور" },
  { value: "unknown", label: "غير مؤكد" },
];

const dispositionLabel = (value?: string) =>
  DISPOSITIONS.find((item) => item.value === value)?.label || value || "غير مؤكد";

const waLabel: Record<string, string> = {
  sent: "تم الإرسال",
  queued: "بالطابور",
  pending: "بالطابور",
  processing: "قيد الإرسال",
  retry: "إعادة محاولة",
  failed: "فشل",
  blocked: "ممنوع",
  expired: "منتهي",
  not_sent: "لم يرسل",
};

function callTabFromLocation(fallback: Tab = "calls"): Tab {
  const value = new URL(window.location.href).searchParams.get("callTab");
  return value === "contacts" || value === "devices" || value === "whatsapp" || value === "settings" || value === "calls"
    ? value : fallback;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "تعذر تنفيذ العملية.";
}

function fmtDateTime(value?: string | null) {
  if (!value) return "—";
  const parsed = new Date(value.includes("T") ? value : value.replace(" ", "T") + "Z");
  return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat("ar-SA", {
    dateStyle: "short", timeStyle: "short",
  }).format(parsed);
}

function phoneFor(call: api.CallLogRow) {
  return call.direction === "outgoing" ? call.to_phone || call.from_phone || "" : call.from_phone || call.to_phone || "";
}

function cleanFilters(filters: api.CallCenterFilters) {
  const entries = Object.entries(filters).filter(([, value]) => value !== "" && value !== undefined && (!Array.isArray(value) || value.length));
  return Object.fromEntries(entries) as api.CallCenterFilters;
}

function filtersFromLocation(): api.CallCenterFilters {
  const params = new URL(window.location.href).searchParams;
  return {
    q: params.get("q") || "",
    dispositions: params.getAll("disposition"),
    direction: (params.get("direction") || "") as api.CallCenterFilters["direction"],
    dateFrom: params.get("dateFrom") || "",
    dateTo: params.get("dateTo") || "",
    handled: (params.get("handled") || "") as api.CallCenterFilters["handled"],
    whatsappStatus: (params.get("whatsappStatus") || "") as api.CallCenterFilters["whatsappStatus"],
    contactState: (params.get("contactState") || "") as api.CallCenterFilters["contactState"],
    deviceId: params.get("deviceId") || "",
    simKey: params.get("simKey") || "",
    employeeUid: params.get("employeeUid") || "",
    provider: params.get("provider") || "",
    page: Math.max(1, Number(params.get("page") || 1)),
    pageSize: Math.max(10, Number(params.get("pageSize") || 25)),
    sortBy: (params.get("sortBy") || "created_at") as api.CallCenterFilters["sortBy"],
    sortDirection: (params.get("sortDirection") || "desc") as api.CallCenterFilters["sortDirection"],
  };
}

function updateUrl(filters: api.CallCenterFilters, tab: Tab, replace = true) {
  const url = new URL(window.location.href);
  url.searchParams.set("section", "callSystem");
  url.searchParams.set("callTab", tab);
  for (const name of [
    "q", "disposition", "direction", "dateFrom", "dateTo", "handled", "whatsappStatus", "contactState",
    "deviceId", "simKey", "employeeUid", "provider", "page", "pageSize", "sortBy", "sortDirection",
  ]) url.searchParams.delete(name);
  for (const [key, raw] of Object.entries(cleanFilters(filters))) {
    if (key === "dispositions") {
      for (const value of raw as string[]) url.searchParams.append("disposition", value);
    } else {
      url.searchParams.set(key, String(raw));
    }
  }
  window.history[replace ? "replaceState" : "pushState"]({}, "", url);
}

function SidePanel({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  return (
    <aside className="call-action-panel" aria-labelledby="call-action-panel-title">
      <header>
        <h2 id="call-action-panel-title">{title}</h2>
        <button className="icon-btn" type="button" onClick={onClose} aria-label="إغلاق اللوحة"><X size={18} aria-hidden="true" /></button>
      </header>
      {children}
    </aside>
  );
}

function GoogleContactsPanel({ notify, canSync }: { notify: Notifier; canSync: boolean }) {
  const [status, setStatus] = useState<api.GoogleContactsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    try { setStatus(await api.getGoogleContactsStatus()); }
    catch (error) { notify(errorMessage(error), false); }
    finally { setLoading(false); }
  }, [notify]);

  useEffect(() => { void refresh(); }, [refresh]);

  const connect = async () => {
    setBusy("connect");
    try {
      const result = await api.beginGoogleContactsConnect();
      window.location.assign(result.url);
    } catch (error) { notify(errorMessage(error), false); setBusy(""); }
  };
  const sync = async () => {
    setBusy("sync");
    try {
      const result = await api.syncGoogleContacts(500);
      notify(`تمت مزامنة ${result.synced} جهة اتصال${result.failed ? `، وفشل ${result.failed}` : ""}.`, result.failed === 0);
      await refresh();
    } catch (error) { notify(errorMessage(error), false); }
    finally { setBusy(""); }
  };
  const disconnect = async () => {
    if (!window.confirm("إلغاء ربط Google لهذا الموظف؟ لن تُحذف جهات الاتصال الموجودة.")) return;
    setBusy("disconnect");
    try { await api.disconnectGoogleContacts(); notify("تم إلغاء ربط Google."); await refresh(); }
    catch (error) { notify(errorMessage(error), false); }
    finally { setBusy(""); }
  };

  if (loading) return <Loading />;
  return (
    <section className="card google-contact-card">
      <div className="integration-icon"><Cloud size={26} aria-hidden="true" /></div>
      <div>
        <h2>مزامنة جهات اتصال Google</h2>
        <p>{status?.connected
          ? `مرتبط بالحساب ${status.email || status.displayName || "المعتمد"}. اتجاه المزامنة: CRM ← المصدر، ثم Google والجوال.`
          : "اربط حساب الموظف ليظهر الاسم المعتمد في Google ثم في الجوال دون إنشاء أسماء مؤقتة."}</p>
        {status?.lastSyncedAt && <small>آخر مزامنة: {fmtDateTime(status.lastSyncedAt)}</small>}
        {status?.lastError && <small className="danger-text">آخر خطأ: {status.lastError}</small>}
        {!status?.configured && <small className="danger-text">يجب إعداد بيانات Google People API في الخادم قبل الربط.</small>}
      </div>
      <div className="call-center-actions">
        {!status?.connected ? (
          <Button disabled={!canSync || !status?.configured} loading={busy === "connect"} onClick={connect}>ربط Google</Button>
        ) : (
          <>
            <Button disabled={!canSync} loading={busy === "sync"} onClick={sync}><RefreshCcw size={15} aria-hidden="true" /> مزامنة الآن</Button>
            <Button tone="muted" disabled={!canSync} loading={busy === "disconnect"} onClick={disconnect}>إلغاء الربط</Button>
          </>
        )}
      </div>
    </section>
  );
}

function CallsWorkspace(props: Props) {
  const [filters, setFilters] = useState<api.CallCenterFilters>(filtersFromLocation);
  const [result, setResult] = useState<api.CallCenterResult | null>(null);
  const [devices, setDevices] = useState<api.MobileDevice[]>([]);
  const [whatsapp, setWhatsapp] = useState<api.WhatsAppStatus | null>(null);
  const [google, setGoogle] = useState<api.GoogleContactsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [panel, setPanel] = useState<"whatsapp" | "contact" | "dial" | "bulk" | null>(null);
  const [activeCall, setActiveCall] = useState<api.CallLogRow | null>(null);
  const [message, setMessage] = useState("شكرًا لاتصالك بنا. كيف يمكننا خدمتك؟ وسنتواصل معك في أقرب فرصة.");
  const [outboundCode, setOutboundCode] = useState("");
  const [contact, setContact] = useState({ name: "", company: "", notes: "" });
  const [deviceId, setDeviceId] = useState("");
  const [busy, setBusy] = useState("");
  const [preview, setPreview] = useState<api.CallSelectionPreview | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [calls, mobileDevices, wa, googleStatus] = await Promise.all([
        api.getCallCenterCalls(filters),
        api.getMobileDevices().catch(() => []),
        api.getWhatsAppStatus().catch(() => null),
        props.canSyncContacts ? api.getGoogleContactsStatus().catch(() => null) : Promise.resolve(null),
      ]);
      setResult(calls);
      setDevices(mobileDevices);
      setWhatsapp(wa);
      setGoogle(googleStatus);
      setDeviceId((current) => current || mobileDevices.find((item) => item.work_sim_key && !item.revoked_at)?.id || "");
      updateUrl(filters, "calls");
    } catch (error) { props.notify(errorMessage(error), false); }
    finally { setLoading(false); }
  }, [filters, props.canSyncContacts, props.notify]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const setFilter = <K extends keyof api.CallCenterFilters>(key: K, value: api.CallCenterFilters[K]) => {
    setFilters((current) => ({ ...current, [key]: value, ...(key === "page" ? {} : { page: 1 }) }));
    setSelected(new Set()); setExcluded(new Set()); setAllMatching(false);
  };
  const toggleDisposition = (value: string) => {
    const current = new Set(filters.dispositions || []);
    current.has(value) ? current.delete(value) : current.add(value);
    setFilter("dispositions", [...current]);
  };
  const isSelected = (id: string) => allMatching ? !excluded.has(id) : selected.has(id);
  const toggleRow = (id: string) => {
    if (allMatching) {
      setExcluded((current) => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; });
    } else {
      setSelected((current) => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; });
    }
  };
  const pageCalls = result?.calls || [];
  const pageAllSelected = pageCalls.length > 0 && pageCalls.every((call) => isSelected(call.id));
  const togglePage = () => {
    if (allMatching) {
      setExcluded((current) => {
        const next = new Set(current);
        for (const call of pageCalls) pageAllSelected ? next.add(call.id) : next.delete(call.id);
        return next;
      });
      return;
    }
    setSelected((current) => {
      const next = new Set(current);
      for (const call of pageCalls) pageAllSelected ? next.delete(call.id) : next.add(call.id);
      return next;
    });
  };
  const selectionCount = allMatching ? Math.max(0, Number(result?.total || 0) - excluded.size) : selected.size;
  const selectionPayload = () => {
    if (!allMatching) return { ids: [...selected] };
    const selectionFilters: api.CallCenterFilters = {
      q: filters.q, dispositions: filters.dispositions, direction: filters.direction,
      dateFrom: filters.dateFrom, dateTo: filters.dateTo, handled: filters.handled,
      whatsappStatus: filters.whatsappStatus, contactState: filters.contactState,
      deviceId: filters.deviceId, simKey: filters.simKey, employeeUid: filters.employeeUid,
      provider: filters.provider, sortBy: filters.sortBy, sortDirection: filters.sortDirection,
    };
    return { filters: cleanFilters(selectionFilters), excludedIds: [...excluded] };
  };

  const openAction = (kind: "whatsapp" | "contact" | "dial", call: api.CallLogRow) => {
    setActiveCall(call); setPanel(kind); setPreview(null);
    setContact({ name: call.contact_needs_name ? "" : call.customer_name || "", company: call.customer_company || "", notes: "" });
    if (kind === "whatsapp") setMessage(`مرحبًا${call.customer_name ? ` ${call.customer_name}` : ""}، شكرًا لاتصالك بنا. كيف يمكننا خدمتك؟`);
  };

  const sendSingle = async () => {
    if (!activeCall) return;
    setBusy("single-wa");
    try {
      await api.sendCallWhatsApp(activeCall.id, { message, outboundCode: outboundCode || undefined });
      props.notify("تم إرسال رسالة واتساب فورًا."); setPanel(null); setRefreshKey((value) => value + 1);
    } catch (error) { props.notify(errorMessage(error), false); }
    finally { setBusy(""); }
  };
  const saveContact = async () => {
    if (!activeCall) return;
    setBusy("contact");
    try {
      await api.saveCallContact(activeCall.id, {
        name: contact.name, company: contact.company, notes: contact.notes,
        phone: phoneFor(activeCall), deviceId: deviceId || undefined,
      });
      props.notify("تم حفظ الاسم في CRM وإرساله للمزامنة مع Google والجوال.");
      setPanel(null); setRefreshKey((value) => value + 1);
    } catch (error) { props.notify(errorMessage(error), false); }
    finally { setBusy(""); }
  };
  const dial = async () => {
    if (!activeCall) return;
    setBusy("dial");
    try {
      await api.dialCallFromDevice(activeCall.id, { deviceId, reason: "معاودة اتصال من مركز الاتصالات" });
      props.notify("وصل طلب الاتصال إلى الجوال، وينتظر تأكيد الموظف."); setPanel(null);
    } catch (error) { props.notify(errorMessage(error), false); }
    finally { setBusy(""); }
  };
  const copyPhone = async (call: api.CallLogRow) => {
    try { await navigator.clipboard.writeText(phoneFor(call)); props.notify("تم نسخ الرقم."); }
    catch { props.notify("تعذر نسخ الرقم من المتصفح.", false); }
  };
  const handleCall = async (call: api.CallLogRow) => {
    try { await api.markCallHandled(call.id); props.notify("تم وضع المكالمة كمعالجة."); setRefreshKey((value) => value + 1); }
    catch (error) { props.notify(errorMessage(error), false); }
  };
  const previewSelection = async (action: "whatsapp" | "export", format?: "csv" | "excel") => {
    if (!selectionCount) { props.notify("حدد مكالمة واحدة على الأقل.", false); return; }
    setBusy(`preview-${action}`); setPanel("bulk");
    try {
      const next = await api.previewCallSelection({ action, ...selectionPayload(), outboundCode: outboundCode || undefined });
      setPreview(next);
      if (action === "export" && format) {
        await api.downloadCallSelection(next.selectionId, format);
        props.notify(`تم تصدير ${next.count} مكالمة.`);
        setPanel(null);
      }
    } catch (error) { props.notify(errorMessage(error), false); setPanel(null); }
    finally { setBusy(""); }
  };
  const sendBulk = async () => {
    if (!preview) return;
    if (!window.confirm(`تأكيد إرسال رسالة واتساب إلى ${preview.count} رقمًا؟`)) return;
    setBusy("bulk-send");
    try {
      const run = await api.runCallBulkWhatsApp({ selectionId: preview.selectionId, message, outboundCode: outboundCode || undefined });
      props.notify(`تم تثبيت القائمة وإضافة ${run.queued} رسالة للطابور${run.skipped ? `، وتخطي ${run.skipped}` : ""}.`);
      setPanel(null); setSelected(new Set()); setExcluded(new Set()); setAllMatching(false); setRefreshKey((value) => value + 1);
    } catch (error) { props.notify(errorMessage(error), false); }
    finally { setBusy(""); }
  };

  const activeDevices = devices.filter((item) => !item.revoked_at);
  const readyDevice = activeDevices.some((item) => item.work_sim_key);
  const waConnected = whatsapp?.status === "connected";
  const outboundBlocked = whatsapp?.outbound?.dryRun || whatsapp?.outbound?.enabled === false;

  return (
    <div className={`call-workspace ${panel ? "has-panel" : ""}`}>
      <div className="call-workspace-main">
        <section className="call-readiness" aria-label="جاهزية مركز الاتصالات">
          <article className={waConnected && !outboundBlocked ? "ready" : "blocked"}>
            <MessageCircle size={19} aria-hidden="true" /><div><strong>واتساب</strong><span>{!waConnected ? "غير متصل" : outboundBlocked ? "وضع تجريبي أو ممنوع" : "متصل وجاهز"}</span></div>
          </article>
          <article className={readyDevice ? "ready" : "blocked"}>
            <Smartphone size={19} aria-hidden="true" /><div><strong>الجوال والشريحة</strong><span>{readyDevice ? "شريحة العمل معتمدة" : "اعتمد شريحة عمل"}</span></div>
          </article>
          <article className={google?.connected ? "ready" : "neutral"}>
            <Cloud size={19} aria-hidden="true" /><div><strong>Google</strong><span>{google?.connected ? "جهات الاتصال مرتبطة" : "غير مربوط"}</span></div>
          </article>
          <button type="button" onClick={() => setRefreshKey((value) => value + 1)} aria-label="تحديث الحالات"><RefreshCcw size={18} aria-hidden="true" /></button>
        </section>

        <section className="card call-filters" aria-labelledby="call-filter-title">
          <header><h2 id="call-filter-title"><Filter size={18} aria-hidden="true" /> تصفية سجل المكالمات</h2><button type="button" onClick={() => setFilters({ page: 1, pageSize: 25, sortBy: "created_at", sortDirection: "desc" })}>مسح الفلاتر</button></header>
          <div className="call-filter-grid">
            <Field label="بحث بالاسم أو الرقم"><div className="search-input"><Search size={16} aria-hidden="true" /><TextInput name="call_search" autoComplete="off" value={filters.q || ""} onChange={(event) => setFilter("q", event.target.value)} /></div></Field>
            <Field label="الاتجاه"><SelectInput name="call_direction" value={filters.direction || ""} onChange={(event) => setFilter("direction", event.target.value as api.CallCenterFilters["direction"])}><option value="">الكل</option><option value="incoming">وارد</option><option value="outgoing">صادر</option></SelectInput></Field>
            <Field label="من تاريخ"><TextInput name="call_date_from" type="date" value={filters.dateFrom || ""} onChange={(event) => setFilter("dateFrom", event.target.value)} /></Field>
            <Field label="إلى تاريخ"><TextInput name="call_date_to" type="date" value={filters.dateTo || ""} onChange={(event) => setFilter("dateTo", event.target.value)} /></Field>
            <Field label="المعالجة"><SelectInput name="call_handled" value={filters.handled || ""} onChange={(event) => setFilter("handled", event.target.value as api.CallCenterFilters["handled"])}><option value="">الكل</option><option value="false">بحاجة متابعة</option><option value="true">تمت المعالجة</option></SelectInput></Field>
            <Field label="حالة واتساب"><SelectInput name="call_wa" value={filters.whatsappStatus || ""} onChange={(event) => setFilter("whatsappStatus", event.target.value as api.CallCenterFilters["whatsappStatus"])}><option value="">الكل</option><option value="not_sent">لم يرسل</option><option value="queued">بالطابور</option><option value="sent">تم الإرسال</option><option value="failed">فشل أو منع</option></SelectInput></Field>
            <Field label="جهة الاتصال"><SelectInput name="call_contact" value={filters.contactState || ""} onChange={(event) => setFilter("contactState", event.target.value as api.CallCenterFilters["contactState"])}><option value="">الكل</option><option value="known">اسم معتمد</option><option value="needs_name">يحتاج اسمًا</option><option value="unknown">غير محفوظ</option></SelectInput></Field>
            <Field label="الجهاز"><SelectInput name="call_device" value={filters.deviceId || ""} onChange={(event) => setFilter("deviceId", event.target.value)}><option value="">كل الأجهزة</option>{result?.facets.devices.map((item) => <option key={item.value} value={item.value}>{item.label || item.value}</option>)}</SelectInput></Field>
            <Field label="الشريحة"><SelectInput name="call_sim" value={filters.simKey || ""} onChange={(event) => setFilter("simKey", event.target.value)}><option value="">كل الشرائح</option>{result?.facets.sims.map((item) => <option key={item.value} value={item.value}>الشريحة {Number(item.slot_index ?? 0) + 1} · {item.carrier_name || item.display_name || "غير معروفة"}{item.phone_suffix ? ` · ••••${item.phone_suffix}` : ""}</option>)}</SelectInput></Field>
            <Field label="الموظف"><SelectInput name="call_employee" value={filters.employeeUid || ""} onChange={(event) => setFilter("employeeUid", event.target.value)}><option value="">كل الموظفين</option>{result?.facets.employees.map((item) => <option key={item.value} value={item.value}>{item.label || item.value}</option>)}</SelectInput></Field>
          </div>
          <fieldset className="call-dispositions"><legend>نتيجة المكالمة</legend>{DISPOSITIONS.map((item) => <label key={item.value}><input type="checkbox" checked={(filters.dispositions || []).includes(item.value)} onChange={() => toggleDisposition(item.value)} /> {item.label}</label>)}</fieldset>
        </section>

        <section className="card call-results" aria-busy={loading}>
          <header className="call-results-head">
            <div><h2>المكالمات</h2><span>{result?.total || 0} نتيجة</span></div>
            <div className="call-center-actions">
              {props.canBulkCalls && <Button tone="muted" disabled={!selectionCount} loading={busy === "preview-whatsapp"} onClick={() => previewSelection("whatsapp")}><Send size={15} aria-hidden="true" /> واتساب للمحدد</Button>}
              {props.canExportCalls && <Button tone="muted" disabled={!selectionCount} loading={busy === "preview-export"} onClick={() => previewSelection("export", "excel")}><Download size={15} aria-hidden="true" /> Excel</Button>}
              {props.canExportCalls && <Button tone="muted" disabled={!selectionCount} onClick={() => previewSelection("export", "csv")}>CSV</Button>}
            </div>
          </header>
          {selectionCount > 0 && <div className="selection-banner" role="status"><strong>محدد: {selectionCount}</strong>{!allMatching && result && selected.size === pageCalls.length && result.total > pageCalls.length && <button type="button" onClick={() => { setAllMatching(true); setSelected(new Set()); }}>تحديد كل النتائج المطابقة ({result.total})</button>}{allMatching && <><span>تم تحديد كل النتائج المطابقة للفلتر.</span><button type="button" onClick={() => { setAllMatching(false); setExcluded(new Set()); }}>إلغاء تحديد الكل</button></>}</div>}
          {loading && !result ? <Loading /> : (
            <div className="table-wrap call-table-wrap">
              <table className="call-table">
                <thead><tr><th><input type="checkbox" aria-label="تحديد الصفحة" checked={pageAllSelected} onChange={togglePage} /></th><th>المتصل</th><th>النتيجة</th><th>الوقت</th><th>الجهاز والشريحة</th><th>واتساب</th><th>المعالجة</th><th>الإجراءات</th></tr></thead>
                <tbody>{pageCalls.map((call) => (
                  <tr key={call.id} className={isSelected(call.id) ? "selected" : ""}>
                    <td><input type="checkbox" aria-label={`تحديد مكالمة ${phoneFor(call)}`} checked={isSelected(call.id)} onChange={() => toggleRow(call.id)} /></td>
                    <td><strong>{call.contact_needs_name ? "يحتاج اسمًا" : call.customer_name || "يحتاج اسمًا"}</strong><button className="phone-copy" type="button" onClick={() => copyPhone(call)} title="نسخ الرقم">{phoneFor(call)} <ClipboardCopy size={13} aria-hidden="true" /></button>{call.customer_company && <small>{call.customer_company}</small>}</td>
                    <td><Badge tone={call.disposition === "answered" ? "success" : ["busy", "no_answer", "rejected", "unreachable"].includes(call.disposition || "") ? "warn" : "muted"}>{dispositionLabel(call.disposition)}</Badge><small>{call.direction === "outgoing" ? "صادر" : "وارد"}{call.duration_sec ? ` · ${call.duration_sec} ث` : ""}</small></td>
                    <td>{fmtDateTime(call.created_at)}</td>
                    <td>{call.device_name || "—"}<small>{call.sim_carrier_name ? `الشريحة ${Number(call.sim_slot_index ?? 0) + 1} · ${call.sim_carrier_name}` : "الشريحة غير محددة"}</small></td>
                    <td><Badge tone={call.whatsapp_status === "sent" ? "success" : ["failed", "blocked"].includes(call.whatsapp_status || "") ? "danger" : "muted"}>{waLabel[call.whatsapp_status || "not_sent"] || call.whatsapp_status}</Badge></td>
                    <td>{call.handled ? <Badge tone="success">معالجة</Badge> : <button className="text-action" type="button" onClick={() => handleCall(call)}>وضع كمعالجة</button>}</td>
                    <td><div className="row-actions">
                      <button type="button" disabled={!props.canSendWhatsApp} onClick={() => openAction("whatsapp", call)} title="إرسال واتساب"><MessageCircle size={16} aria-hidden="true" /><span>واتساب</span></button>
                      <button type="button" disabled={!props.canExecuteCalls} onClick={() => openAction("dial", call)} title="اتصل من جوالي"><PhoneCall size={16} aria-hidden="true" /><span>اتصال</span></button>
                      <button type="button" disabled={!props.canManageContacts} onClick={() => openAction("contact", call)} title="حفظ أو تعديل الاسم"><UserRoundPlus size={16} aria-hidden="true" /><span>حفظ الاسم</span></button>
                      {call.customer_id && <button type="button" onClick={() => { const url = new URL(window.location.href); url.searchParams.set("section", "customers"); url.searchParams.set("customer", call.customer_id || ""); window.history.pushState({}, "", url); window.dispatchEvent(new PopStateEvent("popstate")); }} title="فتح العميل"><ExternalLink size={16} aria-hidden="true" /><span>العميل</span></button>}
                    </div></td>
                  </tr>
                ))}</tbody>
              </table>
              {!pageCalls.length && <p className="empty-state">لا توجد مكالمات مطابقة للفلاتر الحالية.</p>}
            </div>
          )}
          <footer className="call-pagination">
            <Button tone="muted" disabled={(result?.page || 1) <= 1} onClick={() => setFilter("page", Math.max(1, Number(filters.page || 1) - 1))}><ChevronRight size={15} aria-hidden="true" /> السابق</Button>
            <span>صفحة {result?.page || 1} من {result?.totalPages || 1}</span>
            <Button tone="muted" disabled={(result?.page || 1) >= (result?.totalPages || 1)} onClick={() => setFilter("page", Number(filters.page || 1) + 1)}>التالي <ChevronLeft size={15} aria-hidden="true" /></Button>
          </footer>
        </section>
      </div>

      {panel === "whatsapp" && activeCall && <SidePanel title="إرسال واتساب" onClose={() => setPanel(null)}><div className="call-panel-body"><p>إرسال فوري إلى <strong dir="ltr">{phoneFor(activeCall)}</strong>. الرسالة لا تُحفظ للإرسال لاحقًا إذا كان واتساب مفصولًا.</p><Field label="نص الرسالة"><TextArea name="call_message" value={message} maxLength={2000} onChange={(event) => setMessage(event.target.value)} /></Field>{whatsapp?.outbound?.requiresCode && <Field label="رمز اعتماد الإرسال"><TextInput name="outbound_code" type="password" autoComplete="off" value={outboundCode} onChange={(event) => setOutboundCode(event.target.value)} /></Field>}<div className="panel-status">{waConnected && !outboundBlocked ? <><CheckCircle2 size={16} aria-hidden="true" /> واتساب جاهز</> : <>الإرسال ممنوع: {!waConnected ? "واتساب غير متصل" : "وضع الإرسال التجريبي"}</>}</div><Button disabled={!message.trim() || !waConnected || outboundBlocked} loading={busy === "single-wa"} onClick={sendSingle}><Send size={16} aria-hidden="true" /> إرسال الآن</Button></div></SidePanel>}
      {panel === "contact" && activeCall && <SidePanel title={activeCall.customer_id ? "تعديل جهة الاتصال" : "حفظ جهة اتصال"} onClose={() => setPanel(null)}><div className="call-panel-body"><p>سيبقى CRM المصدر الأساسي، ثم يرسل الاسم المعتمد إلى Google والجوال.</p><Field label="الاسم الحقيقي"><TextInput name="contact_name" autoComplete="name" value={contact.name} onChange={(event) => setContact((current) => ({ ...current, name: event.target.value }))} /></Field><Field label="الشركة"><TextInput name="contact_company" autoComplete="organization" value={contact.company} onChange={(event) => setContact((current) => ({ ...current, company: event.target.value }))} /></Field><Field label="ملاحظات"><TextArea name="contact_notes" value={contact.notes} onChange={(event) => setContact((current) => ({ ...current, notes: event.target.value }))} /></Field><Field label="الجوال الذي يستقبل الاسم"><SelectInput name="contact_device" value={deviceId} onChange={(event) => setDeviceId(event.target.value)}><option value="">المزامنة العامة فقط</option>{activeDevices.map((device) => <option key={device.id} value={device.id}>{device.name}{device.work_sim_key ? " · شريحة عمل معتمدة" : " · دون شريحة"}</option>)}</SelectInput></Field><Button disabled={contact.name.trim().length < 2} loading={busy === "contact"} onClick={saveContact}>حفظ ومزامنة</Button></div></SidePanel>}
      {panel === "dial" && activeCall && <SidePanel title="اتصل من جوالي" onClose={() => setPanel(null)}><div className="call-panel-body"><p>سيرسل طلب صالح لخمس دقائق. يجب تأكيد الاتصال على الجوال، ولن يستخدم BreeXe شريحة غير معتمدة تلقائيًا.</p><Field label="الجهاز وشريحة العمل"><SelectInput name="dial_device" value={deviceId} onChange={(event) => setDeviceId(event.target.value)}><option value="">اختر جهازًا</option>{activeDevices.map((device) => <option key={device.id} value={device.id} disabled={!device.work_sim_key}>{device.name} · {device.work_sim_key ? "شريحة العمل معتمدة" : "لم تعتمد شريحة"}</option>)}</SelectInput></Field><div className="dial-target"><PhoneCall size={20} aria-hidden="true" /><strong dir="ltr">{phoneFor(activeCall)}</strong><span>{activeCall.customer_name || "متصل غير محفوظ"}</span></div><Button disabled={!deviceId || !activeDevices.find((item) => item.id === deviceId)?.work_sim_key} loading={busy === "dial"} onClick={dial}>إرسال طلب الاتصال</Button></div></SidePanel>}
      {panel === "bulk" && <SidePanel title="معاينة الإجراء الجماعي" onClose={() => setPanel(null)}><div className="call-panel-body">{busy.startsWith("preview") && <p><LoaderCircle className="spin" size={18} aria-hidden="true" /> جارٍ تثبيت قائمة المستلمين…</p>}{preview && <><div className="bulk-preview-count"><strong>{preview.count}</strong><span>رقم صالح ومسموح</span></div>{preview.excludedCount > 0 && <p className="warn-text">تم استثناء {preview.excludedCount} سجل بسبب التكرار أو الرقم غير الصالح أو سياسة الأمان.</p>}<ul className="bulk-sample">{preview.sample.map((item) => <li key={item.id}><span>{item.name}</span><bdi>{item.phone}</bdi></li>)}</ul><small>هذه القائمة مثبتة حتى {fmtDateTime(preview.expiresAt)} ولن تتغير إذا تغير الفلتر.</small><Field label="الرسالة الجماعية"><TextArea name="bulk_message" value={message} maxLength={2000} onChange={(event) => setMessage(event.target.value)} /></Field>{whatsapp?.outbound?.requiresCode && <Field label="رمز اعتماد الإرسال"><TextInput name="bulk_outbound_code" type="password" autoComplete="off" value={outboundCode} onChange={(event) => setOutboundCode(event.target.value)} /></Field>}<Button disabled={!props.canBulkCalls || !message.trim()} loading={busy === "bulk-send"} onClick={sendBulk}>تأكيد وإضافة للطابور</Button></>}</div></SidePanel>}
    </div>
  );
}

export default function CallCenterPage(props: Props) {
  const fallbackTab: Tab = props.canViewCalls ? (props.initialTab || "calls") : "devices";
  const resolvedTab = () => {
    const requested = callTabFromLocation(fallbackTab);
    if (requested === "calls" && !props.canViewCalls) return "devices";
    if (requested === "settings" && !props.canManageCallSystem) return "devices";
    if (requested === "whatsapp" && !props.canManageWhatsApp) return fallbackTab;
    return requested;
  };
  const [tab, setTab] = useState<Tab>(resolvedTab);
  const selectTab = (next: Tab) => {
    setTab(next);
    const url = new URL(window.location.href);
    url.searchParams.set("section", "callSystem"); url.searchParams.set("callTab", next);
    window.history.pushState({}, "", url);
    window.requestAnimationFrame(() => document.getElementById(`call-center-${next}`)?.focus());
  };
  useEffect(() => {
    const restore = () => setTab(resolvedTab());
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [fallbackTab]);

  return (
    <div className="call-center-page">
      <header className="page-head call-center-title"><div><span className="eyebrow">BreeXe Connect 2.2</span><h1>مركز الاتصالات</h1><p>المكالمات وواتساب وجهات الاتصال والجوال والشريحة في شاشة تشغيل واحدة.</p></div></header>
      <nav className="call-center-tabs" aria-label="أقسام مركز الاتصالات">
        {props.canViewCalls && <button type="button" className={tab === "calls" ? "active" : ""} aria-current={tab === "calls" ? "page" : undefined} onClick={() => selectTab("calls")}><PhoneCall size={17} aria-hidden="true" /> المكالمات</button>}
        <button type="button" className={tab === "contacts" ? "active" : ""} aria-current={tab === "contacts" ? "page" : undefined} onClick={() => selectTab("contacts")}><Users size={17} aria-hidden="true" /> الأسماء وGoogle</button>
        <button type="button" className={tab === "devices" ? "active" : ""} aria-current={tab === "devices" ? "page" : undefined} onClick={() => selectTab("devices")}><Smartphone size={17} aria-hidden="true" /> الجوال والشرائح</button>
        {props.canManageWhatsApp && <button type="button" className={tab === "whatsapp" ? "active" : ""} aria-current={tab === "whatsapp" ? "page" : undefined} onClick={() => selectTab("whatsapp")}><MessageCircle size={17} aria-hidden="true" /> واتساب</button>}
        {props.canManageCallSystem && <button type="button" className={tab === "settings" ? "active" : ""} aria-current={tab === "settings" ? "page" : undefined} onClick={() => selectTab("settings")}><Settings2 size={17} aria-hidden="true" /> إعدادات الاتصال</button>}
      </nav>
      <main id={`call-center-${tab}`} className="call-center-panel" tabIndex={-1}>
        {tab === "calls" && props.canViewCalls && <CallsWorkspace {...props} />}
        {tab === "contacts" && <><GoogleContactsPanel notify={props.notify} canSync={props.canSyncContacts} /><section className="card contact-workflow"><UserRoundPlus size={24} aria-hidden="true" /><div><h2>الأرقام التي تحتاج اسمًا</h2><p>ارجع إلى تبويب المكالمات واختر فلتر «يحتاج اسمًا»، ثم استخدم «حفظ الاسم». لن تُرسل الأسماء المؤقتة القديمة إلى Google.</p></div><Button tone="muted" onClick={() => { selectTab("calls"); const next = { ...filtersFromLocation(), contactState: "needs_name" as const, page: 1 }; updateUrl(next, "calls"); window.dispatchEvent(new PopStateEvent("popstate")); }}><Filter size={15} aria-hidden="true" /> عرض الأرقام</Button></section></>}
        {tab === "devices" && <MobileOperationsPage embedded notify={props.notify} canPairDevices={props.canPairDevices} canManageDevices={props.canManageDevices} canManageSims={props.canManageSims} canExecuteCalls={props.canExecuteCalls} canManagePolicy={props.canManagePolicy} canSendTests={props.canSendTests} onOpenWhatsApp={() => selectTab("whatsapp")} />}
        {tab === "whatsapp" && props.canManageWhatsApp && <WhatsAppConsole notify={props.notify} />}
        {tab === "settings" && props.canManageCallSystem && <CallSystemPage notify={props.notify} />}
      </main>
    </div>
  );
}
