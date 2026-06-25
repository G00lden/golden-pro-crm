# ملخص تسليم Golden Pro CRM

## سياق المحادثة

المطلوب كان تحويل المشروع إلى CRM عملي يعمل محليا الآن وقابل للنقل لاحقا إلى VPS/Cloud Run، مع Firestore، واتساب ويب، تذكيرات صيانة، وبيانات تجربة. بعد ذلك ظهرت مشكلة أن الإرسال والجدولة لا تعملان، فتم بناء محرك تذكيرات واضح يوقف الإرسال إذا كان واتساب غير متصل ويعرض التشخيص في الواجهة. الطلب الأخير هو ربط النظام مع متجر عبر Webhook.

## أهم الملفات المعدلة

- `server.ts`: مسارات API، الحماية، health، التذكيرات، وWebhook المتجر.
- `server/reminderEngine.ts`: منطق التذكيرات والجدولة.
- `server/whatsapp.ts`: اتصال واتساب عبر Baileys.
- `server/storeWebhook.ts`: منطق استقبال طلبات المتجر وتطبيعها وكتابتها في Firestore.
- `src/api.ts`: طبقة API للواجهة وأنواع البيانات.
- `src/App.tsx`: صفحات CRM، لوحة واتساب، تشخيص التذكيرات، ولوحة Webhook في الإعدادات.
- `firestore.rules`: قواعد الأمان للمجموعات.
- `firestore.indexes.json`: الفهارس المطلوبة للاستعلامات.
- `.env.example`: متغيرات التشغيل بدون أسرار.
- `docs/reminder-architecture.md`: معمارية التذكيرات.
- `docs/store-webhook-architecture.md`: معمارية Webhook المتجر.

## حالة التنفيذ

- تسجيل الدخول المحلي موجود كحل تطوير عندما لا تكون Firebase Auth مفعلة.
- Firestore يعمل عبر Firebase client في الواجهة، والعمليات الحساسة عبر Firebase Admin في السيرفر.
- واتساب يعتمد على Baileys وجلسة `.wa-session/`.
- التذكيرات لا تُرسل إذا كان واتساب غير متصل، وتظهر رسالة السبب في الواجهة.
- Webhook المتجر يستقبل الطلبات، يتحقق من السر/التوقيع، ثم ينشئ أو يحدث العميل والمنتج والتركيب، والحجز اختياريا.
- إشعار الفنيين مضاف: عند إنشاء/تعديل حجز مؤكد يرسل النظام موعد الصيانة إلى رقم الفني عبر قناة واتساب الحالية.
- قناة واتساب قابلة للتبديل عبر `WHATSAPP_PROVIDER=web` أو `WHATSAPP_PROVIDER=cloud_api`.

## متغيرات مهمة

```env
PORT=3000
APP_TIMEZONE=Asia/Riyadh
ENABLE_DAILY_CRON=false
REMINDER_CRON_SCHEDULE=0 10 * * *
WA_SESSION_DIR=.wa-session
WHATSAPP_PROVIDER=web
WHATSAPP_CLOUD_API_VERSION=v23.0
WHATSAPP_CLOUD_PHONE_NUMBER_ID=
WHATSAPP_CLOUD_API_TOKEN=
FIREBASE_SERVICE_ACCOUNT_PATH=
FIREBASE_SERVICE_ACCOUNT_JSON=
ALLOW_LOCAL_AUTH=true
VITE_LOCAL_AUTH=true

STORE_WEBHOOK_SECRET=
STORE_WEBHOOK_OWNER_UID=
STORE_WEBHOOK_DEFAULT_MAINTENANCE_MONTHS=3
STORE_WEBHOOK_CREATE_BOOKINGS=false
STORE_WEBHOOK_DEFAULT_TECHNICIAN_ID=
STORE_WEBHOOK_DEFAULT_TECHNICIAN_NAME=
```

## أوامر التحقق

```bash
npm install
npm run lint
npm run build
npm run test:smoke
npm run dev
```

## نقاط تحتاج انتباه الوكيل التالي

- يجب ضبط `STORE_WEBHOOK_OWNER_UID` على UID المستخدم الحقيقي في Firebase.
- يجب ضبط `STORE_WEBHOOK_SECRET` في السيرفر والمتجر بنفس القيمة.
- إن كان المطلوب منصة متجر محددة مثل Shopify أو Salla أو Zid، يمكن إضافة mapper خاص لها داخل `server/storeWebhook.ts` مع إبقاء المعالج العام.
- إرسال واتساب الحقيقي يتطلب ربط QR وظهور الحالة `connected`.
- في الإنتاج، الأفضل تشغيل واتساب على VPS أو خدمة طويلة العمر، وليس Cloud Run فقط.

---

## آخر تحديث: 2026-06-19 — Supervisor Sprint #2 kickoff

### حالة Git
- المستودع البعيد: https://github.com/G00lden/golden-pro-crm (private)
- آخر commit في `main`: `e3853dc` — security: harden daily-use readiness and backups
- Working tree نظيف على main. مستعد لإستقبال الـ branches الجديدة.

### حالة Dev Server
- يعمل على http://localhost:3000 — `/api/health` = ok
- واتساب: غير متصل (يحتاج QR)، outbound mode: `code`
- التذكيرات: cron مفعّل كل 10 دقائق، لكنها متوقفة لأن واتساب غير متصل
- Salla: متكامل، Cron مزامنة كل 15 دقيقة

### Supervisor snapshot (2026-06-19)
```
Lint:        ✓
Build:       ✓ (skipped by default but verified)
Secrets:     ✓ (0 hits)
npm audit:   critical=1 high=2 (both baileys/protobuf transitive)
Checklist:   10/71 done, 10 in-progress, 51 todo, 9 hard-gate remaining
Open PRs:    0
```

### Sprint #2 — 3 task briefs written (docs/templates/)

| # | الوكيل | البنود | الفرع |
|---|--------|--------|-------|
| 1 | **Codex** | `2.5 🔒` Rate limiting (per-UID) + `2.6 🔒` Zod input validation | `codex/security-rate-limit-zod` |
| 2 | **Claude Code** | `5.9` GTM container + `5.10` GA4 + `5.11` Meta Pixel | `claude/ad-tracking-gtm-pixels` |
| 3 | **Hermes** | `3.1` Arabic copy audit + `5.31` Brand voice guideline | `hermes/arabic-copy-brand` |

### أبدا مع أي وكيل؟
كل task brief مكتوب كـ `docs/templates/task-brief-<agent>-sprint2.md`. افتح الوكيل المطلوب والصق الـ brief كأول رسالة.

### أولويات المحادثة (next-in-line بعد Sprint #2)
- `1.6` Dockerfile produces runnable image
- `1.7` Cloud Run + VPS deploy scripts
- `5.12-5.15` باقي pixels (TikTok, Snap, Google Ads, Clarity)
- `4.1` Payment gateway (Tap or Moyasar)
- `4.3` Terms of Service + Privacy Policy pages

---

## آخر تحديث: 2026-06-25 — نظام المكالمات والتحويل (IVR + واتساب) [Claude Code]

### ماذا أُضيف
نظام رد على المكالمات الهاتفية العادية وتوجيهها عبر **Unifonic**:
- رقم أساسي يُنشر في الإعلانات → قائمة صوتية (IVR) → تحويل لجوال الموظف المختص.
- عند عدم الرد (no_answer/busy/failed/voicemail) → واتساب للعميل (`missed_call_customer`) وللموظف (`missed_call_agent`).

### الملفات الجديدة
- `server/telephony/types.ts`، `server/telephony/unifonicAdapter.ts` — طبقة مزوّد معزولة.
- `server/ivrEngine.ts` — منطق القرار + DB + تدفق المكالمة الفائتة.
- `server/routes-telephony.ts` — webhooks عامة + admin CRUD + `test-missed`.
- `src/pages/CallSystem.tsx` — لوحة «نظام المكالمات».
- `docs/telephony-architecture.md` — المعمارية الكاملة.

### الملفات المعدّلة
- `server/db.ts` (+4 جداول: telephony_config, ivr_departments, ivr_department_agents, call_logs)،
  `server/whatsappTemplates.ts` (+قالبان)، `server/validation.ts` (+مخططات)، `server.ts` (تسجيل المسارات)،
  `.env.example` (+مفاتيح TELEPHONY_*/UNIFONIC_*)، `src/api.ts` + `src/App.tsx` + `src/shared.tsx` (الواجهة).

### الحالة
- `npm run lint` ✓ ، `npm run build` ✓.
- تم اختبار التدفق محلياً end-to-end (قائمة → تحويل برقم مُطبّع 9665.. → مكالمة فائتة → واتساب للطرفين).

### يحتاج انتباه الوكيل التالي / المالك
- **أسماء حقول Unifonic**: المحوّل دفاعي ويقبل أكثر الأسماء شيوعاً؛ تأكيد العقد الفعلي من توثيق حساب Unifonic وتعديل `unifonicAdapter.ts` فقط (تعليقات `// CONFIRM`).
- ضبط `TELEPHONY_WEBHOOK_SECRET` و`PUBLIC_BASE_URL` و`UNIFONIC_*` في `.env`، وربط IVR Endpoint + Status Callback في لوحة Unifonic.
- `TELEPHONY_WEBHOOK_SECRET` إلزامي في الإنتاج (الـ webhook يُرفض 503 بدونه).
