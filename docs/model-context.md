# Model Context - Golden Pro CRM

هذا الملف مخصص لإعطاء أي موديل أو وكيل برمجي سياقا كاملا وسريعا عن المشروع قبل طلب أي تعديل.

## ما هو المشروع؟

Golden Pro CRM هو نظام لإدارة:

- العملاء.
- المنتجات.
- التركيبات والصيانة.
- الفنيين والحجوزات.
- تذكيرات الصيانة.
- طلبات المتجر القادمة من سلة عبر Webhook.
- رعاية العملاء حتى لا يبقى أي عميل بدون متابعة أو استهداف.

النظام يعمل محليا الآن، ومجهز للنقل إلى Firestore + VPS أو Cloud Run. WhatsApp Web مناسب أكثر لـ VPS، وWhatsApp Cloud API مناسب أكثر لـ Cloud Run.

## التقنية

- Frontend: React + Vite + TypeScript.
- Backend: Express + TypeScript عبر `tsx`.
- Database: Firebase Firestore.
- Auth: Firebase Auth، مع local auth للتجربة فقط.
- Admin operations: Firebase Admin SDK.
- WhatsApp Web: Baileys.
- WhatsApp Cloud API: Meta Graph API.
- Scheduling: `node-cron`.

## أهم أوامر التشغيل

```powershell
npm install
npm run dev
npm run lint
npm run build
npm run test:smoke
npm run doctor
npm run doctor:prod
```

التشغيل المحلي:

```text
http://localhost:3000
```

## هيكل الملفات

```text
src/
  App.tsx            واجهة التطبيق والصفحات والنماذج
  api.ts             Types + CRUD + localStorage + Firestore + calls to Express API
  firebase.ts        Firebase client/auth/firestore helpers
  index.css          تصميم الواجهة
  main.tsx           نقطة دخول React

server/
  auth.ts                    Firebase/local auth middleware
  firebaseAdmin.ts           Firebase Admin initialization
  storeWebhook.ts            Salla webhook journey
  reminderEngine.ts          due maintenance reminders
  whatsapp.ts                WhatsApp Web/Cloud API provider
  bookingLifecycle.ts        booking completion and maintenance cycle reset
  bookingNotifications.ts    technician WhatsApp notifications

scripts/
  doctor.mjs         environment readiness checks
  smoke.mjs          smoke tests for core logic

docs/
  architecture-development-guide.md   full architecture and dev guide
  external-agent-brief.md             short handoff prompt for another agent
  store-webhook-architecture.md       store order journey
  reminder-architecture.md            reminder engine
  cloud-deployment.md                 deployment guide
  handoff-summary.md                  previous conversation summary
  model-context.md                    this file
```

## قاعدة البيانات

Firestore collections:

- `customers`
- `products`
- `installations`
- `technicians`
- `bookings`
- `reminders`
- `technician_notifications`
- `settings`
- `store_orders`
- `store_webhook_events`

قاعدة ثابتة: كل مستند يخص مستخدما يجب أن يحتوي `createdBy`.

## رحلة العميل والطلب

مصدر العميل:

- `manual`: إدخال يدوي من الواجهة.
- `salla`: طلب من سلة عبر Webhook.

تصنيف بنود سلة:

- `SALE-` أو `sale_only`: بيع فقط. يحفظ العميل والطلب ولا ينشئ تركيب أو حجز.
- `INSTALL-` أو `install_maintenance`: منتج جديد يحتاج تركيب وصيانة.
- `MAINT-` أو `maintenance_existing`: طلب صيانة لمنتج سابق.
- `EXT-` أو `external_maintenance`: صيانة جهاز خارجي ليس من Golden Pro.
- غير واضح: `needs_review`.

المنطق:

1. سلة ترسل `POST /api/store/webhook`.
2. السيرفر يتحقق من `STORE_WEBHOOK_SECRET` أو HMAC.
3. `server/storeWebhook.ts` يطبع بيانات العميل والطلب والبنود.
4. ينشئ أو يحدث `customers` و`products`.
5. `SALE-` يسجل فقط في `store_orders`.
6. `INSTALL-` ينشئ `installations.status = pending_installation`.
7. `MAINT-` يبحث عن تركيب سابق بنفس رقم الجوال وSKU normalized، مثل مطابقة `MAINT-GP-FILTER` مع `INSTALL-GP-FILTER`.
8. `EXT-` ينشئ `installations.status = pending_external_service`.
9. إذا يوجد موعد وفني افتراضي، ينشئ `bookings`.
10. إذا فشل ربط صيانة سابقة، يدخل الطلب `needs_review`.
11. صفحة "طلبات المتجر" تسمح بالربط اليدوي.
12. عند الربط اليدوي ومع وجود موعد وفني افتراضي، ينشئ النظام حجزا تلقائيا.
13. عند إكمال الحجز، تتحول الخدمة إلى `active` ويحسب `next_maintenance`.
14. محرك التذكيرات يرسل فقط للخدمات `active`.
15. صفحة "رعاية العملاء" تعرض العملاء الذين يحتاجون متابعة.

## الإرسال والتذكيرات

الملفات:

- `server/reminderEngine.ts`
- `server/whatsapp.ts`
- `src/api.ts`
- `src/App.tsx`

القواعد:

- لا ترسل تذكير إذا WhatsApp غير متصل.
- لا تعتبر الرسالة مرسلة إلا إذا رجع مزود WhatsApp بنجاح.
- الفشل يسجل في `reminders.status = failed`.
- النجاح يسجل في `reminders.status = sent`.
- لا تكرر إرسال تذكير ناجح لنفس التركيب في نفس اليوم.
- `last_remind_attempt_at` يمنع المحاولات المتكررة بسرعة.
- WhatsApp Cloud API يدعم قالبا اختياريا:
  - `WHATSAPP_CLOUD_TEMPLATE_NAME`
  - `WHATSAPP_CLOUD_TEMPLATE_LANGUAGE`

## أين أضيف ميزة؟

- صفحة/زر/نموذج: `src/App.tsx`.
- Type أو CRUD أو استدعاء API: `src/api.ts`.
- Route API: `server.ts`.
- Webhook أو ربط سلة: `server/storeWebhook.ts`.
- تذكيرات: `server/reminderEngine.ts`.
- واتساب: `server/whatsapp.ts`.
- إكمال حجز: `server/bookingLifecycle.ts`.
- إشعار فني: `server/bookingNotifications.ts`.
- قاعدة Firestore: `firestore.rules`.
- فهرس Firestore: `firestore.indexes.json`.
- فحص أساسي: `scripts/smoke.mjs`.
- بيئة التشغيل: `.env.example` و`scripts/doctor.mjs`.

## قواعد تعديل لا تكسرها

- لا تحفظ أسرار أو tokens في الملفات.
- لا ترفع `.env`, `.wa-session`, `node_modules`, `dist`.
- لا تنشئ تركيب من SKU غير مصنف؛ استخدم `needs_review`.
- لا تكتب Firestore document بدون `createdBy`.
- لا تضف query مركب بدون index.
- لا تضف حقل client-write بدون تحديث `firestore.rules`.
- حافظ على وضع local auth للتجربة، لكن عطله في الإنتاج.
- بعد أي تعديل مهم شغل `lint`, `build`, `test:smoke`, `doctor`.

## الملفات التي يجب إرسالها لموديل آخر

أرسل له حزمة السورس أو هذه الملفات على الأقل:

- `package.json`
- `package-lock.json`
- `server.ts`
- `src/**`
- `server/**`
- `scripts/**`
- `docs/**`
- `.env.example`
- `firebase.json`
- `firestore.rules`
- `firestore.indexes.json`
- `Dockerfile`
- `vite.config.ts`
- `tsconfig.json`
- `README.md`

لا ترسل:

- `.env`
- `.wa-session`
- `node_modules`
- `dist`
- ملفات log

## طلب جاهز لموديل آخر

```text
هذا مشروع Golden Pro CRM. اقرأ أولا:
- docs/model-context.md
- docs/architecture-development-guide.md
- docs/external-agent-brief.md

ثم نفذ التعديل المطلوب مع الالتزام:
- الواجهة في src/App.tsx
- data layer في src/api.ts
- العمليات الحساسة في server.ts وخدمات server/
- كل Firestore doc يحتوي createdBy
- حدّث firestore.rules وfirestore.indexes.json عند الحاجة
- حدّث scripts/smoke.mjs لأي رحلة أساسية
- لا تحفظ أسرار في الملفات

بعد التنفيذ شغل:
npm run lint
npm run build
npm run test:smoke
npm run doctor

المطلوب: [اكتب طلبك هنا]
```
