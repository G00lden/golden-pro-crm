import { useEffect, useState } from "react";
import { getConsent, setConsent, type ConsentState } from "../consent";

/**
 * Cookie-consent banner for the public ad-landing pages.
 *
 * Renders only while consent is "unknown". On accept/decline it records the
 * choice (localStorage) and disappears. Tracking scripts are gated on the
 * "granted" state in main.tsx, so nothing third-party loads before a click.
 */
export function ConsentBanner() {
  const [state, setState] = useState<ConsentState>("unknown");

  useEffect(() => {
    setState(getConsent());
  }, []);

  if (state !== "unknown") return null;

  const choose = (next: "granted" | "denied") => {
    setConsent(next);
    setState(next);
  };

  return (
    <div className="consent-banner" dir="rtl" role="dialog" aria-live="polite" aria-label="إعدادات الخصوصية">
      <div className="consent-inner">
        <p className="consent-text">
          نستخدم ملفات تعريف الارتباط لتحليل أداء الإعلانات وتحسين تجربتك.
          بموافقتك نُفعّل أدوات القياس التابعة لتيكتوك وميتا وجوجل. تقدر ترفض
          وتكمل تصفّح الموقع بشكل طبيعي. اطّلع على{" "}
          <a href="/legal/privacy">سياسة الخصوصية</a>.
        </p>
        <div className="consent-actions">
          <button type="button" className="consent-btn ghost" onClick={() => choose("denied")}>
            رفض
          </button>
          <button type="button" className="consent-btn primary" onClick={() => choose("granted")}>
            موافق
          </button>
        </div>
      </div>
    </div>
  );
}

export default ConsentBanner;
