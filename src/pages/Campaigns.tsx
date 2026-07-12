import { Ban, CheckCircle2, Clock3, Megaphone, Pause, Play, RefreshCcw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import * as api from "../api";

type Notifier = (message: string, ok?: boolean) => void;

const STATUS_LABEL: Record<string, string> = {
  draft: "مسودة",
  scheduled: "مجدولة",
  running: "تعمل",
  paused: "متوقفة مؤقتاً",
  completed: "مكتملة",
  cancelled: "ملغاة",
};

const REASON_LABEL: Record<string, string> = {
  invalid_phone: "رقم غير صالح",
  suppressed: "طلب إلغاء",
  consent_missing: "لا توجد موافقة",
  duplicate_phone: "رقم مكرر",
  frequency_cap: "حد التكرار",
};

function fmt(value?: string | null) {
  return value ? new Date(value).toLocaleString("ar-SA") : "—";
}

export function CampaignsPage({ notify }: { notify: Notifier }) {
  const [campaigns, setCampaigns] = useState<api.CommunicationCampaign[]>([]);
  const [templates, setTemplates] = useState<api.WhatsAppTemplateInfo[]>([]);
  const [suppressions, setSuppressions] = useState<api.CommunicationSuppression[]>([]);
  const [providerStatus, setProviderStatus] = useState<api.WhatsAppStatus | null>(null);
  const [preview, setPreview] = useState<api.CampaignPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("general_reminder");
  const [message, setMessage] = useState("");
  const [city, setCity] = useState("");
  const [source, setSource] = useState("");
  const [allCustomers, setAllCustomers] = useState(false);
  const [rate, setRate] = useState(30);
  const [frequencyDays, setFrequencyDays] = useState(7);
  const [scheduleAt, setScheduleAt] = useState("");
  const [preferencePhone, setPreferencePhone] = useState("");
  const [preferenceEvidence, setPreferenceEvidence] = useState("");
  const [preferenceStatus, setPreferenceStatus] = useState<"granted" | "withdrawn">("granted");
  const [liftSuppression, setLiftSuppression] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [campaignData, templateData, suppressionData, statusData] = await Promise.all([
        api.listCommunicationCampaigns(),
        api.getWhatsAppTemplates(),
        api.listCommunicationSuppressions(),
        api.getWhatsAppStatus(),
      ]);
      setCampaigns(campaignData.campaigns);
      setTemplates(templateData.templates);
      setSuppressions(suppressionData.suppressions);
      setProviderStatus(statusData);
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر تحميل الحملات", false);
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => { void refresh(); }, [refresh]);

  const selectedCampaign = useMemo(
    () => campaigns.find((item) => item.id === preview?.campaign.id) || preview?.campaign,
    [campaigns, preview],
  );
  const launchReady = providerStatus?.provider === "cloud_api"
    && providerStatus.status === "connected"
    && providerStatus.outbound?.mode === "production"
    && providerStatus.outbound.launchApproved;

  const createCampaign = async (event: FormEvent) => {
    event.preventDefault();
    setBusy("create");
    try {
      const audience_filter = {
        ...(allCustomers ? { allCustomers: true } : {}),
        ...(city.trim() ? { city: city.trim() } : {}),
        ...(source.trim() ? { source: source.trim() } : {}),
      };
      const created = await api.createCommunicationCampaign({
        name: name.trim(),
        template_name: template,
        audience_filter,
        template_vars: message.trim() ? { message: message.trim() } : {},
        rate_limit_per_minute: rate,
        frequency_cap_days: frequencyDays,
      });
      setPreview(await api.previewCommunicationCampaign(created.campaign.id));
      setName("");
      notify("تم إنشاء المسودة. راجع المعاينة قبل التشغيل.", true);
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر إنشاء الحملة", false);
    } finally {
      setBusy("");
    }
  };

  const inspect = async (id: string) => {
    setBusy(`preview:${id}`);
    try {
      setPreview(await api.previewCommunicationCampaign(id));
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذرت معاينة الجمهور", false);
    } finally {
      setBusy("");
    }
  };

  const launch = async (campaign: api.CommunicationCampaign) => {
    if (!preview || preview.campaign.id !== campaign.id) return notify("اعرض معاينة الحملة أولاً.", false);
    if (!preview.eligible) return notify("لا يوجد مستلم مؤهل بموافقة صريحة.", false);
    const when = scheduleAt ? new Date(scheduleAt).toISOString() : null;
    const label = when ? `جدولة الحملة في ${fmt(when)}` : "تشغيل الحملة الآن";
    if (!window.confirm(`${label} لعدد ${preview.eligible} مستلم مؤهل؟`)) return;
    setBusy(`launch:${campaign.id}`);
    try {
      await api.launchCommunicationCampaign(campaign.id, when);
      notify(when ? "تمت جدولة الحملة" : "تم تشغيل الحملة عبر الطابور الآمن", true);
      await refresh();
      await inspect(campaign.id);
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر تشغيل الحملة", false);
    } finally {
      setBusy("");
    }
  };

  const action = async (campaign: api.CommunicationCampaign, next: "pause" | "resume" | "cancel") => {
    if (next === "cancel" && !window.confirm("إلغاء الحملة ومنع كل الرسائل التي لم تُرسل بعد؟")) return;
    setBusy(`${next}:${campaign.id}`);
    try {
      await api.changeCommunicationCampaign(campaign.id, next);
      notify(next === "pause" ? "توقفت الحملة مؤقتاً" : next === "resume" ? "استؤنفت الحملة" : "أُلغيت الحملة", true);
      await refresh();
      if (preview?.campaign.id === campaign.id) await inspect(campaign.id);
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر تغيير حالة الحملة", false);
    } finally {
      setBusy("");
    }
  };

  const savePreference = async (event: FormEvent) => {
    event.preventDefault();
    setBusy("preference");
    try {
      const result = await api.updateCommunicationPreference({
        phone: preferencePhone,
        status: preferenceStatus,
        evidence: preferenceEvidence,
        source: "manual_admin",
        lift_suppression: preferenceStatus === "granted" && liftSuppression,
      });
      notify(result.eligibility.eligible ? "أصبح الرقم مؤهلاً للحملات" : `حُفظت الحالة: ${REASON_LABEL[result.eligibility.reason || ""] || result.eligibility.reason}`, true);
      setPreferencePhone("");
      setPreferenceEvidence("");
      setLiftSuppression(false);
      await refresh();
      if (preview) await inspect(preview.campaign.id);
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر حفظ الموافقة", false);
    } finally {
      setBusy("");
    }
  };

  if (loading) return <div className="empty" dir="rtl"><RefreshCcw className="spin" /><p>جاري تحميل مركز الحملات…</p></div>;

  return (
    <section dir="rtl" style={{ display: "grid", gap: 18 }}>
      <header style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div><h1 style={{ margin: 0, display: "flex", gap: 8, alignItems: "center" }}><Megaphone size={23} /> الحملات الآمنة</h1><p style={{ margin: "4px 0 0", opacity: 0.7 }}>موافقة صريحة، إلغاء فوري، معاينة، جدولة وحدود تكرار قبل المرور بطابور واتساب.</p></div>
        <button className="btn muted" type="button" onClick={refresh}><RefreshCcw size={14} /> تحديث</button>
      </header>

      <div className="card" style={{ padding: 16, border: "1px solid rgba(15,191,108,.35)" }}><strong style={{ display: "flex", alignItems: "center", gap: 7 }}><ShieldCheck size={18} color="#0fbf6c" /> بوابة الأمان إلزامية</strong><p style={{ marginBottom: 0, opacity: 0.75 }}>لا يدخل الطابور إلا رقم له موافقة تسويق صريحة وغير موجود في قائمة الإلغاء ولم تصله حملة ضمن حد التكرار. يُعاد الفحص لحظة الإرسال.</p></div>
      {!launchReady && <div className="card" style={{ padding: 12, border: "1px solid rgba(245,158,11,.4)", color: "#b7791f" }}>التشغيل مقفل: يلزم اتصال WhatsApp Cloud متحقق ووضع إنتاج معتمد. يمكنك إنشاء المسودات والمعاينة الآن.</div>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(330px,1fr))", gap: 16 }}>
        <form className="card" style={{ padding: 16, display: "grid", gap: 10 }} onSubmit={createCampaign}>
          <h3 style={{ margin: 0 }}>إنشاء مسودة حملة</h3>
          <label className="field"><span>اسم الحملة</span><input className="input" required value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className="field"><span>القالب المعتمد</span><select className="input" value={template} onChange={(e) => setTemplate(e.target.value)}>{templates.filter((item) => item.name === "general_reminder").map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
          <label className="field"><span>نص متغير القالب</span><textarea className="input textarea" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="يستخدم مع general_reminder" /></label>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={allCustomers} onChange={(e) => setAllCustomers(e.target.checked)} /> كل العملاء الموافقين</label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <label className="field"><span>المدينة</span><input className="input" value={city} onChange={(e) => setCity(e.target.value)} /></label>
            <label className="field"><span>المصدر</span><input className="input" value={source} onChange={(e) => setSource(e.target.value)} placeholder="salla / manual" /></label>
            <label className="field"><span>رسالة/دقيقة</span><input className="input" type="number" min={1} max={120} value={rate} onChange={(e) => setRate(Number(e.target.value))} /></label>
            <label className="field"><span>حد التكرار/يوم</span><input className="input" type="number" min={1} max={90} value={frequencyDays} onChange={(e) => setFrequencyDays(Number(e.target.value))} /></label>
          </div>
          <button className="btn primary" disabled={busy === "create" || (!allCustomers && !city.trim() && !source.trim())}><Megaphone size={14} /> إنشاء ومعاينة</button>
        </form>

        <form className="card" style={{ padding: 16, display: "grid", gap: 10, alignContent: "start" }} onSubmit={savePreference}>
          <h3 style={{ margin: 0 }}>الموافقة وإلغاء الاشتراك</h3>
          <label className="field"><span>رقم العميل</span><input className="input" required dir="ltr" value={preferencePhone} onChange={(e) => setPreferencePhone(e.target.value)} placeholder="0500000000" /></label>
          <label className="field"><span>الحالة</span><select className="input" value={preferenceStatus} onChange={(e) => setPreferenceStatus(e.target.value as "granted" | "withdrawn")}><option value="granted">موافق صراحة</option><option value="withdrawn">سحب الموافقة</option></select></label>
          <label className="field"><span>دليل الموافقة أو الإلغاء</span><textarea className="input textarea" required rows={3} value={preferenceEvidence} onChange={(e) => setPreferenceEvidence(e.target.value)} placeholder="نموذج موقع، طلب مكتوب، أو مرجع المحادثة" /></label>
          {preferenceStatus === "granted" && <label style={{ display: "flex", gap: 8 }}><input type="checkbox" checked={liftSuppression} onChange={(e) => setLiftSuppression(e.target.checked)} /> رفع حظر سابق بناءً على موافقة جديدة موثقة</label>}
          <button className="btn primary" disabled={busy === "preference"}><ShieldCheck size={14} /> حفظ الحالة</button>
          <div style={{ borderTop: "1px solid rgba(255,255,255,.1)", paddingTop: 10 }}><strong>قائمة الإلغاء النشطة: {suppressions.length}</strong>{suppressions.slice(0, 6).map((item) => <div key={item.id} style={{ fontSize: 12, marginTop: 6 }}><Ban size={12} color="#ef4444" /> <span dir="ltr">{item.phone}</span> — {item.reason}</div>)}</div>
        </form>
      </div>

      {preview && selectedCampaign && <div className="card" style={{ padding: 16, display: "grid", gap: 12 }}>
        <h3 style={{ margin: 0 }}>معاينة: {selectedCampaign.name}</h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 8 }}><Metric label="الجمهور" value={preview.audience} /><Metric label="المؤهل" value={preview.eligible} good />{Object.entries(preview.excluded).map(([reason, count]) => <Metric key={reason} label={REASON_LABEL[reason] || reason} value={count} />)}</div>
        <label className="field"><span>موعد التشغيل (اختياري)</span><input className="input" type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} /></label>
        <div><button className="btn primary" type="button" onClick={() => launch(selectedCampaign)} disabled={!preview.eligible || !launchReady || busy.startsWith("launch:")}><Play size={14} /> {scheduleAt ? "جدولة" : "تشغيل الآن"}</button></div>
      </div>}

      <div className="card" style={{ padding: 16 }}><h3 style={{ marginTop: 0 }}>الحملات ({campaigns.length})</h3><div style={{ display: "grid", gap: 10 }}>
        {campaigns.map((campaign) => <div key={campaign.id} style={{ border: "1px solid rgba(255,255,255,.1)", borderRadius: 10, padding: 12, display: "grid", gap: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}><strong>{campaign.name}</strong><span>{STATUS_LABEL[campaign.status] || campaign.status}</span></div>
          <small style={{ opacity: 0.7 }}><Clock3 size={12} /> {fmt(campaign.created_at)} · <code>{campaign.template_name}</code> · {campaign.rate_limit_per_minute}/دقيقة</small>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 13 }}><span>بالطابور: {campaign.stats.queued + campaign.stats.processing + campaign.stats.retry}</span><span style={{ color: "#0fbf6c" }}>أُرسلت: {campaign.stats.sent + campaign.stats.delivered + campaign.stats.read}</span><span>قُرئت: {campaign.stats.read}</span><span style={{ color: "#ef4444" }}>فشل/حظر: {campaign.stats.failed + campaign.stats.blocked}</span><span>مستبعد: {campaign.stats.skipped}</span></div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}><button className="btn muted" type="button" onClick={() => inspect(campaign.id)}>معاينة</button>{campaign.status === "running" && <button className="btn muted" type="button" onClick={() => action(campaign, "pause")}><Pause size={13} /> إيقاف</button>}{campaign.status === "paused" && <button className="btn primary" type="button" onClick={() => action(campaign, "resume")}><Play size={13} /> استكمال</button>}{["draft", "scheduled", "running", "paused"].includes(campaign.status) && <button className="btn danger" type="button" onClick={() => action(campaign, "cancel")}><Ban size={13} /> إلغاء</button>}{campaign.status === "completed" && <span style={{ color: "#0fbf6c" }}><CheckCircle2 size={14} /> مكتملة</span>}</div>
        </div>)}
        {!campaigns.length && <p style={{ opacity: 0.65 }}>لا توجد حملات بعد.</p>}
      </div></div>
    </section>
  );
}

function Metric({ label, value, good = false }: { label: string; value: number; good?: boolean }) {
  return <div style={{ border: `1px solid ${good ? "rgba(15,191,108,.35)" : "rgba(255,255,255,.1)"}`, borderRadius: 9, padding: 10 }}><small style={{ opacity: 0.7 }}>{label}</small><strong style={{ display: "block", fontSize: 22 }}>{value}</strong></div>;
}

export default CampaignsPage;
