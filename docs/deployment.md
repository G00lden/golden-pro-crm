# النشر — Golden Pro CRM (فرونت + باك + داتابيس + استضافة)

> النظام **حاوية واحدة دائمة التشغيل** تخدم الواجهة + الـ API + قاعدة SQLite
> (بيانات المكالمات/الأقسام) + جلسة واتساب. مناسب لـ **VPS** أو أي مضيف Docker.
> **غير مناسب** للـ serverless (Cloud Run) لأن واتساب + SQLite يحتاجان عملية
> دائمة وقرصاً ثابتاً.

## المكوّنات الأربعة وأين تعيش

| الطبقة | التقنية | أين |
|--------|---------|-----|
| الفرونت اند | Vite + React (مبني في `dist/`) | يخدمه السيرفر نفسه في الإنتاج (`express.static`) |
| الباك اند | Express + tsx (`server.ts`) | نفس الحاوية، منفذ 8080 |
| الداتابيس (المكالمات/الأقسام/الطابور) | SQLite (`better-sqlite3`) | ملف على volume ثابت (`/app/.runtime`) |
| بيانات CRM (عملاء/منتجات) | Supabase/Firestore (حسب `DATA_PROVIDER`) | خدمة خارجية تضبط مفاتيحها |
| جلسة واتساب | Baileys linked-device | volume ثابت (`/app/.wa-session`) |

## المسار المدعوم: معاملة النشر المقفلة على VPS

```powershell
# 1) جهّز ملف الإنتاج
Copy-Item .env.production.example .env.production
#    املأ الأسرار: GATEWAY_TOKEN, TELEPHONY_WEBHOOK_SECRET, PUBLIC_BASE_URL=https://نطاقك,
#    SUPABASE_*، FIREBASE_*، OUTBOUND_MODE=production (عند الجاهزية) ...
#    توليد سر: openssl rand -hex 24

# 2) انشر من جهاز الإدارة عبر المعاملة المقفلة
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/deploy-vps.ps1 `
  -HostName "SERVER_IP" -SshKey "C:\path\to\key.pem" -SkipDns

# لأول نشر فقط، وبعد التأكد أنه لا توجد خدمة أو بيانات سابقة:
# أضف -AllowFirstDeployWithoutBackup

```

بعد نجاح المعاملة يمكن على الخادم استخدام أوامر القراءة فقط:

```bash
cd /opt/golden-pro-crm
docker compose --env-file .env.production -f deploy/docker-compose.yml ps
docker compose --env-file .env.production -f deploy/docker-compose.yml logs -f crm
```
- البيانات والجلسة محفوظة في volumes المنطقية `crm_data` و`crm_runtime` و`crm_wa_session`، وتبقى عبر إعادة التشغيل والنشر.
- خدمة CRM مربوطة محليًا فقط على `127.0.0.1:3000`، وCaddy المضمّن هو منفذ HTTPS العام الوحيد.

## الواجهة العكسية + HTTPS (لازمة للوصول العام)

واتساب والمزوّد والجوال يحتاجون عنوان **HTTPS** عامًا. معاملة النشر تشغّل Caddy
المضمّن في `deploy/docker-compose.yml` وتتحقق من `deploy/Caddyfile` ومن المسارين
المحلي والعام قبل اعتماد الإصدار. اضبط `CRM_DOMAIN` و`PUBLIC_BASE_URL` في ملف
`.env.production` المحلي ثم أعد النشر بالمعاملة. لا تعدّل `/etc/caddy/Caddyfile`
ولا تشغّل Caddy آخر على الخادم؛ فهذا يسبب تعارض المنافذ ويتجاوز الاسترجاع.

> بديل سريع بدون VPS للتجربة: نفق Cloudflare (`scripts/run-cloudflare-tunnel.ps1`)
> يعطيك عنوان HTTPS عام يشير لجهازك المحلي — مفيد للاختبار، ليس للإنتاج الدائم.

## التشغيل بدون Docker

التشغيل المباشر غير مدعوم للإنتاج على VPS؛ لأنه يتجاوز معاملة النسخ الاحتياطي والقفل
وفحص الإصدار والتراجع. استخدمه للتطوير المحلي المعزول فقط عبر `npm run dev`، وكل
تشغيل عام أو دائم يجب أن يمر عبر `scripts/deploy-vps.ps1` كما في الأعلى.

## فحص الجاهزية

```bash
npm run preflight:prod      # يفحص متغيرات/أسرار الإنتاج
npm run lint && npm run test:unit && npm run build && npm run test:smoke
curl https://نطاقك/api/health        # يجب 200 و status: ok
```

نشر VPS المضمّن يستخدم SQLite ويثبت `DB_PATH=/app/.runtime/golden-crm.db`. إذا
اختير Supabase في نشر آخر، يجب تطبيق جميع الملفات تحت `supabase/migrations/`
أولاً ثم تشغيل `npm run db:verify`. يفحص الأمر أعمدة سجل الفواتير وجدول العداد
ووجود `allocate_invoice_sequence` قراءةً فقط؛ غياب أي منها يمنع تبديل التطبيق
إلى Supabase لأن إصدار الفواتير يعتمد على الحجز الذري لهذا الإجراء.

## بعد النشر (تشغيل فعلي)

1. افتح اللوحة → «واتساب» → امسح QR لربط واتساب (تُحفظ الجلسة على volume).
2. أضِف الأقسام والموظفين من صفحة «نظام المكالمات».
3. للمكالمات العادية: اضبط MacroDroid على عنوان `PUBLIC_BASE_URL` مع `GATEWAY_TOKEN` (انظر `docs/gateway-setup.md`).
4. عند الجاهزية للإرسال الحقيقي: `OUTBOUND_MODE=production` + `OFFICIAL_LAUNCH_APPROVED=true`.

## نسخ احتياطي

استخدم مساعد النسخ المقفّل؛ فهو يكتشف حاوية Compose الفعلية وينسخ قاعدة SQLite
وجلسة واتساب والبيئة وحالة النشر بدل الاعتماد على أسماء volumes يدوية.
```bash
APP_DIR=/opt/golden-pro-crm bash scripts/vps-backup.sh
```
