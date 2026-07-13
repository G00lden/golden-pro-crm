# Golden Pro CRM

نظام CRM لإدارة العملاء والمنتجات والصيانة والحجوزات والفنيين، مع دعم Firestore السحابي وWhatsApp Web عبر QR.

## التشغيل المحلي الآن

```bash
npm install
npm run dev
```

ثم افتح:

```text
http://localhost:3000
```

ملف `.env` الحالي يفعل وضع الدخول المحلي:

```env
ALLOW_LOCAL_AUTH=true
VITE_LOCAL_AUTH=true
```

هذا الوضع مخصص للتطوير عندما لا تكون طرق تسجيل الدخول مفعلة في Firebase بعد. بيانات CRM في هذا الوضع تحفظ في `localStorage` داخل المتصفح، ويمكنك اختبار العملاء والمنتجات والتركيبات والفنيين والحجوزات وسجل التذكيرات مباشرة.

لملء النظام بسرعة اضغط زر "إضافة 10 تجربة" من لوحة التحكم أو الإعدادات. يعمل الزر في الوضع المحلي ومع Firestore، ويضيف عملاء ومنتجات وتركيبات وفنيين وحجوزات تغطي الحالات النشطة والمكتملة والملغاة. أرقام بيانات التجربة غير صالحة عمدا حتى لا يرسل واتساب رسائل حقيقية بالخطأ، لذلك ستظهر محاولات التذكير الفاشلة في سجل الرسائل مع سبب الفشل.

## وضع Firebase السحابي

لكي يعمل الدخول وقاعدة Firestore السحابية بالكامل:

1. افتح Firebase Console.
2. من Authentication > Sign-in method فعّل Email/Password أو Google.
3. من Authentication > Settings > Authorized domains تأكد أن `localhost` موجود.
4. وفر صلاحيات Admin للسيرفر محليا بإحدى الطريقتين:

```env
FIREBASE_SERVICE_ACCOUNT_PATH=C:\path\to\service-account.json
```

أو:

```env
FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
```

5. عند الانتقال للإنتاج أوقف وضع الدخول المحلي:

```env
ALLOW_LOCAL_AUTH=false
VITE_LOCAL_AUTH=false
```

## Firestore

المجموعات المستخدمة:

- `customers`
- `products`
- `installations`
- `technicians`
- `bookings`
- `reminders`
- `settings`

انشر القواعد والفهارس:

```bash
firebase deploy --only firestore
```

## WhatsApp Web

من تبويب "واتساب والسجل":

1. افتح "اتصال واتساب".
2. اضغط بدء الاتصال.
3. امسح QR من WhatsApp > Linked devices.

جلسة واتساب تحفظ في `.wa-session/`. على VPS اجعل هذا المجلد دائما ولا تحذفه.

## WhatsApp API بدل WhatsApp Web

يمكن تبديل قناة الإرسال بدون تغيير منطق التذكيرات والحجوزات:

```env
WHATSAPP_PROVIDER=cloud_api
WHATSAPP_CLOUD_API_VERSION=v23.0
WHATSAPP_CLOUD_PHONE_NUMBER_ID=
WHATSAPP_CLOUD_API_TOKEN=
WHATSAPP_CLOUD_TEMPLATE_NAME=
WHATSAPP_CLOUD_TEMPLATE_LANGUAGE=ar
```

عند استخدام `cloud_api` لن تحتاج QR، وستظهر حالة واتساب متصلة إذا كانت بيانات API مضبوطة. رسائل التذكير ورسائل الفنيين تمر من نفس دالة الإرسال.

ملاحظة تشغيلية: في WhatsApp Business Cloud API قد تحتاج رسائل القوالب المعتمدة للرسائل التي يبدأها النشاط التجاري خارج نافذة المحادثة، خصوصا عند إرسال موعد لفني لم يسبق له مراسلة رقم النشاط خلال آخر 24 ساعة.

إذا ضبطت `WHATSAPP_CLOUD_TEMPLATE_NAME` يستخدم النظام قالب WhatsApp معتمد فيه متغير جسم واحد `{{1}}`، ويمرر نص التذكير أو إشعار الفني داخل هذا المتغير. إذا تركته فارغا يستخدم رسالة نصية عادية.

## إشعار الفنيين

عند إنشاء حجز مؤكد أو تعديل موعد/فني حجز مؤكد، يرسل النظام للفني رسالة واتساب تحتوي:

- اسم العميل.
- جوال العميل.
- الخدمة/المنتج.
- التاريخ والوقت.
- حالة الموعد.

يمكن أيضا إرسال الموعد يدويا من صفحة "الحجوزات" عبر زر الإرسال بجانب الحجز المؤكد. يتم حفظ سجل الإرسال في `technician_notifications`.

## تذكيرات الصيانة

- عند تسجيل الدخول يراجع النظام التركيبات النشطة التي حل موعد صيانتها ويرسل التذكيرات المستحقة.
- في التشغيل المحلي يعيد المتصفح الفحص تلقائيا كل 10 دقائق ما دام المستخدم مسجلا.
- في تشغيل السيرفر يفعل `ENABLE_DAILY_CRON=true` مهمة مجدولة، ويمكن ضبط الجدولة عبر `REMINDER_CRON_SCHEDULE`.
- لا يتم احتساب الرسائل الفاشلة ضمن "رسائل اليوم"، ويتم عرض سبب الفشل في سجل الرسائل.
- لا يكرر النظام إرسال تذكير ناجح لنفس التركيب في نفس اليوم.

تفاصيل المعمارية وخط سير الإرسال موثقة في `docs/reminder-architecture.md`.

## ربط المتجر عبر Webhook

المسار الجاهز للمتجر:

```text
POST /api/store/webhook
```

اضبط المتغيرات التالية في `.env`:

```env
STORE_WEBHOOK_SECRET=
STORE_WEBHOOK_OWNER_UID=
STORE_WEBHOOK_DEFAULT_MAINTENANCE_MONTHS=3
STORE_WEBHOOK_CREATE_BOOKINGS=true
STORE_WEBHOOK_DEFAULT_TECHNICIAN_ID=
STORE_WEBHOOK_DEFAULT_TECHNICIAN_NAME=
```

الحماية تكون بإحدى طريقتين:

- `X-Golden-Webhook-Secret` بنفس قيمة `STORE_WEBHOOK_SECRET`.
- `X-Golden-Signature: sha256=<hmac>` باستخدام HMAC SHA-256 لجسم الطلب.

يعالج النظام طلب المتجر حسب SKU أو الوسوم:

- `SALE-` أو `sale_only`: يسجل العميل والطلب فقط بدون تركيب أو تذكير.
- `INSTALL-` أو `install_maintenance`: ينشئ تركيبا جديدا، وينشئ حجزا إذا وصل موعد من سلة وكان الفني الافتراضي مضبوطا.
- `MAINT-` أو `maintenance_existing`: يبحث عن تركيب سابق بنفس رقم العميل وSKU؛ إن لم يجده ينتقل الطلب إلى `needs_review` في صفحة "طلبات المتجر".
- `EXT-` أو `external_maintenance`: صيانة لجهاز ليس من Golden Pro، ينشئ طلب صيانة قابل للجدولة بدون ربطه بتركيب سابق.

تظهر رحلة كل طلب في صفحة "طلبات المتجر"، ويمكن ربط طلبات الصيانة التي تحتاج مراجعة بتركيب سابق يدويا. تفاصيل المعمارية والأمثلة موجودة في `docs/store-webhook-architecture.md`.

صفحة "رعاية العملاء" هي مركز المتابعة اليومي: تعرض العملاء بلا نشاط، والعملاء الذين لم يتم استهدافهم، والصيانات القريبة أو المتأخرة حتى لا يبقى أي عميل خارج دورة الاهتمام.

## VPS

```bash
npm install
npm run build
npm start
```

مثال بيئة VPS:

```env
PORT=3000
APP_TIMEZONE=Asia/Riyadh
WA_SESSION_DIR=.wa-session
ENABLE_DAILY_CRON=true
REMINDER_CRON_SCHEDULE=*/10 * * * *
ALLOW_LOCAL_AUTH=false
VITE_LOCAL_AUTH=false
FIREBASE_SERVICE_ACCOUNT_PATH=/secure/path/service-account.json
```

## VPS + Hosting

الإصدار الحالي يُنشر كاملًا على VPS عبر Docker لأنه يعتمد على SQLite وجلسة واتساب ذات تخزين دائم. مسار Cloud Run معطّل عمدًا كي لا يُنتج نسخة ناقصة أو يفقد البيانات والجلسة.

```bash
npm run doctor:prod
npm run deploy:vps -- -HostName YOUR_VPS_HOST -SshKey YOUR_SSH_KEY
npm run deploy:firebase
```

خطوات النشر التفصيلية والنسخ الاحتياطي وربط سلة موثقة في `docs/vps-deployment-ar.md`.

## أوامر الفحص

```bash
npm run doctor
npm run lint
npm run build
npm run test:smoke
```

اختبار `test:smoke` يفحص تشغيل السيرفر، حماية API بدون token، منطق بيانات التجربة، مسارات التذكيرات، قواعد Firestore، والفهارس المطلوبة.

## أدلة التطوير والتسليم

- `docs/architecture-development-guide.md`: المعمارية الكاملة وطريقة قراءة السورس كود وإضافة الميزات.
- `docs/external-agent-brief.md`: ملخص قصير جاهز لإرساله لأي وكيل أو منصة أخرى قبل طلب تعديل.
- `docs/model-context.md`: سياق شامل مخصص لإرساله لأي موديل لفهم المشروع بسرعة.
- `docs/store-webhook-architecture.md`: تفاصيل رحلة سلة والويب هوك.
- `docs/reminder-architecture.md`: تفاصيل التذكيرات والجدولة والإرسال.
- `docs/vps-deployment-ar.md`: خطوات النشر المدعومة على VPS.
