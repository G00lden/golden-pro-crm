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
import { createDepartmentDeletionController } from "../callSystemDelete";

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
  completed: "تمت",
  no_answer: "لم يُرد",
  busy: "مشغول",
  failed: "فشلت",
  voicemail: "بريد صوتي",
  ringing: "يرن",
  routed: "مُحوّلة لموظف",
  handled: "تمت المعالجة",
};

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
  const [gateway, setGateway] = useState<api.GatewayStatus | null>(null);
  const [draft, setDraft] = useState<DraftDept>(emptyDraft());
  const [savingDept, setSavingDept] = useState(false);
  const [deletingDeptId, setDeletingDeptId] = useState<string | null>(null);
  const [savingConfig, setSavingConfig] = useState(false);
  const [testPhone, setTestPhone] = useState("");
  const [testDigit, setTestDigit] = useState("");

  const baseUrl = typeof window !== "undefined" ? window.location.origin : "";

  const refresh = useCallback(async () => {
    try {
      const [cfg, depts, log, gw] = await Promise.all([
        api.getTelephonyConfig(),
        api.getTelephonyDepartments(),
        api.getCallLogs({ limit: 100 }),
        api.getGatewayStatus().catch(() => null),
      ]);
      setConfig(cfg);
      setDepartments(depts);
      setCalls(log);
      setGateway(gw);
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

  const departmentDeletion = useMemo(
    () => createDepartmentDeletionController({
      confirm: (message) => window.confirm(message),
      remove: (id) => api.deleteTelephonyDepartment(id),
      onPendingChange: setDeletingDeptId,
    }),
    [],
  );

  const saveConfig = async () => {
    if (!config) return;
    setSavingConfig(true);
    try {
      const saved = await api.updateTelephonyConfig({
        main_number: config.main_number,
        greeting: config.greeting,
        menu_prompt: config.menu_prompt,
        ring_timeout_sec: config.ring_timeout_sec,
        enabled: config.enabled,
      });
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

  const removeDept = async (department: api.TelephonyDepartment) => {
    try {
      const result = await departmentDeletion.request(department);
      if (result !== "deleted") return;
      notify("تم حذف القسم", true);
      if (draft.id === department.id) setDraft(emptyDraft());
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
      const res = await api.testMissedCall({ from_phone: testPhone.trim(), digit: testDigit.trim() || undefined });
      notify(`تمت محاكاة مكالمة فائتة لقسم ${res.department}`, true);
      setTestPhone("");
      setTestDigit("");
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر تشغيل الاختبار", false);
    }
  };

  if (loading) {
    return (
      <div className="empty" dir="rtl" role="status" aria-live="polite">
        <RefreshCcw className="spin" size={26} aria-hidden="true" />
        <p>جاري تحميل نظام المكالمات…</p>
      </div>
    );
  }

  return (
    <section dir="rtl" className="call-system-page">
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
        <div>
          <h1 style={{ margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
            <PhoneCall size={22} aria-hidden="true" /> نظام المكالمات والتحويل
          </h1>
          <p style={{ margin: 0, opacity: 0.7, fontSize: 13 }}>
            قائمة صوتية ترد على المتصلين وتحوّلهم للموظف المختص، وعند عدم الرد ترسل واتساب للعميل والموظف.
          </p>
        </div>
        <button className="btn muted" type="button" onClick={refresh}><RefreshCcw size={14} /> تحديث</button>
      </header>

      {/* Self-hosted gateway (no external provider, no WhatsApp QR) */}
      <div className="card" style={{ padding: 16, display: "grid", gap: 10, border: "1px solid rgba(96,165,250,0.35)" }}>
        <h3 style={{ margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
          <Smartphone size={18} /> البوابة الذاتية (جوالك) — بدون مزوّد خارجي
          <span style={{ fontSize: 12, padding: "2px 10px", borderRadius: 8,
            background: gateway?.configured ? "rgba(15,191,108,0.15)" : "rgba(245,158,11,0.15)",
            color: gateway?.configured ? "#0fbf6c" : "#f59e0b" }}>
            {gateway?.configured ? "مُفعّلة (التوكن مضبوط)" : "تحتاج ضبط GATEWAY_TOKEN"}
          </span>
        </h3>
        <p style={{ margin: 0, opacity: 0.8, fontSize: 13, lineHeight: 1.8 }}>
          ضع شريحة الشركة في جوال أندرويد وشغّل تطبيق أتمتة مجاني (MacroDroid/Tasker) ليرسل أحداث المكالمات لخادمك ويرسل ردود SMS من شريحتك.
          نمط التوجيه الحالي: <strong>{gateway?.routing_mode === "direct" ? "تحويل مباشر" : "قائمة عبر SMS (يرد العميل برقم)"}</strong> — يُضبط عبر <code>GATEWAY_ROUTING_MODE</code>.
        </p>
        <div style={{ display: "grid", gap: 4, fontSize: 12 }}>
          <code style={{ background: "rgba(255,255,255,0.06)", padding: "4px 8px", borderRadius: 6 }}>POST {baseUrl}/api/gateway/event  (ترويسة x-gateway-token)</code>
          <code style={{ background: "rgba(255,255,255,0.06)", padding: "4px 8px", borderRadius: 6 }}>GET  {baseUrl}/api/gateway/outbox   ← الرسائل المنتظرة للإرسال</code>
          <code style={{ background: "rgba(255,255,255,0.06)", padding: "4px 8px", borderRadius: 6 }}>POST {baseUrl}/api/gateway/outbox/ack  ← تأكيد الإرسال</code>
        </div>
        <p style={{ margin: 0, opacity: 0.7, fontSize: 12 }}>
          الدليل الكامل لإعداد الجوال في <code>docs/gateway-setup.md</code>. الرسائل المنتظرة الآن: <strong>{gateway?.pending ?? 0}</strong>.
          {!gateway?.configured && " تظهر الردود محلياً حتى تضبط التوكن."}
        </p>
        {gateway && gateway.recent.length > 0 && (
          <div className="scrollable-table-region" role="region" aria-label="رسائل البوابة الذاتية الأخيرة" tabIndex={0}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead><tr style={{ textAlign: "right", opacity: 0.7 }}>
                <th scope="col" style={{ padding: 5 }}>الوقت</th><th scope="col" style={{ padding: 5 }}>إلى</th>
                <th scope="col" style={{ padding: 5 }}>النوع</th><th scope="col" style={{ padding: 5 }}>الحالة</th><th scope="col" style={{ padding: 5 }}>النص</th>
              </tr></thead>
              <tbody>
                {gateway.recent.slice(0, 12).map((m) => (
                  <tr key={m.id} style={{ borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                    <td style={{ padding: 5, whiteSpace: "nowrap" }}>{fmtDateTime(m.created_at)}</td>
                    <td style={{ padding: 5 }}>{m.to_phone}</td>
                    <td style={{ padding: 5 }}>{m.role === "agent" ? "موظف" : "عميل"}</td>
                    <td style={{ padding: 5, color: m.status === "sent" ? "#0fbf6c" : m.status === "failed" ? "#ef4444" : "#f59e0b" }}>
                      {m.status === "sent" ? "أُرسلت" : m.status === "failed" ? "فشلت" : "بالانتظار"}
                    </td>
                    <td style={{ padding: 5, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.body}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Config */}
      {config && (
        <form
          className="card"
          style={{ padding: 16, display: "grid", gap: 12 }}
          aria-busy={savingConfig}
          onSubmit={(event) => { event.preventDefault(); void saveConfig(); }}
        >
          <h3 style={{ margin: 0 }}>الإعدادات العامة</h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 12 }}>
            <label className="field">
              <span>الرقم الأساسي (للإعلانات)</span>
              <input className="input" type="tel" inputMode="tel" name="telephony_main_number" autoComplete="tel" value={config.main_number}
                onChange={(e) => setConfig({ ...config, main_number: e.target.value })}
                placeholder="مثال: 9665XXXXXXXX…" />
            </label>
            <label className="field">
              <span>مهلة الرنين (ثانية)</span>
              <input className="input" type="number" inputMode="numeric" name="telephony_ring_timeout" autoComplete="off" min={5} max={120} value={config.ring_timeout_sec}
                onChange={(e) => setConfig({ ...config, ring_timeout_sec: Number(e.target.value) || 20 })} />
            </label>
            <label className="field" style={{ alignSelf: "end" }}>
              <span>تفعيل النظام</span>
              <select className="input" name="telephony_enabled" autoComplete="off" value={config.enabled ? "1" : "0"}
                onChange={(e) => setConfig({ ...config, enabled: e.target.value === "1" })}>
                <option value="1">مفعّل</option>
                <option value="0">متوقف</option>
              </select>
            </label>
          </div>
          <label className="field">
            <span>رسالة الترحيب</span>
            <input className="input" name="telephony_greeting" autoComplete="off" value={config.greeting}
              onChange={(e) => setConfig({ ...config, greeting: e.target.value })}
              placeholder="مثال: مرحباً بكم في شركتنا…" />
          </label>
          <label className="field">
            <span>نص القائمة (اتركه فارغاً لتوليده تلقائياً من الأقسام)</span>
            <input className="input" name="telephony_menu_prompt" autoComplete="off" value={config.menu_prompt}
              onChange={(e) => setConfig({ ...config, menu_prompt: e.target.value })}
              placeholder="مثال: للمبيعات اضغط 1، للصيانة اضغط 2…" />
          </label>
          <div>
            <button className="btn primary" type="submit" disabled={savingConfig} aria-busy={savingConfig}>
              <Save size={14} aria-hidden="true" /> {savingConfig ? "جاري الحفظ…" : "حفظ الإعدادات"}
            </button>
          </div>
        </form>
      )}

      {/* Departments + editor */}
      <div className="call-departments-grid">
        <div className="card" style={{ padding: 16 }}>
          <h3 style={{ marginTop: 0 }}>الأقسام ({departments.length})</h3>
          {departments.length === 0 ? (
            <p style={{ opacity: 0.7 }}>لا توجد أقسام. أضف قسماً من النموذج المجاور.</p>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              {departments.map((d) => (
                <div key={d.id} style={{ border: "1px solid rgba(255,255,255,0.1)", borderRadius: 10, padding: 12 }}>
                  <div className="call-department-head">
                    <strong style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ background: "rgba(96,165,250,0.18)", color: "#60a5fa", borderRadius: 8, padding: "2px 10px", fontSize: 16 }}>{d.digit}</span>
                      {d.name}
                      {!d.active && <span style={{ fontSize: 11, color: "#f59e0b" }}>(متوقف)</span>}
                    </strong>
                    <span className="call-department-actions">
                      <button className="icon-btn muted" title="تعديل" type="button" onClick={() => editDept(d)}>تعديل</button>
                      <button
                        className="icon-btn danger"
                        title={deletingDeptId === d.id ? "جارٍ حذف القسم" : "حذف القسم"}
                        aria-label={`حذف قسم ${d.name}`}
                        aria-busy={deletingDeptId === d.id}
                        type="button"
                        disabled={deletingDeptId !== null}
                        onClick={() => removeDept(d)}
                      >
                        {deletingDeptId === d.id ? "…" : <Trash2 size={14} />}
                      </button>
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

        <form
          className="card"
          style={{ padding: 16 }}
          aria-busy={savingDept}
          onSubmit={(event) => { event.preventDefault(); void saveDept(); }}
        >
          <h3 style={{ marginTop: 0 }}>{draft.id ? "تعديل قسم" : "إضافة قسم"}</h3>
          <div style={{ display: "grid", gap: 10 }}>
            <label className="field">
              <span>رقم الاختيار (0-9)</span>
              <input className="input" inputMode="numeric" name="telephony_department_digit" autoComplete="off" maxLength={1} value={draft.digit}
                onChange={(e) => setDraft({ ...draft, digit: e.target.value.replace(/[^0-9]/g, "") })}
                placeholder="مثال: 1…" />
            </label>
            <label className="field">
              <span>اسم القسم</span>
              <input className="input" name="telephony_department_name" autoComplete="organization-title" value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="مثال: المبيعات…" />
            </label>
            <label className="field">
              <span>مهلة الرنين (ثانية)</span>
              <input className="input" type="number" inputMode="numeric" name="telephony_department_timeout" autoComplete="off" min={5} max={120} value={draft.ring_timeout_sec}
                onChange={(e) => setDraft({ ...draft, ring_timeout_sec: Number(e.target.value) || 20 })} />
            </label>

            <div style={{ display: "grid", gap: 6 }}>
              <span style={{ fontSize: 13, opacity: 0.8 }}>الموظفون (تُجرّب أرقامهم بالترتيب)</span>
              {draft.agents.map((a, i) => (
                <div key={i} className="call-agent-row">
                  <input className="input" value={a.name} name={`telephony_agent_${i}_name`} autoComplete="name" aria-label={`اسم الموظف ${i + 1}`} placeholder="اسم الموظف…"
                    onChange={(e) => setDraft({ ...draft, agents: draft.agents.map((x, j) => j === i ? { ...x, name: e.target.value } : x) })} />
                  <input className="input" type="tel" inputMode="tel" value={a.phone} name={`telephony_agent_${i}_phone`} autoComplete="tel" aria-label={`جوال الموظف ${i + 1}`} placeholder="مثال: 9665XXXXXXXX…"
                    onChange={(e) => setDraft({ ...draft, agents: draft.agents.map((x, j) => j === i ? { ...x, phone: e.target.value } : x) })} />
                  <button className="icon-btn danger" title="حذف الموظف" aria-label={`حذف الموظف ${i + 1}`} type="button"
                    onClick={() => setDraft({ ...draft, agents: draft.agents.filter((_, j) => j !== i) })}><Trash2 size={13} aria-hidden="true" /></button>
                </div>
              ))}
              <button className="btn muted" type="button" onClick={() => setDraft({ ...draft, agents: [...draft.agents, { name: "", phone: "" }] })}>
                <Plus size={13} /> موظف آخر
              </button>
            </div>

            <div className="form-actions">
              <button className="btn primary" type="submit" disabled={savingDept} aria-busy={savingDept}>
                <Save size={14} aria-hidden="true" /> {savingDept ? "جاري الحفظ…" : draft.id ? "حفظ التعديل" : "إضافة القسم"}
              </button>
              {draft.id && (
                <button className="btn muted" type="button" onClick={() => setDraft(emptyDraft())}>إلغاء</button>
              )}
            </div>
          </div>
        </form>
      </div>

      {/* Setup hint */}
      <div className="card" style={{ padding: 16, fontSize: 13, lineHeight: 1.9 }}>
        <h3 style={{ marginTop: 0 }}>ربط Unifonic</h3>
        <p style={{ opacity: 0.85, margin: "0 0 6px" }}>في لوحة Unifonic، اضبط العناوين التالية لرقمك الأساسي:</p>
        <div style={{ display: "grid", gap: 4 }}>
          <code className="call-endpoint">IVR Endpoint: {baseUrl}/webhooks/telephony/ivr</code>
          <code className="call-endpoint">Status Callback: {baseUrl}/webhooks/telephony/status</code>
        </div>
        <p style={{ opacity: 0.7, marginBottom: 0 }}>
          أرسل السر المشترك في الترويسة <code>x-telephony-webhook-secret</code> (نفس قيمة <code>TELEPHONY_WEBHOOK_SECRET</code>).
        </p>
      </div>

      {/* This simulator can enqueue the real missed-call communication flow, so
          production builds do not expose it. The server also rejects direct
          production requests; this condition is only the matching UX policy. */}
      {import.meta.env.DEV && <div className="card" style={{ padding: 16, display: "grid", gap: 10 }}>
        <h3 style={{ margin: 0 }}>اختبار مكالمة فائتة</h3>
        <p style={{ margin: 0, opacity: 0.7, fontSize: 13 }}>محاكاة مكالمة لم يُرد عليها لاختبار وصول الواتساب للعميل والموظف (بدون مكالمة حقيقية).</p>
        <form className="call-test-form" onSubmit={(event) => { event.preventDefault(); void runTest(); }}>
          <label className="field">
            <span>رقم جوال العميل</span>
            <input className="input" type="tel" inputMode="tel" name="missed_call_test_phone" autoComplete="tel" value={testPhone} placeholder="مثال: 9665XXXXXXXX…"
              onChange={(e) => setTestPhone(e.target.value)} />
          </label>
          <label className="field">
            <span>رقم القسم</span>
            <input className="input" inputMode="numeric" name="missed_call_test_digit" autoComplete="off" maxLength={1} value={testDigit} placeholder="مثال: 1…"
              onChange={(e) => setTestDigit(e.target.value.replace(/[^0-9]/g, ""))} />
          </label>
          <button className="btn primary" type="submit"><PhoneMissed size={14} aria-hidden="true" /> تشغيل الاختبار</button>
        </form>
      </div>}

      {/* Call log */}
      <div className="card" style={{ padding: 16 }}>
        <h3 style={{ marginTop: 0, display: "flex", alignItems: "center", gap: 8 }}>
          سجل المكالمات
          {missedCount > 0 && <span style={{ color: "#ef4444", fontSize: 13 }}>({missedCount} فائتة)</span>}
        </h3>
        {calls.length === 0 ? (
          <p style={{ opacity: 0.7 }}>لا توجد مكالمات بعد.</p>
        ) : (
          <div className="scrollable-table-region" role="region" aria-label="سجل المكالمات" tabIndex={0}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "right", opacity: 0.7 }}>
                  <th scope="col" style={{ padding: 6 }}>الوقت</th>
                  <th scope="col" style={{ padding: 6 }}>المتصل</th>
                  <th scope="col" style={{ padding: 6 }}>القسم</th>
                  <th scope="col" style={{ padding: 6 }}>الموظف</th>
                  <th scope="col" style={{ padding: 6 }}>الحالة</th>
                  <th scope="col" style={{ padding: 6 }}>المتابعة</th>
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
                    <td style={{ padding: 6, color: c.missed && !c.handled ? "#ef4444" : undefined }}>{STATUS_LABEL[c.status] || c.status}</td>
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
