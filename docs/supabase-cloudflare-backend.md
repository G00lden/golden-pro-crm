# Golden Pro CRM: Supabase Backend + Cloudflare DNS

## Supabase

تم إنشاء مشروع Supabase:

```text
golden-pro-crm
project_ref: rrvyzfedxuzuzgrwvkwf
url: https://rrvyzfedxuzuzgrwvkwf.supabase.co
region: eu-central-1
```

تم تطبيق الجداول التالية:

```text
customers
products
installations
technicians
bookings
reminders
settings
store_orders
store_webhook_events
technician_notifications
```

كل الجداول تستخدم:

```text
owner_uid
```

لعزل بيانات كل مستخدم. تم تفعيل RLS على الجداول، وفحص Supabase Security Advisors رجع بدون مشاكل.

## تفعيل Supabase في التطبيق

في بيئة السيرفر:

```env
DATA_PROVIDER=supabase
SUPABASE_URL=https://rrvyzfedxuzuzgrwvkwf.supabase.co
SUPABASE_SERVICE_ROLE_KEY=ضع_المفتاح_من_Supabase_Dashboard
```

في بيئة بناء الواجهة:

```env
VITE_DATA_PROVIDER=supabase
VITE_SUPABASE_URL=https://rrvyzfedxuzuzgrwvkwf.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=ضع_publishable_key
```

ملاحظة مهمة: `SUPABASE_SERVICE_ROLE_KEY` يبقى في السيرفر فقط ولا يوضع في الواجهة.

## الباك اند

تمت إضافة طبقة توافق:

```text
server/supabaseFirestoreAdapter.ts
```

هذه الطبقة تجعل منطق السيرفر القديم الذي كان يستخدم Firestore Admin يكتب في Supabase عند تفعيل:

```env
DATA_PROVIDER=supabase
```

وتمت إضافة REST API داخلي للواجهة:

```text
GET/POST/PUT/DELETE /api/customers
GET/POST/PUT/DELETE /api/products
GET/POST/PUT/DELETE /api/installations
GET/POST/PUT/DELETE /api/technicians
GET/POST/PUT/DELETE /api/bookings
GET /api/reminders
GET/PUT /api/settings
POST /api/demo-data
GET /api/stats
```

عند ضبط `VITE_DATA_PROVIDER=supabase` تستخدم الواجهة هذه المسارات بدل الكتابة المباشرة إلى Firestore.

## Cloudflare DNS

الدومين المطلوب:

```text
breexe-pro.com
```

والفرع المقترح للتطبيق:

```text
crm.breexe-pro.com
```

تمت إضافة سكربت:

```powershell
npm run cloudflare:dns
```

يتطلب هذه المتغيرات:

```env
CLOUDFLARE_API_TOKEN=
CLOUDFLARE_ZONE_NAME=breexe-pro.com
CLOUDFLARE_RECORD_NAME=crm
CLOUDFLARE_RECORD_TYPE=CNAME
CLOUDFLARE_DNS_TARGET=target.example.com
CLOUDFLARE_PROXIED=false
```

استخدم `CLOUDFLARE_PROXIED=false` أول مرة حتى يتأكد مزود الاستضافة من الدومين ويصدر SSL، ثم يمكن تحويله إلى `true` إذا كان ذلك مناسبا.

## ما ينقص قبل الربط النهائي

لا يمكن ربط Cloudflare فعليا قبل معرفة هدف النشر النهائي:

- إذا كان النشر على Cloud Run/Firebase Hosting، استخدم قيمة DNS التي يعطيها Firebase/Google.
- إذا كان النشر على VPS، استخدم IP السيرفر وسجل `A`.
- إذا كان النشر على Cloudflare Pages، استخدم هدف Pages الذي يعطيه Cloudflare.

بعد توفر الهدف، نفذ:

```powershell
$env:CLOUDFLARE_API_TOKEN="..."
$env:CLOUDFLARE_DNS_TARGET="..."
npm run cloudflare:dns
```
