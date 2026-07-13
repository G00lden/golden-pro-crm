import { useEffect, useState, type FormEvent } from "react";
import {
  Droplets,
  Snowflake,
  Wrench,
  Phone,
  MessageCircle,
  Shield,
  CheckCircle2,
  Settings as SettingsIcon,
  HeadphonesIcon,
  Send,
} from "lucide-react";
import { captureUtm, trackEvent } from "../track";
import { PublicContactLink } from "../components/PublicContactLink";
import { submitPublicLead } from "../publicLead";

/**
 * BreeXe Pro — public landing page.
 *
 *   - Lives at `/landing` (see routing guard in App.tsx).
 *   - Public, no auth required — this is the destination for paid ads
 *     (Meta / TikTok / Snap / Google).
 *   - Mobile-first, brand-aligned (light theme, see docs/brand-identity.md).
 *   - Every CTA fires a tracked event via src/track.ts.
 */

const WA_DEEPLINK_TEXT = "السلام عليكم، أبي أستفسر عن خدمات BreeXe Pro.";

const services = [
  { icon: Droplets, title: "تنقية المياه", desc: "فلاتر منزلية وتجارية بأحدث التقنيات" },
  { icon: SettingsIcon, title: "المضخات", desc: "مضخات صناعية ومنزلية بكفاءة عالية" },
  { icon: Snowflake, title: "حلول التبريد", desc: "تركيب وصيانة أنظمة التبريد" },
  { icon: Wrench, title: "التركيب", desc: "فريق فني معتمد لتركيب احترافي" },
  { icon: Shield, title: "الصيانة الدورية", desc: "عقود صيانة سنوية بأسعار تنافسية" },
  { icon: HeadphonesIcon, title: "الدعم الفني", desc: "خدمة عملاء ٧/٢٤ للاستفسارات الفنية" },
];

const trustNumbers = [
  { value: "+1,200", label: "عميل سعيد" },
  { value: "+8", label: "سنوات خبرة" },
  { value: "+150", label: "منتج متاح" },
  { value: "24/7", label: "دعم فني" },
];

export function LandingPage() {
  const [form, setForm] = useState({ name: "", phone: "", service: "", message: "", website: "" });
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Capture UTM params and fire a single page_view on mount.
  useEffect(() => {
    captureUtm();
    trackEvent({ name: "page_view", meta: { page: "landing" } });
  }, []);

  const onWaClick = (source: string) => {
    trackEvent({ name: "wa_click", meta: { source } });
  };
  const onCallClick = (source: string) => {
    trackEvent({ name: "call_click", meta: { source } });
  };

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await submitPublicLead({
        ...form,
        source: "landing",
        utm: captureUtm(),
      });
      setSubmitted(true);
      trackEvent({ name: "lead_submit", meta: { service: form.service || "unspecified" } });
      setForm({ name: "", phone: "", service: "", message: "", website: "" });
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "عذراً، تعذر إرسال طلبك الآن. حاول مرة أخرى.");
      // eslint-disable-next-line no-console
      console.error("[landing] lead submit failed", err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="landing-page" dir="rtl" lang="ar">
      {/* === Header === */}
      <header className="lp-header">
        <a href="/landing" className="lp-brand" aria-label="BreeXe Pro">
          <img src="/brand/logo-256.png" alt="BreeXe Pro" />
        </a>
        <nav className="lp-nav">
          <a href="#services">خدماتنا</a>
          <a href="#about">عن BreeXe</a>
          <a href="#contact">تواصل</a>
        </nav>
        <PublicContactLink
          channel="whatsapp"
          whatsappText={WA_DEEPLINK_TEXT}
          className="lp-cta-mini"
          onClick={() => onWaClick("header")}
        >
          <MessageCircle size={16} aria-hidden="true" />
          <span>واتساب</span>
        </PublicContactLink>
      </header>

      {/* === Hero === */}
      <section className="lp-hero">
        <div className="lp-hero-inner">
          <span className="lp-eyebrow">تابعة للمجموعة الذهبية المتحدة</span>
          <h1>حلول متكاملة في فلاتر المياه والمضخات والتبريد</h1>
          <p>
            في BreeXe Pro نقدّم خدمات احترافية في تنقية المياه، المضخات، وأنظمة التبريد —
            من اختيار المنتج المناسب إلى التركيب والصيانة الدورية، بفريق فني معتمد
            وضمان على كل عملية.
          </p>
          <div className="lp-cta-row">
            <PublicContactLink
              channel="whatsapp"
              whatsappText={WA_DEEPLINK_TEXT}
              className="lp-btn primary"
              onClick={() => onWaClick("hero")}
            >
              <MessageCircle size={18} aria-hidden="true" />
              <span>تواصل عبر واتساب</span>
            </PublicContactLink>
            <PublicContactLink
              channel="call"
              className="lp-btn ghost"
              onClick={() => onCallClick("hero")}
            >
              <Phone size={18} aria-hidden="true" />
              <span>اتصل بنا الآن</span>
            </PublicContactLink>
          </div>
          <div className="lp-hero-trust">
            <CheckCircle2 size={14} /><span>ضمان على التركيب</span>
            <span className="dot">•</span>
            <CheckCircle2 size={14} /><span>فنيون معتمدون</span>
            <span className="dot">•</span>
            <CheckCircle2 size={14} /><span>أسعار شفافة</span>
          </div>
        </div>
        <div className="lp-hero-art" aria-hidden="true" />
      </section>

      {/* === Services === */}
      <section className="lp-section" id="services">
        <h2>خدماتنا</h2>
        <p className="lp-section-sub">كل ما تحتاجه لمياه نظيفة وأنظمة موثوقة، تحت سقف واحد.</p>
        <div className="lp-services-grid">
          {services.map((s) => (
            <article key={s.title} className="lp-service-card">
              <div className="lp-service-icon"><s.icon size={28} aria-hidden="true" /></div>
              <h3>{s.title}</h3>
              <p>{s.desc}</p>
            </article>
          ))}
        </div>
      </section>

      {/* === Trust strip === */}
      <section className="lp-trust">
        {trustNumbers.map((t) => (
          <div key={t.label} className="lp-trust-cell">
            <span className="lp-trust-value">{t.value}</span>
            <span className="lp-trust-label">{t.label}</span>
          </div>
        ))}
      </section>

      {/* === About / Profile === */}
      <section className="lp-section" id="about">
        <h2>عن BreeXe Pro</h2>
        <div className="lp-about">
          <div className="lp-about-text">
            <p>
              BreeXe Pro علامة سعودية متخصصة تتبع للمجموعة الذهبية المتحدة. نقدّم حلولاً
              متكاملة في مجالات فلاتر المياه، المضخات، وأنظمة التبريد، مع التركيب والصيانة
              الدورية. هدفنا أن نكون شريكاً موثوقاً لكل عائلة ومنشأة تبحث عن جودة، ضمان،
              ومتابعة لا تنقطع بعد البيع.
            </p>
            <ul className="lp-bullets">
              <li>فريق فني معتمد ومُدرّب على أحدث الأنظمة.</li>
              <li>ضمان رسمي على المنتجات والتركيب.</li>
              <li>صيانة دورية مجدولة مع تذكير تلقائي قبل موعدها.</li>
              <li>أسعار شفافة بدون رسوم خفية، وعروض موسمية للعملاء الدائمين.</li>
            </ul>
          </div>
          <div className="lp-about-card">
            <div className="lp-about-card-head">
              <img src="/brand/icon-256.png" alt="" aria-hidden="true" />
              <div>
                <strong>BreeXe Pro</strong>
                <span>تابعة للمجموعة الذهبية المتحدة</span>
              </div>
            </div>
            <ul className="lp-about-card-list">
              <li><CheckCircle2 size={14} /><span>منتجات معتمدة بمواصفات عالمية</span></li>
              <li><CheckCircle2 size={14} /><span>خدمة في كل مدن المملكة الرئيسية</span></li>
              <li><CheckCircle2 size={14} /><span>دعم فني سريع عبر واتساب والهاتف</span></li>
            </ul>
          </div>
        </div>
      </section>

      {/* === Contact form === */}
      <section className="lp-section lp-contact" id="contact">
        <h2>اطلب عرض سعر أو استفسر</h2>
        <p className="lp-section-sub">عبّئ النموذج وراح يتواصل معك فريقنا خلال ساعات العمل.</p>

        {submitted ? (
          <div className="lp-success">
            <CheckCircle2 size={28} aria-hidden="true" />
            <h3>شكراً لتواصلك معنا</h3>
            <p>سنرد عليك في أقرب وقت. لو حاب تستعجل، تواصل عبر واتساب مباشرة.</p>
            <PublicContactLink
              channel="whatsapp"
              whatsappText={WA_DEEPLINK_TEXT}
              className="lp-btn primary"
              onClick={() => onWaClick("post-submit")}
            >
              <MessageCircle size={18} aria-hidden="true" />
              <span>تابع عبر واتساب</span>
            </PublicContactLink>
          </div>
        ) : (
          <form className="lp-form" onSubmit={onSubmit}>
            <label
              style={{ position: "absolute", insetInlineStart: "-10000px", width: 1, height: 1, overflow: "hidden" }}
            >
              <span>Website</span>
              <input
                type="text"
                name="website"
                tabIndex={-1}
                autoComplete="off"
                aria-label="اترك هذا الحقل فارغاً"
                value={form.website}
                onChange={(e) => setForm({ ...form, website: e.target.value })}
              />
            </label>
            <label>
              <span>الاسم</span>
              <input
                type="text"
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="اسمك الكريم"
                autoComplete="name"
              />
            </label>
            <label>
              <span>الجوال</span>
              <input
                type="tel"
                required
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                placeholder="05xxxxxxxx"
                autoComplete="tel"
                inputMode="tel"
                dir="ltr"
              />
            </label>
            <label>
              <span>الخدمة المطلوبة</span>
              <select
                value={form.service}
                onChange={(e) => setForm({ ...form, service: e.target.value })}
              >
                <option value="">اختر…</option>
                {services.map((s) => <option key={s.title} value={s.title}>{s.title}</option>)}
                <option value="غير محدد">غير ذلك</option>
              </select>
            </label>
            <label className="lp-form-wide">
              <span>تفاصيل إضافية (اختياري)</span>
              <textarea
                rows={3}
                value={form.message}
                onChange={(e) => setForm({ ...form, message: e.target.value })}
                placeholder="مثلاً: المنزل دور أرضي، فيه ٤ أفراد، أبغى فلتر تحت المغسلة"
              />
            </label>
            {submitError && <div className="lp-form-error">{submitError}</div>}
            <button className="lp-btn primary lp-form-submit" type="submit" disabled={submitting}>
              <Send size={18} aria-hidden="true" />
              <span>{submitting ? "جاري الإرسال…" : "أرسل الطلب"}</span>
            </button>
            <p className="lp-form-fine">
              بإرسال هذا النموذج توافق على <a href="/legal/privacy">سياسة الخصوصية</a> و
              <a href="/legal/terms">شروط الخدمة</a> و
              <a href="/legal/refund">سياسة الاسترجاع والاستبدال</a>.
            </p>
          </form>
        )}
      </section>

      {/* === Sticky mobile CTA === */}
      <div className="lp-sticky-cta" aria-hidden="false">
        <PublicContactLink
          channel="whatsapp"
          whatsappText={WA_DEEPLINK_TEXT}
          className="lp-sticky-btn primary"
          onClick={() => onWaClick("sticky")}
        >
          <MessageCircle size={18} aria-hidden="true" />
          <span>واتساب</span>
        </PublicContactLink>
        <PublicContactLink
          channel="call"
          className="lp-sticky-btn ghost"
          onClick={() => onCallClick("sticky")}
        >
          <Phone size={18} aria-hidden="true" />
          <span>اتصل</span>
        </PublicContactLink>
      </div>

      {/* === Footer === */}
      <footer className="lp-footer">
        <div className="lp-footer-grid">
          <div>
            <img src="/brand/logo-256.png" alt="BreeXe Pro" className="lp-footer-logo" />
            <p>تابعة للمجموعة الذهبية المتحدة. كل الحقوق محفوظة.</p>
          </div>
          <div>
            <h4>تواصل</h4>
            <ul>
              <li>
                <PublicContactLink channel="whatsapp" whatsappText={WA_DEEPLINK_TEXT} onClick={() => onWaClick("footer")}>
                  واتساب
                </PublicContactLink>
              </li>
              <li><PublicContactLink channel="call" onClick={() => onCallClick("footer")}>اتصال مباشر</PublicContactLink></li>
            </ul>
          </div>
          <div>
            <h4>روابط</h4>
            <ul>
              <li><a href="#services">خدماتنا</a></li>
              <li><a href="#about">عن BreeXe</a></li>
              <li><a href="/legal/privacy">سياسة الخصوصية</a></li>
              <li><a href="/legal/terms">شروط الخدمة</a></li>
              <li><a href="/legal/refund">الاسترجاع والاستبدال</a></li>
              <li><a href="/" className="lp-admin-link">دخول الإدارة</a></li>
            </ul>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default LandingPage;
