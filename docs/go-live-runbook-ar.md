# دليل النشر النهائي — Golden Pro CRM (VPS + Cloudflare → crm.breexe-pro.com)

هذا الدليل يأخذك من الكود المُصلَّح إلى نظام يعمل وجاهز للفريق. الخطوات اللي تحتاج إدخال بياناتك معلّمة بوضوح بـ **«تدخلها أنت»**.

---

## 0) قبل ما تبدأ — تحقق محلي (دقيقة واحدة على جهازك)

افتح طرفية VS Code داخل مجلد المشروع ونفّذ:

```bash
npm install
npm run lint      # = tsc --noEmit (فحص الأنواع الكامل)
npm run build     # = vite build (بناء الإنتاج)
```

النتيجة المتوقعة: `lint` بدون أخطاء، و`build` ينتج مجلد `dist/`.
> أنا تحققت أن كل ملفات TypeScript سليمة الصياغة (0 أخطاء)، لكن هذي الخطوة تأكيد نهائي على جهازك.

---

## 1) جهّز ملف الأسرار `.env.production`

1. انسخ القالب: `cp .env.production.ready .env.production`
2. ولّد الأسرار العشوائية (على جهازك أو الخادم):

```bash
openssl rand -hex 32   # لـ STORE_WEBHOOK_SECRET
openssl rand -hex 32   # لـ SALLA_STATE_SECRET
openssl rand -hex 32   # لـ SALLA_APP_WEBHOOK_SECRET
openssl rand -hex 16   # لـ OUTBOUND_CONFIRM_CODE
```

3. **تدخلها أنت** في `.env.production`:

| المفتاح | من وين تجيبه |
|--------|----------------|
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase › Project Settings › API › service_role |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Supabase › نفس الصفحة › anon/public |
| `FIREBASE_SERVICE_ACCOUNT_*` | Firebase › Project Settings › Service accounts › Generate key |
| `STORE_WEBHOOK_OWNER_UID` | UID حسابك في Firebase Authentication |
| `ADMIN_UIDS` | UID(ات) من يتحكم بقناة واتساب (نفس uid المالك غالبًا) |
| `BOOTSTRAP_ADMIN_EMAILS` | البريد الموثق للمالك/المشرف الأول؛ قائمة مفصولة بفواصل عند الحاجة |
| `SALLA_CLIENT_ID` / `SALLA_CLIENT_SECRET` | لوحة مطوّري سلة › تطبيقك |
| `CLOUDFLARE_API_TOKEN` | Cloudflare › My Profile › API Tokens |
| الأسرار العشوائية الأربعة | من الأمر `openssl` أعلاه |

> ⚠️ لا ترفع `.env.production` إلى Git. هو مستبعد أصلاً في `.gitignore`.

---

## 2) جهّز قاعدة البيانات (Supabase)

```bash
npm run db:verify     # يتحقق أن الجداول والسياسات موجودة
```

لو الجداول ناقصة، طبّق الـ migrations من `supabase/migrations/` عبر Supabase SQL editor أو CLI:

تأكد خصوصًا من تطبيق `20260712010400_quotes_invoices_financial.sql` قبل تفعيل `DATA_PROVIDER=supabase`؛ فهي تنشئ جداول العروض والفواتير وحقول الخصم والضريبة والأقساط مع RLS.
`20260429181500_initial_crm_schema.sql` ثم `20260429183500_harden_crm_schema.sql`.

---

## 3) فعّل تسجيل الدخول للفريق (Firebase Auth)

1. Firebase Console › Authentication › Sign-in method › فعّل **Email/Password** (أو Google).
2. أضف كل عضو فريق كمستخدم (Authentication › Users › Add user).
3. Authentication › Settings › Authorized domains › أضف `crm.breexe-pro.com`.
4. ضع UID المالك في `ADMIN_UIDS` وبريده الموثق في `BOOTSTRAP_ADMIN_EMAILS` قبل أول دخول. أول مستخدم لا يصبح admin تلقائيًا.

> ملاحظة عزل البيانات: كل مستخدم يشوف بياناته فقط (الفلترة بـ `createdBy === uid`). لو تبي الفريق **يتشارك** نفس بيانات المتجر، استخدم حساب مالك واحد مشترك، أو أخبرني لأضيف نموذج فريق/مؤسسة (workspace) — تطوير إضافي.

---

## 4) انشر على الخادم (VPS)

مشروعك فيه السكربتات الجاهزة:

```powershell
# على جهازك (PowerShell) — ينشر إلى خادمك عبر SSH
npm run deploy:vps
```

**تدخلها أنت** داخل `scripts/deploy-vps.ps1` أو كمتغيرات: عنوان الخادم (IP)، مستخدم SSH، ومفتاح SSH.
على الخادم: ثبّت Node 20+، ضع `.env.production` و`service-account.json` في `/opt/golden-pro-crm/`، ثم:

```bash
npm ci --omit=dev
npm run build
ENV_FILE=.env.production NODE_ENV=production node --import tsx server.ts
# أو الأفضل: شغّله كخدمة دائمة عبر systemd / pm2
```

> واتساب Web (Baileys) يخزّن الجلسة في `.wa-session/` على القرص — تأكد أن المجلد دائم ولا يُحذف بين عمليات النشر.

---

## 5) اربط الدومين (Cloudflare)

```powershell
npm run cloudflare:dns                 # ينشئ/يحدّث سجل crm.breexe-pro.com
# نفق Cloudflare (يبقي الخادم خلف Cloudflare بدون فتح منافذ):
scripts/setup-cloudflare-tunnel.ps1    # مرة واحدة
scripts/run-cloudflare-tunnel.ps1      # تشغيل النفق
```

**تدخلها أنت**: `CLOUDFLARE_API_TOKEN` و`CLOUDFLARE_DNS_TARGET` (يظهر بعد إنشاء النفق).

---

## 6) فحص ما قبل الإطلاق

```bash
npm run doctor:prod          # فحص شامل للإعدادات الإنتاجية
npm run security:audit       # فحص أمني
npm run preflight:prod       # تحقق نهائي قبل الإطلاق
curl https://crm.breexe-pro.com/api/health   # لازم يرجّع status: ok
```

---

## 7) اربط واتساب وفعّل الإرسال الحقيقي

1. سجّل دخول كمشرف (UID ضمن `ADMIN_UIDS`).
2. من لوحة التحكم › واتساب › اضغط «اتصال» وامسح الـ QR من جوال الشركة.
3. اختبر بـ «إرسال تجريبي» مع `OUTBOUND_CONFIRM_CODE`.
4. بعد نجاح الاختبار فقط: غيّر `OFFICIAL_LAUNCH_APPROVED=true` لتفعيل الإرسال الحقيقي.

---

## 8) اربط سلة

1. لوحة مطوّري سلة › Redirect URI = `https://crm.breexe-pro.com/api/integrations/salla/callback`.
2. Webhook URL = `https://crm.breexe-pro.com/api/integrations/salla/webhook` بسر `SALLA_APP_WEBHOOK_SECRET`.
3. من لوحة التحكم › تكاملات › سلة › «ربط».

---

## ملخص: البيانات اللي تدخلها أنت
- مفاتيح Supabase (service_role + anon)
- Firebase service account (JSON)
- UID المالك + ADMIN_UIDS
- بيانات تطبيق سلة (client id/secret)
- Cloudflare API token + DNS target
- عنوان الخادم وSSH
- الأسرار العشوائية الأربعة (من openssl)

أي خطوة تبيني أساعدك فيها مباشرة (مثل توليد الأسرار، أو ضبط systemd، أو إضافة نموذج فريق مشترك) — قل لي.
