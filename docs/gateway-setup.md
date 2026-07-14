# البوابة الذاتية للمكالمات — إعداد جوال أندرويد (بدون أي مزوّد خارجي)

> نظام رد وتوجيه مكالمات **ذاتي 100%**: شريحة الشركة في جوال أندرويد + تطبيق أتمتة
> مجاني + خادمك. لا Unifonic، لا Twilio، لا QR واتساب، لا اشتراكات.

> المسار الموصى به حاليًا هو تطبيق أندرويد الأصلي `1.1.0`: من صفحة «نظام المكالمات»
> أنشئ رمز ربط من 8 أرقام، ثم أدخله في الجوال. بقية هذا الدليل لمسار
> MacroDroid القديم فقط، ويظل متاحًا كحل احتياطي باستخدام `GATEWAY_TOKEN`.

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
GATEWAY_DEVICE_HMAC_SECRET=<سر منفصل اختياري لتوقيع توكنات الأجهزة>
GATEWAY_ROUTING_MODE=menu              # أو direct
COMPANY_NAME=اسم شركتك
```
ثم من لوحة **«نظام المكالمات»** أنشئ الأقسام وأرقام الموظفين (الرقم 1 = المبيعات…).

## 2) إعداد MacroDroid على الجوال — مفصّل

### 2.0 تجهيز الأذونات (مهم جداً للموثوقية)
في إعدادات الجوال + MacroDroid فعّل ما يلي وإلا لن يعمل بثبات:
- امنح MacroDroid إذن **الرسائل (SMS)** و**الهاتف (Phone/Call log)** و**جهات الاتصال**.
- أوقف **توفير البطارية / تحسين البطارية** لتطبيق MacroDroid (Settings → Apps → MacroDroid → Battery → Unrestricted).
- فعّل **التشغيل التلقائي (Autostart)** لـ MacroDroid (مهم في Xiaomi/Oppo/Samsung).
- في MacroDroid: Settings → فعّل **«Macro enabled at boot»** ليعمل بعد إعادة التشغيل.

> القيم الثابتة التي ستكررها:
> - الخادم: `https://<server>` (ضع عنوانك الحقيقي، يجب أن يكون HTTPS ويصله الجوال).
> - الترويسة في **كل** طلب HTTP: المفتاح `x-gateway-token` والقيمة `<GATEWAY_TOKEN>`.
> - رقم الشركة (الذي عليه الشريحة) — سمّه `<COMPANY_NUMBER>`.

---

### ماكرو A — إبلاغ بالمكالمة الفائتة
- **Trigger:** أضف Trigger → **Call/SMS → Call Missed** (مكالمة فائتة).
- **Action:** أضف Action → **Connectivity → HTTP Request**:
  - **Method:** `POST`
  - **URL:** `https://<server>/api/gateway/event`
  - **Headers:** أضف صفّاً: المفتاح `x-gateway-token` والقيمة `<GATEWAY_TOKEN>`.
  - **Content Type:** `application/json`
  - **Body** (نوع Custom/Raw):
    ```json
    {"type":"missed_call","from":"[call_number]","to":"<COMPANY_NUMBER>"}
    ```
  - 🔸 لإدراج رقم المتصل: لا تكتبه يدوياً — اضغط زر النص السحري **{ }** بجانب الحقل
    واختر من القائمة رقم المكالمة (Call number / Incoming number). سيُدرَج رمز مثل
    `[call_number]`. هذا يضمن الرمز الصحيح لنسخة تطبيقك.

---

### ماكرو B — إبلاغ برسالة SMS واردة (اختيار القسم)
- **Trigger:** Call/SMS → **SMS Received** (بدون فلتر مرسل، أو فلتر حسب رغبتك).
- **Action:** HTTP Request:
  - **Method:** `POST` ، **URL:** `https://<server>/api/gateway/event`
  - **Header:** `x-gateway-token: <GATEWAY_TOKEN>` ، **Content Type:** `application/json`
  - **Body:**
    ```json
    {"type":"sms_in","from":"[sms_sender]","text":"[sms_message]"}
    ```
  - 🔸 أدرِج `[sms_sender]` و`[sms_message]` من زر النص السحري **{ }** (SMS sender / SMS message).

---

### ماكرو C — إرسال الردود من الطابور (الأهم)
نستخدم نقطة `/api/gateway/next` التي تُرجع **رسالة واحدة مسطّحة** (بدون مصفوفة) ليسهل ربطها.

- **Trigger:** Date/Time → **Regular Interval → كل 1 دقيقة** (أو 30 ثانية).
- **Action 1 — اجلب التالي:** HTTP Request:
  - **Method:** `GET` ، **URL:** `https://<server>/api/gateway/next`
  - **Header:** `x-gateway-token: <GATEWAY_TOKEN>`
  - فعّل **Save response to variable** واختر **Dictionary** (تحليل JSON تلقائياً)،
    سمِّ المتغير `g`. (الآن تتوفّر `{g[has]}`, `{g[id]}`, `{g[to]}`, `{g[body]}`.)
- **Action 2 — تحقّق:** أضف **If** / Condition: إذا `{g[has]}` يساوي `true`.
  - داخل الـ If:
    - **Action — Send SMS:** Number = `{g[to]}` ، Message = `{g[body]}`.
    - **Action — HTTP Request (تأكيد):**
      - **Method:** `POST` ، **URL:** `https://<server>/api/gateway/outbox/ack`
      - **Header:** `x-gateway-token: <GATEWAY_TOKEN>` ، **Content Type:** `application/json`
      - **Body:** `{"ids":["{g[id]}"]}`
  - **End If**.

> 🔁 لإرسال أكثر من رسالة في نفس الدورة (لو تراكمت عدة ردود): كرّر Action 1+2 من 3 إلى
> 5 مرات داخل نفس الماكرو، أو اجعل Action C بالكامل داخل **Loop → Repeat 5**.
> كل تكرار يرسل رسالة واحدة ويؤكّدها، والتكرار الذي يجد `{g[has]} = false` لا يرسل شيئاً.

> ✅ هكذا يكون التدفق صحيحاً وموثوقاً: A و B يُبلّغان الخادم، و C يفرّغ طابور الردود
> رسالةً رسالةً ويؤكّدها (لا تكرار مصفوفات، لا إرسال مزدوج).

## 3) (اختياري) ربط واتساب لاحقاً

لو ربطت واتساب لاحقاً (من لوحة واتساب)، يتحوّل إرسال الردود تلقائياً إلى واتساب
بدل SMS — `dispatchMessage` يفضّل واتساب عند اتصاله، وإلا يستخدم طابور SMS. لا حاجة
لتغيير شيء في الجوال (تبقى ماكرواتك تعمل كاحتياطي).

## نقاط النهاية (مرجع)

| الطريقة | المسار | الوصف |
|--------|--------|-------|
| POST | `/api/gateway/event` | إبلاغ بحدث: `missed_call` أو `sms_in`. (توكن) |
| GET | `/api/gateway/next` | **رسالة واحدة مسطّحة** للإرسال: `{has,id,to,body,role}` — الأنسب لـ MacroDroid. (توكن) |
| GET | `/api/gateway/outbox?limit=20` | كل الرسائل المنتظرة (مصفوفة). (توكن) |
| POST | `/api/gateway/outbox/ack` | تأكيد الإرسال `{ids:[...], failed:[...]}`. (توكن) |
| GET | `/api/gateway/status` | حالة البوابة (admin). |
| POST | `/api/gateway/pairing-code` | إنشاء رمز ربط مؤقت لمرة واحدة (admin). |
| POST | `/api/gateway/pair` | استبدال رمز الربط بتوكن جهاز مستقل. |
| GET | `/api/gateway/devices` | عرض الأجهزة المرتبطة وآخر اتصال (admin). |
| POST | `/api/gateway/devices/:id/revoke` | إلغاء جهاز فورًا (admin). |

## الأمان

- تطبيق أندرويد الأصلي يستخدم توكنًا مستقلًا لكل جهاز، ويمكن إلغاؤه دون إيقاف بقية الأجهزة.
- رمز الربط صالح 10 دقائق ولمرة واحدة، ومحاولاته محدودة على مستوى الشبكة.
- لا تُخزّن قاعدة البيانات رمز الربط أو توكن الجهاز كنص واضح؛ تحفظ بصمات HMAC فقط.
- يظل `GATEWAY_TOKEN` مقبولًا لمسار MacroDroid القديم. بدون سر بوابة مهيأ تُرفض النقاط بحالة 503، وبدون توكن صحيح تُرفض بحالة 401.
- لا تضع أي توكن في مكان عام؛ هو مفتاح إرسال أحداث المكالمات.

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
