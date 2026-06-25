# البوابة الذاتية للمكالمات — إعداد جوال أندرويد (بدون أي مزوّد خارجي)

> نظام رد وتوجيه مكالمات **ذاتي 100%**: شريحة الشركة في جوال أندرويد + تطبيق أتمتة
> مجاني + خادمك. لا Unifonic، لا Twilio، لا QR واتساب، لا اشتراكات.

## كيف يعمل

```
عميل يتصل على شريحة الشركة (في جوال أندرويد)
   ├─ رُدّ عليه بشري → مكالمة عادية، لا حاجة لشيء.
   └─ لم يُرد (فائتة) → تطبيق الأتمتة على الجوال يرسل الحدث للخادم
            │  POST /api/gateway/event {type:"missed_call", from, to}
            ▼
      الخادم يوجّه ويضع رد SMS في طابور الإرسال (outbox)
            │
      الجوال يسحب الطابور  GET /api/gateway/outbox
            │  ويرسل كل SMS من شريحة الشركة، ثم يؤكّد POST /api/gateway/outbox/ack
            ▼
   - نمط "menu": العميل يستلم قائمة الأقسام ويرد برقم →
       الجوال يرسل الـ SMS الوارد للخادم → يُحوَّل للموظف (إشعار SMS له) ويُؤكَّد للعميل.
   - نمط "direct": يُسنَد لأول قسم/موظف فوراً، ويُشعر الطرفان.
```

> ملاحظة صريحة: لا يوجد «قائمة صوتية أثناء المكالمة» في هذا النمط — تشغيل DTMF صوتي
> أثناء مكالمة GSM يتطلب بنية اتصالات (Unifonic/مزوّد). البديل الذاتي هنا هو
> **قائمة عبر SMS** (يرد العميل برقم القسم)، أو **تحويل مباشر** بدون قائمة.

## المتطلبات

- جوال أندرويد فيه شريحة الشركة (يبقى متصلاً بالإنترنت والكهرباء).
- تطبيق أتمتة مجاني: **MacroDroid** (الأسهل) أو **Tasker**.
- خادم CRM يعمل وعنوانه `https://<server>` (نفس مشروعك).

## 1) إعداد الخادم

في `.env`:
```env
GATEWAY_TOKEN=<قيمة عشوائية سرية>      # مثال: openssl rand -hex 24
GATEWAY_ROUTING_MODE=menu              # أو direct
COMPANY_NAME=اسم شركتك
```
ثم من لوحة **«نظام المكالمات»** أنشئ الأقسام وأرقام الموظفين (الرقم 1 = المبيعات…).

## 2) إعداد MacroDroid على الجوال (3 ماكروات)

> في كل طلب HTTP أضِف الترويسة: `x-gateway-token: <GATEWAY_TOKEN>`

### ماكرو A — مكالمة فائتة
- **Trigger:** Call → Missed Call (أو Incoming Call Ended + لم يُرد).
- **Action:** HTTP Request POST → `https://<server>/api/gateway/event`
  - Content-Type: `application/json`
  - Body: `{"type":"missed_call","from":"[call_number]","to":"<رقم الشركة>"}`
  - (المتغير `[call_number]` من MacroDroid.)

### ماكرو B — رسالة SMS واردة (لاختيار القسم)
- **Trigger:** SMS Received.
- **Action:** HTTP Request POST → `.../api/gateway/event`
  - Body: `{"type":"sms_in","from":"[sms_number]","text":"[sms_message]"}`

### ماكرو C — إرسال الردود من الطابور (كل دقيقة)
- **Trigger:** Regular Interval → كل 1 دقيقة.
- **Action 1:** HTTP Request GET → `.../api/gateway/outbox` → خزّن الرد في متغير.
- **Action 2:** لكل عنصر في `messages`: Send SMS إلى `to_phone` بالنص `body`.
- **Action 3:** HTTP Request POST → `.../api/gateway/outbox/ack` Body: `{"ids":[المعرفات التي أُرسلت]}`.

> بديل أبسط بدون الماكرو C: فعّل قراءة رد `POST /event` مباشرة — الاستجابة تحوي
> حقل `outbox` بالرسائل المطلوب إرسالها فوراً. لكن نمط الطابور (C) أكثر موثوقية.

## 3) (اختياري) ربط واتساب لاحقاً

لو ربطت واتساب لاحقاً (من لوحة واتساب)، يتحوّل إرسال الردود تلقائياً إلى واتساب
بدل SMS — `dispatchMessage` يفضّل واتساب عند اتصاله، وإلا يستخدم طابور SMS. لا حاجة
لتغيير شيء في الجوال (تبقى ماكرواتك تعمل كاحتياطي).

## نقاط النهاية (مرجع)

| الطريقة | المسار | الوصف |
|--------|--------|-------|
| POST | `/api/gateway/event` | إبلاغ بحدث: `missed_call` أو `sms_in`. (توكن) |
| GET | `/api/gateway/outbox?limit=20` | الرسائل المنتظرة للإرسال. (توكن) |
| POST | `/api/gateway/outbox/ack` | تأكيد الإرسال `{ids:[...], failed:[...]}`. (توكن) |
| GET | `/api/gateway/status` | حالة البوابة (admin). |

## الأمان

- جميع نقاط البوابة محمية بـ `GATEWAY_TOKEN` (ترويسة `x-gateway-token` أو `?token=`).
- في الإنتاج: بدون توكن تُرفض النقاط (503). في التطوير المحلي تُسمح بدون توكن للتجربة.
- لا تضع التوكن في أي مكان عام؛ هو مفتاح إرسال الرسائل.

## الاختبار المحلي (تم التحقق)

```bash
# مكالمة فائتة → رد قائمة في الطابور
curl -X POST :3000/api/gateway/event -H "Content-Type: application/json" \
  -d '{"type":"missed_call","from":"05XXXXXXXX","to":"<company>"}'
# سحب الطابور
curl :3000/api/gateway/outbox
# رد العميل برقم القسم → تحويل + إشعار الموظف
curl -X POST :3000/api/gateway/event -H "Content-Type: application/json" \
  -d '{"type":"sms_in","from":"05XXXXXXXX","text":"1"}'
```
