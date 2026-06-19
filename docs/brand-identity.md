# BreeXe Pro — Brand Identity (canonical reference)

> Source: `الهوية البصرية BreeXe Pro-1.pdf` (تابعة للمجموعة الذهبية المتحدة).
> This document is the single source of truth for every brand decision in code. If the PDF and this document disagree, the PDF wins — update this file. CSS variables in `src/index.css` (`--brand-*`) mirror what's here.

## 1. Brand essence

- **Brand name:** BreeXe Pro (always written with capital **X** and **P** — `BreeXe Pro`, never `Breexe`, `breeXe`, or `BreXe Pro`).
- **Parent group:** المجموعة الذهبية المتحدة (United Golden Group). Tagline under the logo: *"تابعة للمجموعة الذهبية المتحدة"*.
- **What we do:** فلاتر المياه، المضخات، حلول التبريد، التركيب والصيانة (water filters, pumps, cooling solutions, installation & maintenance).
- **Voice:** professional, trust-building, Arabic-first, KSA-focused.

## 2. Colour palette

Hex values are normative. Use the CSS variable name in code; do not hard-code the hex.

### Primary

| Role | Name (AR / EN) | Hex | CSS var | Use it for |
|------|----------------|-----|---------|------------|
| Primary | الأزرق الأساسي / Primary Blue | `#0B355C` | `--brand-blue` | Logo, primary buttons, headers, section dividers, official documents |
| Accent | الذهبي الشمباني / Champagne Gold | `#C9A47A` | `--brand-gold` | Premium elements, certifications, badges, sub-logos, gold accents |
| Neutral | الأبيض / White | `#FFFFFF` | `--brand-white` | Default background, body of pages, light surfaces |

### Secondary

| Role | Name (AR / EN) | Hex | CSS var | Use it for |
|------|----------------|-----|---------|------------|
| Surface | الرمادي الفاتح / Light Gray | `#F4F4F4` | `--brand-gray` | Secondary backgrounds, block separators, subtle borders |
| Text | الرمادي الداكن / Dark Gray | `#393A3F` | `--brand-charcoal` | Body text, secondary headings, icon strokes |
| Accent | الأزرق الفاتح / Soft Light Blue | `#CDE8FA` | `--brand-blue-soft` | Modern hovers, info chips, soft section backgrounds |

### Derived (for elevation / interaction states)

| Role | Hex | CSS var |
|------|-----|---------|
| Deep brand blue | `#07223D` | `--brand-blue-deep` |
| Lighter gold for hovers | `#DCBE9A` | `--brand-gold-light` |

## 3. Typography

| Role | Family | Weight ladder | CSS var |
|------|--------|---------------|---------|
| Arabic (primary, headlines + body) | **Tajawal** | 300 / 400 / 500 / 700 / 800 / 900 | `--brand-font-ar` |
| Latin (supporting + technical text) | **Montserrat** | 400 / 500 / 600 / 700 / 800 | `--brand-font-en` |

Both are loaded from Google Fonts in `index.html`. The Arabic family is the page default; Latin glyphs render in Montserrat automatically via the `[lang="en"], .latin, code, kbd, samp` selector in `src/index.css`.

### Type scale (from the brand book — apply as we touch each component)

- **H1 — Page title:** 40px / Bold
- **H2 — Section heading:** 24px / Bold
- **H3 — Sub-section:** 18px / Semibold
- **Body:** 14–16px / Regular
- **Caption / Label:** 12px / Medium

## 4. Logo

Master files in `public/brand/`:

| File | Use case |
|------|----------|
| `logo-full.png` (1619×505) | Hero / large headers / print |
| `logo-512.png` | Sidebar / app shell brand mark (mid size) |
| `logo-256.png` | Card / tile contexts |
| `icon-256.png` | Square mark — apple-touch-icon, social share |
| `icon-64.png` | App favicon (HiDPI), in-app brand-mark background |
| `icon-32.png` | Browser favicon |

**Logo rules (from brand book):**
- Always keep clear-space around the mark equal to the height of the "B" letter on all sides.
- Never recolour the mark outside the brand palette. The default mark is `--brand-blue` on white; for dark backgrounds, use a white-on-deep-blue inversion (`--brand-blue-deep`).
- Never stretch, skew, rotate, or apply drop-shadows that aren't from the brand book.
- The bilingual tagline *"تابعة للمجموعة الذهبية المتحدة"* sits **below** the mark, not beside.

## 5. Applications (from the brand book)

The PDF includes worked examples for: store signage (لوحة المحل), vehicle branding (هوية المركبات), business cards (بطاقة العمل), stationery (التطبيقات الورقية), and digital surfaces (التطبيقات الرقمية: socials, mobile app, website). When designing for any of those surfaces, lift the corresponding page from the PDF as the visual reference.

## 6. Where it's wired in code

- `index.html` — favicon set, theme-color (`#0B355C`), Tajawal + Montserrat font links.
- `src/index.css` — `--brand-*` variables under `:root`, font-family defaults, `.brand-mark` and `.brand-mark.large` rules use `public/brand/icon-64.png`.
- `src/App.tsx` — all string occurrences of the brand name use `BreeXe Pro` (capital X, capital P).
- `public/brand/` — all logo and icon assets.

## 7. Landing Modern — Dark mode design

للاندنج الحديثة (`/landing-v2`)، تم بناء ثيم **dark mode مريح للعين** من نفس الهوية البصرية:

### Design principles
- **الخلفية:** أسود مزرق عميق (`#0a0e14`) — أغمق من الأزرق الأساسي لكنه يحافظ على الدفء
- **الأسطح:** طبقات من الأزرق الداكن المغبر (`#111a24`, `#162332`)
- **النصوص:** أبيض مزرق خفيف (`#e8edf2`) — غير قاسي على العين
- **الأزرار:** تدرج من الأزرق الأساسي (`#0b355c → #144e7a`) أو الذهبي
- **اللمسات:** الذهبي الشمباني (`#c9a47a`) في hover, borders, icon colors
- **الهويات:** إضاءات ناعمة (glow effects) ذهبية وزرقاء في الخلفية

### CSS variables for landing modern
Stored in `src/pages/LandingModern.css`:

```css
--lm-bg: #0a0e14;
--lm-surface: #111a24;
--lm-surface-2: #162332;
--lm-line: #1e2d3d;
--lm-blue: #0b355c;
--lm-blue-deep: #07223d;
--lm-blue-soft: #1a3f5e;
--lm-gold: #c9a47a;
--lm-gold-light: #dcbe9a;
--lm-text: #e8edf2;
--lm-muted: #8a9aa8;
--lm-success: #28c7a0;
```

### Key visual features
1. **Header زجاجي** — `backdrop-filter: blur()` مع border ذهبي
2. **Hero مع glow gradient** — radial gradients زرقاء وذهبية كخلفية
3. **بطاقات services** تتغير حوافها للذهبي عند hover وتصعد للأعلى
4. **شريط إحصائيات** متداخل في الـ hero مع خلفية داكنة وأرقام ذهبية
5. **قسم تقييمات** مع نجوم ذهبية وتنسيق اقتباسات
6. **جميع الزوايا دائرية** (`14px` للبطاقات، `10px` للأزرار)
7. **متجاوب بالكامل** — موبايل، تابلت، ديسكتوب

## 8. Changing brand values

If the user supplies a revised brand book:

1. Re-extract page 8 (brand summary) of the new PDF.
2. Update the hex values in this document.
3. Update the matching `--brand-*` variables in `src/index.css`.
4. Replace files in `public/brand/` only if the logo itself changed.
5. Run `npm run lint && npm run build` and visually verify on every route.
6. Commit with message `brand: <what changed> per <new pdf>`.
