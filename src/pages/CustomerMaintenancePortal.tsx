import {
  ArrowLeft,
  ArrowRight,
  CalendarClock,
  Check,
  CheckCircle2,
  ClipboardList,
  Copy,
  ExternalLink,
  FileText,
  FileVideo,
  ImagePlus,
  MapPin,
  MessageCircleMore,
  PackageCheck,
  RefreshCw,
  Search,
  ShieldCheck,
  Upload,
  Wrench,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  actOnPublicMaintenanceRequest,
  confirmPublicMaintenanceVerification,
  createPublicMaintenanceRequest,
  customerPortalUrl,
  getPublicMaintenanceAvailability,
  getPublicMaintenanceKits,
  getPublicMaintenanceProducts,
  getPublicMaintenanceRequest,
  requestPublicMaintenanceVerification,
  uploadPublicMaintenanceAttachment,
  type MaintenanceAttachment,
  type MaintenanceAvailability,
  type MaintenanceKitOption,
  type MaintenanceProduct,
  type PublicMaintenanceRequest,
} from "../maintenanceRequestsApi";
import { maintenanceRequestStatusLabel, maintenanceRequestStatusTone } from "../../shared/maintenanceRequest";
import { formatMaintenanceTime } from "../../shared/maintenanceTime";
import "./MaintenanceRequests.css";

const dateFormatter = new Intl.DateTimeFormat("ar-SA-u-ca-gregory", { dateStyle: "medium", timeStyle: "short" });
const dayFormatter = new Intl.DateTimeFormat("ar-SA-u-ca-gregory", { weekday: "long", day: "numeric", month: "short" });
const GEOLOCATION_PERMISSION_DENIED = 1;
const GEOLOCATION_POSITION_UNAVAILABLE = 2;
const GEOLOCATION_TIMEOUT = 3;
const wizardSteps = [
  { number: 1, label: "نوع الصيانة" },
  { number: 2, label: "تأكيد واتساب" },
  { number: 3, label: "الجهاز والمرفقات" },
  { number: 4, label: "الموعد والموقع" },
] as const;
type WizardStep = (typeof wizardSteps)[number]["number"];

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
  const [requestType, setRequestType] = useState<"repair" | "periodic" | "">("");
  const [products, setProducts] = useState<MaintenanceProduct[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<MaintenanceProduct | null>(null);
  const [maintenanceKits, setMaintenanceKits] = useState<MaintenanceKitOption[]>([]);
  const [selectedKit, setSelectedKit] = useState<MaintenanceKitOption | null>(null);
  const [kitsLoading, setKitsLoading] = useState(false);
  const [attachments, setAttachments] = useState<MaintenanceAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [location, setLocation] = useState<{ latitude: number; longitude: number; accuracy: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const clientRequestId = useRef(crypto.randomUUID());
  const formRef = useRef<HTMLFormElement>(null);
  const [currentStep, setCurrentStep] = useState<WizardStep>(1);

  const showStep = (step: WizardStep) => {
    setError("");
    setCurrentStep(step);
  };

  useEffect(() => {
    if (token) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(`maintenance-step-${currentStep}`)?.focus({ preventScroll: false });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [currentStep, token]);

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
    if (token || !requestType) return;
    const timer = window.setTimeout(() => {
      getPublicMaintenanceProducts(productQuery, requestType).then((result) => setProducts(result.data)).catch(() => setProducts([]));
    }, productQuery ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [productQuery, requestType, token]);

  useEffect(() => {
    if (requestType !== "periodic" || !selectedProduct) {
      setMaintenanceKits([]);
      setSelectedKit(null);
      return;
    }
    let active = true;
    setKitsLoading(true);
    setSelectedKit(null);
    getPublicMaintenanceKits(selectedProduct.id)
      .then((result) => { if (active) setMaintenanceKits(result.data); })
      .catch((reason) => { if (active) { setMaintenanceKits([]); setError(reason instanceof Error ? reason.message : "تعذر تحميل أطقم الصيانة المتوافقة."); } })
      .finally(() => { if (active) setKitsLoading(false); });
    return () => { active = false; };
  }, [requestType, selectedProduct]);

  const canCustomerChange = request && ["new", "approved", "scheduled"].includes(request.status);
  const scheduleText = useMemo(() => {
    if (!request?.scheduled_date) return request?.preferred_date
      ? `${request.preferred_date}${request.preferred_time ? ` · ${formatMaintenanceTime(request.preferred_time)}` : ""} (مطلوب)`
      : "لم يُحدد الموعد بعد";
    return `${request.scheduled_date}${request.scheduled_time ? ` · ${formatMaintenanceTime(request.scheduled_time)}` : ""}`;
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

  const captureLocation = async () => {
    if (!window.isSecureContext) { setError("تحديد الموقع يحتاج اتصالاً آمناً. افتح الصفحة عبر HTTPS أو أضف رابط الموقع."); return; }
    if (!navigator.geolocation) { setError("المتصفح لا يدعم تحديد الموقع. أضف رابط Google Maps بدلاً منه."); return; }
    const locate = (options: PositionOptions) => new Promise<GeolocationPosition>((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, options);
    });
    setLocating(true);
    setError("");
    setNotice("");
    try {
      let position: GeolocationPosition;
      try {
        position = await locate({ enableHighAccuracy: true, timeout: 12_000, maximumAge: 60_000 });
      } catch (reason) {
        const code = Number((reason as GeolocationPositionError)?.code || 0);
        if (code === GEOLOCATION_PERMISSION_DENIED) throw reason;
        position = await locate({ enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 });
      }
      const nextLocation = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy,
      };
      if (![nextLocation.latitude, nextLocation.longitude, nextLocation.accuracy].every(Number.isFinite)) {
        throw new Error("invalid_geolocation");
      }
      setLocation(nextLocation);
      setNotice("تم تسجيل موقع الصيانة. راجع الموقع المسجّل قبل إرسال الطلب.");
    } catch (reason) {
      const code = Number((reason as GeolocationPositionError)?.code || 0);
      if (code === GEOLOCATION_PERMISSION_DENIED) {
        setError("صلاحية الموقع مرفوضة. اسمح للموقع من إعدادات المتصفح ثم حاول مجدداً، أو أضف رابط Google Maps.");
      } else if (code === GEOLOCATION_POSITION_UNAVAILABLE) {
        setError("تعذر تحديد موقع الجهاز. فعّل GPS والإنترنت ثم حاول مجدداً، أو أضف رابط Google Maps.");
      } else if (code === GEOLOCATION_TIMEOUT) {
        setError("استغرق تحديد الموقع وقتاً طويلاً. انتقل لمكان مفتوح وحاول مجدداً، أو أضف رابط Google Maps.");
      } else {
        setError("تعذر تسجيل الموقع. حاول مجدداً أو أضف رابط Google Maps.");
      }
    } finally {
      setLocating(false);
    }
  };

  const locationMapUrl = location
    ? `https://www.google.com/maps?q=${encodeURIComponent(`${location.latitude},${location.longitude}`)}`
    : "";

  const continueFromServiceType = () => {
    if (!requestType) {
      setError("اختر صيانة عطل أو صيانة دورية للمتابعة.");
      return;
    }
    showStep(2);
  };

  const continueFromIdentity = () => {
    const form = formRef.current;
    const customerName = form?.elements.namedItem("customer_name") as HTMLInputElement | null;
    const customerPhone = form?.elements.namedItem("customer_phone") as HTMLInputElement | null;
    if (!customerName?.reportValidity() || !customerPhone?.reportValidity()) {
      setError("أكمل الاسم ورقم الجوال الصحيح أولاً.");
      return;
    }
    if (!verificationToken) {
      setError("أرسل رمز واتساب ثم أدخل الرمز لتأكيد الرقم.");
      return;
    }
    showStep(3);
  };

  const continueFromDevice = () => {
    if (!selectedProduct) {
      setError("اختر جهاز BreeXe Pro المطلوب صيانته.");
      return;
    }
    if (requestType === "periodic" && !selectedKit) {
      setError("اختر طقم الصيانة المتوافق مع جهازك.");
      return;
    }
    const issueDescription = formRef.current?.elements.namedItem("issue_description") as HTMLTextAreaElement | null;
    if (!issueDescription?.reportValidity()) {
      setError("أكمل وصف العطل قبل اختيار الموعد.");
      return;
    }
    showStep(4);
  };

  const submitRequest = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (!requestType) { setCurrentStep(1); setError("اختر صيانة عطل أو صيانة دورية."); return; }
    if (!verificationToken) { setCurrentStep(2); setError("أكد رقم واتساب أولاً."); return; }
    if (!selectedProduct) { setCurrentStep(3); setError("اختر منتج BreeXe Pro المطلوب صيانته."); return; }
    if (requestType === "periodic" && !selectedKit) { setCurrentStep(3); setError("اختر طقم الصيانة الدوري المتوافق مع جهازك."); return; }
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
        request_type: requestType,
        product_id: selectedProduct.id,
        maintenance_kit_id: selectedKit?.id,
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
              <article><span>نوع الصيانة</span><strong>{request.request_type === "periodic" ? "صيانة دورية" : "صيانة عطل"}</strong><small>{request.maintenance_kind === "cooling_cells" ? "تغيير خلايا تبريد" : request.maintenance_kind === "filter_change" ? "تغيير فلاتر" : "فحص وإصلاح"}</small></article>
              {request.maintenance_kit_name && <article><span>الطقم المعتمد</span><strong>{request.maintenance_kit_name}</strong><small>{request.maintenance_kit_category}</small></article>}
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
              <h1 id="intake-title">صيانة عطل أو صيانة دورية، حسب احتياج جهازك</h1>
              <p>اختر نوع الصيانة أولاً، ثم جهازك الفعلي. في الصيانة الدورية سنعرض فقط طقم الفلاتر أو خلايا التبريد المتوافق معه.</p>
              <div className="maintenance-portal__trust-grid"><span><MessageCircleMore /> تحقق عبر واتساب</span><span><CalendarClock /> مواعيد متاحة فعلياً</span><span><ShieldCheck /> ملف متابعة خاص</span></div>
            </div>

            <nav className="maintenance-wizard-progress" aria-label="تقدم طلب الصيانة">
              <ol>
                {wizardSteps.map((step) => <li key={step.number} className={currentStep === step.number ? "active" : currentStep > step.number ? "complete" : ""} aria-current={currentStep === step.number ? "step" : undefined}>
                  <span>{currentStep > step.number ? <Check aria-hidden="true" /> : step.number}</span>
                  <strong>{step.label}</strong>
                </li>)}
              </ol>
              <p aria-live="polite">الخطوة {currentStep} من {wizardSteps.length}: {wizardSteps[currentStep - 1].label}</p>
            </nav>

            <form ref={formRef} className="maintenance-portal__form maintenance-portal__form--steps" onSubmit={submitRequest}>
              <fieldset id="maintenance-step-1" aria-labelledby="maintenance-step-1-title" tabIndex={-1} hidden={currentStep !== 1} className="maintenance-portal__card maintenance-step maintenance-request-type">
                <legend id="maintenance-step-1-title"><span>1</span> اختر نوع الصيانة</legend>
                <p className="maintenance-request-type__intro maintenance-portal__full">ما الذي يحتاجه جهازك الآن؟ يمكنك تغيير الاختيار قبل إرسال الطلب.</p>
                <label className={requestType === "repair" ? "maintenance-request-type__option active" : "maintenance-request-type__option"}>
                  <input type="radio" name="request_type" value="repair" checked={requestType === "repair"} onChange={() => { setRequestType("repair"); setProducts([]); setSelectedProduct(null); setSelectedKit(null); setProductQuery(""); setError(""); }} required />
                  <Wrench aria-hidden="true" />
                  <span><strong>صيانة عطل</strong><small>فحص مشكلة أو توقف أو ضعف أداء وإصلاحها.</small></span>
                  {requestType === "repair" && <CheckCircle2 aria-hidden="true" />}
                </label>
                <label className={requestType === "periodic" ? "maintenance-request-type__option active" : "maintenance-request-type__option"}>
                  <input type="radio" name="request_type" value="periodic" checked={requestType === "periodic"} onChange={() => { setRequestType("periodic"); setProducts([]); setSelectedProduct(null); setSelectedKit(null); setProductQuery(""); setError(""); }} required />
                  <RefreshCw aria-hidden="true" />
                  <span><strong>صيانة دورية</strong><small>تغيير فلاتر أو خلايا تبريد بالطقم المناسب للجهاز.</small></span>
                  {requestType === "periodic" && <CheckCircle2 aria-hidden="true" />}
                </label>
                <div className="maintenance-step__actions maintenance-portal__full">
                  <button className="maintenance-submit" type="button" onClick={continueFromServiceType} disabled={!requestType}>متابعة إلى تأكيد واتساب <ArrowLeft aria-hidden="true" /></button>
                </div>
              </fieldset>

              <fieldset id="maintenance-step-2" aria-labelledby="maintenance-step-2-title" tabIndex={-1} hidden={currentStep !== 2} className="maintenance-portal__card maintenance-step" disabled={!requestType}>
                <legend id="maintenance-step-2-title"><span>2</span> تأكيد هويتك</legend>
                <div className="maintenance-step__intro"><MessageCircleMore aria-hidden="true" /><div><strong>تأكد من رقمك على واتساب</strong><p>سنرسل رمزاً من 6 أرقام لحماية طلبك وربطه برقمك.</p></div></div>
                <label>الاسم الكامل<input name="customer_name" autoComplete="name" minLength={2} maxLength={200} required placeholder="مثال: محمد أحمد" /></label>
                <label>رقم الجوال واتساب<input name="customer_phone" value={phone} onChange={(event) => { setPhone(event.target.value); setVerificationToken(""); setVerificationId(""); }} type="tel" inputMode="tel" autoComplete="tel" minLength={7} maxLength={30} required placeholder="05xxxxxxxx" /></label>
                <div className="maintenance-verify-row maintenance-portal__full">
                  <button className="maintenance-link-button" type="button" onClick={sendOtp} disabled={verifying || phone.length < 7}>{verifying ? "جاري الإرسال" : verificationId ? "إعادة إرسال الرمز" : "إرسال رمز واتساب"}</button>
                  {verificationId && !verificationToken && <><label htmlFor="maintenance-otp">رمز التحقق</label><input id="maintenance-otp" value={otp} onChange={(event) => setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" spellCheck={false} maxLength={6} placeholder="000000" /><button className="maintenance-submit maintenance-submit--compact" type="button" onClick={confirmOtp} disabled={verifying || otp.length !== 6}>تأكيد الرمز</button></>}
                  {verificationToken && <span className="maintenance-verified"><Check /> تم تأكيد رقم واتساب</span>}
                </div>
                <div className="maintenance-step__actions maintenance-portal__full">
                  <button className="maintenance-link-button" type="button" onClick={() => showStep(1)}><ArrowRight aria-hidden="true" /> رجوع إلى نوع الصيانة</button>
                  <button className="maintenance-submit" type="button" onClick={continueFromIdentity} disabled={!verificationToken}>متابعة إلى اختيار الجهاز <ArrowLeft aria-hidden="true" /></button>
                </div>
              </fieldset>

              <fieldset id="maintenance-step-3" aria-labelledby="maintenance-step-3-title" tabIndex={-1} hidden={currentStep !== 3} className="maintenance-portal__card maintenance-step" disabled={!verificationToken || !requestType}>
                <legend id="maintenance-step-3-title"><span>3</span> {requestType === "periodic" ? "الجهاز والطقم" : "الجهاز والعطل"}</legend>
                <label className="maintenance-portal__full">ابحث عن جهاز BreeXe Pro<div className="maintenance-product-search"><Search size={18} /><input value={productQuery} onChange={(event) => setProductQuery(event.target.value)} type="search" autoComplete="off" placeholder="اسم الجهاز أو التصنيف" /></div></label>
                <div className="maintenance-products maintenance-portal__full" role="listbox" aria-label="نتائج المنتجات">
                  {products.map((product) => <button key={product.id} type="button" role="option" aria-selected={selectedProduct?.id === product.id} className={selectedProduct?.id === product.id ? "maintenance-product active" : "maintenance-product"} onClick={() => { setSelectedProduct(product); setSelectedKit(null); }}>
                    {product.image_url ? <img src={product.image_url} width="72" height="72" alt="" loading="lazy" /> : <span className="maintenance-product__placeholder">BX</span>}
                    <span><strong>{product.name}</strong><small>{product.category || product.sku || "منتج BreeXe Pro"}</small></span>{selectedProduct?.id === product.id && <CheckCircle2 aria-hidden="true" />}
                  </button>)}
                </div>
                {requestType === "periodic" && selectedProduct && <section className="maintenance-kit-picker maintenance-portal__full" aria-labelledby="maintenance-kit-title">
                  <div className="maintenance-step__intro"><PackageCheck aria-hidden="true" /><div><strong id="maintenance-kit-title">الطقم المتوافق مع جهازك</strong><p>هذه الأطقم مطابقة آلياً من كتالوج BreeXe Pro، والاختيار يعاد التحقق منه عند إرسال الطلب.</p></div></div>
                  {kitsLoading ? <p role="status">جاري مطابقة الجهاز مع أطقم الصيانة…</p> : maintenanceKits.length ? <div className="maintenance-kits" role="listbox" aria-label="أطقم الصيانة المتوافقة">{maintenanceKits.map((kit) => <button key={kit.id} type="button" role="option" aria-selected={selectedKit?.id === kit.id} className={selectedKit?.id === kit.id ? "maintenance-kit active" : "maintenance-kit"} onClick={() => setSelectedKit(kit)}>
                    {kit.image_url ? <img src={kit.image_url} width="62" height="62" alt="" loading="lazy" /> : <span className="maintenance-product__placeholder">BX</span>}
                    <span><strong>{kit.name}</strong><small>{kit.kind === "cooling_cells" ? "تغيير خلايا تبريد" : "تغيير فلاتر"}</small><small>{kit.compatibility_note}</small></span>
                    {selectedKit?.id === kit.id && <CheckCircle2 aria-hidden="true" />}
                  </button>)}</div> : <div className="maintenance-portal__warning" role="status">لا يوجد طقم دوري معتمد لهذا الجهاز حالياً. اختر جهازاً آخر أو أرسل طلب صيانة عطل.</div>}
                </section>}
                <label className="maintenance-portal__full">{requestType === "periodic" ? "ملاحظات إضافية (اختياري)" : "وصف العطل"}<textarea name="issue_description" rows={5} minLength={requestType === "repair" ? 10 : undefined} maxLength={4000} required={requestType === "repair"} placeholder={requestType === "periodic" ? "مثال: آخر تغيير للفلاتر أو ملاحظة عن الجهاز" : "متى بدأ العطل؟ وما الأعراض الظاهرة؟"} /></label>
                {requestType === "repair" && <><label>حالة الضمان<select name="warranty_status" defaultValue="unknown"><option value="unknown">غير متأكد</option><option value="yes">داخل الضمان</option><option value="no">خارج الضمان</option></select></label>
                <label>رقم الفاتورة<input name="invoice_number" autoComplete="off" maxLength={120} placeholder="اختياري" /></label></>}
                {availability?.settings.attachments_enabled && <div className="maintenance-upload maintenance-portal__full">
                  <label htmlFor="maintenance-files"><Upload aria-hidden="true" /> رفع صورة أو مقطع للمشكلة أو ملف الفاتورة<input id="maintenance-files" type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,application/pdf" multiple onChange={(event) => uploadFiles(event.target.files)} disabled={uploading || attachments.length >= 5} /></label>
                  <small>اختياري: حتى 5 ملفات، بينها مقطع واحد. الصور 8 MB، الفاتورة PDF ‏10 MB، والمقطع 25 MB كحد أقصى.</small>
                  <div className="maintenance-upload__files">{attachments.map((item) => <span key={item.id}>{item.kind === "video" ? <FileVideo aria-hidden="true" /> : item.kind === "document" ? <FileText aria-hidden="true" /> : <ImagePlus aria-hidden="true" />} {item.kind === "video" ? "مقطع" : item.kind === "document" ? "فاتورة PDF" : "صورة"} · {(item.byte_size / 1024 / 1024).toFixed(1)}MB</span>)}</div>
                </div>}
                <div className="maintenance-step__actions maintenance-portal__full">
                  <button className="maintenance-link-button" type="button" onClick={() => showStep(2)}><ArrowRight aria-hidden="true" /> رجوع إلى تأكيد واتساب</button>
                  <button className="maintenance-submit" type="button" onClick={continueFromDevice} disabled={!selectedProduct || (requestType === "periodic" && !selectedKit)}>متابعة إلى الموعد والموقع <ArrowLeft aria-hidden="true" /></button>
                </div>
              </fieldset>

              <fieldset id="maintenance-step-4" aria-labelledby="maintenance-step-4-title" tabIndex={-1} hidden={currentStep !== 4} className="maintenance-portal__card maintenance-step" disabled={!verificationToken || !selectedProduct || (requestType === "periodic" && !selectedKit)}>
                <legend id="maintenance-step-4-title"><span>4</span> الموعد والموقع</legend>
                <SlotPicker availability={availability} date={selectedDate} time={selectedTime} onSelect={(date, time) => { setSelectedDate(date); setSelectedTime(time); }} />
                <label>المدينة<input name="city" autoComplete="address-level2" maxLength={160} required placeholder="مثال: الرياض" /></label>
                <label className="maintenance-portal__full">عنوان موقع الصيانة<input name="address" autoComplete="street-address" minLength={5} maxLength={1000} required placeholder="الحي، الشارع، رقم المبنى" /></label>
                <div className="maintenance-location maintenance-portal__full"><button className="maintenance-link-button" type="button" onClick={captureLocation} disabled={locating} aria-busy={locating || undefined}><MapPin aria-hidden="true" /> {locating ? "جاري تحديد الموقع…" : location ? "تحديث الموقع" : "تسجيل موقعي الحالي"}</button>{location && <><span className="maintenance-verified" role="status"><Check aria-hidden="true" /> تم تسجيل الموقع بدقة {Math.round(location.accuracy)} م</span><a className="maintenance-map-link" href={locationMapUrl} target="_blank" rel="noreferrer"><ExternalLink aria-hidden="true" /> معاينة الموقع المسجّل</a></>}</div>
                <label className="maintenance-portal__full">أو رابط الموقع<input name="location_url" type="url" inputMode="url" autoComplete="url" placeholder="https://maps.google.com/?q=24.7136,46.6753" /></label>
                <label className="maintenance-portal__checkbox maintenance-portal__full"><input name="accept_terms" type="checkbox" required /><span>أوافق على استخدام بياناتي وموقعي ومرفقاتي لإدارة طلب الصيانة والتواصل بشأنه فقط.</span></label>
                <label className="maintenance-portal__honeypot" aria-hidden="true">الموقع<input name="website" tabIndex={-1} autoComplete="off" /></label>
                <div className="maintenance-step__actions maintenance-portal__full">
                  <button className="maintenance-link-button" type="button" onClick={() => showStep(3)}><ArrowRight aria-hidden="true" /> رجوع إلى الجهاز والمرفقات</button>
                  <button className="maintenance-submit" type="submit" disabled={submitting || !selectedDate || !selectedTime}>{submitting ? "جاري تثبيت الطلب…" : "تأكيد طلب الصيانة"}</button>
                </div>
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
  return <div className="maintenance-slots maintenance-portal__full"><h3>اختر اليوم المتاح</h3><div className="maintenance-slot-days">{availability.dates.map((item) => <button key={item.date} type="button" className={date === item.date ? "active" : ""} onClick={() => onSelect(item.date, "")}><span>{dayFormatter.format(new Date(`${item.date}T12:00:00+03:00`))}</span><small>{item.slots.length} أوقات</small></button>)}</div>{selected && <><h3>اختر الوقت</h3><div className="maintenance-slot-times">{selected.slots.map((slot) => <button key={slot.time} type="button" className={time === slot.time ? "active" : ""} onClick={() => onSelect(date, slot.time)}><bdi>{formatMaintenanceTime(slot.time)}</bdi>{time === slot.time && <Check size={16} aria-hidden="true" />}</button>)}</div></>}</div>;
}
