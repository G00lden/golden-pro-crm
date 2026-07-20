import { useEffect, useState } from "react";

/**
 * Legal pages (privacy policy & terms of service).
 * Rendered inside the React SPA at /legal/privacy and /legal/terms.
 * The static HTML versions in public/legal/ serve the public landing page;
 * this component provides an in-app view for authenticated users.
 */

type LegalPage = "privacy" | "terms";

function LegalHeader({ page, setPage }: { page: LegalPage; setPage: (p: LegalPage) => void }) {
  return (
    <header
      style={{
        background: "linear-gradient(135deg, #0B355C 0%, #0f4a7a 100%)",
        color: "#fff",
        padding: "2rem 1rem",
        textAlign: "center",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          height: 4,
          background: "linear-gradient(90deg, #C9A47A, #e0c090, #C9A47A)",
        }}
      />
      <div style={{ display: "flex", gap: "1rem", justifyContent: "center", marginBottom: "1rem" }}>
        <button
          onClick={() => setPage("privacy")}
          style={{
            background: page === "privacy" ? "#C9A47A" : "transparent",
            color: page === "privacy" ? "#0B355C" : "#C9A47A",
            border: "2px solid #C9A47A",
            borderRadius: 8,
            padding: "0.5rem 1.2rem",
            fontWeight: 700,
            fontSize: "0.95rem",
            cursor: "pointer",
            fontFamily: "'Tajawal', sans-serif",
            transition: "all 0.2s",
          }}
        >
          سياسة الخصوصية
        </button>
        <button
          onClick={() => setPage("terms")}
          style={{
            background: page === "terms" ? "#C9A47A" : "transparent",
            color: page === "terms" ? "#0B355C" : "#C9A47A",
            border: "2px solid #C9A47A",
            borderRadius: 8,
            padding: "0.5rem 1.2rem",
            fontWeight: 700,
            fontSize: "0.95rem",
            cursor: "pointer",
            fontFamily: "'Tajawal', sans-serif",
            transition: "all 0.2s",
          }}
        >
          شروط الخدمة
        </button>
      </div>
      <h1 style={{ fontSize: "1.6rem", fontWeight: 800, color: "#fff", margin: 0 }}>
        {page === "privacy" ? "سياسة الخصوصية" : "شروط الخدمة"}
      </h1>
      <p style={{ color: "rgba(255,255,255,0.7)", marginTop: "0.3rem", fontSize: "0.95rem" }}>
        آخر تحديث: 21 يوليو 2026
      </p>
    </header>
  );
}

function PrivacyContent() {
  return (
    <div className="legal-card" style={cardStyle}>
      <h2 style={h2Style}>مقدمة</h2>
      <p style={pStyle}>
        نحن في <strong>BreeXe Pro</strong> (التابعة <strong>للمجموعة الذهبية المتحدة</strong>) نلتزم بحماية
        خصوصية عملائنا وزوار موقعنا. توضح سياسة الخصوصية هذه كيفية جمع، استخدام، مشاركة، وتخزين
        بياناتك الشخصية وفقاً <strong>لائحة حماية البيانات الشخصية (PDPL)</strong> الصادرة عن الهيئة
        السعودية للبيانات والذكاء الاصطناعي (SDAIA).
      </p>

      <h2 style={h2Style}>أولاً: البيانات التي نجمعها</h2>
      <ul style={ulStyle}>
        <li><strong>معلومات التعريف:</strong> الاسم الكامل، رقم الجوال، البريد الإلكتروني، العنوان.</li>
        <li><strong>معلومات الخدمة:</strong> نوع الخدمة المطلوبة، تفاصيل الطلب، تاريخ الزيارة.</li>
        <li><strong>بيانات التقنية:</strong> عنوان IP، نوع المتصفح، الصفحات التي زرتها (عبر الكوكيز).</li>
        <li><strong>بيانات الإحالة الإعلانية:</strong> معرّف نقرة تيكتوك، مصدر الحملة، مرجع عشوائي قصير، وحالة انتقال العميل بين التواصل والتأهيل والشراء.</li>
        <li><strong>سجل التواصل:</strong> محتوى الرسائل عبر نموذج التواصل، واتساب، أو البريد الإلكتروني.</li>
        <li><strong>بيانات الدفع:</strong> بيانات الدفع الضرورية (تُعالج عبر مزود آمن ولا نخزنها كاملة).</li>
      </ul>

      <h2 style={h2Style}>ثانياً: كيفية استخدام بياناتك</h2>
      <ul style={ulStyle}>
        <li>تقديم الخدمات التي طلبتها (تركيب، صيانة، استشارة).</li>
        <li>التواصل معك بخصوص طلباتك واستفساراتك.</li>
        <li>إرسال تذكيرات بالصيانة الدورية والعروض (بعد الموافقة).</li>
        <li>تحسين موقعنا وخدماتنا.</li>
        <li>قياس نتائج الحملات الإعلانية وإنشاء جماهير إعادة استهداف بعد موافقتك.</li>
        <li>الامتثال للالتزامات القانونية والتنظيمية في المملكة العربية السعودية.</li>
      </ul>

      <h2 style={h2Style}>ثالثاً: مشاركة البيانات مع أطراف ثالثة</h2>
      <p style={pStyle}>لا نبيع بياناتك. قد نشارك البيانات اللازمة مع مزودي الخدمة (شحن، دفع، تحليلات)، ومنصات القياس الإعلاني مثل تيكتوك وميتا وجوجل بعد موافقتك، والجهات الرسمية عند الأمر القضائي، أو الشركات التابعة داخل المجموعة الذهبية المتحدة.</p>
      <p style={pStyle}>عند قياس حملة تيكتوك قد نرسل معرّف النقرة، رابط الصفحة، نوع المتصفح، عنوان الشبكة، ونسخة مشفّرة أحادية الاتجاه من رقم الجوال عند تحقق التواصل. لا نرسل نص محادثة واتساب ولا رقم الجوال بصورته الخام إلى تيكتوك.</p>
      <div style={highlightStyle}>نضمن التزام جميع الأطراف الثالثة بمعايير حماية البيانات المكافئة.</div>

      <h2 style={h2Style}>رابعاً: تخزين البيانات وأمنها</h2>
      <p style={pStyle}>تُخزَّن بياناتك على خوادم آمنة مع تشفير (TLS 1.3)، جدران حماية، وصلاحيات وصول محدودة، ونسخ احتياطي منتظم.</p>

      <h2 style={h2Style}>خامساً: حقوقك بموجب PDPL</h2>
      <p style={pStyle}>لك حق الإطلاع، التصحيح، الحذف، تقييد المعالجة، الاعتراض، نقل البيانات، وسحب الموافقة. تواصل معنا وسنستجيب خلال 30 يوماً.</p>

      <h2 style={h2Style}>سادساً: الكوكيز</h2>
      <p style={pStyle}>نستخدم ملفات ضرورية، وتحليلية، وتسويقية تابعة لتيكتوك وميتا وجوجل بعد الموافقة. نحتفظ بمرجع الإحالة الإعلانية مدة لا تتجاوز تسعين يوماً ما لم يلزم النظام مدة أخرى. يمكنك الرفض أو سحب الموافقة من إعدادات المتصفح.</p>

      <h2 style={h2Style}>سابعاً: التواصل</h2>
      <p style={pStyle}>privacy@breexe-pro.com | واتساب من موقعنا | المجموعة الذهبية المتحدة، المملكة العربية السعودية</p>
    </div>
  );
}

function TermsContent() {
  return (
    <div className="legal-card" style={cardStyle}>
      <h2 style={h2Style}>مقدمة</h2>
      <p style={pStyle}>
        باستخدامك لموقع <strong>BreeXe Pro</strong> (التابعة <strong>للمجموعة الذهبية المتحدة</strong>) وخدماتك،
        فإنك توافق على هذه الشروط.
      </p>

      <h2 style={h2Style}>أولاً: تعريفات</h2>
      <ul style={ulStyle}>
        <li><strong>الشركة:</strong> BreeXe Pro — المجموعة الذهبية المتحدة، المملكة العربية السعودية.</li>
        <li><strong>العميل:</strong> أي شخص يستخدم خدمات الموقع أو يشتري منتجاتنا.</li>
        <li><strong>الخدمات:</strong> تركيب، صيانة، توريد قطع غيار، استشارات فنية.</li>
      </ul>

      <h2 style={h2Style}>ثانياً: الخدمات</h2>
      <p style={pStyle}>المبيعات، التركيب بفريق فني معتمد، الصيانة الدورية بعقود سنوية، الصيانة الطارئة، والاستشارات الفنية.</p>

      <h2 style={h2Style}>ثالثاً: الأسعار والدفع</h2>
      <p style={pStyle}>بالريال السعودي شامل الضريبة. السعر المتفق عليه في عرض السعر ساري حتى انتهاء صلاحيته. الدفع عبر بطاقة، تحويل بنكي، أو محفظة رقمية.</p>

      <h2 style={h2Style}>رابعاً: الضمان</h2>
      <p style={pStyle}>ضمان المصنع على المنتجات + سنة على التركيب. لا يغطي سوء الاستخدام أو القطع الاستهلاكية.</p>

      <h2 style={h2Style}>خامساً: الإلغاء والاسترجاع</h2>
      <p style={pStyle}>الإلغاء قبل التركيب خلال 24 ساعة باسترداد كامل. المنتجات غير المفتوحة تُسترجع خلال 7 أيام. المنتجات المفتوحة لا تُقبل إلا بعيب صناعي.</p>

      <h2 style={h2Style}>سادساً: التوصيل</h2>
      <p style={pStyle}>توصيل داخل المملكة (2-7 أيام عمل). رسوم الشحن حسب المنطقة. العميل مسؤول عن دقة العنوان.</p>

      <h2 style={h2Style}>سابعاً: التركيب</h2>
      <p style={pStyle}>بواسطة فنيين معتمدين. يُشترط توفر المتطلبات الأساسية. يُوقع محضر تسليم بعد الانتهاء.</p>

      <h2 style={h2Style}>ثامناً: الصيانة</h2>
      <p style={pStyle}>عقود سنوية تُجدد تلقائياً مع إشعار قبل 30 يوماً. زيارة أو زيارتان سنوياً حسب العقد.</p>

      <h2 style={h2Style}>تاسعاً: المسؤولية</h2>
      <p style={pStyle}>مسؤوليتنا لا تتجاوز قيمة الخدمة أو المنتج. لا نتحمل أضراراً غير مباشرة أو تبعية.</p>

      <h2 style={h2Style}>عاشراً: القانون المطبق</h2>
      <p style={pStyle}>تخضع للقوانين السعودية. النزاعات تُحل ودياً خلال 30 يوماً، ثم في المحاكم المختصة بالرياض.</p>

      <h2 style={h2Style}>الحادي عشر: تعديل الشروط</h2>
      <p style={pStyle}>نحق تعديلها بنشر التحديثات على هذه الصفحة. الاستمرار في الاستخدام بعد التعديل يعني الموافقة.</p>

      <h2 style={h2Style}>الثاني عشر: التواصل</h2>
      <p style={pStyle}>support@breexe-pro.com | واتساب | المجموعة الذهبية المتحدة، المملكة العربية السعودية</p>
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  background: "#fff",
  borderRadius: 16,
  padding: "2rem 2rem 1rem",
  boxShadow: "0 2px 12px rgba(11,53,92,0.06)",
  border: "1px solid rgba(201,164,122,0.15)",
  maxWidth: 820,
  margin: "0 auto",
};

const h2Style: React.CSSProperties = {
  color: "#0B355C",
  fontSize: "1.3rem",
  fontWeight: 700,
  margin: "1.8rem 0 0.8rem",
  paddingBottom: "0.5rem",
  borderBottom: "2px solid rgba(201,164,122,0.3)",
};

const pStyle: React.CSSProperties = {
  marginBottom: "0.8rem",
  fontSize: "1rem",
  color: "#2c2c2c",
  lineHeight: 1.8,
};

const ulStyle: React.CSSProperties = {
  margin: "0.5rem 0 1rem 1.5rem",
  paddingRight: "1rem",
  listStyle: "disc",
};

const highlightStyle: React.CSSProperties = {
  background: "rgba(201,164,122,0.1)",
  borderRight: "3px solid #C9A47A",
  padding: "0.8rem 1rem",
  borderRadius: 8,
  margin: "1rem 0",
  fontWeight: 500,
  color: "#0B355C",
};

export default function LegalPage() {
  const [page, setPage] = useState<LegalPage>("privacy");

  // Sync URL hash with page state
  useEffect(() => {
    const hash = window.location.hash.replace("#", "") as LegalPage;
    if (hash === "privacy" || hash === "terms") {
      setPage(hash);
    }
  }, []);

  useEffect(() => {
    window.location.hash = page;
  }, [page]);

  return (
    <div dir="rtl" lang="ar" style={{ fontFamily: "'Tajawal', sans-serif", background: "#f8f6f3", minHeight: "100vh" }}>
      <LegalHeader page={page} setPage={setPage} />

      <div style={{ maxWidth: 820, margin: "0 auto", padding: "2rem 1.5rem 3rem" }}>
        {page === "privacy" ? <PrivacyContent /> : <TermsContent />}
      </div>

      {/* In-app footer */}
      <footer
        style={{
          background: "#0B355C",
          color: "rgba(255,255,255,0.7)",
          textAlign: "center",
          padding: "2rem 1rem",
          fontSize: "0.9rem",
        }}
      >
        <a
          href={page === "privacy" ? "/legal/terms" : "/legal/privacy"}
          style={{ color: "#C9A47A", textDecoration: "none", fontWeight: 500 }}
          onClick={(e) => {
            e.preventDefault();
            setPage(page === "privacy" ? "terms" : "privacy");
          }}
        >
          {page === "privacy" ? "شروط الخدمة" : "سياسة الخصوصية"}
        </a>
        <span style={{ color: "rgba(255,255,255,0.3)", margin: "0 0.6rem" }}>|</span>
        <a href="/" style={{ color: "#C9A47A", textDecoration: "none", fontWeight: 500 }}>
          العودة إلى BreeXe Pro
        </a>
        <p style={{ marginTop: "0.8rem" }}>
          © 2026 BreeXe Pro — تابعة للمجموعة الذهبية المتحدة. كل الحقوق محفوظة.
        </p>
      </footer>
    </div>
  );
}
