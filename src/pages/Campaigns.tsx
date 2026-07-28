import {
  Ban,
  BellRing,
  CalendarPlus,
  CheckCircle2,
  Clock3,
  FileSpreadsheet,
  Megaphone,
  Pause,
  Play,
  RefreshCcw,
  ShieldCheck,
  ShoppingCart,
  SlidersHorizontal,
  Upload,
  UsersRound,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from "react";
import * as api from "../api";
import {
  parseCampaignAudience,
  type CampaignAudienceMember,
  type CampaignAudienceImportResult,
} from "../campaignAudienceImport";

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
  const [suppressions, setSuppressions] = useState<api.CommunicationSuppression[]>([]);
  const [providerStatus, setProviderStatus] = useState<api.WhatsAppStatus | null>(null);
  const [preview, setPreview] = useState<api.CampaignPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [name, setName] = useState("");
  const [campaignKind, setCampaignKind] = useState<"text" | "image" | "video">("image");
  const [mediaUrl, setMediaUrl] = useState("");
  const [orderUrl, setOrderUrl] = useState("");
  const [uploadedFileName, setUploadedFileName] = useState("");
  const [message, setMessage] = useState("");
  const [city, setCity] = useState("");
  const [source, setSource] = useState("");
  const [allCustomers, setAllCustomers] = useState(false);
  const [audienceMode, setAudienceMode] = useState<"crm" | "file">("crm");
  const [audienceFileName, setAudienceFileName] = useState("");
  const [audienceMembers, setAudienceMembers] = useState<CampaignAudienceMember[]>([]);
  const [audienceImport, setAudienceImport] = useState<CampaignAudienceImportResult | null>(null);
  const [audienceConsentConfirmed, setAudienceConsentConfirmed] = useState(false);
  const [audienceConsentEvidence, setAudienceConsentEvidence] = useState("");
  const [rate, setRate] = useState(30);
  const [frequencyDays, setFrequencyDays] = useState(7);
  const [scheduleAt, setScheduleAt] = useState("");
  const [preferencePhone, setPreferencePhone] = useState("");
  const [preferenceEvidence, setPreferenceEvidence] = useState("");
  const [preferenceStatus, setPreferenceStatus] = useState<"granted" | "withdrawn">("granted");
  const [liftSuppression, setLiftSuppression] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [campaignData, suppressionData, statusData] = await Promise.all([
        api.listCommunicationCampaigns(),
        api.listCommunicationSuppressions(),
        api.getWhatsAppStatus(),
      ]);
      setCampaigns(campaignData.campaigns);
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
  const mediaCampaign = campaignKind !== "text";
  const mediaType: "image" | "video" = campaignKind === "video" ? "video" : "image";
  const campaignTemplate = campaignKind === "text"
    ? "campaign_offer_text_reminder"
    : mediaType === "video"
      ? "campaign_offer_video_reminder"
      : "campaign_offer_image_reminder";
  const estimatedMinutes = Math.ceil(
    (audienceMode === "file" ? audienceMembers.length : preview?.eligible || 0) / Math.max(1, rate),
  );

  const uploadMedia = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const expected = mediaType === "video"
      ? ["video/mp4"]
      : ["image/jpeg", "image/png"];
    if (!expected.includes(file.type)) {
      notify(
        mediaType === "video"
          ? "اختر ملف MP4 للحملة المصورة."
          : "اختر صورة JPEG أو PNG.",
        false,
      );
      return;
    }
    setBusy("upload");
    try {
      const result = await api.uploadCommunicationCampaignMedia(file);
      setCampaignKind(result.media.type);
      setMediaUrl(result.media.url);
      setUploadedFileName(file.name);
      notify("تم رفع الوسائط وحفظ رابط HTTPS العام للحملة.", true);
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر رفع الوسائط", false);
    } finally {
      setBusy("");
    }
  };

  const importAudienceFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 1_500_000) {
      notify("ملف الجمهور أكبر من 1.5 MB. قسّمه أو احذف الأعمدة غير المطلوبة.", false);
      return;
    }
    setBusy("audience-upload");
    try {
      const parsed = parseCampaignAudience(await file.text());
      if (!parsed.members.length) {
        notify("لم يعثر الملف على أي رقم جوال صالح.", false);
        return;
      }
      setAudienceMembers(parsed.members);
      setAudienceImport(parsed);
      setAudienceFileName(file.name);
      notify(
        `تم تجهيز ${parsed.members.length.toLocaleString("ar-SA")} رقم فريد للحملة.`,
        true,
      );
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر قراءة ملف الجمهور.", false);
    } finally {
      setBusy("");
    }
  };

  const createCampaign = async (event: FormEvent) => {
    event.preventDefault();
    setBusy("create");
    try {
      const audience_filter = audienceMode === "file"
        ? { importedAudience: true }
        : {
            ...(allCustomers ? { allCustomers: true } : {}),
            ...(city.trim() ? { city: city.trim() } : {}),
            ...(source.trim() ? { source: source.trim() } : {}),
          };
      const created = await api.createCommunicationCampaign({
        name: name.trim(),
        template_name: campaignTemplate,
        audience_filter,
        template_vars: { offer_text: message.trim() },
        ...(audienceMode === "file" ? {
          audience_members: audienceMembers,
          audience_consent: {
            granted: true as const,
            evidence: audienceConsentEvidence.trim(),
            source: "campaign_import",
          },
        } : {}),
        ...(mediaCampaign ? {
          media: { type: mediaType, url: mediaUrl.trim() },
        } : {}),
        order_url: orderUrl.trim(),
        rate_limit_per_minute: rate,
        frequency_cap_days: frequencyDays,
      });
      setPreview(await api.previewCommunicationCampaign(created.campaign.id));
      setName("");
      if (audienceMode === "file") {
        setAudienceMembers([]);
        setAudienceImport(null);
        setAudienceFileName("");
        setAudienceConsentConfirmed(false);
        setAudienceConsentEvidence("");
      }
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
          <h3 style={{ margin: 0 }}>إنشاء حملة حتى 10,000 رقم</h3>
          <p className="muted" style={{ margin: 0 }}>نص أو صورة أو فيديو، مع 3 أزرار ثابتة ومعتمدة: الطلب، التذكير بعد أسبوع، وإيقاف الرسائل.</p>
          <label className="field"><span>اسم الحملة</span><input className="input" name="campaign_name" autoComplete="off" required value={name} onChange={(e) => setName(e.target.value)} placeholder="مثال: عرض فلاتر الصيف…" /></label>
          <label className="field">
            <span>نوع الحملة</span>
            <select
              className="input"
              name="campaign_content_type"
              value={campaignKind}
              onChange={(e) => {
                setCampaignKind(e.target.value as "text" | "image" | "video");
                setMediaUrl("");
                setUploadedFileName("");
              }}
            >
              <option value="text">رسالة نصية</option>
              <option value="image">صورة — JPEG أو PNG</option>
              <option value="video">فيديو — MP4</option>
            </select>
          </label>
          {mediaCampaign && <>
            <label className="field">
              <span>إرفاق {mediaType === "video" ? "فيديو" : "صورة"}</span>
              <span className="btn muted" style={{ justifyContent: "center", cursor: busy === "upload" ? "wait" : "pointer" }}>
                <Upload size={14} /> {busy === "upload" ? "جاري الرفع…" : uploadedFileName || "اختر ملفًا من جهازك"}
                <input
                  hidden
                  name="campaign_media_file"
                  type="file"
                  disabled={busy === "upload"}
                  accept={mediaType === "video" ? "video/mp4" : "image/jpeg,image/png"}
                  onChange={uploadMedia}
                />
              </span>
            </label>
            <label className="field">
              <span>أو رابط HTTPS عام للوسائط</span>
              <input
                className="input"
                dir="ltr"
                name="campaign_media_url"
                autoComplete="off"
                type="url"
                required
                value={mediaUrl}
                onChange={(e) => {
                  setMediaUrl(e.target.value);
                  setUploadedFileName("");
                }}
                placeholder={mediaType === "video" ? "https://cdn.example/offer.mp4" : "https://cdn.example/offer.jpg"}
              />
            </label>
            {mediaUrl && (
              <div style={{ borderRadius: 10, overflow: "hidden", border: "1px solid rgba(255,255,255,.1)", background: "#111" }}>
                {mediaType === "video"
                  ? <video controls preload="metadata" width={520} height={260} src={mediaUrl} style={{ display: "block", width: "100%", maxHeight: 260 }} />
                  : <img src={mediaUrl} alt="معاينة وسائط العرض" width={520} height={260} style={{ display: "block", width: "100%", maxHeight: 260, objectFit: "contain" }} />}
              </div>
            )}
          </>}
          <label className="field"><span>نص العرض</span><textarea className="input textarea" name="campaign_message" autoComplete="off" required rows={4} maxLength={2000} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="مثال: عرض خاص على فلاتر المياه لفترة محدودة…" /></label>
          <label className="field"><span>رابط زر «اطلب الآن»</span><input className="input" dir="ltr" name="campaign_order_url" autoComplete="off" type="url" required value={orderUrl} onChange={(e) => setOrderUrl(e.target.value)} placeholder="https://goldenksa.store/product/…" /></label>
          <div className="campaign-button-preview" aria-label="معاينة أزرار قالب واتساب">
            <a className="btn primary" href={orderUrl || undefined} target="_blank" rel="noreferrer noopener" onClick={(event) => { if (!orderUrl) event.preventDefault(); }}><ShoppingCart size={14} aria-hidden="true" /> اطلب الآن</a>
            <button className="btn muted" type="button" disabled><BellRing size={14} aria-hidden="true" /> ذكّرني بعد أسبوع</button>
            <button className="btn muted" type="button" disabled><Ban size={14} aria-hidden="true" /> إيقاف الرسائل</button>
          </div>
          <small className="muted">عند ضغط «ذكّرني» يحفظ النظام طلباً دائماً ويرسل العرض نفسه بعد 7 أيام. ويُعاد فحص الموافقة وقائمة الإلغاء لحظة الإرسال.</small>

          <fieldset className="campaign-audience-fieldset">
            <legend>اختيار الجمهور</legend>
            <div className="campaign-audience-tabs">
              <label><input type="radio" name="audience_mode" value="crm" checked={audienceMode === "crm"} onChange={() => setAudienceMode("crm")} /> عملاء CRM</label>
              <label><input type="radio" name="audience_mode" value="file" checked={audienceMode === "file"} onChange={() => setAudienceMode("file")} /> ملف أرقام</label>
            </div>

            {audienceMode === "crm" ? (
              <div className="campaign-audience-fields">
                <label className="campaign-check"><input type="checkbox" name="all_consenting_customers" checked={allCustomers} onChange={(e) => setAllCustomers(e.target.checked)} /> كل العملاء الموافقين</label>
                <label className="field"><span>المدينة</span><input className="input" name="audience_city" autoComplete="off" value={city} onChange={(e) => setCity(e.target.value)} /></label>
                <label className="field"><span>المصدر</span><input className="input" name="audience_source" autoComplete="off" value={source} onChange={(e) => setSource(e.target.value)} placeholder="salla أو manual…" /></label>
              </div>
            ) : (
              <div className="campaign-import-panel">
                <label className="field">
                  <span>ملف CSV أو TXT — حتى 10,000 رقم</span>
                  <span className="btn muted campaign-file-button">
                    <FileSpreadsheet size={16} aria-hidden="true" />
                    {busy === "audience-upload" ? "جاري قراءة الملف…" : audienceFileName || "اختر ملف الجمهور"}
                    <input hidden type="file" name="campaign_audience_file" accept=".csv,.txt,text/csv,text/plain" disabled={busy === "audience-upload"} onChange={importAudienceFile} />
                  </span>
                </label>
                <small className="muted">العمود المطلوب: <bdi>phone</bdi> أو «رقم الجوال». عمود الاسم اختياري. يقبل أيضاً ملفاً فيه رقم واحد بكل سطر.</small>
                {audienceImport && (
                  <div className="campaign-import-summary" role="status" aria-live="polite">
                    <strong><UsersRound size={16} aria-hidden="true" /> {audienceMembers.length.toLocaleString("ar-SA")} رقم جاهز</strong>
                    <span>مكرر: {audienceImport.duplicates.toLocaleString("ar-SA")}</span>
                    <span>غير صالح: {audienceImport.invalid.toLocaleString("ar-SA")}</span>
                    <span>فوق الحد: {audienceImport.overflow.toLocaleString("ar-SA")}</span>
                  </div>
                )}
                <label className="field"><span>دليل الموافقة التسويقية لهذه القائمة</span><textarea className="input textarea" name="audience_consent_evidence" autoComplete="off" rows={3} maxLength={1000} value={audienceConsentEvidence} onChange={(e) => setAudienceConsentEvidence(e.target.value)} placeholder="مثال: نموذج الاشتراك في عروض المتجر بتاريخ…"/></label>
                <label className="campaign-check"><input type="checkbox" name="audience_consent_confirmed" checked={audienceConsentConfirmed} onChange={(e) => setAudienceConsentConfirmed(e.target.checked)} /> أؤكد أن جميع الأرقام في الملف وافقت صراحة على رسائل التسويق، وأن الدليل أعلاه صحيح.</label>
              </div>
            )}
          </fieldset>

          <div className="campaign-settings-grid">
            <label className="field"><span>رسالة/دقيقة</span><input className="input" name="campaign_rate" type="number" inputMode="numeric" min={1} max={120} value={rate} onChange={(e) => setRate(Number(e.target.value))} /></label>
            <label className="field"><span>حد التكرار/يوم</span><input className="input" name="campaign_frequency_days" type="number" inputMode="numeric" min={1} max={90} value={frequencyDays} onChange={(e) => setFrequencyDays(Number(e.target.value))} /></label>
          </div>
          {audienceMode === "file" && audienceMembers.length > 0 && (
            <p className="note" role="status">
              الزمن التقديري لإدخال كامل القائمة إلى الطابور: {estimatedMinutes.toLocaleString("ar-SA")} دقيقة بسرعة {rate.toLocaleString("ar-SA")} رسالة/دقيقة.
            </p>
          )}
          <button
            className="btn primary"
            disabled={
              busy === "create"
              || busy === "upload"
              || busy === "audience-upload"
              || !message.trim()
              || !orderUrl.trim()
              || (mediaCampaign && !mediaUrl.trim())
              || (
                audienceMode === "crm"
                  ? !allCustomers && !city.trim() && !source.trim()
                  : !audienceMembers.length
                    || !audienceConsentConfirmed
                    || audienceConsentEvidence.trim().length < 3
              )
            }
          >
            <Megaphone size={14} aria-hidden="true" /> إنشاء المسودة ومعاينتها
          </button>
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
        {selectedCampaign.media && (
          <div style={{ maxWidth: 520, borderRadius: 12, overflow: "hidden", background: "#111" }}>
            {selectedCampaign.media.type === "video"
              ? <video controls preload="metadata" width={520} height={320} src={selectedCampaign.media.url} style={{ display: "block", width: "100%", maxHeight: 320 }} />
              : <img src={selectedCampaign.media.url} alt={`وسائط ${selectedCampaign.name}`} width={520} height={320} style={{ display: "block", width: "100%", maxHeight: 320, objectFit: "contain" }} />}
          </div>
        )}
        {selectedCampaign.template_vars.offer_text && <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{selectedCampaign.template_vars.offer_text}</p>}
        {selectedCampaign.order_url && (
          <div className="campaign-button-preview">
            <a className="btn primary" href={selectedCampaign.order_url} target="_blank" rel="noreferrer noopener"><ShoppingCart size={14} aria-hidden="true" /> اطلب الآن</a>
            {selectedCampaign.template_name.endsWith("_reminder") ? <>
              <button className="btn muted" type="button" disabled><BellRing size={14} aria-hidden="true" /> ذكّرني بعد أسبوع</button>
              <button className="btn muted" type="button" disabled><Ban size={14} aria-hidden="true" /> إيقاف الرسائل</button>
            </> : <>
              <button className="btn muted" type="button" disabled><SlidersHorizontal size={14} aria-hidden="true" /> غيّر الفلاتر</button>
              <button className="btn muted" type="button" disabled><CalendarPlus size={14} aria-hidden="true" /> احجز موعد</button>
            </>}
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 8 }}>
          <Metric label="الجمهور" value={preview.audience} />
          <Metric label="المؤهل" value={preview.eligible} good />
          <Metric label="تذكيرات أسبوعية" value={selectedCampaign.stats.followups_scheduled} />
          {Object.entries(preview.excluded).map(([reason, count]) => <Metric key={reason} label={REASON_LABEL[reason] || reason} value={count} />)}
        </div>
        <label className="field"><span>موعد التشغيل (اختياري)</span><input className="input" name="campaign_schedule_at" autoComplete="off" type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} /></label>
        <div><button className="btn primary" type="button" onClick={() => launch(selectedCampaign)} disabled={!preview.eligible || !launchReady || busy.startsWith("launch:")}><Play size={14} /> {scheduleAt ? "جدولة" : "تشغيل الآن"}</button></div>
      </div>}

      <div className="card" style={{ padding: 16 }}><h3 style={{ marginTop: 0 }}>الحملات ({campaigns.length})</h3><div style={{ display: "grid", gap: 10 }}>
        {campaigns.map((campaign) => <div key={campaign.id} style={{ border: "1px solid rgba(255,255,255,.1)", borderRadius: 10, padding: 12, display: "grid", gap: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}><strong>{campaign.name}</strong><span>{STATUS_LABEL[campaign.status] || campaign.status}</span></div>
          <small style={{ opacity: 0.7 }}><Clock3 size={12} /> {fmt(campaign.created_at)} · {campaign.media?.type === "video" ? "فيديو" : campaign.media?.type === "image" ? "صورة" : "نص"} · <code>{campaign.template_name}</code> · {campaign.rate_limit_per_minute}/دقيقة</small>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 13 }}><span>بالطابور: {campaign.stats.queued + campaign.stats.processing + campaign.stats.retry}</span><span style={{ color: "#0fbf6c" }}>أُرسلت: {campaign.stats.sent + campaign.stats.delivered + campaign.stats.read}</span><span>قُرئت: {campaign.stats.read}</span><span><BellRing size={13} aria-hidden="true" /> تذكير أسبوعي: {campaign.stats.followups_scheduled}</span><span style={{ color: "#ef4444" }}>فشل/حظر: {campaign.stats.failed + campaign.stats.blocked}</span><span>مستبعد: {campaign.stats.skipped}</span></div>
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
