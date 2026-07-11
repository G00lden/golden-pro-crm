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

## الأسرع: Docker Compose (موصى به لأي VPS)

```bash
# 1) جهّز ملف الإنتاج
cp .env.production.example .env.production
#    املأ الأسرار: GATEWAY_TOKEN, TELEPHONY_WEBHOOK_SECRET, PUBLIC_BASE_URL=https://نطاقك,
#    SUPABASE_*، FIREBASE_*، OUTBOUND_MODE=production (عند الجاهزية) ...
#    توليد سر: openssl rand -hex 24

# 2) شغّل (يبني الصورة + يقلع)
docker compose up -d --build

# 3) تابع السجل واطلب الـ QR من اللوحة لربط واتساب
docker compose logs -f
```
- البيانات وجلسة واتساب محفوظة على volumes (`crm-data`, `crm-wa`) وتبقى عبر إعادة التشغيل/النشر.
- المنفذ: `3000:8080` (المضيف:الحاوية). ضع **reverse proxy + HTTPS** أمامها (انظر أدناه).

## الواجهة العكسية + HTTPS (لازمة للوصول العام)

واتساب/المزوّد/الجوال يحتاجون عنوان **HTTPS** عاماً. على VPS استخدم Caddy (الأبسط):

```
# /etc/caddy/Caddyfile
crm.YOURDOMAIN.com {
    reverse_proxy 127.0.0.1:3000
}
```
ثم اضبط `PUBLIC_BASE_URL=https://crm.YOURDOMAIN.com` في `.env.production`.

> بديل سريع بدون VPS للتجربة: نفق Cloudflare (`scripts/run-cloudflare-tunnel.ps1`)
> يعطيك عنوان HTTPS عام يشير لجهازك المحلي — مفيد للاختبار، ليس للإنتاج الدائم.

## بدون Docker (تشغيل مباشر على VPS/جهاز)

> `npm start` يخدم `dist` فقط. لا تستخدم `npm run dev` خلف Cloudflare أو أي نطاق عام.

```bash
npm ci
npm run build
NODE_ENV=production ENV_FILE=.env.production PORT=3000 npm start
# أبقِها دائمة عبر pm2 أو systemd، وثبّت DB_PATH على مسار ثابت يُنسخ احتياطياً.
```

## فحص الجاهزية

```bash
npm run preflight:prod      # يفحص متغيرات/أسرار الإنتاج
npm run lint && npm run build && npm run test:smoke
curl https://نطاقك/api/health        # يجب 200 و status: ok
```

## بعد النشر (تشغيل فعلي)

1. افتح اللوحة → «واتساب» → امسح QR لربط واتساب (تُحفظ الجلسة على volume).
2. أضِف الأقسام والموظفين من صفحة «نظام المكالمات».
3. للمكالمات العادية: اضبط MacroDroid على عنوان `PUBLIC_BASE_URL` مع `GATEWAY_TOKEN` (انظر `docs/gateway-setup.md`).
4. عند الجاهزية للإرسال الحقيقي: `OUTBOUND_MODE=production` + `OFFICIAL_LAUNCH_APPROVED=true`.

## نسخ احتياطي

انسخ دورياً الـ volumes: `crm-data` (قاعدة SQLite) و`crm-wa` (جلسة واتساب).
```bash
docker run --rm -v golden-pro-crm_crm-data:/d -v "$PWD":/b alpine tar czf /b/crm-data-backup.tgz -C /d .
```
