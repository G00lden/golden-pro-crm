import {
  CalendarClock,
  Check,
  CheckCircle2,
  ClipboardList,
  Copy,
  ExternalLink,
  FileVideo,
  Home,
  ImagePlus,
  MapPin,
  MessageCircleMore,
  Search,
  ShieldCheck,
  Upload,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  actOnPublicMaintenanceRequest,
  confirmPublicMaintenanceVerification,
  createPublicMaintenanceRequest,
  customerPortalUrl,
  getPublicMaintenanceAvailability,
  getPublicMaintenanceProducts,
  getPublicMaintenanceRequest,
  requestPublicMaintenanceVerification,
  uploadPublicMaintenanceAttachment,
  type MaintenanceAttachment,
  type MaintenanceAvailability,
  type MaintenanceProduct,
  type PublicMaintenanceRequest,
} from "../maintenanceRequestsApi";
import { maintenanceRequestStatusLabel, maintenanceRequestStatusTone } from "../../shared/maintenanceRequest";
import "./MaintenanceRequests.css";

const dateFormatter = new Intl.DateTimeFormat("ar-SA-u-ca-gregory", { dateStyle: "medium", timeStyle: "short" });
const dayFormatter = new Intl.DateTimeFormat("ar-SA-u-ca-gregory", { weekday: "long", day: "numeric", month: "short" });

function eventDate(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : dateFormatter.format(date);
}

function initialToken() {
  return new URL(window.location.href).searchParams.get("token") || "";
}

function Brand() {
  return (
    <a className="maintenance-portal__brand" href={customerPortalUrl()} aria-label="مركز صيانة BreeXe Pro">
      <img src="/brand/icon-256.png" width="52" height="52" alt="" />
      <span><strong translate="no">BreeXe Pro</strong><small>تابعة للمجموعة الذهبية المتحدة</small></span>
    </a>
  );
}

export default function CustomerMaintenancePortal() {
  const [token, setToken] = useState(initialToken);
  const [request, setRequest] = useState<PublicMaintenanceRequest | null>(null);
  const [loading, setLoading] = useState(Boolean(token));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [actionMode, setActionMode] = useState<"" | "reschedule" | "cancel">("");
  const [availability, setAvailability] = useState<MaintenanceAvailability | null>(null);
  const [selectedDate, setSelectedDate] = useState("");
  const [selectedTime, setSelectedTime] = useState("");
  const [phone, setPhone] = useState("");
  const [verificationId, setVerificationId] = useState("");
  const [verificationToken, setVerificationToken] = useState("");
  const [otp, setOtp] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [productQuery, setProductQuery] = useState("");
  const [products, setProducts] = useState<MaintenanceProduct[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<MaintenanceProduct | null>(null);
  const [attachments, setAttachments] = useState<MaintenanceAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [location, setLocation] = useState<{ latitude: number; longitude: number; accuracy: number } | null>(null);
  const clientRequestId = useRef(crypto.randomUUID());

  useEffect(() => {
    if (!token) return;
    let active = true;
    setLoading(true);
    getPublicMaintenanceRequest(token)
      .then((result) => { if (active) setRequest(result.request); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "تعذر فتح رابط الطلب."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token]);

  useEffect(() => {
    if (token) return;
    getPublicMaintenanceAvailability().then(setAvailability).catch((reason) => setError(reason instanceof Error ? reason.message : "تعذر تحميل المواعيد."));
  }, [token]);

  useEffect(() => {
    if (token) return;
    const timer = window.setTimeout(() => {
      getPublicMaintenanceProducts(productQuery).then((result) => setProducts(result.data)).catch(() => setProducts([]));
    }, productQuery ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [productQuery, token]);

  const canCustomerChange = request && ["new", "approved", "scheduled"].includes(request.status);
  const scheduleText = useMemo(() => {
    if (!request?.scheduled_date) return request?.preferred_date
      ? `${request.preferred_date}${request.preferred_time ? ` · ${request.preferred_time}` : ""} (مطلوب)`
      : "لم يُحدد الموعد بعد";
    return `${request.scheduled_date}${request.scheduled_time ? ` · ${request.scheduled_time}` : ""}`;
  }, [request]);

  const sendOtp = async () => {
    setVerifying(true); setError(""); setNotice("");
    try {
      const result = await requestPublicMaintenanceVerification(phone);
      setVerificationId(result.verification_id);
      setVerificationToken("");
      setOtp("");
      setNotice(`أرسلنا رمز التحقق عبر واتساب إلى الرقم المنتهي بـ ${result.phone_hint}.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر إرسال رمز التحقق.");
    } finally { setVerifying(false); }
  };

  const confirmOtp = async () => {
    setVerifying(true); setError(""); setNotice("");
    try {
      const result = await confirmPublicMaintenanceVerification(verificationId, phone, otp);
      setVerificationToken(result.verification_token);
      setNotice("تم تأكيد رقم واتساب بنجاح.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "رمز التحقق غير صحيح.");
    } finally { setVerifying(false); }
  };

  const uploadFiles = async (files: FileList | null) => {
    if (!files?.length || !verificationToken) return;
    setUploading(true); setError("");
    try {
      const next: MaintenanceAttachment[] = [];
      for (const file of Array.from(files).slice(0, 5 - attachments.length)) {
        next.push(await uploadPublicMaintenanceAttachment(file, verificationId, verificationToken));
      }
      setAttachments((current) => [...current, ...next]);
      setNotice("تم حفظ المرفقات بأمان مع طلبك.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر رفع المرفق.");
    } finally { setUploading(false); }
  };

  const captureLocation = () => {
    if (!navigator.geolocation) { setError("المتصفح لا يدعم تحديد الموقع. أضف رابط الموقع بدلاً منه."); return; }
    setError("");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocation({ latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy });
        setNotice("تم تسجيل موقع الصيانة.");
      },
      () => setError("تعذر الوصول إلى الموقع. اسمح بالوصول أو أضف رابط الموقع."),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    );
  };

  const submitRequest = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (!verificationToken) { setError("أكد رقم واتساب أولاً."); return; }
    if (!selectedProduct) { setError("اختر منتج BreeXe Pro المطلوب صيانته."); return; }
    if (!selectedDate || !selectedTime) { setError("اختر موعداً متاحاً من الجدول."); return; }
    if (availability?.settings.location_required && !location && !String(data.get("location_url") || "").trim()) {
      setError("سجّل موقع الصيانة أو أضف رابط الموقع."); return;
    }
    setSubmitting(true); setError(""); setNotice("");
    try {
      const result = await createPublicMaintenanceRequest({
        client_request_id: clientRequestId.current,
        customer_name: String(data.get("customer_name") || ""),
        customer_phone: phone,
        city: String(data.get("city") || ""),
        address: String(data.get("address") || ""),
        product_id: selectedProduct.id,
        issue_description: String(data.get("issue_description") || ""),
        warranty_status: String(data.get("warranty_status") || "unknown") as "yes" | "no" | "unknown",
        invoice_number: String(data.get("invoice_number") || ""),
        preferred_date: selectedDate,
        preferred_time: selectedTime,
        customer_latitude: location?.latitude,
        customer_longitude: location?.longitude,
        location_accuracy: location?.accuracy,
        location_url: String(data.get("location_url") || "") || undefined,
        verification_id: verificationId,
        verification_token: verificationToken,
        attachment_ids: attachments.map((item) => item.id),
        accept_terms: true,
        website: String(data.get("website") || ""),
      });
      window.history.replaceState({}, "", customerPortalUrl(result.portal_token));
      setRequest(result.request); setToken(result.portal_token);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر إرسال الطلب. راجع البيانات ثم حاول مرة أخرى.");
    } finally { setSubmitting(false); }
  };

  const submitAction = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token || !actionMode) return;
    const data = new FormData(event.currentTarget);
    setSubmitting(true); setError("");
    try {
      const result = actionMode === "cancel"
        ? await actOnPublicMaintenanceRequest({ token, action: "cancel", reason: String(data.get("reason") || "") })
        : await actOnPublicMaintenanceRequest({ token, action: "request_reschedule", preferred_date: selectedDate, preferred_time: selectedTime, note: String(data.get("note") || "") });
      setRequest(result.request); setActionMode("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "تعذر تحديث الطلب."); }
    finally { setSubmitting(false); }
  };

  const copyLink = async () => { await navigator.clipboard.writeText(customerPortalUrl(token)); setNotice("تم نسخ رابط المتابعة."); };

  return (
    <div className="maintenance-portal" dir="rtl">
      <a className="skip-link" href="#maintenance-portal-main">انتقل إلى المحتوى</a>
      <header className="maintenance-portal__header">
        <Brand />
        <a className="maintenance-portal__home" href={window.location.origin}><Home size={17} aria-hidden="true" /> دخول الموظفين</a>
      </header>

      <main id="maintenance-portal-main" className="maintenance-portal__main" tabIndex={-1}>
        <div className="maintenance-portal__announcer" aria-live="polite">{notice}</div>
        {error && <div className="maintenance-portal__error" role="alert">{error}</div>}

        {loading ? (
          <section className="maintenance-portal__state" role="status"><span className="maintenance-portal__spinner" aria-hidden="true" /><h1>جاري تحميل طلبك</h1></section>
        ) : token && request ? (
          <section className="maintenance-portal__tracking" aria-labelledby="request-title">
            <div className="maintenance-portal__hero maintenance-portal__hero--tracking">
              <span className="maintenance-portal__eyebrow">ملف صيانة {request.customer_name}</span>
              <h1 id="request-title">طلب <bdi>{request.request_number}</bdi></h1>
              <p>تابع حالة الصيانة والفني والموعد من صفحتك الخاصة.</p>
              <div className="maintenance-portal__hero-actions">
                <span className={`maintenance-status maintenance-status--${maintenanceRequestStatusTone(request.status)}`}>{maintenanceRequestStatusLabel(request.status)}</span>
                <button className="maintenance-link-button" type="button" onClick={copyLink}><Copy size={17} /> نسخ رابط المتابعة</button>
              </div>
            </div>
            <div className="maintenance-portal__summary">
              <article className="maintenance-product-summary">
                {request.product_image_url && <img src={request.product_image_url} width="64" height="64" alt="" loading="lazy" />}
                <span>منتج BreeXe Pro</span><strong>{request.product_name}</strong><small>{request.product_category}</small>
              </article>
              <article><span>الموعد</span><strong><bdi>{scheduleText}</bdi></strong></article>
              <article><span>الفني</span><strong>{request.technician_name || "سيظهر بعد إسناد الطلب"}</strong></article>
              <article><span>بيانات الطلب</span><strong>{request.phone_verified ? "رقم واتساب مؤكد" : "قيد التحقق"}</strong><small>{request.attachment_count || 0} مرفقات</small></article>
            </div>
            {request.location_url && <a className="maintenance-map-link" href={request.location_url} target="_blank" rel="noreferrer"><MapPin size={18} /> فتح موقع الصيانة <ExternalLink size={15} /></a>}
            <section className="maintenance-portal__card" aria-labelledby="timeline-title">
              <div className="maintenance-portal__section-title"><ClipboardList size={20} /><h2 id="timeline-title">سجل الطلب</h2></div>
              <ol className="maintenance-timeline">
                {request.events.map((item, index) => <li key={`${item.action}-${item.created_at}-${index}`}><span><CheckCircle2 size={18} /></span><div><strong>{item.to_status ? maintenanceRequestStatusLabel(item.to_status) : "تحديث"}</strong>{item.message && <p>{item.message}</p>}<time dateTime={item.created_at}>{eventDate(item.created_at)}</time></div></li>)}
              </ol>
            </section>
            {canCustomerChange && <section className="maintenance-portal__card" aria-labelledby="change-title">
              <div className="maintenance-portal__section-title"><CalendarClock size={20} /><h2 id="change-title">تعديل الطلب</h2></div>
              {!actionMode ? <div className="maintenance-portal__actions"><button className="maintenance-link-button" type="button" onClick={async () => { setActionMode("reschedule"); setAvailability(await getPublicMaintenanceAvailability()); }}>طلب تغيير الموعد</button><button className="maintenance-link-button maintenance-link-button--danger" type="button" onClick={() => setActionMode("cancel")}>إلغاء الطلب</button></div> :
                <form className="maintenance-portal__action-form" onSubmit={submitAction}>
                  {actionMode === "reschedule" ? <><SlotPicker availability={availability} date={selectedDate} time={selectedTime} onSelect={(date, time) => { setSelectedDate(date); setSelectedTime(time); }} /><label className="maintenance-portal__full">ملاحظة<textarea name="note" rows={3} maxLength={1000} /></label></> : <label className="maintenance-portal__full">سبب الإلغاء<textarea name="reason" rows={3} minLength={3} maxLength={1000} required /></label>}
                  <div className="maintenance-portal__actions maintenance-portal__full"><button className="maintenance-submit" type="submit" disabled={submitting || (actionMode === "reschedule" && (!selectedDate || !selectedTime))}>تأكيد</button><button className="maintenance-link-button" type="button" onClick={() => setActionMode("")}>رجوع</button></div>
                </form>}
            </section>}
          </section>
        ) : token ? (
          <section className="maintenance-portal__state"><XCircle size={36} /><h1>تعذر فتح الطلب</h1><a className="maintenance-submit" href={customerPortalUrl()}>إنشاء طلب جديد</a></section>
        ) : (
          <section className="maintenance-portal__intake" aria-labelledby="intake-title">
            <div className="maintenance-portal__hero maintenance-portal__hero--branded">
              <span className="maintenance-portal__eyebrow">مركز صيانة BreeXe Pro</span>
              <h1 id="intake-title">صيانة منتجك، بموعد واضح ومتابعة كاملة</h1>
              <p>اختر منتجك الفعلي، وثّق المشكلة، وحدد موعداً متاحاً من جدول فريق الصيانة.</p>
              <div className="maintenance-portal__trust-grid"><span><MessageCircleMore /> تحقق عبر واتساب</span><span><CalendarClock /> مواعيد متاحة فعلياً</span><span><ShieldCheck /> ملف متابعة خاص</span></div>
            </div>

            <form className="maintenance-portal__form maintenance-portal__form--steps" onSubmit={submitRequest}>
              <fieldset className="maintenance-portal__card maintenance-step">
                <legend><span>1</span> تأكيد هويتك</legend>
                <div className="maintenance-step__intro"><MessageCircleMore aria-hidden="true" /><div><strong>تأكد من رقمك على واتساب</strong><p>سنرسل رمزاً من 6 أرقام لحماية طلبك وربطه برقمك.</p></div></div>
                <label>الاسم الكامل<input name="customer_name" autoComplete="name" minLength={2} maxLength={200} required placeholder="مثال: محمد أحمد" /></label>
                <label>رقم الجوال واتساب<input value={phone} onChange={(event) => { setPhone(event.target.value); setVerificationToken(""); setVerificationId(""); }} type="tel" inputMode="tel" autoComplete="tel" minLength={7} maxLength={30} required placeholder="05xxxxxxxx" /></label>
                <div className="maintenance-verify-row maintenance-portal__full">
                  <button className="maintenance-link-button" type="button" onClick={sendOtp} disabled={verifying || phone.length < 7}>{verifying ? "جاري الإرسال" : verificationId ? "إعادة إرسال الرمز" : "إرسال رمز واتساب"}</button>
                  {verificationId && !verificationToken && <><label htmlFor="maintenance-otp">رمز التحقق</label><input id="maintenance-otp" value={otp} onChange={(event) => setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" spellCheck={false} maxLength={6} placeholder="000000" /><button className="maintenance-submit maintenance-submit--compact" type="button" onClick={confirmOtp} disabled={verifying || otp.length !== 6}>تأكيد الرمز</button></>}
                  {verificationToken && <span className="maintenance-verified"><Check /> تم تأكيد رقم واتساب</span>}
                </div>
              </fieldset>

              <fieldset className="maintenance-portal__card maintenance-step" disabled={!verificationToken}>
                <legend><span>2</span> المنتج والمشكلة</legend>
                <label className="maintenance-portal__full">ابحث في منتجات BreeXe Pro<div className="maintenance-product-search"><Search size={18} /><input value={productQuery} onChange={(event) => setProductQuery(event.target.value)} type="search" autoComplete="off" placeholder="اسم المنتج أو التصنيف" /></div></label>
                <div className="maintenance-products maintenance-portal__full" role="listbox" aria-label="نتائج المنتجات">
                  {products.map((product) => <button key={product.id} type="button" role="option" aria-selected={selectedProduct?.id === product.id} className={selectedProduct?.id === product.id ? "maintenance-product active" : "maintenance-product"} onClick={() => setSelectedProduct(product)}>
                    {product.image_url ? <img src={product.image_url} width="72" height="72" alt="" loading="lazy" /> : <span className="maintenance-product__placeholder">BX</span>}
                    <span><strong>{product.name}</strong><small>{product.category || product.sku || "منتج BreeXe Pro"}</small></span>{selectedProduct?.id === product.id && <CheckCircle2 />}
                  </button>)}
                </div>
                <label className="maintenance-portal__full">وصف المشكلة<textarea name="issue_description" rows={5} minLength={10} maxLength={4000} required placeholder="متى بدأت المشكلة؟ وما الأعراض الظاهرة؟" /></label>
                <label>حالة الضمان<select name="warranty_status" defaultValue="unknown"><option value="unknown">غير متأكد</option><option value="yes">داخل الضمان</option><option value="no">خارج الضمان</option></select></label>
                <label>رقم الفاتورة<input name="invoice_number" autoComplete="off" maxLength={120} placeholder="اختياري" /></label>
                {availability?.settings.attachments_enabled && <div className="maintenance-upload maintenance-portal__full">
                  <label htmlFor="maintenance-files"><Upload /> إرفاق صورة أو مقطع للمشكلة<input id="maintenance-files" type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime" multiple onChange={(event) => uploadFiles(event.target.files)} disabled={uploading || attachments.length >= 5} /></label>
                  <small>حتى 5 ملفات، بينها مقطع واحد. الصور 8MB والمقطع 25MB كحد أقصى.</small>
                  <div className="maintenance-upload__files">{attachments.map((item) => <span key={item.id}>{item.kind === "video" ? <FileVideo /> : <ImagePlus />} {item.kind === "video" ? "مقطع" : "صورة"} · {(item.byte_size / 1024 / 1024).toFixed(1)}MB</span>)}</div>
                </div>}
              </fieldset>

              <fieldset className="maintenance-portal__card maintenance-step" disabled={!verificationToken || !selectedProduct}>
                <legend><span>3</span> الموعد والموقع</legend>
                <SlotPicker availability={availability} date={selectedDate} time={selectedTime} onSelect={(date, time) => { setSelectedDate(date); setSelectedTime(time); }} />
                <label>المدينة<input name="city" autoComplete="address-level2" maxLength={160} required placeholder="مثال: الرياض" /></label>
                <label className="maintenance-portal__full">عنوان موقع الصيانة<input name="address" autoComplete="street-address" minLength={5} maxLength={1000} required placeholder="الحي، الشارع، رقم المبنى" /></label>
                <div className="maintenance-location maintenance-portal__full"><button className="maintenance-link-button" type="button" onClick={captureLocation}><MapPin /> {location ? "تحديث الموقع" : "تسجيل موقعي الحالي"}</button>{location && <span className="maintenance-verified"><Check /> تم تسجيل الموقع بدقة {Math.round(location.accuracy)}م</span>}</div>
                <label className="maintenance-portal__full">أو رابط الموقع<input name="location_url" type="url" inputMode="url" autoComplete="url" placeholder="https://maps.google.com/..." /></label>
                <label className="maintenance-portal__checkbox maintenance-portal__full"><input name="accept_terms" type="checkbox" required /><span>أوافق على استخدام بياناتي وموقعي ومرفقاتي لإدارة طلب الصيانة والتواصل بشأنه فقط.</span></label>
                <label className="maintenance-portal__honeypot" aria-hidden="true">الموقع<input name="website" tabIndex={-1} autoComplete="off" /></label>
                <div className="maintenance-portal__full"><button className="maintenance-submit maintenance-submit--wide" type="submit" disabled={submitting || !selectedDate || !selectedTime}>{submitting ? "جاري تثبيت الطلب" : "تأكيد طلب الصيانة"}</button></div>
              </fieldset>
            </form>
          </section>
        )}
      </main>
    </div>
  );
}

function SlotPicker({ availability, date, time, onSelect }: { availability: MaintenanceAvailability | null; date: string; time: string; onSelect: (date: string, time: string) => void }) {
  if (!availability) return <div className="maintenance-slots maintenance-portal__full" role="status">جاري تحميل المواعيد المتاحة</div>;
  if (!availability.ready) return <div className="maintenance-portal__warning maintenance-portal__full" role="status">لا توجد مواعيد متاحة حالياً. يرجى المحاولة لاحقاً.</div>;
  const selected = availability.dates.find((item) => item.date === date);
  return <div className="maintenance-slots maintenance-portal__full"><h3>اختر اليوم المتاح</h3><div className="maintenance-slot-days">{availability.dates.map((item) => <button key={item.date} type="button" className={date === item.date ? "active" : ""} onClick={() => onSelect(item.date, "")}><span>{dayFormatter.format(new Date(`${item.date}T12:00:00+03:00`))}</span><small>{item.slots.length} أوقات</small></button>)}</div>{selected && <><h3>اختر الوقت</h3><div className="maintenance-slot-times">{selected.slots.map((slot) => <button key={slot.time} type="button" className={time === slot.time ? "active" : ""} onClick={() => onSelect(date, slot.time)}><bdi>{slot.time}</bdi>{time === slot.time && <Check size={16} />}</button>)}</div></>}</div>;
}
