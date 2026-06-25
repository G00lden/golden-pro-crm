# Telephony / IVR call-routing architecture

> نظام الرد على المكالمات وتوجيهها — قائمة صوتية (IVR) عبر Unifonic، تحويل لجوال
> الموظف المختص، وعند عدم الرد إرسال واتساب للعميل وللموظف.

## التدفق (Flow)

```
العميل يتصل على الرقم الأساسي (المنشور في الإعلانات)
        │
        ▼
Unifonic يستدعي  POST /webhooks/telephony/ivr      ← لا يوجد digit
        │  buildGreeting() يبني القائمة من ivr_departments ويسجّل call_logs
        ▼
العميل يضغط رقماً → Unifonic يستدعي /ivr مرة أخرى   ← digits=N
        │  handleDigit() → القسم → أول موظف نشط → تعليمة dial (تحويل)
        ▼
Unifonic يحوّل المكالمة لجوال الموظف، وعند الانتهاء يستدعي
   POST /webhooks/telephony/status
        │  handleCallStatus()
        ├─ رد (completed/in_progress) → تُسجّل وتنتهي
        └─ لم يُرد (no_answer/busy/failed/voicemail) → runMissedCallFlow()
                 ├─ واتساب للعميل  (قالب missed_call_customer)
                 └─ واتساب للموظف (قالب missed_call_agent)
```

## المكوّنات

| الملف | المسؤولية |
|------|-----------|
| `server/telephony/types.ts` | الأنواع الموحّدة المستقلة عن المزوّد (IvrInstruction، NormalizedInboundCall، NormalizedCallStatus). |
| `server/telephony/unifonicAdapter.ts` | **النقطة الوحيدة** التي تعرف أسماء حقول Unifonic — تحويل الطلب الوارد ↔ الموحّد، وتسلسل التعليمات إلى JSON المتوقع. |
| `server/ivrEngine.ts` | منطق القرار + الوصول لقاعدة البيانات + تدفق المكالمة الفائتة. |
| `server/routes-telephony.ts` | مسارات webhook العامة + مسارات admin (إدارة الأقسام، الإعدادات، السجل، الاختبار). |
| `src/pages/CallSystem.tsx` | لوحة الواجهة (الأقسام، الإعدادات، سجل المكالمات، اختبار). |

## قاعدة البيانات (server/db.ts)

- `telephony_config` — إعدادات لكل مالك: الرقم الأساسي، الترحيب، نص القائمة، مهلة الرنين، التفعيل.
- `ivr_departments` — صف لكل رقم اختيار (digit) → اسم القسم.
- `ivr_department_agents` — موظفو القسم (الاسم + الجوال)، تُجرّب أرقامهم بترتيب `sort_order`.
- `call_logs` — صف لكل مكالمة: الاختيار، الموظف، الحالة، هل فائتة، وهل أُرسل الواتساب.

## نقاط النهاية (Endpoints)

**عامة (تتطلب السر المشترك `x-telephony-webhook-secret`؛ fail-closed في الإنتاج):**
- `GET|POST /webhooks/telephony/ivr` — القائمة الصوتية ومعالجة الضغط.
- `POST /webhooks/telephony/status` — حالة المكالمة → تدفق المكالمة الفائتة.

**admin (تتطلب دور admin/manager):**
- `GET|PUT /api/telephony/config`
- `GET|POST /api/telephony/departments` ، `PUT|DELETE /api/telephony/departments/:id`
- `GET /api/telephony/calls?missed=true`
- `POST /api/telephony/test-missed` — محاكاة مكالمة فائتة (اختبار الواتساب بدون مكالمة حقيقية).

## إعادة الاستخدام

- الإرسال عبر `sendWhatsAppTemplate()` و`recordWhatsAppMessage()` من `server/whatsapp.ts` — نفس قناة الواتساب الحالية وأمان الإرسال (`outboundSafety`).
- القوالب العربية في `server/whatsappTemplates.ts`: `missed_call_customer`، `missed_call_agent`.

## الإعداد (.env)

```
TELEPHONY_PROVIDER=unifonic
TELEPHONY_MAIN_NUMBER=<الرقم الأساسي>
TELEPHONY_RING_TIMEOUT_SEC=20
TELEPHONY_WEBHOOK_SECRET=<سر مشترك>
PUBLIC_BASE_URL=https://<server>
UNIFONIC_APP_SID=
UNIFONIC_API_KEY=
UNIFONIC_VOICE_BASE_URL=
```

## خطوات الربط مع Unifonic (يدوية)

1. شراء الرقم الأساسي من Unifonic.
2. ضبط **IVR Endpoint** = `https://<server>/webhooks/telephony/ivr`.
3. ضبط **Status Callback** = `https://<server>/webhooks/telephony/status`.
4. وضع نفس `TELEPHONY_WEBHOOK_SECRET` في الطرفين (يُرسل في ترويسة `x-telephony-webhook-secret` أو `?secret=`).

## ⚠️ تنبيه: تأكيد عقد الحقول

أسماء حقول Unifonic لتعليمات IVR و status webhook محمية خلف تسجيل دخول حساب
Unifonic. المحوّل `unifonicAdapter.ts` مكتوب دفاعياً ليقبل أكثر الأسماء شيوعاً
(`callSid/sessionId`، `digits/Digits`، `status/DialCallStatus`...) مع تعليمات
`// CONFIRM`. عند توفّر توثيق الحساب، يُعدّل **هذا الملف فقط**؛ بقية النظام لا
يلمس أسماء حقول المزوّد. غلاف الاستجابة الحالي `{ actions: [...] }` يجب مطابقته
بما يتوقعه Unifonic IVR Endpoint.

## الاختبار المحلي (تم التحقق)

```bash
# 1) إنشاء قسم
curl -X POST :3000/api/telephony/departments -H "Authorization: Bearer <tok>" \
  -d '{"digit":"1","name":"المبيعات","agents":[{"name":"خالد","phone":"05XXXXXXXX"}]}'
# 2) القائمة (بدون digit)
curl -X POST :3000/webhooks/telephony/ivr -d '{"callSid":"c1","from":"9665..","to":"9665.."}'
# 3) الضغط على 1 → تعليمة dial لرقم الموظف (مُطبّع 9665..)
curl -X POST :3000/webhooks/telephony/ivr -d '{"callSid":"c1","from":"9665..","digits":"1"}'
# 4) عدم الرد → واتساب للعميل والموظف
curl -X POST :3000/webhooks/telephony/status -d '{"callSid":"c1","status":"noanswer"}'
```
