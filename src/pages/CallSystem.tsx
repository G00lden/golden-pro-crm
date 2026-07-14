import { useCallback, useEffect, useMemo, useState } from "react";
import {
  PhoneCall,
  PhoneMissed,
  Plus,
  RefreshCcw,
  Save,
  Smartphone,
  Trash2,
  Users as UsersIcon,
} from "lucide-react";
import * as api from "../api";

type Notifier = (message: string, ok?: boolean) => void;

function fmtDateTime(value?: string | null) {
  if (!value) return "—";
  try {
    return new Date(value.replace(" ", "T") + (value.length === 19 ? "Z" : "")).toLocaleString("ar-SA");
  } catch {
    return value;
  }
}

const STATUS_LABEL: Record<string, string> = {
  menu: "في القائمة",
  forwarding: "جارٍ التحويل",
  in_progress: "قيد المكالمة",
  answered: "تم الرد",
  no_answer: "لم يُرد",
  busy: "مشغول",
  unreachable: "مغلق أو خارج التغطية",
  rejected: "مرفوضة",
  after_hours: "خارج الدوام",
  blocked: "محظورة",
  outgoing: "صادرة",
  unknown: "غير مؤكدة",
  ringing: "يرن",
  routed: "مُحوّلة لموظف",
  handled: "تمت المعالجة",
};

const ACTION_LABEL: Record<string, string> = {
  none: "تسجيل فقط",
  queued: "في طابور واتساب",
  sent: "أُرسلت الرسالة",
  dry_run: "اختبار جاف",
  waiting_whatsapp: "بانتظار ربط واتساب",
  failed_whatsapp: "الرقم غير متاح على واتساب",
  cooldown: "مُنعت للتكرار",
  task_created: "أُنشئت مهمة",
  customer_replied: "رد العميل",
  not_applicable: "تسجيل فقط",
};

const BUSINESS_DAYS = [
  { value: 6, label: "السبت" },
  { value: 0, label: "الأحد" },
  { value: 1, label: "الاثنين" },
  { value: 2, label: "الثلاثاء" },
  { value: 3, label: "الأربعاء" },
  { value: 4, label: "الخميس" },
  { value: 5, label: "الجمعة" },
];

type DraftAgent = { name: string; phone: string };
type DraftDept = {
  id?: string;
  digit: string;
  name: string;
  ring_timeout_sec: number;
  active: boolean;
  agents: DraftAgent[];
};

const emptyDraft = (): DraftDept => ({
  digit: "",
  name: "",
  ring_timeout_sec: 20,
  active: true,
  agents: [{ name: "", phone: "" }],
});

export function CallSystemPage({ notify }: { notify: Notifier }) {
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<api.TelephonyConfig | null>(null);
  const [departments, setDepartments] = useState<api.TelephonyDepartment[]>([]);
  const [calls, setCalls] = useState<api.CallLogRow[]>([]);
  const [actions, setActions] = useState<api.CallActionRow[]>([]);
  const [draft, setDraft] = useState<DraftDept>(emptyDraft());
  const [savingDept, setSavingDept] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [testPhone, setTestPhone] = useState("");
  const [testDigit, setTestDigit] = useState("");
  const [testDisposition, setTestDisposition] = useState<api.AutomatedCallDisposition>("no_answer");

  const baseUrl = typeof window !== "undefined" ? window.location.origin : "";

  const refresh = useCallback(async () => {
    try {
      const [cfg, depts, log, queuedActions] = await Promise.all([
        api.getTelephonyConfig(),
        api.getTelephonyDepartments(),
        api.getCallLogs({ limit: 100 }),
        api.getCallActions().catch(() => []),
      ]);
      setConfig(cfg);
      setDepartments(depts);
      setCalls(log);
      setActions(queuedActions);
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر تحميل نظام المكالمات", false);
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const missedCount = useMemo(() => calls.filter((c) => c.missed).length, [calls]);

  const saveConfig = async () => {
    if (!config) return;
    setSavingConfig(true);
    try {
      const { owner_uid: _ownerUid, provider: _provider, ...patch } = config;
      const saved = await api.updateTelephonyConfig(patch);
      setConfig(saved);
      notify("تم حفظ إعدادات المكالمات", true);
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر الحفظ", false);
    } finally {
      setSavingConfig(false);
    }
  };

  const editDept = (d: api.TelephonyDepartment) => {
    setDraft({
      id: d.id,
      digit: d.digit,
      name: d.name,
      ring_timeout_sec: d.ring_timeout_sec,
      active: d.active,
      agents: d.agents.length ? d.agents.map((a) => ({ name: a.name || "", phone: a.phone })) : [{ name: "", phone: "" }],
    });
  };

  const saveDept = async () => {
    const agents = draft.agents.filter((a) => a.phone.trim());
    if (!draft.digit.trim() || !draft.name.trim()) {
      notify("الرقم واسم القسم مطلوبان", false);
      return;
    }
    if (!agents.length) {
      notify("أضف موظفاً واحداً على الأقل برقم جوال", false);
      return;
    }
    setSavingDept(true);
    try {
      const payload = {
        digit: draft.digit.trim(),
        name: draft.name.trim(),
        ring_timeout_sec: draft.ring_timeout_sec,
        active: draft.active,
        agents: agents.map((a, i) => ({ name: a.name.trim(), phone: a.phone.trim(), sort_order: i })),
      };
      if (draft.id) {
        await api.updateTelephonyDepartment(draft.id, payload);
        notify("تم تحديث القسم", true);
      } else {
        await api.createTelephonyDepartment(payload);
        notify("تم إضافة القسم", true);
      }
      setDraft(emptyDraft());
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر حفظ القسم", false);
    } finally {
      setSavingDept(false);
    }
  };

  const removeDept = async (id: string) => {
    try {
      await api.deleteTelephonyDepartment(id);
      notify("تم حذف القسم", true);
      if (draft.id === id) setDraft(emptyDraft());
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر الحذف", false);
    }
  };

  const handleCall = async (id: string) => {
    try {
      await api.markCallHandled(id);
      notify("تم وضع المكالمة كمُعالَجة", true);
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر التحديث", false);
    }
  };

  const runTest = async () => {
    if (!testPhone.trim()) {
      notify("أدخل رقم جوال العميل للاختبار", false);
      return;
    }
    try {
      const res = await api.testMissedCall({
        from_phone: testPhone.trim(),
        disposition: testDisposition,
        digit: testDigit.trim() || undefined,
      });
      notify(`تمت محاكاة الحالة: ${STATUS_LABEL[res.disposition] || res.disposition}`, true);
      setTestPhone("");
      setTestDigit("");
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر تشغيل الاختبار", false);
    }
  };

  if (loading) {
    return (
      <div className="empty" dir="rtl">
        <RefreshCcw className="spin" size={26} />
        <p>جاري تحميل نظام المكالمات…</p>
      </div>
    );
  }

  return (
    <section dir="rtl" style={{ display: "grid", gap: 18 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
        <div>
          <h1 style={{ margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
            <PhoneCall size={22} /> نظام المكالمات والتحويل
          </h1>
          <p style={{ margin: 0, opacity: 0.7, fontSize: 13 }}>
            تحويل زين المشروط إلى Unifonic، ثم رد صوتي ورسالة واتساب ومهمة متابعة داخل CRM.
          </p>
        </div>
        <button className="btn muted" type="button" onClick={refresh}><RefreshCcw size={14} /> تحديث</button>
      </header>

      <div className="card" style={{ padding: 16, display: "grid", gap: 10, border: "1px solid rgba(96,165,250,0.35)" }}>
        <h3 style={{ margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
          <Smartphone size={18} /> مسار المكالمة التجاري
        </h3>
        <p style={{ margin: 0, opacity: 0.82, fontSize: 13, lineHeight: 1.9 }}>
          رقم زين يحوّل المكالمة المشروطة بعد 15 ثانية إلى Unifonic. يرد Unifonic صوتياً، ثم يحفظ CRM الحدث ويرسل من واتساب ويب وينشئ مهمة متابعة. تطبيق أندرويد يسجل المكالمات المجابة والصادرة فقط، ولا تعتمد عليه حالات الهاتف المطفأ.
        </p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", fontSize: 12 }}>
          <span>إجراءات مرسلة: <strong>{actions.filter((action) => action.status === "sent").length}</strong></span>
          <span>بالطابور: <strong>{actions.filter((action) => ["pending", "retry", "sending"].includes(action.status)).length}</strong></span>
          <span>اختبار جاف: <strong>{actions.filter((action) => action.status === "dry_run").length}</strong></span>
          <button className="btn muted" type="button" onClick={async () => { await api.retryCallActions(); await refresh(); }}>
            إعادة محاولة الطابور
          </button>
        </div>
      </div>

      {/* Config */}
      {config && (
        <div className="card" style={{ padding: 16, display: "grid", gap: 12 }}>
          <h3 style={{ margin: 0 }}>الإعدادات العامة</h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 12 }}>
            <label className="field">
              <span>اسم الشركة في الرسائل</span>
              <input className="input" value={config.company_name}
                onChange={(e) => setConfig({ ...config, company_name: e.target.value })} />
            </label>
            <label className="field">
              <span>الرقم الأساسي (للإعلانات)</span>
              <input className="input" value={config.main_number}
                onChange={(e) => setConfig({ ...config, main_number: e.target.value })}
                placeholder="9665XXXXXXXX" />
            </label>
            <label className="field">
              <span>مهلة الرنين (ثانية)</span>
              <input className="input" type="number" min={15} max={120} value={config.ring_timeout_sec}
                onChange={(e) => setConfig({ ...config, ring_timeout_sec: Number(e.target.value) || 15 })} />
            </label>
            <label className="field">
              <span>آلية الرد</span>
              <select className="input" value={config.call_flow_mode}
                onChange={(e) => setConfig({ ...config, call_flow_mode: e.target.value as api.TelephonyConfig["call_flow_mode"] })}>
                <option value="unavailable_reply">رسالة تعذر الرد ثم إنهاء</option>
                <option value="menu">قائمة صوتية قديمة</option>
              </select>
            </label>
            <label className="field" style={{ alignSelf: "end" }}>
              <span>تفعيل النظام</span>
              <select className="input" value={config.enabled ? "1" : "0"}
                onChange={(e) => setConfig({ ...config, enabled: e.target.value === "1" })}>
                <option value="1">مفعّل</option>
                <option value="0">متوقف</option>
              </select>
            </label>
            <label className="field" style={{ alignSelf: "end" }}>
              <span>رسائل واتساب التلقائية</span>
              <select className="input" value={config.auto_reply_enabled ? "1" : "0"}
                onChange={(e) => setConfig({ ...config, auto_reply_enabled: e.target.value === "1" })}>
                <option value="1">مفعّل</option>
                <option value="0">متوقف — تسجيل فقط</option>
              </select>
            </label>
          </div>
          <div className="field">
            <span>أيام الدوام</span>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {BUSINESS_DAYS.map((day) => (
                <label key={day.value} style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 9px", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8 }}>
                  <input type="checkbox" checked={config.business_days.includes(day.value)} onChange={(e) => setConfig({
                    ...config,
                    business_days: e.target.checked
                      ? [...config.business_days, day.value]
                      : config.business_days.filter((value) => value !== day.value),
                  })} />
                  {day.label}
                </label>
              ))}
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 12 }}>
            <label className="field"><span>بداية الدوام</span><input className="input" type="time" value={config.business_open} onChange={(e) => setConfig({ ...config, business_open: e.target.value })} /></label>
            <label className="field"><span>نهاية الدوام</span><input className="input" type="time" value={config.business_close} onChange={(e) => setConfig({ ...config, business_close: e.target.value })} /></label>
            <label className="field"><span>المنطقة الزمنية</span><input className="input" value={config.timezone} onChange={(e) => setConfig({ ...config, timezone: e.target.value })} /></label>
            <label className="field"><span>منع التكرار (دقيقة)</span><input className="input" type="number" min={0} value={config.reply_cooldown_min} onChange={(e) => setConfig({ ...config, reply_cooldown_min: Number(e.target.value) || 0 })} /></label>
            <label className="field"><span>مهلة المتابعة داخل الدوام</span><input className="input" type="number" min={1} value={config.follow_up_sla_min} onChange={(e) => setConfig({ ...config, follow_up_sla_min: Number(e.target.value) || 5 })} /></label>
          </div>
          <label className="field"><span>الصوت داخل الدوام</span><textarea className="input" rows={2} value={config.voice_in_hours} onChange={(e) => setConfig({ ...config, voice_in_hours: e.target.value })} /></label>
          <label className="field"><span>الصوت خارج الدوام</span><textarea className="input" rows={2} value={config.voice_after_hours} onChange={(e) => setConfig({ ...config, voice_after_hours: e.target.value })} /></label>
          <label className="field"><span>واتساب داخل الدوام</span><textarea className="input" rows={2} value={config.whatsapp_in_hours} onChange={(e) => setConfig({ ...config, whatsapp_in_hours: e.target.value })} /></label>
          <label className="field"><span>واتساب خارج الدوام</span><textarea className="input" rows={2} value={config.whatsapp_after_hours} onChange={(e) => setConfig({ ...config, whatsapp_after_hours: e.target.value })} /></label>
          <label className="field"><span>واتساب عند الرد على المكالمة</span><textarea className="input" rows={2} value={config.whatsapp_answered} onChange={(e) => setConfig({ ...config, whatsapp_answered: e.target.value })} /></label>
          {config.call_flow_mode === "menu" && (
            <>
              <label className="field"><span>رسالة الترحيب للقائمة</span><input className="input" value={config.greeting} onChange={(e) => setConfig({ ...config, greeting: e.target.value })} /></label>
              <label className="field"><span>نص القائمة</span><input className="input" value={config.menu_prompt} onChange={(e) => setConfig({ ...config, menu_prompt: e.target.value })} /></label>
            </>
          )}
          <div>
            <button className="btn primary" type="button" onClick={saveConfig} disabled={savingConfig}>
              <Save size={14} /> {savingConfig ? "…" : "حفظ الإعدادات"}
            </button>
          </div>
        </div>
      )}

      {/* Departments + editor */}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.4fr) minmax(0,1fr)", gap: 16 }}>
        <div className="card" style={{ padding: 16 }}>
          <h3 style={{ marginTop: 0 }}>الأقسام ({departments.length})</h3>
          {departments.length === 0 ? (
            <p style={{ opacity: 0.7 }}>لا توجد أقسام. أضف قسماً من النموذج المجاور.</p>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              {departments.map((d) => (
                <div key={d.id} style={{ border: "1px solid rgba(255,255,255,0.1)", borderRadius: 10, padding: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <strong style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ background: "rgba(96,165,250,0.18)", color: "#60a5fa", borderRadius: 8, padding: "2px 10px", fontSize: 16 }}>{d.digit}</span>
                      {d.name}
                      {!d.active && <span style={{ fontSize: 11, color: "#f59e0b" }}>(متوقف)</span>}
                    </strong>
                    <span style={{ display: "flex", gap: 6 }}>
                      <button className="icon-btn muted" title="تعديل" type="button" onClick={() => editDept(d)}>تعديل</button>
                      <button className="icon-btn danger" title="حذف" type="button" onClick={() => removeDept(d.id)}><Trash2 size={14} /></button>
                    </span>
                  </div>
                  <div style={{ marginTop: 8, fontSize: 13, opacity: 0.85, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <UsersIcon size={13} />
                    {d.agents.length ? d.agents.map((a) => `${a.name || "موظف"} (${a.phone})`).join("، ") : "لا يوجد موظفون"}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card" style={{ padding: 16 }}>
          <h3 style={{ marginTop: 0 }}>{draft.id ? "تعديل قسم" : "إضافة قسم"}</h3>
          <div style={{ display: "grid", gap: 10 }}>
            <label className="field">
              <span>رقم الاختيار (0-9)</span>
              <input className="input" maxLength={1} value={draft.digit}
                onChange={(e) => setDraft({ ...draft, digit: e.target.value.replace(/[^0-9]/g, "") })}
                placeholder="1" />
            </label>
            <label className="field">
              <span>اسم القسم</span>
              <input className="input" value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="المبيعات" />
            </label>
            <label className="field">
              <span>مهلة الرنين (ثانية)</span>
              <input className="input" type="number" min={5} max={120} value={draft.ring_timeout_sec}
                onChange={(e) => setDraft({ ...draft, ring_timeout_sec: Number(e.target.value) || 20 })} />
            </label>

            <div style={{ display: "grid", gap: 6 }}>
              <span style={{ fontSize: 13, opacity: 0.8 }}>الموظفون (تُجرّب أرقامهم بالترتيب)</span>
              {draft.agents.map((a, i) => (
                <div key={i} style={{ display: "flex", gap: 6 }}>
                  <input className="input" style={{ flex: 1 }} value={a.name} placeholder="الاسم"
                    onChange={(e) => setDraft({ ...draft, agents: draft.agents.map((x, j) => j === i ? { ...x, name: e.target.value } : x) })} />
                  <input className="input" style={{ flex: 1 }} value={a.phone} placeholder="9665XXXXXXXX"
                    onChange={(e) => setDraft({ ...draft, agents: draft.agents.map((x, j) => j === i ? { ...x, phone: e.target.value } : x) })} />
                  <button className="icon-btn danger" title="حذف الموظف" type="button"
                    onClick={() => setDraft({ ...draft, agents: draft.agents.filter((_, j) => j !== i) })}><Trash2 size={13} /></button>
                </div>
              ))}
              <button className="btn muted" type="button" onClick={() => setDraft({ ...draft, agents: [...draft.agents, { name: "", phone: "" }] })}>
                <Plus size={13} /> موظف آخر
              </button>
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn primary" type="button" onClick={saveDept} disabled={savingDept}>
                <Save size={14} /> {savingDept ? "…" : draft.id ? "حفظ التعديل" : "إضافة القسم"}
              </button>
              {draft.id && (
                <button className="btn muted" type="button" onClick={() => setDraft(emptyDraft())}>إلغاء</button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Setup hint */}
      <div className="card" style={{ padding: 16, fontSize: 13, lineHeight: 1.9 }}>
        <h3 style={{ marginTop: 0 }}>ربط Unifonic</h3>
        <p style={{ opacity: 0.85, margin: "0 0 6px" }}>في لوحة Unifonic، اضبط العناوين التالية لرقمك الأساسي:</p>
        <div style={{ display: "grid", gap: 4 }}>
          <code style={{ background: "rgba(255,255,255,0.06)", padding: "4px 8px", borderRadius: 6 }}>IVR Endpoint: {baseUrl}/webhooks/telephony/ivr</code>
          <code style={{ background: "rgba(255,255,255,0.06)", padding: "4px 8px", borderRadius: 6 }}>Status Callback: {baseUrl}/webhooks/telephony/status</code>
        </div>
        <p style={{ opacity: 0.7, marginBottom: 0 }}>
          أرسل السر المشترك في الترويسة <code>x-telephony-webhook-secret</code> (نفس قيمة <code>TELEPHONY_WEBHOOK_SECRET</code>).
        </p>
        <p style={{ marginBottom: 0, color: "#f59e0b" }}>
          شرط الإطلاق: اختبر من رقم ثالث أن التحويل المشروط من زين يحافظ على رقم المتصل الأصلي داخل Webhook في الحالات الأربع. لا تفعّل الإرسال التجاري قبل نجاح هذا الاختبار.
        </p>
      </div>

      {/* Test missed call */}
      <div className="card" style={{ padding: 16, display: "grid", gap: 10 }}>
        <h3 style={{ margin: 0 }}>اختبار نتيجة المكالمة</h3>
        <p style={{ margin: 0, opacity: 0.7, fontSize: 13 }}>محاكاة نتيجة مكالمة واردة لاختبار حفظ جهة الاتصال ووصول رسالة واتساب المناسبة (بدون مكالمة حقيقية).</p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input className="input" style={{ flex: 2, minWidth: 180 }} value={testPhone} placeholder="رقم جوال العميل 9665XXXXXXXX"
            onChange={(e) => setTestPhone(e.target.value)} />
          <select className="input" style={{ flex: 1, minWidth: 170 }} value={testDisposition}
            onChange={(e) => setTestDisposition(e.target.value as api.AutomatedCallDisposition)}>
            <option value="answered">تم الرد</option>
            <option value="no_answer">لم يُرد خلال 15 ثانية</option>
            <option value="busy">مشغول</option>
            <option value="unreachable">مغلق أو خارج التغطية</option>
            <option value="rejected">مرفوضة</option>
            <option value="after_hours">خارج الدوام</option>
          </select>
          <input className="input" style={{ flex: 1, minWidth: 90 }} maxLength={1} value={testDigit} placeholder="القسم (رقم)"
            onChange={(e) => setTestDigit(e.target.value.replace(/[^0-9]/g, ""))} />
          <button className="btn primary" type="button" onClick={runTest}><PhoneMissed size={14} /> تشغيل الاختبار</button>
        </div>
      </div>

      {/* Call log */}
      <div className="card" style={{ padding: 16 }}>
        <h3 style={{ marginTop: 0, display: "flex", alignItems: "center", gap: 8 }}>
          سجل المكالمات
          {missedCount > 0 && <span style={{ color: "#ef4444", fontSize: 13 }}>({missedCount} فائتة)</span>}
        </h3>
        {calls.length === 0 ? (
          <p style={{ opacity: 0.7 }}>لا توجد مكالمات بعد.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "right", opacity: 0.7 }}>
                  <th style={{ padding: 6 }}>الوقت</th>
                  <th style={{ padding: 6 }}>المتصل</th>
                  <th style={{ padding: 6 }}>القسم</th>
                  <th style={{ padding: 6 }}>الموظف</th>
                  <th style={{ padding: 6 }}>الحالة</th>
                  <th style={{ padding: 6 }}>المصدر</th>
                  <th style={{ padding: 6 }}>إجراء واتساب</th>
                  <th style={{ padding: 6 }}>المتابعة</th>
                </tr>
              </thead>
              <tbody>
                {calls.map((c) => (
                  <tr key={c.id} style={{ borderTop: "1px solid rgba(255,255,255,0.08)", background: c.missed && !c.handled ? "rgba(239,68,68,0.06)" : undefined }}>
                    <td style={{ padding: 6 }}>{fmtDateTime(c.created_at)}</td>
                    <td style={{ padding: 6 }}>
                      {c.customer_name
                        ? <span title={c.from_phone || ""}><strong>{c.customer_name}</strong> <span style={{ opacity: 0.6, fontSize: 11 }}>(عميل)</span></span>
                        : (c.from_phone || "—")}
                    </td>
                    <td style={{ padding: 6 }}>{c.department_name || (c.selected_digit ? `#${c.selected_digit}` : "—")}</td>
                    <td style={{ padding: 6 }}>{c.agent_name || c.agent_phone || "—"}</td>
                    <td style={{ padding: 6, color: c.missed && !c.handled ? "#ef4444" : undefined }}>{STATUS_LABEL[c.disposition] || STATUS_LABEL[c.status] || c.disposition || c.status}</td>
                    <td style={{ padding: 6 }}>{c.source === "android" ? "أندرويد" : c.source === "unifonic" ? "Unifonic" : c.source || "—"}</td>
                    <td style={{ padding: 6 }}>{ACTION_LABEL[c.action_state] || c.action_state || "—"}</td>
                    <td style={{ padding: 6 }}>
                      {c.handled
                        ? <span style={{ color: "#0fbf6c" }}>✓ تمت المعالجة</span>
                        : c.missed
                          ? <button className="btn muted" style={{ padding: "2px 10px", fontSize: 12 }} type="button" onClick={() => handleCall(c.id)}>تمت المعالجة</button>
                          : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

export default CallSystemPage;
