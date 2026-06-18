# نشر Golden Pro CRM على crm.breexe-pro.com

هذا الملف هو خطة التنفيذ العملية للدومين:

```text
crm.breexe-pro.com
```

## القرار

- الدومين الأساسي: `breexe-pro.com`
- فرع CRM: `crm.breexe-pro.com`
- رابط الويب هوك النهائي في سلة:

```text
https://crm.breexe-pro.com/api/store/webhook
```

## المعمارية المقترحة الآن

```text
Salla
  -> https://crm.breexe-pro.com/api/store/webhook
  -> Firebase Hosting
  -> Cloud Run service: golden-pro-crm
  -> Firestore
```

هذا المسار مناسب إذا كان الإرسال عبر WhatsApp Cloud API أو Telegram API.
إذا قررت استخدام WhatsApp Web بشكل دائم، الأفضل لاحقا نقل نفس المشروع إلى VPS لأن جلسة WhatsApp Web تحتاج سيرفر طويل العمر ومجلد جلسة ثابت.

## ما يلزم من حسابك

لا يمكن تنفيذ هذه الخطوات بالكامل بدون دخولك لحساباتك، لأن Google/Firebase ومالك الدومين سيطلبان تسجيل دخول وربما تفعيل فوترة.

المطلوب منك:

1. تسجيل الدخول إلى Firebase/Google على هذا الجهاز.
2. تفعيل Firestore.
3. تفعيل Authentication.
4. إضافة سجلات DNS في لوحة شركة الدومين عند ظهورها من Firebase.

## أدوات النشر المحلية

تم تثبيت أدوات النشر داخل مجلد المشروع في `.tools/` حتى لا تحتاج صلاحيات مدير على ويندوز.

اختبار Firebase CLI:

```powershell
.\.tools\firebase\firebase-tools-win.exe --version
```

اختبار Google Cloud CLI:

```powershell
.\.tools\gcloud\google-cloud-sdk\bin\gcloud.cmd --version
```

ثم سجّل الدخول:

```powershell
.\.tools\firebase\firebase-tools-win.exe login
.\.tools\gcloud\google-cloud-sdk\bin\gcloud.cmd auth login
```

يمكنك لاحقا تثبيت الأدوات عالميا إذا رغبت، لكن الأوامر أعلاه تكفي للنشر من هذا المشروع.

## إنشاء أو اختيار مشروع Firebase

يفضل إنشاء مشروع جديد باسم واضح مثل:

```text
breexe-pro-crm
```

بعد الإنشاء:

```powershell
.\.tools\gcloud\google-cloud-sdk\bin\gcloud.cmd config set project YOUR_PROJECT_ID
.\.tools\firebase\firebase-tools-win.exe use --add
```

اختر alias:

```text
production
```

## Firestore

من Firebase Console:

1. Build > Firestore Database.
2. Create database.
3. Native mode.
4. اختر أقرب موقع متاح، مثل `me-central1` إن توفر.

مهم: موقع Firestore لا يمكن تغييره بعد الإنشاء.

ثم من المشروع:

```powershell
npm run deploy:firestore
```

## Authentication

من Firebase Console:

1. Authentication > Sign-in method.
2. فعل Email/Password.
3. فعل Google إن رغبت.
4. Authentication > Settings > Authorized domains.
5. أضف:

```text
crm.breexe-pro.com
```

## متغيرات الإنتاج

استخدم القيم التالية كأساس في بيئة Cloud Run:

```env
NODE_ENV=production
PORT=8080
APP_TIMEZONE=Asia/Riyadh
APP_URL=https://crm.breexe-pro.com

ALLOW_LOCAL_AUTH=false
VITE_LOCAL_AUTH=false

ENABLE_DAILY_CRON=true
REMINDER_CRON_SCHEDULE=0 10 * * *

STORE_WEBHOOK_SECRET=ضع_قيمة_سرية_طويلة
STORE_WEBHOOK_OWNER_UID=ضع_UID_المستخدم_المالك
STORE_WEBHOOK_DEFAULT_MAINTENANCE_MONTHS=3
STORE_WEBHOOK_CREATE_BOOKINGS=true

WHATSAPP_PROVIDER=cloud_api
WHATSAPP_CLOUD_API_VERSION=v23.0
WHATSAPP_CLOUD_PHONE_NUMBER_ID=
WHATSAPP_CLOUD_API_TOKEN=
WHATSAPP_CLOUD_TEMPLATE_NAME=
WHATSAPP_CLOUD_TEMPLATE_LANGUAGE=ar
```

إذا بقيت على WhatsApp Web مؤقتا:

```env
WHATSAPP_PROVIDER=web
WA_SESSION_DIR=.wa-session
```

لكن لا يوصى بهذا على Cloud Run.

## النشر إلى Cloud Run و Firebase Hosting

من مجلد المشروع:

```powershell
npm install
npm run lint
npm run build
.\.tools\gcloud\google-cloud-sdk\bin\gcloud.cmd run deploy golden-pro-crm --source . --region me-central1 --allow-unauthenticated
.\.tools\firebase\firebase-tools-win.exe deploy --only hosting,firestore
```

ملف `firebase.json` جاهز حاليا لتمرير:

```text
/api/**
```

إلى خدمة Cloud Run:

```text
golden-pro-crm
```

في المنطقة:

```text
me-central1
```

## ربط الدومين

من Firebase Console:

1. Hosting.
2. Add custom domain.
3. اكتب:

```text
crm.breexe-pro.com
```

4. Firebase سيعطيك سجلات DNS.
5. افتح لوحة شركة الدومين `breexe-pro.com`.
6. أضف السجلات كما هي.
7. انتظر تفعيل SSL.

لا تختر سجلات DNS من هذا الملف؛ استخدم القيم التي يعطيها Firebase لأنها قد تختلف.

## إعداد سلة

في سلة:

- نوع الحدث المتاح حاليا عندك: `انشاء فاتورة طلب`
- إصدار Webhook: v2
- رابط الحدث:

```text
https://crm.breexe-pro.com/api/store/webhook
```

- Header key:

```text
X-Golden-Webhook-Secret
```

- Header value:

```text
نفس STORE_WEBHOOK_SECRET
```

ملاحظة: بما أن حدث `Order Created` غير ظاهر عندك في سلة، قد لا يصل الطلب فور إنشائه. للحل التجاري الصحيح نضيف لاحقا مزامنة Salla API دورية تسحب الطلبات الجديدة حتى لو الويب هوك لم ينطلق.

## فحص الجاهزية

قبل النشر:

```powershell
npm run doctor:prod
```

يجب ألا تظهر أي `FAIL`.

بعد النشر:

```text
https://crm.breexe-pro.com/api/health
```

يجب أن يرجع:

```json
{"status":"ok"}
```
