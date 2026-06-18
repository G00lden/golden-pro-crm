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

## آخر تحديث: 2026-06-18 — Multi-agent setup (Claude Code)

### حالة Git
- المستودع البعيد: https://github.com/G00lden/golden-pro-crm (private)
- الفرع: `main` — last commit `12e9c90` (payment fields + manual WhatsApp send WIP)
- Working tree نظيف. الفروع المحلية والبعيدة متزامنة.

### حالة Dev Server
- يعمل حاليًا على http://localhost:3000 (PID قابل للتغيير).
- `/api/health` يرجع `status: ok`، المنطقة الزمنية `Asia/Riyadh`.
- جدولة Cron مفعّلة: التذكيرات `*/10`، مزامنة Salla `*/15`، تنبيه الفنيين `*/10`.
- وضع outbound: `code` (الإرسال يتطلب كود تفعيل من الواجهة).

### الوكلاء الثلاثة على نفس المجلد
- اقرأ [AGENTS.md](../AGENTS.md) في جذر المشروع — هذا هو "العقد" بين Codex / Claude Code / Hermes.
- ابدأ كل جلسة بـ: `git fetch && git pull --rebase` ثم اقرأ هذا الملف.
- انهِ كل جلسة بـ: `git add -A && git commit -m "<msg>" && git push`.
- لتشغيل الثلاثة دفعة واحدة: `open-all-agents.cmd` في جذر المشروع.

### آخر تغييرات WIP (commit 12e9c90)
- إضافة حقول الدفع (طريقة، نسبة المقدم/النهائي، البنك، IBAN) على Customer/Quote.
- مسار `/api/whatsapp/send` يدوي مع تسجيل في `whatsapp_messages`.
- تعديلات schema في SQLite + Supabase adapter لتطابق.
- تعديلات UI في `Quotes.tsx` و`WhatsAppConsole.tsx`.

### "أكمل من حيث وقفت" — أولويات الوكيل التالي
1. **اختبر مسار `/api/whatsapp/send` يدويًا** من `WhatsAppConsole.tsx` بعد ربط QR.
2. **اربط حقول الدفع الجديدة في `Quotes.tsx`** بقالب PDF عرض السعر (`public/quotation-template.html`).
3. **شغّل `npm run lint`** قبل أي commit جديد — الـTypeScript يتحقق من حقول الدفع الجديدة في `src/api.ts`.
4. **إذا تعطل WhatsApp**: امسح `.wa-session/` ثم أعد فتح صفحة الكونسول لإعادة ربط QR.
5. **قبل push لـmain**: `npm run lint && npm run build` يجب أن يمرّا.
