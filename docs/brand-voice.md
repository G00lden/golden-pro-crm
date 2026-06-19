# BreeXe Pro — Brand Voice Guideline

> This document codifies the Arabic brand voice for all user-facing copy across the landing page, CRM, quotations, WhatsApp messages, and email templates.
>
> **Canonical brand identity reference:** [`docs/brand-identity.md`](brand-identity.md)
>
> Closes checklist item **5.31** (Brand voice guideline for future copy consistency).

---

## 1. Brand personality (3 adjectives)

1. **موثوق** (Trustworthy) — We speak with confidence and clarity. No exaggeration, no fine-print traps.
2. **مهني** (Professional) — We use correct Arabic grammar and consistent terminology. We respect the reader's time.
3. **قريب** (Approachable) — Warm but not overly casual. We use Saudi colloquial touches only where they make the user feel understood, not to sound "cool."

---

## 2. Formality level

**Professional but warm** — think a well-dressed store manager who smiles and says "تفضل":

| Context | Level | Example |
|---------|-------|---------|
| Hero / CTA | Formal-compelling | "تواصل عبر واتساب" |
| Form labels | Neutral-clear | "الاسم", "الجوال", "الخدمة المطلوبة" |
| Placeholder text | Warm-specific | "مثلاً: المنزل دور أرضي، فيه ٤ أفراد، أبغى فلتر تحت المغسلة" |
| Error messages | Apologetic + actionable | "عذراً، تعذر إرسال طلبك الآن. جرّب التواصل عبر واتساب أو الاتصال المباشر." |
| Success confirmations | Grateful + clear next step | "شكراً لتواصلك معنا. سنرد عليك في أقرب وقت." |
| WhatsApp / SMS reminders | Polite + specific | "عزيزي أحمد، نود تذكيركم بموعد صيانة الفلتر. فريق BreeXe Pro في خدمتكم." |
| Internal CRM UI (notifications) | Direct + concise | "تم حفظ عرض السعر", "تم حذف العميل" |

---

## 3. Saudi Arabic conventions

### Numerals

- **Use Arabic-Indic numerals (٠-٩) for static content** — hero stats, trust numbers, prices in static copy: `أكثر من ١٢٠٠ عميل سعيد`, `٢٤ ساعة`.
- **Use Western digits (0-9) for dynamic data** — user-input fields, phone numbers, dates in CRM tables, API responses. This is the standard in Saudi digital products.
- **Money format:** `١٬٢٠٠ ر.س` (comma as thousands separator with Arabic-Indic digits) or `1,200 ر.س` (western digits) — be consistent per page; prefer western digits for dynamic CRM data.

### Grammar & spelling

| Rule | Apply | Don't apply |
|------|-------|-------------|
| Use full إعراب for formal text (hero, about) | "نقدّم خدمات احترافية" | "نقدم خدمات احترافية" (acceptable but less polished for hero) |
| Use relaxed إعراب for form placeholders & toasts | "لو حاب تستعجل" | "لو تحب أن تستعجل" (too formal for a toast) |
| Saudi dialect for "want" in placeholders | "أبغى فلتر" | "أبي فلتر" (more Levantine/Egyptian) |
| Saudi dialect for "try" in instructions | "جرّب التواصل" | "جرب التواصل" (عامية acceptable but جرب is also Saudi) |

### Dialect choices

- **Preferred:** Saudi dialect (نجدي / حجازي عام) for placeholders, tooltips, and WhatsApp messages.
- **Avoid:** Egyptian ("إحنا", "بس كده"), Levantine ("بدي", "شو"), or Gulf Khaleeji that isn't Saudi-specific.
- **Exceptions:** The word "أبي" (I want) in the WhatsApp deeplink text is acceptable since it's a neutral Arabic deeplink that works across dialects.

### Brand name casing (critical)

- **Always:** `BreeXe Pro` — capital **X**, capital **P**, space between words.
- **Never:** `Breexe`, `breeXe`, `BreXe Pro`, `Breexe Pro`, `BreeXe pro`.
- **Arabic references:** بريكس برو (optional; English brand name is preferred in all marketing).

---

## 4. "Do say" / "Don't say" examples

### Service descriptions

| ✅ Do say | ❌ Don't say |
|-----------|-------------|
| "حلول متكاملة لفلاتر المياه والمضخات والتبريد — تركيب وصيانة بضمان" | "حلول متكاملة في فلاتر المياه والمضخات والتبريد" (vague, no value prop) |
| "فلاتر منزلية وتجارية بأحدث التقنيات" | "فلاتر مياه" (too short, no differentiation) |
| "خدمة عملاء ٧/٢٤ للاستفسارات الفنية" | "دعم فني ٢٤ ساعة" (works but less specific) |

### Error messages

| ✅ Do say | ❌ Don't say |
|-----------|-------------|
| "عذراً، تعذر إرسال طلبك الآن. جرّب التواصل عبر واتساب أو الاتصال المباشر." | "تعذر إرسال طلبك. جرب واتساب." (cold, no apology) |
| "فشل الاتصال. تحقق من اتصال الإنترنت وحاول مرة أخرى." | "خطأ في الاتصال" (no action guidance) |
| "تعذر الحفظ. قد يكون البريد مسجلاً مسبقاً." | "خطأ" (tells nothing useful) |

### Success confirmations

| ✅ Do say | ❌ Don't say |
|-----------|-------------|
| "شكراً لتواصلك معنا. سنرد عليك في أقرب وقت." | "تم الإرسال" (robotic) |
| "تم إصدار عرض السعر بنجاح" | "تم" (too minimal) |
| "تم إرسال التذكير للعميل" | "تم الإرسال" (unclear what was sent) |

### CTAs (calls to action)

| ✅ Do say | ❌ Don't say |
|-----------|-------------|
| "تواصل عبر واتساب" | "راسلنا" (ambiguous) |
| "اتصل بنا الآن" | "اتصل" (too short, no urgency) |
| "أرسل الطلب" | "إرسال" (cold) |
| "إصدار عرض سعر" | "عرض سعر" (noun, not a CTA) |

### Email / WhatsApp messages

| ✅ Do say | ❌ Don't say |
|-----------|-------------|
| "عزيزي [الاسم]، نود تذكيركم بموعد صيانة [المنتج]." | "تذكير صيانة" (no greeting) |
| "فريق BreeXe Pro في خدمتكم." | "شكراً" alone (no closing) |
| "يرجى إرسال إيصال التحويل بعد الدفع لتأكيد الطلب." | "أرسل الإيصال" (commanding, no reason) |

---

## 5. Tone matrix

| Surface | Tone | Length | Dialect | Example |
|---------|------|--------|---------|---------|
| **Landing page — Hero** | Inspiring + confident | Short headline (≤10 words) | Standard Arabic | "حلول متكاملة لفلاتر المياه والمضخات والتبريد" |
| **Landing page — About** | Trust-building + descriptive | 2–4 paragraphs | Standard Arabic | "BreeXe Pro علامة سعودية متخصصة..." |
| **Landing page — Form** | Helpful + clear | Labels: 1–2 words; Placeholders: full sentence | Saudi dialect for placeholders, standard for labels | placeholder: "مثلاً: المنزل دور أرضي..." |
| **Landing page — Error toast** | Apologetic + solution-first | 1–2 sentences | Neutral Arabic with Saudi flavour | "عذراً، تعذر إرسال طلبك الآن. جرّب التواصل..." |
| **Landing page — Success** | Warm + grateful | 1 sentence + CTA | Standard Arabic | "شكراً لتواصلك معنا. سنرد عليك في أقرب وقت." |
| **CRM — Form labels** | Neutral + technical | 1–2 words | Standard Arabic | "الاسم", "الجوال", "الدور" |
| **CRM — Notifications (toast)** | Direct + concise | 3–6 words | Standard Arabic | "تم حفظ عرض السعر" / "تم حذف المستخدم" |
| **CRM — Error feedback** | Direct + diagnostic | 1 sentence | Standard Arabic | "تعذر الحذف. العميل لديه صيانة مرتبطة." |
| **CRM — Confirm dialogs** | Clear + specific | Full question | Standard Arabic | "حذف عرض السعر QT-20250215-123؟" |
| **CRM — Empty states** | Encouraging + actionable | 1 sentence + CTA | Standard Arabic | "لا توجد عروض أسعار بعد. إصدار أول عرض." |
| **WhatsApp — Auto reminders** | Polite + specific | 2–3 sentences | Formal Arabic | "عزيزي [الاسم]، نود تذكيركم بموعد صيانة..." |
| **Quotation PDF — Header/title** | Official + branded | Short | Formal Arabic | "عرض سعر رسمي — BreeXe Pro" |
| **Quotation PDF — Fine print** | Legal + clear | Bullet points | Formal Arabic | "الأسعار سارية لمدة 7 أيام من تاريخ العرض..." |

---

## 6. Reference to brand identity

| Element | Value | Source |
|---------|-------|--------|
| Brand name | **BreeXe Pro** (بريكس برو) | `docs/brand-identity.md` |
| Parent group | المجموعة الذهبية المتحدة | `docs/brand-identity.md` |
| Primary colour | Royal Blue `#0B355C` | `docs/brand-identity.md` |
| Accent colour | Champagne Gold `#C9A47A` | `docs/brand-identity.md` |
| Arabic font | **Tajawal** (300–900 weight) | `docs/brand-identity.md` |
| Latin font | **Montserrat** (400–800 weight) | `docs/brand-identity.md` |
| Tagline | "تابعة للمجموعة الذهبية المتحدة" | `docs/brand-identity.md` |

All visual brand assets (logos, icons, colour CSS variables) are documented in [`docs/brand-identity.md`](brand-identity.md). Any copy change that touches brand-visible text must reference this voice guideline first.

---

## 7. Reviewer checklist (for future copy PRs)

- [ ] Brand name is `BreeXe Pro` (capital X, capital P) everywhere
- [ ] Numerals are consistent per context (Arabic-Indic for static, Western for dynamic)
- [ ] Error messages include apology + actionable next step
- [ ] Success messages include gratitude + clear next step
- [ ] Dialect choice matches the tone matrix above
- [ ] CTAs are verbs, not nouns
- [ ] WhatsApp deeplink text uses natural Saudi dialect
- [ ] All /legal/privacy and /legal/terms links exist (or are flagged as a blocker)
