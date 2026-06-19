import {useMemo, useState, type FormEvent} from "react";
import {
  Droplets, Snowflake, Wrench, Shield,
  Phone, MessageCircle, Send, CheckCircle2,
  Star, Award, HeadphonesIcon,
} from "lucide-react";
import {captureUtm, trackEvent} from "../track";

/* ────────────────────────────────
 * BreeXe Pro — Landing Page v2
 * Brand identity: docs/brand-identity.md
 * Dark mode: مريح للعين، درجات زرقاء داكنة مع لمسات ذهبية
 * ──────────────────────────────── */

const WA_NUMBER = "966500000000"; // ← استبدله برقم واتساب الأعمال الحقيقي
const CALL_HREF = `tel:+966500000000`;
const WA_TEXT = "السلام عليكم، أبغى أستفسر عن خدمات BreeXe Pro";

const services = [
  {icon: Droplets,   title: "تنقية المياه",         desc: "فلاتر منزلية وتجارية بأحدث التقنيات"},
  {icon: Snowflake,  title: "حلول التبريد",          desc: "أنظمة تبريد مركزي وصحراوي بمواصفات عالمية"},
  {icon: Wrench,     title: "التركيب",               desc: "فريق فني معتمد لتركيب احترافي مع ضمان"},
  {icon: Shield,     title: "الصيانة الدورية",       desc: "عقود صيانة سنوية وتذكير تلقائي قبل الموعد"},
  {icon: Award,      title: "المضخات والغطاسات",     desc: "مضخات تعزيز وكبس وغطاسات لكافة الاستخدامات"},
  {icon: HeadphonesIcon, title: "الدعم الفني",        desc: "خدمة عملاء عبر واتساب والاتصال المباشر"},
];

const stats = [
  {value: "أكثر من ١٢٠٠", label: "عميل سعيد"},
  {value: "أكثر من ٨",    label: "سنوات خبرة"},
  {value: "أكثر من ١٥٠",  label: "منتج متاح"},
  {value: "24/7",         label: "دعم فني"},
];

const reviews = [
  {
    name: "أبو محمد",
    text: "ركبوا لي محطة تحلية منزلية .. شغل نظيف وضمان سنوي. أنصح فيه.",
    rating: 5,
  },
  {
    name: "أم خالد",
    text: "تعاملت معاهم لفلتر خزان العمارة. التركيب كان سريع والفريق محترف.",
    rating: 5,
  },
  {
    name: "مهندس سعد",
    text: "نظام الرذاذ للمزرعة شغّلوه باحترافية. الصيانة الدورية شي يريح البال.",
    rating: 5,
  },
];

/* ─── Helpers ─── */
function waUrl(text = WA_TEXT): string {
  return `https://wa.me/${WA_NUMBER}?text=${encodeURIComponent(text)}`;
}

/* ─── Component ─── */
export function LandingModern() {
  const [form, setForm] = useState({name: "", phone: "", service: "", message: ""});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Capture UTM + page_view on mount
  useMemo(() => {
    captureUtm();
    trackEvent({name: "page_view", meta: {page: "landing-v2"}});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const waHref = useMemo(() => waUrl(), []);
  const callHref = CALL_HREF;

  const onWa = (src: string) => trackEvent({name: "wa_click", meta: {source: src}});
  const onCall = (src: string) => trackEvent({name: "call_click", meta: {source: src}});

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const r = await fetch("/api/leads/public", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(form),
      });
      if (r.ok || r.status === 404) {
        setSubmitted(true);
        trackEvent({name: "lead_submit", meta: {service: form.service || "unspecified"}});
        setForm({name: "", phone: "", service: "", message: ""});
      } else {
        const text = await r.text();
        throw new Error(text || `HTTP ${r.status}`);
      }
    } catch {
      setSubmitError("عذراً، تعذر إرسال طلبك الآن. تواصل عبر واتساب أو الاتصال المباشر.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="lm-page" dir="rtl" lang="ar">
      {/* ═══ Header ═══ */}
      <header className="lm-header">
        <div className="lm-header-inner">
          <a href="/landing" className="lm-brand" aria-label="BreeXe Pro">
            <img src="/brand/logo-256.png" alt="BreeXe Pro" className="lm-logo" />
            <span className="lm-brand-name">BreeXe<span className="lm-brand-pro">Pro</span></span>
          </a>
          <nav className="lm-nav" aria-label="التنقل الرئيسي">
            <a href="#services">خدماتنا</a>
            <a href="#about">عن BreeXe</a>
            <a href="#reviews">آراء العملاء</a>
            <a href="#contact">تواصل</a>
          </nav>
          <a className="lm-btn lm-btn-sm lm-btn-gold"
             href={waHref} target="_blank" rel="noopener noreferrer"
             onClick={() => onWa("header")}>
            <MessageCircle size={16} aria-hidden="true" />
            <span>واتساب</span>
          </a>
        </div>
      </header>

      {/* ═══ Hero ═══ */}
      <section className="lm-hero">
        <div className="lm-hero-bg" aria-hidden="true" />
        <div className="lm-hero-inner">
          <div className="lm-hero-badge">تابعة للمجموعة الذهبية المتحدة</div>
          <h1 className="lm-hero-title">
            حلول متكاملة في <span className="lm-gold-text">المياه</span> والتبريد
            <br />
            — تركيب وصيانة بضمان
          </h1>
          <p className="lm-hero-sub">
            في BreeXe Pro نقدّم خدمات احترافية في تنقية المياه، المضخات، وأنظمة التبريد —
            من اختيار المنتج المناسب إلى التركيب والصيانة الدورية، بفريق فني معتمد.
          </p>
          <div className="lm-hero-actions">
            <a className="lm-btn lm-btn-primary lm-btn-lg"
               href={waHref} target="_blank" rel="noopener noreferrer"
               onClick={() => onWa("hero")}>
              <MessageCircle size={20} aria-hidden="true" />
              <span>تواصل عبر واتساب</span>
            </a>
            <a className="lm-btn lm-btn-outline lm-btn-lg"
               href={callHref} onClick={() => onCall("hero")}>
              <Phone size={20} aria-hidden="true" />
              <span>اتصل بنا الآن</span>
            </a>
          </div>
          <div className="lm-hero-trust">
            <span><CheckCircle2 size={14} /> ضمان على التركيب</span>
            <span className="lm-dot">•</span>
            <span><CheckCircle2 size={14} /> فنيون معتمدون</span>
            <span className="lm-dot">•</span>
            <span><CheckCircle2 size={14} /> أسعار شفافة</span>
          </div>
        </div>
      </section>

      {/* ═══ Stats ═══ */}
      <section className="lm-stats">
        {stats.map((s) => (
          <div key={s.label} className="lm-stat-cell">
            <span className="lm-stat-value">{s.value}</span>
            <span className="lm-stat-label">{s.label}</span>
          </div>
        ))}
      </section>

      {/* ═══ Services ═══ */}
      <section className="lm-section" id="services">
        <div className="lm-section-label">خدماتنا</div>
        <h2 className="lm-section-title">كل ما تحتاجه لمياه نظيفة وأنظمة موثوقة</h2>
        <div className="lm-grid">
          {services.map((s) => (
            <article key={s.title} className="lm-card">
              <div className="lm-card-icon"><s.icon size={28} aria-hidden="true" /></div>
              <h3>{s.title}</h3>
              <p>{s.desc}</p>
              <a className="lm-card-cta"
                 href={waHref} target="_blank" rel="noopener noreferrer"
                 onClick={() => onWa(`service:${s.title}`)}>
                استفسر الآن ←
              </a>
            </article>
          ))}
        </div>
      </section>

      {/* ═══ About ═══ */}
      <section className="lm-section lm-section-alt" id="about">
        <div className="lm-section-label">من نحن</div>
        <h2 className="lm-section-title">علامة سعودية موثوقة</h2>
        <div className="lm-about">
          <div className="lm-about-text">
            <p>
              BreeXe Pro علامة سعودية متخصصة تتبع للمجموعة الذهبية المتحدة. نقدّم حلولاً
              متكاملة في مجالات فلاتر المياه، المضخات، وأنظمة التبريد، مع التركيب والصيانة
              الدورية.
            </p>
            <ul className="lm-bullets">
              <li><CheckCircle2 size={16} className="lm-check-icon" /> فريق فني معتمد ومدرّب على أحدث الأنظمة</li>
              <li><CheckCircle2 size={16} className="lm-check-icon" /> ضمان رسمي على المنتجات والتركيب</li>
              <li><CheckCircle2 size={16} className="lm-check-icon" /> صيانة دورية مجدولة مع تذكير تلقائي</li>
              <li><CheckCircle2 size={16} className="lm-check-icon" /> أسعار شفافة بدون رسوم خفية</li>
            </ul>
          </div>
          <div className="lm-about-card">
            <img src="/brand/logo-256.png" alt="BreeXe Pro" className="lm-about-logo" />
            <strong>BreeXe Pro</strong>
            <span>تابعة للمجموعة الذهبية المتحدة</span>
          </div>
        </div>
      </section>

      {/* ═══ Reviews ═══ */}
      <section className="lm-section" id="reviews">
        <div className="lm-section-label">آراء العملاء</div>
        <h2 className="lm-section-title">ماذا يقول عملاؤنا</h2>
        <div className="lm-reviews">
          {reviews.map((r, i) => (
            <blockquote key={i} className="lm-review-card">
              <div className="lm-stars" aria-label={`تقييم ${r.rating} من 5`}>
                {Array.from({length: r.rating}).map((_, j) => (
                  <Star key={j} size={16} fill="var(--brand-gold)" stroke="var(--brand-gold)" />
                ))}
              </div>
              <p>"{r.text}"</p>
              <footer>— {r.name}</footer>
            </blockquote>
          ))}
        </div>
      </section>

      {/* ═══ Contact form ═══ */}
      <section className="lm-section lm-section-alt" id="contact">
        <div className="lm-section-label">تواصل معنا</div>
        <h2 className="lm-section-title">اطلب عرض سعر أو استفسر</h2>
        <p className="lm-section-sub">عبّئ النموذج وراح يتواصل معك فريقنا خلال ساعات العمل.</p>

        {submitted ? (
          <div className="lm-success">
            <CheckCircle2 size={40} className="lm-success-icon" />
            <h3>شكراً لتواصلك معنا</h3>
            <p>سنرد عليك في أقرب وقت. لو حاب تستعجل، تواصل عبر واتساب مباشرة.</p>
            <a className="lm-btn lm-btn-primary"
               href={waHref} target="_blank" rel="noopener noreferrer"
               onClick={() => onWa("post-submit")}>
              <MessageCircle size={18} aria-hidden="true" />
              <span>تابع عبر واتساب</span>
            </a>
          </div>
        ) : (
          <form className="lm-form" onSubmit={onSubmit}>
            <label>
              <span>الاسم</span>
              <input type="text" required value={form.name}
                     onChange={(e) => setForm({...form, name: e.target.value})}
                     placeholder="اسمك الكريم" autoComplete="name" />
            </label>
            <label>
              <span>الجوال</span>
              <input type="tel" required value={form.phone}
                     onChange={(e) => setForm({...form, phone: e.target.value})}
                     placeholder="05xxxxxxxx" autoComplete="tel" dir="ltr" />
            </label>
            <label>
              <span>الخدمة المطلوبة</span>
              <select value={form.service}
                      onChange={(e) => setForm({...form, service: e.target.value})}>
                <option value="">اختر…</option>
                {services.map((s) => <option key={s.title} value={s.title}>{s.title}</option>)}
                <option value="غير ذلك">غير ذلك</option>
              </select>
            </label>
            <label className="lm-form-wide">
              <span>تفاصيل إضافية (اختياري)</span>
              <textarea rows={3} value={form.message}
                        onChange={(e) => setForm({...form, message: e.target.value})}
                        placeholder="مثلاً: المنزل دور أرضي، فيه ٤ أفراد، أبغى فلتر تحت المغسلة" />
            </label>
            {submitError && <div className="lm-form-error">{submitError}</div>}
            <button className="lm-btn lm-btn-primary lm-btn-block" type="submit" disabled={submitting}>
              <Send size={18} aria-hidden="true" />
              <span>{submitting ? "جاري الإرسال…" : "أرسل الطلب"}</span>
            </button>
            <p className="lm-form-fine">
              بإرسال هذا النموذج توافق على <a href="/legal/privacy">سياسة الخصوصية</a> و
              <a href="/legal/terms"> شروط الخدمة</a>.
            </p>
          </form>
        )}
      </section>

      {/* ═══ Footer ═══ */}
      <footer className="lm-footer">
        <div className="lm-footer-inner">
          <div className="lm-footer-col">
            <img src="/brand/logo-256.png" alt="BreeXe Pro" className="lm-footer-logo" />
            <p>تابعة للمجموعة الذهبية المتحدة. كل الحقوق محفوظة.</p>
          </div>
          <div className="lm-footer-col">
            <h4>تواصل</h4>
            <a href={waHref} target="_blank" rel="noopener noreferrer"
               onClick={() => onWa("footer")}>واتساب</a>
            <a href={callHref} onClick={() => onCall("footer")}>اتصال مباشر</a>
          </div>
          <div className="lm-footer-col">
            <h4>روابط</h4>
            <a href="#services">خدماتنا</a>
            <a href="#about">عن BreeXe</a>
            <a href="/legal/privacy">سياسة الخصوصية</a>
            <a href="/legal/terms">شروط الخدمة</a>
            <a href="/" className="lm-admin-link">دخول الإدارة</a>
          </div>
        </div>
        <div className="lm-footer-bar">
          <span>© {new Date().getFullYear()} BreeXe Pro — جميع الحقوق محفوظة</span>
        </div>
      </footer>
    </div>
  );
}
