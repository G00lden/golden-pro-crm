import { ExternalLink, RefreshCcw, Save, Plus, LogOut, Smartphone, X } from "lucide-react";
import { useState, useEffect, type FormEvent } from "react";
import * as api from "../api";
import {
  Badge,
  Button,
  Empty,
  ErrorBlock,
  Field,
  Loading,
  PageHeader,
  TextArea,
  TextInput,
  fmtDate,
  useData,
} from "../shared";
import { normalizeSallaStoreUrl } from "../sallaStoreUrl";

export default function SettingsPage({ notify }: { notify: (message: string, ok?: boolean) => void }) {
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
  const storeUrl = normalizeSallaStoreUrl(salla.data?.store_url);

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
            <fieldset className="form-fieldset">
              <legend>بيانات الفاتورة الضريبية (ZATCA)</legend>
              <div className="form-grid">
                <Field label="اسم البائع (الجهة المصدرة)">
                  <TextInput value={values.seller_name || ""} onChange={(e) => setValues({ ...values, seller_name: e.target.value })} placeholder="Breexe Pro Co." />
                </Field>
                <Field label="الرقم الضريبي (VAT)">
                  <TextInput value={values.seller_vat_number || ""} onChange={(e) => setValues({ ...values, seller_vat_number: e.target.value.replace(/\D/g, '').slice(0, 15) })} placeholder="15 رقم" />
                </Field>
              </div>
              <div className="form-grid">
                <Field label="عنوان البائع">
                  <TextInput value={values.seller_address || ""} onChange={(e) => setValues({ ...values, seller_address: e.target.value })} placeholder="شركة بريكس برو شخص واحد ذات مسؤولية محدودة - الرياض" />
                </Field>
              </div>
            </fieldset>
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
                {storeUrl ? (
                  <a
                    className="btn muted store-link"
                    href={storeUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLink size={16} aria-hidden="true" focusable="false" />
                    فتح صفحة المتجر
                  </a>
                ) : (
                  <p className="store-link-empty">
                    {salla.data?.linked
                      ? "لم يصل رابط المتجر من سلة بعد. حدّث حالة الربط، وإن استمر غيابه فأعد تثبيت التطبيق من لوحة سلة."
                      : "اربط متجر سلة أولاً، ثم حدّث الحالة ليظهر رابط فتح المتجر هنا."}
                  </p>
                )}
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
