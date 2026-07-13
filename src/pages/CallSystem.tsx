import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  ExternalLink,
  Filter,
  MessageCircle,
  PhoneCall,
  PhoneMissed,
  Plus,
  RefreshCcw,
  Save,
  Settings2,
  ShieldCheck,
  Smartphone,
  Trash2,
  Users,
  X,
} from "lucide-react";
import * as api from "../api";

type Notifier = (message: string, ok?: boolean) => void;
type CallPage = "odooCrm" | "bookings" | "quotes" | "customers";
type Tab = "operations" | "routing" | "integration" | "test";

type DraftAgent = {
  user_id: string | null;
  name: string;
  phone: string;
  external: boolean;
};

type DraftDepartment = {
  id?: string;
  digit: string;
  name: string;
  ring_timeout_sec: number;
  active: boolean;
  workflow_action: "lead" | "service_task" | "none";
  fallback_user_id: string | null;
  scheduleEnabled: boolean;
  workDays: number[];
  start: string;
  end: string;
  agents: DraftAgent[];
};

const STATUS_LABEL: Record<string, string> = {
  new: "جديدة",
  menu: "في القائمة",
  selected: "تم الاختيار",
  forwarding: "جاري التحويل",
  ringing: "ترن",
  connected: "متصلة",
  in_progress: "متصلة",
  completed: "مكتملة",
  no_answer: "لم يُرد",
  busy: "مشغول",
  failed: "فشلت",
};

// `in_progress` is a legacy provider alias kept for rendering old rows. The
// public lifecycle exposes `connected`, so showing both in the filter creates
// two indistinguishable "متصلة" options.
const FILTER_CALL_STATUSES = Object.entries(STATUS_LABEL).filter(([value]) => value !== "in_progress");

const FOLLOW_UP_LABEL: Record<string, string> = {
  new: "جديدة",
  assigned: "مسندة",
  in_progress: "قيد المتابعة",
  done: "منجزة",
};

const WORKFLOW_LABEL: Record<DraftDepartment["workflow_action"], string> = {
  lead: "إنشاء فرصة للمتصل الجديد",
  service_task: "إنشاء مهمة خدمة",
  none: "تسجيل المكالمة فقط",
};

const emptyAgent = (): DraftAgent => ({ user_id: null, name: "", phone: "", external: false });
const emptyDraft = (): DraftDepartment => ({
  digit: "",
  name: "",
  ring_timeout_sec: 20,
  active: true,
  workflow_action: "none",
  fallback_user_id: null,
  scheduleEnabled: false,
  workDays: [0, 1, 2, 3, 4],
  start: "09:00",
  end: "18:00",
  agents: [emptyAgent()],
});

function fmtDateTime(value?: string | null) {
  if (!value) return "—";
  const normalized = value.includes("T") ? value : value.replace(" ", "T") + "Z";
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("ar-SA");
}

function phoneForWhatsApp(phone?: string | null) {
  let digits = String(phone || "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = `966${digits.slice(1)}`;
  if (digits.length === 9 && digits.startsWith("5")) digits = `966${digits}`;
  return digits;
}

function parseSchedule(raw: string) {
  try {
    const parsed = JSON.parse(raw) as { days?: number[]; start?: string; end?: string };
    return {
      scheduleEnabled: Boolean(parsed.days?.length && parsed.start && parsed.end),
      workDays: parsed.days?.length ? parsed.days : [0, 1, 2, 3, 4],
      start: parsed.start || "09:00",
      end: parsed.end || "18:00",
    };
  } catch {
    return { scheduleEnabled: false, workDays: [0, 1, 2, 3, 4], start: "09:00", end: "18:00" };
  }
}

export function CallSystemPage({
  notify,
  currentRole,
  onNavigate,
}: {
  notify: Notifier;
  currentRole: api.AppUserRole;
  onNavigate: (page: CallPage) => void;
}) {
  const isAdmin = currentRole === "admin" || currentRole === "manager";
  const [tab, setTab] = useState<Tab>("operations");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [config, setConfig] = useState<api.TelephonyConfig | null>(null);
  const [savedConfig, setSavedConfig] = useState("");
  const [readiness, setReadiness] = useState<api.TelephonyReadiness | null>(null);
  const [departments, setDepartments] = useState<api.TelephonyDepartment[]>([]);
  const [calls, setCalls] = useState<api.CallLogRow[]>([]);
  const [users, setUsers] = useState<api.ManagedAppUser[]>([]);
  const [gateway, setGateway] = useState<api.GatewayStatus | null>(null);
  const [draft, setDraft] = useState<DraftDepartment>(emptyDraft());
  const [savedDraft, setSavedDraft] = useState(JSON.stringify(emptyDraft()));
  const [saving, setSaving] = useState(false);
  const [testPhone, setTestPhone] = useState("");
  const [testDigit, setTestDigit] = useState("");
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim().toLowerCase());
  const [statusFilter, setStatusFilter] = useState("");
  const [followUpFilter, setFollowUpFilter] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [selectedCall, setSelectedCall] = useState<api.CallLogRow | null>(null);
  const [outcome, setOutcome] = useState("completed");
  const [notes, setNotes] = useState("");

  const configDirty = Boolean(config && JSON.stringify(config) !== savedConfig);
  const draftDirty = JSON.stringify(draft) !== savedDraft;
  const hasUnsavedChanges = isAdmin && (configDirty || draftDirty);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedChanges) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasUnsavedChanges]);

  const refresh = useCallback(async (initial = false) => {
    if (!initial) setRefreshing(true);
    try {
      if (isAdmin) {
        const [nextConfig, nextReadiness, nextDepartments, nextCalls, nextUsers, nextGateway] = await Promise.all([
          api.getTelephonyConfig(),
          api.getTelephonyReadiness(),
          api.getTelephonyDepartments(),
          api.getCallLogs({ limit: 300 }),
          api.listAppUsers({ active: true }),
          api.getGatewayStatus().catch(() => null),
        ]);
        setConfig(nextConfig);
        setSavedConfig(JSON.stringify(nextConfig));
        setReadiness(nextReadiness);
        setDepartments(nextDepartments);
        setCalls(nextCalls);
        setUsers(nextUsers.users);
        setGateway(nextGateway);
      } else {
        setCalls(await api.getCallLogs({ limit: 300 }));
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر تحميل نظام المكالمات", false);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [isAdmin, notify]);

  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  const visibleCalls = useMemo(() => calls.filter((call) => {
    const haystack = `${call.from_phone || ""} ${call.customer_name || ""} ${call.agent_name || ""}`.toLowerCase();
    if (deferredSearch && !haystack.includes(deferredSearch)) return false;
    if (statusFilter && (call.call_status || call.status) !== statusFilter) return false;
    if (followUpFilter && call.follow_up_status !== followUpFilter) return false;
    if (departmentFilter && call.department_name !== departmentFilter) return false;
    const date = String(call.created_at || "").slice(0, 10);
    if (fromDate && date < fromDate) return false;
    if (toDate && date > toDate) return false;
    return true;
  }), [calls, deferredSearch, departmentFilter, followUpFilter, fromDate, statusFilter, toDate]);

  const switchTab = (next: Tab) => {
    if (hasUnsavedChanges && !window.confirm("لديك تعديلات غير محفوظة. هل تريد الانتقال دون حفظها؟")) return;
    setTab(next);
  };

  const saveConfig = async () => {
    if (!config) return;
    setSaving(true);
    try {
      const saved = await api.updateTelephonyConfig(config);
      setConfig(saved);
      setSavedConfig(JSON.stringify(saved));
      setReadiness(await api.getTelephonyReadiness());
      notify("تم حفظ إعدادات الرقم والرد الآلي");
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر حفظ الإعدادات", false);
    } finally {
      setSaving(false);
    }
  };

  const editDepartment = (department: api.TelephonyDepartment) => {
    const schedule = parseSchedule(department.schedule_json);
    const next: DraftDepartment = {
      id: department.id,
      digit: department.digit,
      name: department.name,
      ring_timeout_sec: department.ring_timeout_sec,
      active: department.active,
      workflow_action: department.workflow_action || "none",
      fallback_user_id: department.fallback_user_id,
      ...schedule,
      agents: department.agents.length
        ? department.agents.map((agent) => ({
            user_id: agent.user_id || null,
            name: agent.name || "",
            phone: agent.phone,
            external: !agent.user_id,
          }))
        : [emptyAgent()],
    };
    setDraft(next);
    setSavedDraft(JSON.stringify(next));
  };

  const resetDraft = () => {
    const next = emptyDraft();
    setDraft(next);
    setSavedDraft(JSON.stringify(next));
  };

  const saveDepartment = async () => {
    if (!draft.digit || !draft.name.trim()) {
      notify("رقم الاختيار واسم القسم مطلوبان", false);
      return;
    }
    const agents = draft.agents
      .filter((agent) => agent.phone.trim())
      .map((agent, index) => ({
        user_id: agent.external ? null : agent.user_id,
        name: agent.name.trim(),
        phone: agent.phone.trim(),
        sort_order: index,
        active: true,
      }));
    const payload: api.TelephonyDepartmentInput = {
      digit: draft.digit,
      name: draft.name.trim(),
      ring_timeout_sec: draft.ring_timeout_sec,
      active: draft.active,
      workflow_action: draft.workflow_action,
      fallback_user_id: draft.fallback_user_id,
      schedule_json: draft.scheduleEnabled
        ? JSON.stringify({ days: draft.workDays, start: draft.start, end: draft.end })
        : "",
      agents,
    };
    setSaving(true);
    try {
      if (draft.id) await api.updateTelephonyDepartment(draft.id, payload);
      else await api.createTelephonyDepartment(payload);
      notify(draft.id ? "تم تحديث القسم" : "تم إنشاء القسم");
      resetDraft();
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر حفظ القسم", false);
    } finally {
      setSaving(false);
    }
  };

  const deleteDepartment = async (department: api.TelephonyDepartment) => {
    if (!window.confirm(`حذف قسم «${department.name}»؟ لا يمكن التراجع عن هذا الإجراء.`)) return;
    try {
      await api.deleteTelephonyDepartment(department.id);
      if (draft.id === department.id) resetDraft();
      notify("تم حذف القسم");
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر حذف القسم", false);
    }
  };

  const chooseUser = (index: number, uid: string) => {
    const user = users.find((candidate) => candidate.uid === uid);
    setDraft((current) => ({
      ...current,
      agents: current.agents.map((agent, agentIndex) => agentIndex === index
        ? { user_id: uid || null, name: user?.name || "", phone: user?.phone || "", external: false }
        : agent),
    }));
  };

  const openAction = (page: CallPage, call: api.CallLogRow) => {
    sessionStorage.setItem("telephony_action_context", JSON.stringify({
      target: page,
      call_id: call.id,
      lead_id: call.lead_id,
      task_id: call.task_id,
      customer_id: call.customer_id,
      customer_name: call.customer_name,
      phone: call.from_phone,
    }));
    onNavigate(page);
  };

  const completeFollowUp = async () => {
    if (!selectedCall) return;
    try {
      await api.completeCallFollowUp(selectedCall.id, { outcome, notes: notes.trim() });
      notify("تم تسجيل نتيجة المتابعة دون تغيير حالة الاتصال الأصلية");
      setSelectedCall(null);
      setNotes("");
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر تسجيل المتابعة", false);
    }
  };

  const runTest = async () => {
    if (!testPhone.trim()) {
      notify("أدخل رقم المتصل للمحاكاة", false);
      return;
    }
    try {
      const result = await api.testMissedCall({ from_phone: testPhone.trim(), digit: testDigit || undefined });
      notify(`نجحت محاكاة مكالمة فائتة لقسم ${result.department}`);
      setTestPhone("");
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "فشل الاختبار", false);
    }
  };

  if (loading) {
    return <div className="empty" dir="rtl"><RefreshCcw className="spin" size={24} /><p>جاري تحميل المكالمات…</p></div>;
  }

  const tabs: Array<{ id: Tab; label: string; icon: typeof PhoneCall; admin?: boolean }> = [
    { id: "operations", label: isAdmin ? "التشغيل والمتابعة" : "مكالماتي", icon: PhoneCall },
    { id: "routing", label: "الأقسام والتوجيه", icon: Users, admin: true },
    { id: "integration", label: "ربط الرقم وUnifonic", icon: Settings2, admin: true },
    { id: "test", label: "الاختبار", icon: ClipboardCheck, admin: true },
  ];

  return (
    <section className="call-system-page" dir="rtl">
      <header className="call-system-header">
        <div>
          <span className="eyebrow">مركز الاتصال</span>
          <h1>{isAdmin ? "نظام المكالمات والرد الآلي" : "مكالماتي"}</h1>
          <p>{isAdmin
            ? "Unifonic يجيب عن المكالمة ويوجهها لمختص واحد بالتناوب، ثم ينشئ متابعة عند عدم الرد."
            : "المكالمات والمهام المسندة إليك فقط، مع تسجيل نتيجة المتابعة."}</p>
        </div>
        <button className="btn muted" type="button" onClick={() => void refresh()} disabled={refreshing}>
          <RefreshCcw size={15} className={refreshing ? "spin" : ""} /> تحديث
        </button>
      </header>

      <nav className="call-tabs" aria-label="أقسام نظام المكالمات">
        {tabs.filter((item) => !item.admin || isAdmin).map((item) => {
          const Icon = item.icon;
          return <button key={item.id} type="button" className={tab === item.id ? "active" : ""} onClick={() => switchTab(item.id)}>
            <Icon size={16} /> {item.label}
          </button>;
        })}
      </nav>

      {tab === "operations" && (
        <div className="call-section">
          <div className="call-summary-grid">
            <article><span>المعروضة</span><strong>{visibleCalls.length}</strong></article>
            <article><span>تحتاج متابعة</span><strong>{visibleCalls.filter((call) => call.missed && call.follow_up_status !== "done").length}</strong></article>
            <article><span>منجزة</span><strong>{visibleCalls.filter((call) => call.follow_up_status === "done").length}</strong></article>
          </div>

          <form className="call-filters" onSubmit={(event) => event.preventDefault()}>
            <label><span>بحث</span><input className="input" type="search" name="call_search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="رقم أو عميل أو مختص" /></label>
            <label><span>حالة الاتصال</span><select className="input" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="">الكل</option>{FILTER_CALL_STATUSES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label><span>حالة المتابعة</span><select className="input" value={followUpFilter} onChange={(event) => setFollowUpFilter(event.target.value)}><option value="">الكل</option>{Object.entries(FOLLOW_UP_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            {isAdmin && <label><span>القسم</span><select className="input" value={departmentFilter} onChange={(event) => setDepartmentFilter(event.target.value)}><option value="">كل الأقسام</option>{departments.map((department) => <option key={department.id} value={department.name}>{department.name}</option>)}</select></label>}
            <label><span>من تاريخ</span><input className="input" type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} /></label>
            <label><span>إلى تاريخ</span><input className="input" type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} /></label>
            <button className="btn muted" type="button" onClick={() => { setSearch(""); setStatusFilter(""); setFollowUpFilter(""); setDepartmentFilter(""); setFromDate(""); setToDate(""); }}><Filter size={14} /> مسح</button>
          </form>

          {visibleCalls.length === 0 ? <div className="empty"><PhoneCall size={28} /><p>لا توجد مكالمات مطابقة.</p></div> : (
            <div className="responsive-table-wrap">
              <table className="responsive-table call-table">
                <thead><tr><th>الوقت</th><th>المتصل</th><th>القسم</th><th>المختص</th><th>الاتصال</th><th>المتابعة</th><th>إجراءات</th></tr></thead>
                <tbody>{visibleCalls.map((call) => {
                  const callStatus = call.call_status || call.status;
                  const waPhone = phoneForWhatsApp(call.from_phone);
                  return <tr key={call.id} className={call.missed && call.follow_up_status !== "done" ? "needs-follow-up" : ""}>
                    <td data-label="الوقت">{fmtDateTime(call.created_at)}</td>
                    <td data-label="المتصل"><strong>{call.customer_name || call.from_phone || "غير معروف"}</strong>{call.customer_name && <small>{call.from_phone}</small>}</td>
                    <td data-label="القسم">{call.department_name || "عام"}</td>
                    <td data-label="المختص">{call.agent_name || call.agent_phone || "طابور المدير"}</td>
                    <td data-label="الاتصال"><span className={`call-status status-${callStatus}`}>{STATUS_LABEL[callStatus] || callStatus}</span></td>
                    <td data-label="المتابعة"><span className={`follow-status follow-${call.follow_up_status || "new"}`}>{FOLLOW_UP_LABEL[call.follow_up_status || "new"]}</span></td>
                    <td data-label="إجراءات"><div className="call-actions">
                      {waPhone && <a className="icon-btn muted" href={`https://wa.me/${waPhone}`} target="_blank" rel="noreferrer" aria-label="فتح محادثة واتساب" title="فتح واتساب"><MessageCircle size={15} /></a>}
                      <button className="icon-btn muted" type="button" onClick={() => openAction("odooCrm", call)} aria-label="فتح سجل CRM" title="CRM"><ExternalLink size={15} /></button>
                      <button className="btn muted compact" type="button" onClick={() => { setSelectedCall(call); setOutcome(call.follow_up_outcome || "completed"); setNotes(call.follow_up_notes || ""); }} disabled={call.follow_up_status === "done"}>تسجيل النتيجة</button>
                    </div></td>
                  </tr>;
                })}</tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === "routing" && isAdmin && (
        <div className="routing-layout">
          <section className="call-panel">
            <div className="section-heading"><div><h2>الأقسام</h2><p>يُختار مختص واحد بالتناوب لكل مكالمة.</p></div><button className="btn muted" type="button" onClick={resetDraft}><Plus size={14} /> قسم جديد</button></div>
            <div className="department-list">{departments.length === 0 ? <div className="empty"><p>لم تُنشأ أقسام بعد.</p></div> : departments.map((department) => <article key={department.id}>
              <button className="department-main" type="button" onClick={() => editDepartment(department)}>
                <span className="digit">{department.digit}</span><span><strong>{department.name}</strong><small>{WORKFLOW_LABEL[department.workflow_action || "none"]} · {department.agents.length} مختص</small></span>
              </button>
              <button className="icon-btn danger" type="button" onClick={() => void deleteDepartment(department)} aria-label={`حذف قسم ${department.name}`} title="حذف"><Trash2 size={15} /></button>
            </article>)}</div>
          </section>

          <section className="call-panel department-editor">
            <div className="section-heading"><div><h2>{draft.id ? "تعديل القسم" : "قسم جديد"}</h2><p>{draftDirty ? "توجد تعديلات غير محفوظة" : "لا توجد تعديلات معلقة"}</p></div></div>
            <div className="form-grid two">
              <label><span>رقم الاختيار</span><input className="input" inputMode="numeric" maxLength={1} value={draft.digit} onChange={(event) => setDraft((current) => ({ ...current, digit: event.target.value.replace(/\D/g, "") }))} /></label>
              <label><span>اسم القسم</span><input className="input" name="department_name" value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></label>
              <label><span>سلوك القسم</span><select className="input" value={draft.workflow_action} onChange={(event) => setDraft((current) => ({ ...current, workflow_action: event.target.value as DraftDepartment["workflow_action"] }))}><option value="lead">إنشاء فرصة</option><option value="service_task">إنشاء مهمة خدمة</option><option value="none">تسجيل فقط</option></select></label>
              <label><span>مهلة الرنين بالثواني</span><input className="input" type="number" min={5} max={120} value={draft.ring_timeout_sec} onChange={(event) => setDraft((current) => ({ ...current, ring_timeout_sec: Number(event.target.value) || 20 }))} /></label>
              <label><span>طابور الاحتياط</span><select className="input" value={draft.fallback_user_id || ""} onChange={(event) => setDraft((current) => ({ ...current, fallback_user_id: event.target.value || null }))}><option value="">المدير تلقائيًا</option>{users.filter((user) => user.uid && ["admin", "manager"].includes(user.role)).map((user) => <option key={user.id} value={user.uid || ""}>{user.name}</option>)}</select></label>
              <label><span>الحالة</span><select className="input" value={draft.active ? "active" : "inactive"} onChange={(event) => setDraft((current) => ({ ...current, active: event.target.value === "active" }))}><option value="active">نشط</option><option value="inactive">متوقف</option></select></label>
            </div>

            <fieldset className="schedule-fieldset"><legend>ساعات العمل</legend><label className="check-row"><input type="checkbox" checked={draft.scheduleEnabled} onChange={(event) => setDraft((current) => ({ ...current, scheduleEnabled: event.target.checked }))} /> تقييد التحويل بساعات محددة</label>{draft.scheduleEnabled && <><div className="weekday-row">{["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"].map((label, day) => <label key={label}><input type="checkbox" checked={draft.workDays.includes(day)} onChange={(event) => setDraft((current) => ({ ...current, workDays: event.target.checked ? [...current.workDays, day].sort() : current.workDays.filter((item) => item !== day) }))} /> {label}</label>)}</div><div className="form-grid two"><label><span>من</span><input className="input" type="time" value={draft.start} onChange={(event) => setDraft((current) => ({ ...current, start: event.target.value }))} /></label><label><span>إلى</span><input className="input" type="time" value={draft.end} onChange={(event) => setDraft((current) => ({ ...current, end: event.target.value }))} /></label></div></>}</fieldset>

            <div className="agent-editor"><div className="section-heading"><div><h3>المختصون</h3><p>اختر مستخدم CRM أو أضف وجهة خارجية واضحة.</p></div><button className="btn muted" type="button" onClick={() => setDraft((current) => ({ ...current, agents: [...current.agents, emptyAgent()] }))}><Plus size={14} /> مختص</button></div>{draft.agents.map((agent, index) => <div className="agent-row" key={`${index}-${agent.user_id || "external"}`}>
              <label className="check-row"><input type="checkbox" checked={agent.external} onChange={(event) => setDraft((current) => ({ ...current, agents: current.agents.map((item, itemIndex) => itemIndex === index ? { ...item, external: event.target.checked, user_id: null, name: "", phone: "" } : item) }))} /> وجهة خارجية</label>
              {agent.external ? <><label><span>الاسم</span><input className="input" value={agent.name} onChange={(event) => setDraft((current) => ({ ...current, agents: current.agents.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item) }))} /></label><label><span>رقم التحويل</span><input className="input" type="tel" inputMode="tel" value={agent.phone} onChange={(event) => setDraft((current) => ({ ...current, agents: current.agents.map((item, itemIndex) => itemIndex === index ? { ...item, phone: event.target.value } : item) }))} /></label></> : <label className="agent-user-select"><span>مستخدم CRM</span><select className="input" value={agent.user_id || ""} onChange={(event) => chooseUser(index, event.target.value)}><option value="">اختر مستخدمًا</option>{users.filter((user) => user.uid && user.phone && ["sales", "technician", "manager", "admin"].includes(user.role)).map((user) => <option key={user.id} value={user.uid || ""}>{user.name} — {user.phone}</option>)}</select></label>}
              <button className="icon-btn danger" type="button" onClick={() => setDraft((current) => ({ ...current, agents: current.agents.filter((_, itemIndex) => itemIndex !== index) }))} aria-label="إزالة المختص" title="إزالة"><X size={15} /></button>
            </div>)}</div>

            <button className="btn primary" type="button" disabled={saving} onClick={() => void saveDepartment()}><Save size={15} /> {draft.id ? "حفظ التعديلات" : "إنشاء القسم"}</button>
          </section>
        </div>
      )}

      {tab === "integration" && isAdmin && config && (
        <div className="integration-layout">
          <section className="call-panel readiness-panel">
            <div className="readiness-head"><div><h2>جاهزية التشغيل</h2><p>الإعداد المكتمل لا يعني أنه تم التحقق بمكالمة حقيقية.</p></div></div>
            <div className="readiness-badges"><span className={readiness?.setup_complete ? "ready" : "pending"}>{readiness?.setup_complete ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />} الإعداد {readiness?.setup_complete ? "مكتمل" : "غير مكتمل"}</span><span className={readiness?.live_verified ? "ready" : "pending"}>{readiness?.live_verified ? <CheckCircle2 size={16} /> : <PhoneCall size={16} />} {readiness?.live_verified ? "تم التحقق بمكالمة حقيقية" : "لم يتم التحقق بمكالمة حقيقية"}</span></div>
            <div className="readiness-list">{readiness?.checks.map((check) => <article key={check.id}>{check.ready ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}<span><strong>{check.label}</strong><small>{check.detail}</small></span></article>)}</div>
          </section>

          <section className="call-panel">
            <div className="section-heading"><div><h2>الرقم والرسالة</h2><p>الرقم الحالي يُحوّل دون شرط إلى رقم Unifonic.</p></div></div>
            <div className="form-grid two"><label><span>رقم Unifonic</span><input className="input" type="tel" inputMode="tel" name="unifonic_number" value={config.main_number} onChange={(event) => setConfig((current) => current ? { ...current, main_number: event.target.value } : current)} placeholder="9665XXXXXXXX" /></label><label><span>مهلة الرنين</span><input className="input" type="number" min={5} max={120} value={config.ring_timeout_sec} onChange={(event) => setConfig((current) => current ? { ...current, ring_timeout_sec: Number(event.target.value) || 20 } : current)} /></label></div>
            <label><span>رسالة الترحيب</span><textarea className="input" rows={3} value={config.greeting} onChange={(event) => setConfig((current) => current ? { ...current, greeting: event.target.value } : current)} /></label>
            <label><span>نص القائمة المخصص</span><textarea className="input" rows={3} value={config.menu_prompt} onChange={(event) => setConfig((current) => current ? { ...current, menu_prompt: event.target.value } : current)} placeholder="اتركه فارغًا لبنائه من الأقسام" /></label>
            <label className="check-row"><input type="checkbox" checked={config.enabled} onChange={(event) => setConfig((current) => current ? { ...current, enabled: event.target.checked } : current)} /> تشغيل الرد الآلي</label>
            <button className="btn primary" type="button" onClick={() => void saveConfig()} disabled={saving || !configDirty}><Save size={15} /> حفظ الإعدادات</button>
          </section>

          <section className="call-panel endpoint-panel"><div className="section-heading"><div><h2>عناوين Unifonic</h2><p>انسخها إلى Incoming Call Application.</p></div><ShieldCheck size={21} /></div><label><span>IVR Endpoint — مع Authorization</span><output dir="ltr">{readiness?.ivr_webhook_url || "يظهر بعد ضبط PUBLIC_BASE_URL"}</output></label><label><span>Status Webhook — مع Basic Authentication</span><output dir="ltr">{readiness?.status_webhook_url || "يظهر بعد ضبط PUBLIC_BASE_URL"}</output></label><p className="call-note">رابط اختيار العميل يُنشأ تلقائيًا لكل مكالمة ويحمل رمز جلسة مؤقتًا؛ لا تضفه يدويًا في Unifonic.</p></section>

          <section className="call-panel gateway-panel"><div className="section-heading"><div><h2><Smartphone size={19} /> بوابة أندرويد</h2><p>احتياط لإرسال SMS فقط عند تعذر واتساب؛ لا تجيب عن المكالمة الصوتية.</p></div><span className={gateway?.configured ? "gateway-ready" : "gateway-pending"}>{gateway?.configured ? "مضبوطة" : "غير مضبوطة"}</span></div><p>الرسائل المنتظرة: <strong>{gateway?.pending || 0}</strong>. مصدر الرد الآلي الصوتي هو Unifonic حصراً.</p></section>
        </div>
      )}

      {tab === "test" && isAdmin && (
        <div className="test-layout">
          <section className="call-panel"><div className="section-heading"><div><h2>محاكي المتابعة</h2><p>يختبر إنشاء المهمة وطابور واتساب ثم SMS بدون مكالمة حقيقية.</p></div><PhoneMissed size={22} /></div><div className="form-grid two"><label><span>رقم المتصل</span><input className="input" type="tel" inputMode="tel" name="test_phone" value={testPhone} onChange={(event) => setTestPhone(event.target.value)} placeholder="9665XXXXXXXX" /></label><label><span>رقم القسم</span><select className="input" value={testDigit} onChange={(event) => setTestDigit(event.target.value)}><option value="">أول قسم نشط</option>{departments.filter((department) => department.active).map((department) => <option key={department.id} value={department.digit}>{department.digit} — {department.name}</option>)}</select></label></div><button className="btn primary" type="button" onClick={() => void runTest()}><PhoneMissed size={15} /> تشغيل المحاكي</button></section>
          <section className="call-panel launch-checklist"><h2>اختبار المكالمة الحقيقية</h2><ol><li>اختيار صحيح ثم خاطئ مرتين.</li><li>مختص يجيب ومختص لا يجيب.</li><li>اتصالان متتاليان من الرقم نفسه.</li><li>اتصال خارج ساعات العمل.</li><li>واتساب متصل ثم غير متصل للتحقق من SMS.</li></ol><p>لا تعتمد الإنتاج حتى تظهر شارة «تم التحقق بمكالمة حقيقية» وتظهر المهمة مرة واحدة فقط.</p></section>
        </div>
      )}

      {selectedCall && <div className="call-dialog-backdrop" role="presentation" onMouseDown={() => setSelectedCall(null)}><section className="call-dialog" role="dialog" aria-modal="true" aria-labelledby="follow-up-title" onMouseDown={(event) => event.stopPropagation()}><header><div><h2 id="follow-up-title">نتيجة متابعة المكالمة</h2><p>{selectedCall.customer_name || selectedCall.from_phone}</p></div><button className="icon-btn muted" type="button" onClick={() => setSelectedCall(null)} aria-label="إغلاق"><X size={17} /></button></header><label><span>النتيجة</span><select className="input" value={outcome} onChange={(event) => setOutcome(event.target.value)}><option value="completed">تم التواصل</option><option value="no_response">لم يرد العميل</option><option value="rescheduled">تم تحديد موعد لاحق</option><option value="not_interested">غير مهتم</option></select></label><label><span>ملاحظات المتابعة</span><textarea className="input" rows={4} value={notes} onChange={(event) => setNotes(event.target.value)} /></label><div className="dialog-actions"><button className="btn primary" type="button" onClick={() => void completeFollowUp()}><CheckCircle2 size={15} /> حفظ النتيجة</button><button className="btn muted" type="button" onClick={() => openAction("bookings", selectedCall)}>حجز صيانة</button><button className="btn muted" type="button" onClick={() => openAction("quotes", selectedCall)}>عرض سعر</button><button className="btn muted" type="button" onClick={() => openAction("customers", selectedCall)}>إنشاء/فتح عميل</button></div></section></div>}
    </section>
  );
}

export default CallSystemPage;
