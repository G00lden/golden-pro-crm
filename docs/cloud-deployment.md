# خطة Cloud Run مؤجلة وغير مدعومة في الإصدار الحالي

> تحذير تشغيلي: هذا المستند محفوظ كتصميم مستقبلي فقط. الإصدار الحالي يعتمد
> SQLite وجلسة واتساب ذات volumes دائمة، ولذلك يمنع أمر `npm run deploy:cloudrun`
> النشر عمدًا. استخدم مسار VPS الموثق في `docs/vps-deployment-ar.md`.

# التصميم التاريخي لتشغيل Golden Pro CRM كسحابة

## الهدف

النشر المقترح للتشغيل المحدود:

- الواجهة: Firebase Hosting.
- قاعدة البيانات: Firestore.
- API والسيرفر: Cloud Run.
- إرسال رسائل العملاء: WhatsApp Business Cloud API من رقم العمل.
- WhatsApp Web يبقى خيار VPS فقط، وليس الخيار الأفضل على Cloud Run.

## 1. تجهيز Firebase

ثبت الأدوات:

```bash
npm install
npm install -g firebase-tools
```

سجل الدخول:

```bash
firebase login
```

اختر مشروع Firebase:

```bash
firebase use --add
```

فعّل في Firebase Console:

- Authentication > Sign-in method > Email/Password أو Google.
- Authentication > Settings > Authorized domains وأضف الدومين النهائي.
- Firestore Database.

## 2. تجهيز البيئة المحلية

انسخ ملف البيئة:

```bash
copy .env.example .env
```

للتجربة المحلية السريعة:

```env
ALLOW_LOCAL_AUTH=true
VITE_LOCAL_AUTH=true
WHATSAPP_PROVIDER=web
```

للنشر السحابي:

```env
ALLOW_LOCAL_AUTH=false
VITE_LOCAL_AUTH=false
WHATSAPP_PROVIDER=cloud_api
WHATSAPP_CLOUD_API_VERSION=v23.0
WHATSAPP_CLOUD_PHONE_NUMBER_ID=ضع_معرف_رقم_واتساب
WHATSAPP_CLOUD_API_TOKEN=ضع_التوكن_في_Secret_Manager_وليس_في_الكود
WHATSAPP_CLOUD_TEMPLATE_NAME=
WHATSAPP_CLOUD_TEMPLATE_LANGUAGE=ar
STORE_WEBHOOK_SECRET=سر_طويل_عشوائي
STORE_WEBHOOK_OWNER_UID=UID_حسابك_في_Firebase
STORE_WEBHOOK_CREATE_BOOKINGS=true
STORE_WEBHOOK_DEFAULT_TECHNICIAN_ID=معرف_الفني
STORE_WEBHOOK_DEFAULT_TECHNICIAN_NAME=اسم_الفني
ENABLE_DAILY_CRON=true
REMINDER_CRON_SCHEDULE=0 10 * * *
```

افحص الجاهزية:

```bash
npm run doctor
npm run doctor:prod
```

## 3. الفحص قبل النشر

```bash
npm run lint
npm run build
npm run test:smoke
```

## 4. نشر Firestore

```bash
npm run deploy:firestore
```

هذا ينشر:

- `firestore.rules`
- `firestore.indexes.json`

## 5. نشر Cloud Run (تصميم مستقبلي غير قابل للتنفيذ حاليًا)

لا تنفّذ أوامر هذا القسم في الإصدار الحالي. مسار النشر المدعوم:

```bash
npm run deploy:vps -- -HostName YOUR_VPS_HOST -SshKey YOUR_SSH_KEY
```

بعد النشر ضع متغيرات البيئة في Cloud Run من واجهة Google Cloud أو بالأوامر:

```bash
gcloud run services update golden-pro-crm ^
  --region me-central1 ^
  --set-env-vars APP_TIMEZONE=Asia/Riyadh,ALLOW_LOCAL_AUTH=false,VITE_LOCAL_AUTH=false,WHATSAPP_PROVIDER=cloud_api,ENABLE_DAILY_CRON=true,REMINDER_CRON_SCHEDULE="0 10 * * *",STORE_WEBHOOK_CREATE_BOOKINGS=true
```

الأسرار مثل `WHATSAPP_CLOUD_API_TOKEN` و`STORE_WEBHOOK_SECRET` الأفضل وضعها في Secret Manager:

لرسائل التذكير الإنتاجية عبر WhatsApp Cloud API، أنشئ قالبا معتمدا في Meta يحتوي متغير جسم واحد `{{1}}` واضبط `WHATSAPP_CLOUD_TEMPLATE_NAME`. إذا تركته فارغا يستخدم النظام الرسائل النصية العادية فقط.

```bash
gcloud secrets create whatsapp-cloud-token --replication-policy=automatic
gcloud secrets versions add whatsapp-cloud-token --data-file=whatsapp-token.txt
gcloud secrets create store-webhook-secret --replication-policy=automatic
gcloud secrets versions add store-webhook-secret --data-file=store-webhook-secret.txt
```

ثم اربطها بخدمة Cloud Run:

```bash
gcloud run services update golden-pro-crm ^
  --region me-central1 ^
  --set-secrets WHATSAPP_CLOUD_API_TOKEN=whatsapp-cloud-token:latest,STORE_WEBHOOK_SECRET=store-webhook-secret:latest
```

## 6. نشر Firebase Hosting

بعد نشر Cloud Run، انشر الواجهة والربط مع `/api/**`:

```bash
npm run deploy:hosting
```

أو انشر الواجهة وقواعد Firestore معا:

```bash
npm run deploy:firebase
```

## 7. ربط سلة

في سلة:

- اسم الحدث: `Golden Pro CRM - طلب جديد`.
- نوع الحدث: `order.created` أو `invoice.created`.
- إصدار Webhook: `v2`.
- رابط الحدث:

```text
https://YOUR_DOMAIN/api/store/webhook
```

Header:

```text
X-Golden-Webhook-Secret: نفس STORE_WEBHOOK_SECRET
```

تصنيف SKU:

- `SALE-...`: بيع فقط.
- `INSTALL-...`: تركيب وصيانة.
- `MAINT-...`: صيانة لمنتج سابق.
- `EXT-...`: صيانة لجهاز خارجي ليس من Golden Pro.

## 8. اختبار الإنتاج المحدود

1. سجل دخول بحساب Firebase حقيقي.
2. أضف فني افتراضي واحفظ `STORE_WEBHOOK_DEFAULT_TECHNICIAN_ID`.
3. أرسل طلب سلة تجريبي `SALE-`.
4. أرسل طلب `INSTALL-` بدون موعد، وتأكد أنه ظهر بانتظار الجدولة.
5. أرسل طلب `INSTALL-` مع موعد، وتأكد أن الحجز نشأ.
6. أكمل الحجز وتأكد أن موعد الصيانة القادم حدث.
7. أرسل طلب `MAINT-` لنفس العميل والSKU وتأكد أنه ربط بالتركيب السابق.
8. أرسل طلب `EXT-` وتأكد أنه ظهر كصيانة جهاز خارجي قابلة للجدولة.
9. افتح صفحة "رعاية العملاء" وتأكد أن العملاء غير المستهدفين أو المتأخرين يظهرون هناك.
10. اختبر إرسال رسالة WhatsApp Cloud API لرقم مسموح أو داخل نافذة محادثة.

## أوامر مختصرة

```bash
npm run doctor:prod
npm run lint
npm run build
npm run test:smoke
npm run deploy:vps -- -HostName YOUR_VPS_HOST -SshKey YOUR_SSH_KEY
npm run deploy:firebase
```
