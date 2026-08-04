import { CalendarClock, CheckCircle2, ClipboardList, Copy, Home, ShieldCheck, Wrench, XCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  actOnPublicMaintenanceRequest,
  createPublicMaintenanceRequest,
  customerPortalUrl,
  getPublicMaintenanceRequest,
  type PublicMaintenanceRequest,
} from "../maintenanceRequestsApi";
import {
  maintenanceRequestStatusLabel,
  maintenanceRequestStatusTone,
} from "../../shared/maintenanceRequest";
import "./MaintenanceRequests.css";

const dateFormatter = new Intl.DateTimeFormat("ar-SA-u-ca-gregory", { dateStyle: "medium", timeStyle: "short" });

function eventDate(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : dateFormatter.format(date);
}

function initialToken() {
  return new URL(window.location.href).searchParams.get("token") || "";
}

export default function CustomerMaintenancePortal() {
  const [token, setToken] = useState(initialToken);
  const [request, setRequest] = useState<PublicMaintenanceRequest | null>(null);
  const [loading, setLoading] = useState(Boolean(token));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [actionMode, setActionMode] = useState<"" | "reschedule" | "cancel">("");
  const clientRequestId = useRef(crypto.randomUUID());

  useEffect(() => {
    if (!token) return;
    let active = true;
    setLoading(true);
    setError("");
    getPublicMaintenanceRequest(token)
      .then((result) => {
        if (active) setRequest(result.request);
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : "تعذر فتح رابط الطلب.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [token]);

  const canCustomerChange = request && ["new", "approved", "scheduled"].includes(request.status);
  const scheduleText = useMemo(() => {
    if (!request?.scheduled_date) return "لم يُحدد الموعد بعد";
    return `${request.scheduled_date}${request.scheduled_time ? ` · ${request.scheduled_time}` : ""}`;
  }, [request?.scheduled_date, request?.scheduled_time]);

  const submitRequest = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setSubmitting(true);
    setError("");
    try {
      const result = await createPublicMaintenanceRequest({
        client_request_id: clientRequestId.current,
        customer_name: String(data.get("customer_name") || ""),
        customer_phone: String(data.get("customer_phone") || ""),
        city: String(data.get("city") || ""),
        address: String(data.get("address") || ""),
        service_type: String(data.get("service_type") || "general"),
        product_name: String(data.get("product_name") || ""),
        issue_description: String(data.get("issue_description") || ""),
        warranty_status: String(data.get("warranty_status") || "unknown") as "yes" | "no" | "unknown",
        invoice_number: String(data.get("invoice_number") || ""),
        preferred_date: String(data.get("preferred_date") || "") || undefined,
        preferred_time: String(data.get("preferred_time") || "") || undefined,
        accept_terms: true,
        website: String(data.get("website") || ""),
      });
      const nextUrl = customerPortalUrl(result.portal_token);
      window.history.replaceState({}, "", nextUrl);
      setRequest(result.request);
      setToken(result.portal_token);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر إرسال الطلب. راجع البيانات ثم حاول مرة أخرى.");
    } finally {
      setSubmitting(false);
    }
  };

  const submitAction = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token || !actionMode) return;
    const data = new FormData(event.currentTarget);
    setSubmitting(true);
    setError("");
    try {
      const result = actionMode === "cancel"
        ? await actOnPublicMaintenanceRequest({
            token,
            action: "cancel",
            reason: String(data.get("reason") || ""),
          })
        : await actOnPublicMaintenanceRequest({
            token,
            action: "request_reschedule",
            preferred_date: String(data.get("preferred_date") || ""),
            preferred_time: String(data.get("preferred_time") || "") || undefined,
            note: String(data.get("note") || ""),
          });
      setRequest(result.request);
      setActionMode("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر تحديث الطلب.");
    } finally {
      setSubmitting(false);
    }
  };

  const copyLink = async () => {
    await navigator.clipboard.writeText(customerPortalUrl(token));
  };

  return (
    <div className="maintenance-portal" dir="rtl">
      <a className="skip-link" href="#maintenance-portal-main">انتقل إلى المحتوى</a>
      <header className="maintenance-portal__header">
        <a className="maintenance-portal__brand" href={customerPortalUrl()} aria-label="صفحة طلب صيانة جديد">
          <span><Wrench aria-hidden="true" size={22} /></span>
          <strong>BreeXe Pro</strong>
        </a>
        <a className="maintenance-portal__home" href={window.location.origin}>
          <Home size={17} aria-hidden="true" /> دخول الموظفين
        </a>
      </header>

      <main id="maintenance-portal-main" className="maintenance-portal__main" tabIndex={-1}>
        {error && <div className="maintenance-portal__error" role="alert">{error}</div>}

        {loading ? (
          <section className="maintenance-portal__state" role="status" aria-live="polite">
            <span className="maintenance-portal__spinner" aria-hidden="true" />
            <h1>جاري تحميل طلبك…</h1>
          </section>
        ) : token && request ? (
          <section className="maintenance-portal__tracking" aria-labelledby="request-title">
            <div className="maintenance-portal__hero">
              <span className="maintenance-portal__eyebrow">متابعة طلب الصيانة</span>
              <h1 id="request-title">طلب رقم <bdi>{request.request_number}</bdi></h1>
              <p>احتفظ بهذا الرابط؛ يمكنك العودة إليه في أي وقت لمعرفة الموعد وحالة التنفيذ.</p>
              <div className="maintenance-portal__hero-actions">
                <span className={`maintenance-status maintenance-status--${maintenanceRequestStatusTone(request.status)}`}>
                  {maintenanceRequestStatusLabel(request.status)}
                </span>
                <button className="maintenance-link-button" type="button" onClick={copyLink}>
                  <Copy size={17} aria-hidden="true" /> نسخ رابط المتابعة
                </button>
              </div>
            </div>

            <div className="maintenance-portal__summary">
              <article>
                <span>الخدمة</span>
                <strong>{request.product_name}</strong>
              </article>
              <article>
                <span>الموعد</span>
                <strong><bdi>{scheduleText}</bdi></strong>
              </article>
              <article>
                <span>الفني</span>
                <strong>{request.technician_name || "سيُحدد بعد اعتماد الطلب"}</strong>
              </article>
            </div>

            {request.customer_change_requested && (
              <div className="maintenance-portal__notice" role="status">
                استلمنا طلب تغيير الموعد، وسيؤكد فريق الصيانة الموعد الجديد هنا.
              </div>
            )}

            <section className="maintenance-portal__card" aria-labelledby="timeline-title">
              <div className="maintenance-portal__section-title">
                <ClipboardList size={20} aria-hidden="true" />
                <h2 id="timeline-title">سجل الطلب</h2>
              </div>
              <ol className="maintenance-timeline">
                {request.events.map((item, index) => (
                  <li key={`${item.action}-${item.created_at}-${index}`}>
                    <span aria-hidden="true"><CheckCircle2 size={18} /></span>
                    <div>
                      <strong>{item.to_status ? maintenanceRequestStatusLabel(item.to_status) : "تحديث"}</strong>
                      {item.message && <p>{item.message}</p>}
                      <time dateTime={item.created_at}>{eventDate(item.created_at)}</time>
                    </div>
                  </li>
                ))}
              </ol>
            </section>

            {canCustomerChange && (
              <section className="maintenance-portal__card" aria-labelledby="change-title">
                <div className="maintenance-portal__section-title">
                  <CalendarClock size={20} aria-hidden="true" />
                  <h2 id="change-title">تعديل الطلب</h2>
                </div>
                {!actionMode ? (
                  <div className="maintenance-portal__actions">
                    <button className="maintenance-link-button" type="button" onClick={() => setActionMode("reschedule")}>طلب تغيير الموعد</button>
                    <button className="maintenance-link-button maintenance-link-button--danger" type="button" onClick={() => setActionMode("cancel")}>إلغاء الطلب</button>
                  </div>
                ) : (
                  <form className="maintenance-portal__action-form" onSubmit={submitAction}>
                    {actionMode === "reschedule" ? (
                      <>
                        <label>التاريخ المفضل<input name="preferred_date" type="date" required /></label>
                        <label>الوقت المفضل<input name="preferred_time" type="time" /></label>
                        <label className="maintenance-portal__full">ملاحظة<textarea name="note" rows={3} maxLength={1000} placeholder="مثال: أفضل الفترة المسائية…" /></label>
                      </>
                    ) : (
                      <>
                        <div className="maintenance-portal__warning maintenance-portal__full">
                          <XCircle size={19} aria-hidden="true" /> سيُلغى الحجز المرتبط أيضاً إن وُجد.
                        </div>
                        <label className="maintenance-portal__full">سبب الإلغاء<textarea name="reason" rows={3} minLength={3} maxLength={1000} required placeholder="اكتب سبب الإلغاء…" /></label>
                      </>
                    )}
                    <div className="maintenance-portal__actions maintenance-portal__full">
                      <button className={actionMode === "cancel" ? "maintenance-submit maintenance-submit--danger" : "maintenance-submit"} type="submit" disabled={submitting}>
                        {submitting ? "جاري الحفظ…" : actionMode === "cancel" ? "تأكيد إلغاء الطلب" : "إرسال طلب التغيير"}
                      </button>
                      <button className="maintenance-link-button" type="button" onClick={() => setActionMode("")} disabled={submitting}>رجوع</button>
                    </div>
                  </form>
                )}
              </section>
            )}
          </section>
        ) : token ? (
          <section className="maintenance-portal__state">
            <XCircle size={36} aria-hidden="true" />
            <h1>تعذر فتح الطلب</h1>
            <p>تحقق من الرابط أو أنشئ طلب صيانة جديداً.</p>
            <a className="maintenance-submit" href={customerPortalUrl()}>إنشاء طلب جديد</a>
          </section>
        ) : (
          <section className="maintenance-portal__intake" aria-labelledby="intake-title">
            <div className="maintenance-portal__hero">
              <span className="maintenance-portal__eyebrow">خدمة العملاء</span>
              <h1 id="intake-title">اطلب صيانة منزلك في دقائق</h1>
              <p>أرسل تفاصيل العطل، ثم تابع الاعتماد والموعد والفني حتى إغلاق الطلب من رابط واحد.</p>
              <div className="maintenance-portal__trust"><ShieldCheck size={18} aria-hidden="true" /> بياناتك تُستخدم لتنفيذ الطلب والتواصل بشأنه فقط.</div>
            </div>

            <form className="maintenance-portal__form maintenance-portal__card" onSubmit={submitRequest}>
              <label>الاسم الكامل<input name="customer_name" autoComplete="name" minLength={2} maxLength={200} required placeholder="مثال: محمد أحمد…" /></label>
              <label>رقم الجوال<input name="customer_phone" type="tel" inputMode="tel" autoComplete="tel" minLength={7} maxLength={30} required placeholder="مثال: 05xxxxxxxx…" /></label>
              <label>المدينة<input name="city" autoComplete="address-level2" maxLength={160} placeholder="مثال: الرياض…" /></label>
              <label>نوع الخدمة<select name="service_type" defaultValue="air_conditioning">
                <option value="air_conditioning">تكييف وتبريد</option>
                <option value="electrical">كهرباء</option>
                <option value="plumbing">سباكة</option>
                <option value="appliances">أجهزة منزلية</option>
                <option value="general">صيانة عامة</option>
              </select></label>
              <label className="maintenance-portal__full">عنوان موقع الصيانة<input name="address" autoComplete="street-address" minLength={5} maxLength={1000} required placeholder="الحي، الشارع، رقم المبنى…" /></label>
              <label>الجهاز أو الخدمة<input name="product_name" autoComplete="off" minLength={2} maxLength={240} required placeholder="مثال: مكيف سبليت 24 وحدة…" /></label>
              <label>حالة الضمان<select name="warranty_status" defaultValue="unknown">
                <option value="unknown">غير متأكد</option>
                <option value="yes">داخل الضمان</option>
                <option value="no">خارج الضمان</option>
              </select></label>
              <label>رقم الفاتورة<input name="invoice_number" autoComplete="off" maxLength={120} placeholder="اختياري…" /></label>
              <label>التاريخ المفضل<input name="preferred_date" type="date" /></label>
              <label>الوقت المفضل<input name="preferred_time" type="time" /></label>
              <label className="maintenance-portal__full">وصف العطل<textarea name="issue_description" rows={5} minLength={10} maxLength={4000} required placeholder="متى بدأ العطل؟ وما الأعراض الظاهرة؟…" /></label>
              <label className="maintenance-portal__checkbox maintenance-portal__full">
                <input name="accept_terms" type="checkbox" required />
                <span>أوافق على استخدام بياناتي لإدارة طلب الصيانة والتواصل بشأنه.</span>
              </label>
              <label className="maintenance-portal__honeypot" aria-hidden="true">الموقع<input name="website" tabIndex={-1} autoComplete="off" /></label>
              <div className="maintenance-portal__full">
                <button className="maintenance-submit" type="submit" disabled={submitting}>
                  {submitting ? "جاري إرسال الطلب…" : "إرسال طلب الصيانة"}
                </button>
              </div>
            </form>
          </section>
        )}
      </main>
    </div>
  );
}
