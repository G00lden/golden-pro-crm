import { useEffect } from "react";
import { CheckCircle2, MapPin, MessageCircle, Ruler, ShieldCheck, Wind } from "lucide-react";
import { PublicContactLink } from "../components/PublicContactLink";
import { captureUtm, trackEvent } from "../track";
import "./air-conditioner-landing.css";

const WHATSAPP_MESSAGE = `السلام عليكم، أرغب بعرض سعر لمكيف.

المدينة:
نوع المكان:
المساحة التقريبية:
العدد المطلوب:
صورة الموقع إن أمكن:`;

export function AirConditionerLanding() {
  useEffect(() => {
    captureUtm();
    trackEvent({ name: "page_view", meta: { page: "air-conditioners" } });
  }, []);

  const whatsappClick = (position: string) => {
    trackEvent({ name: "wa_click", meta: { source: position, product: "air-conditioners" } });
  };

  return (
    <div className="ac-page" dir="rtl" lang="ar">
      <header className="ac-header">
        <a className="ac-brand" href="/landing-ac" aria-label="بريكس برو">
          <Wind size={26} aria-hidden="true" />
          <span>بريكس برو</span>
        </a>
        <span className="ac-header-note">توريد وحلول تكييف للمنازل والمنشآت</span>
      </header>

      <main>
        <section className="ac-hero">
          <div className="ac-hero-copy">
            <span className="ac-kicker">لا تشترِ قبل معرفة المقاس المناسب</span>
            <h1>نرشّح لك المكيف المناسب ونرسل عرض السعر على واتساب</h1>
            <p>
              أرسل المدينة، نوع المكان، المساحة والعدد المطلوب. يراجع المختص احتياجك قبل اعتماد الجهاز والسعر.
            </p>
            <div className="ac-actions">
              <PublicContactLink
                channel="whatsapp"
                whatsappText={WHATSAPP_MESSAGE}
                className="ac-primary"
                onClick={() => whatsappClick("hero")}
              >
                <MessageCircle size={22} aria-hidden="true" />
                ابدأ طلب عرض السعر
              </PublicContactLink>
              <a className="ac-secondary" href="#requirements">ما المعلومات المطلوبة؟</a>
            </div>
            <ul className="ac-trust" aria-label="مزايا الخدمة">
              <li><CheckCircle2 size={18} /> ترشيح حسب المساحة والاستخدام</li>
              <li><CheckCircle2 size={18} /> متابعة العرض حتى اتخاذ القرار</li>
              <li><CheckCircle2 size={18} /> سجل موحد للمحادثة والطلب</li>
            </ul>
          </div>
          <aside className="ac-quote-card" aria-label="خطوات عرض السعر">
            <span className="ac-card-label">أربع معلومات تختصر عليك الوقت</span>
            <ol>
              <li><MapPin /> المدينة وموقع التركيب</li>
              <li><Ruler /> المساحة التقريبية</li>
              <li><Wind /> نوع المكان والاستخدام</li>
              <li><ShieldCheck /> العدد والميزانية المتوقعة</li>
            </ol>
            <PublicContactLink
              channel="whatsapp"
              whatsappText={WHATSAPP_MESSAGE}
              className="ac-card-link"
              onClick={() => whatsappClick("quote-card")}
            >
              أرسل التفاصيل الآن
            </PublicContactLink>
          </aside>
        </section>

        <section className="ac-requirements" id="requirements">
          <div>
            <span className="ac-kicker">رحلة واضحة للطلب</span>
            <h2>من الاستفسار إلى إغلاق الصفقة</h2>
          </div>
          <div className="ac-steps">
            <article><b>١</b><h3>تفاصيل الاحتياج</h3><p>يرسل العميل المدينة والمساحة ونوع المكان.</p></article>
            <article><b>٢</b><h3>الترشيح والعرض</h3><p>يُراجع المختص المقاس والعدد ويرسل عرض السعر.</p></article>
            <article><b>٣</b><h3>المتابعة</h3><p>تُسجّل المتابعة والأسئلة حتى يصبح القرار جاهزاً.</p></article>
            <article><b>٤</b><h3>تأكيد الطلب</h3><p>عند الاتفاق يُثبت الطلب وتُحفظ نتيجة الحملة.</p></article>
          </div>
        </section>

        <section className="ac-final">
          <div><h2>جاهز لمعرفة الخيار المناسب؟</h2><p>أرسل التفاصيل، وسيبدأ تقييم احتياجك من نفس المحادثة.</p></div>
          <PublicContactLink
            channel="whatsapp"
            whatsappText={WHATSAPP_MESSAGE}
            className="ac-primary"
            onClick={() => whatsappClick("final")}
          >
            <MessageCircle size={22} aria-hidden="true" />
            تواصل عبر واتساب
          </PublicContactLink>
        </section>
      </main>

      <footer className="ac-footer">
        <span>بريكس برو</span>
        <nav><a href="/legal/privacy">الخصوصية</a><a href="/legal/terms">الشروط</a></nav>
      </footer>
    </div>
  );
}

export default AirConditionerLanding;
