# تدقيق منصة التواصل: واتساب + المكالمات + الرد الآلي + Odoo + سلة

> تحديث المعالجة: نُفّذت إصلاحات الأساس في الإصدار `1.2.0` باسم «مركز التواصل الموثوق». أُضيف توحيد الهاتف، منع تكرار الأحداث، طابور دائم، إعادة المحاولة، حالات أحادية الاتجاه، توحيد الوارد، ربط المكالمة الفائتة، lease لبوابة SMS، فحص Cloud API حي، ولوحة مراقبة. تفاصيل التنفيذ والآثار في `docs/communications-release-1.2.0-ar.md`. بقيت إعدادات الإنتاج ومحرك الحملات الكامل وموصل Odoo الخارجي خارج هذا الإصدار.

تاريخ الفحص: 2026-07-12

الإصدار المفحوص: `1.1.0`

بيئة الإنتاج: `https://crm.breexe-pro.com` على Contabo VPS
نوع الفحص: قراءة للكود، تتبع تدفق البيانات، فحص آمن لإعدادات الإنتاج، وفحوص اتصال لا ترسل رسائل للعملاء.

## الزبدة التنفيذية

البرنامج يحتوي أجزاء جيدة ومفيدة: سجل مكالمات، أقسام وموظفون، توزيع round-robin، قناة WhatsApp Cloud API أو WhatsApp Web، بديل SMS عبر Android Gateway، سجل رسائل، ومعالجة بعض ردود الصيانة. لكنه **ليس بعد منصة حملات أو مركز تواصل متكاملًا**.

سيناريو «العميل اتصل ولم نرد، أرسل له واتساب واسأله ماذا يريد» موجود جزئيًا في الكود، لكنه غير قابل للعمل على الإنتاج الآن للأسباب التالية:

1. توكن WhatsApp Cloud الحالي مرفوض من Meta: HTTP `401` ورمز OAuth `190`.
2. Webhook واتساب في الإنتاج يعيد `503` لأن `WHATSAPP_APP_SECRET` و`WHATSAPP_WEBHOOK_SECRET` غير مضبوطين.
3. لا يوجد قالب Meta محدد للرسالة الابتدائية؛ الإرسال النصي الحر ليس بديلًا صالحًا لبدء محادثة خارج نافذة خدمة العميل.
4. لا يوجد رقم اتصال رئيسي مضبوط، ولا أقسام، ولا موظفون داخل نظام IVR، ولا أي مكالمة مسجلة في الإنتاج.
5. لا توجد حملة، شرائح جمهور، موافقات، إلغاء اشتراك، جدولة، حدود تكرار، queue، retries، أو شاشة نتائج حملة.

الحكم: **REQUEST CHANGES — لا تطلق رسائل آلية أو حملة جماعية قبل إغلاق الحواجز الحرجة.**

## صورة الإنتاج الحالية

| الجزء | الحالة الحالية |
|---|---|
| WhatsApp provider | `cloud_api` |
| وجود token وphone number id | موجودان، لكن التحقق الحي أعاد OAuth `190` |
| قالب Meta للإرسال الابتدائي | غير مضبوط |
| HMAC/shared secret للـWebhook | غير مضبوط؛ POST صالح البنية يعيد `503` |
| وضع الإرسال | `production` و`OFFICIAL_LAUNCH_APPROVED=true` |
| Telephony provider | `unifonic` |
| الرقم الرئيسي | غير مضبوط |
| سر Webhook الاتصال | مضبوط |
| Android Gateway token | مضبوط |
| نمط Gateway | `menu` |
| أقسام/موظفو IVR | 0 / 0 |
| المكالمات المسجلة | 0 |
| رسائل واتساب المخزنة | 7 واردة، 6 مرسلة، 20 dry-run |
| message ids مكررة | مجموعة مكررة واحدة على الأقل |
| سلة | مفاتيح التطبيق موجودة و65 طلبًا مرحلًا، لكن لا توجد جلسة OAuth مرتبطة حاليًا |
| CRM Odoo | وحدة CRM محلية داخل SQLite؛ ليست اتصالًا بخادم Odoo خارجي |

## التدفق الحالي كما هو

```text
مكالمة Unifonic
  -> /webhooks/telephony/ivr
  -> ivrEngine
  -> اختيار قسم وموظف
  -> status webhook
  -> runMissedCallFlow
  -> WhatsApp مباشرة

أو

هاتف Android + MacroDroid/Tasker
  -> /api/gateway/event
  -> gateway.ts
  -> WhatsApp إن اعتبره النظام متصلًا
  -> وإلا gateway_outbox كرسالة SMS

رد العميل على WhatsApp Web
  -> whatsappAutoReply
  -> gateway.ts

رد العميل على WhatsApp Cloud API
  -> whatsappWebhook
  -> تأكيد/إعادة جدولة/تأكيد فني فقط
  -> لا يدخل إلى gateway ولا يختار قسمًا
```

هذه المسارات تستخدم قواعد متشابهة لكن غير موحدة، لذلك يمكن أن يتصرف الرد الآلي بصورة مختلفة حسب مزود واتساب أو مصدر المكالمة.

## النتائج حسب الخطورة

### CRITICAL 1 — قناة WhatsApp الإنتاجية غير صالحة حاليًا

**الملفات:** `server/whatsapp.ts:195-208`, `server/whatsappWebhook.ts:186-215`, `server/whatsapp.ts:563-594`

**المشكلة:** وجود token وphone id يكفي ليعلن الكود أن Cloud API «connected». الفحص الحقيقي للـGraph API أعاد `401 / OAuthException 190`. كذلك webhook يرفض كل inbound/status callback لأن أسرار التحقق غائبة، ولا يوجد قالب Meta محدد.

**الأثر:** رسالة المكالمة الفائتة تفشل، ورد العميل وحالات delivered/read لا تصل، بينما شاشة النظام قد تبدو سليمة.

**الإصلاح:** إصدار token صالح طويل العمر/عبر system user، ضبط app secret أو webhook shared secret، ضبط verify token، إنشاء القوالب واعتمادها، ثم فحص إرسال allowlist واستلام webhook حقيقي.

### CRITICAL 2 — مصدر المكالمة والتوجيه غير مجهزين في الإنتاج

**الملفات:** `server/routes-telephony.ts:116-170`, `server/gateway.ts:184-237`, `src/pages/CallSystem.tsx`

**المشكلة:** `TELEPHONY_MAIN_NUMBER` فارغ، وعدد الأقسام والموظفين صفر، وسجل المكالمات صفر. وجود `GATEWAY_TOKEN` وحده لا يثبت أن هاتف Android يرسل الأحداث أو يقرأ outbox.

**الأثر:** لا يوجد حدث حقيقي يبدأ السيناريو المطلوب، وحتى لو وصل missed-call event فلا توجد أقسام لتوجيه طلب العميل.

**الإصلاح:** اختيار مصدر رسمي واحد للمكالمات في المرحلة الأولى، ضبط الرقم والـwebhook، إضافة الأقسام والموظفين، ثم إجراء مكالمة اختبار حقيقية موثقة.

### CRITICAL 3 — لا يوجد Campaign Engine ولا متطلبات امتثال

**الملفات:** `src/pages/WhatsAppConsole.tsx:165-180,296-329`, `server/routes-whatsapp.ts:249-334`

**المشكلة:** الشاشة ترسل إلى رقم واحد فقط. لا توجد جداول campaign/audience/job/suppression، ولا سجل موافقة، ولا `STOP/إلغاء`، ولا frequency cap، ولا جدولة أو pause/resume أو retry.

**الأثر:** لا يمكن تشغيل حملة شاملة بطريقة قابلة للقياس أو الإيقاف، والإرسال الجماعي المباشر يهدد جودة الرقم وإمكانية تقييد حساب واتساب.

**مرجع رسمي:** سياسة WhatsApp Business تشترط موافقة مناسبة، احترام طلبات الإيقاف، وقالبًا معتمدًا لبدء المحادثة؛ وتسمح بالنص الحر خلال 24 ساعة من آخر رسالة للعميل فقط:
`https://whatsappbusiness.com/policy/`

### HIGH 1 — فحص الصحة يعطي نتيجة خضراء كاذبة

**الملفات:** `server/whatsapp.ts:195-208`, `server.ts:420-429`, `scripts/doctor.mjs:192-198`

`getStatus()` وdaily-prep وdoctor تتحقق من وجود المفاتيح فقط ولا تستدعي Meta للتحقق من صلاحيتها أو جودة الرقم أو webhook.

**الإصلاح:** health probe مخزن مؤقتًا يتحقق من Graph API، زمن انتهاء token، webhook readiness، حالة القالب، وآخر callback ناجح.

### HIGH 2 — معرّف مكالمة Unifonic يعيد استخدام سجل قديم للمتصل نفسه

**الملفات:** `server/telephony/unifonicAdapter.ts:80-85`, `server/ivrEngine.ts:463-480,609-638`

عند غياب call id حقيقي يستخدم النظام `caller:<phone>`. كل مكالمة لاحقة من الرقم نفسه ترتبط بالسجل القديم، وبعد ضبط `wa_customer_notified=1` قد لا تصله رسالة في مكالماته المستقبلية.

**الإصلاح:** event/call id حقيقي، أو session id محلي مرتبط بنافذة زمنية وحالة in-flight، مع صف جديد لكل مكالمة فعلية.

### HIGH 3 — خصائص التحويل المهمة تضيع داخل adapter

**الملفات:** `server/ivrEngine.ts:564-573`, `server/telephony/unifonicAdapter.ts:147-155`, `server/routes-telephony.ts:60-64`

المحرك يرسل `ringTimeoutSec`, `callerId`, و`statusCallbackUrl`، لكن adapter لا يضعها في response. كذلك `adapterFor()` يعيد Unifonic دائمًا مهما كانت قيمة provider.

**الأثر:** إعداد مهلة الرنين قد لا يعمل، وربط نتيجة التحويل بالـstatus callback غير مضمون، وإضافة مزود جديد غير حقيقية رغم وجود interface.

### HIGH 4 — الإرسال المباشر بلا Outbox موثوق أو Retry

**الملفات:** `server/ivrEngine.ts:609-655`, `server/routes-telephony.ts:148-167`, `server/whatsapp.ts:563-594`

الـstatus webhook ينتظر إرسال واتساب مباشرة. عند الفشل يتم تسجيل الخطأ ثم إرجاع HTTP 200، ولا توجد وظيفة تعيد المحاولة. كذلك فحص flag ثم الإرسال ثم تحديث flag ليس atomic؛ callbackان متزامنان يمكن أن يرسلا مرتين.

**الإصلاح:** transactional outbox بوظائف `pending -> processing -> sent/failed`, idempotency key، lease، exponential backoff، حد محاولات، وdead-letter queue.

### HIGH 5 — ردود Cloud API لا تدخل الرد الآلي أو اختيار القسم

**الملفات:** `server/whatsappWebhook.ts:237-306`, `server/whatsappAutoReply.ts:29-42`

WhatsApp Web يمرر الرسالة الواردة إلى `handleGatewayEvent`، أما Cloud API فيعالج كلمات الصيانة والفني فقط. إذا رد العميل `1` أو `2` فلن يتم توجيهه للقسم.

**الإصلاح:** inbound pipeline واحد لكلا المزودين، مع router للنية والحالة conversation state بدل مسارين منفصلين.

### HIGH 6 — بنية قوالب Cloud API غير صحيحة للتوسع

**الملفات:** `server/whatsapp.ts:515-560,728-758`, `server/whatsappTemplates.ts:108-129`

كل الرسائل تستخدم اسم قالب عالمي واحد إن كان مضبوطًا، وترسل النص الكامل كمتغير واحد. اسم القالب المنطقي (`missed_call_customer`, إلخ) لا يصل إلى Cloud payload. الدالة `templateToCloudParams()` موجودة لكنها غير مستخدمة.

**الإصلاح:** registry يربط كل use-case باسم Meta المعتمد، اللغة، الفئة، وترتيب parameters/buttons. منع النص الحر تلقائيًا خارج customer-service window.

### HIGH 7 — Android SMS outbox قابل للإرسال المكرر

**الملفات:** `server/gateway.ts:70-97`, `server/routes-gateway.ts:95-127`

poll يقرأ `pending` ولا يحجز الرسالة أو يمنح lease. Pollان قبل ack يستلمان نفس الرسالة. كما أن failed ack يستطيع تحويل رسالة `sent` إلى `failed` لأن شرط `status='pending'` مفقود.

**الإصلاح:** claim endpoint ذري، lease expiry، device id، attempt count، ومنع أي انتقال عكسي للحالة.

### HIGH 8 — لا يوجد مفتاح idempotency مفروض في قاعدة البيانات

**الملفات:** `server/db.ts:356-379,604-632`, `server/whatsappWebhook.ts:237-245`

`message_id` و`call_sid` عليهما indexes عادية فقط. check-then-insert قابل للسباق، والإنتاج يحتوي بالفعل message id مكررًا.

**الإصلاح:** unique partial indexes مناسبة، جدول webhook_events بمفتاح provider event id، وupsert/transaction بدل check منفصل.

### HIGH 9 — لا توجد اختبارات لوظائف التواصل الحرجة

لا توجد unit tests لمحرك IVR أو gateway أو WhatsApp Cloud payload أو webhook routing أو outbox concurrency. نجاح `45/45` الحالي يتعلق بالمخطط والإصدار والأمان والحسابات، ولا يثبت نجاح المكالمة الفائتة.

**الإصلاح:** contract tests لكل adapter، state-machine tests، duplicate/retry tests، وE2E من missed-call إلى delivered/read ثم رد العميل وتسليم الموظف.

### MEDIUM 1 — تطبيع الهاتف مكرر في ستة أماكن

**الملفات:** `server/gateway.ts`, `server/ivrEngine.ts`, `server/salla.ts`, `server/telephony/unifonicAdapter.ts`, `server/whatsapp.ts`, `server/whatsappWebhook.ts`

**الإصلاح:** `shared/phone.ts` بقيمة canonical E.164 واختبارات السعودية/الدولي والأرقام غير الصحيحة.

### MEDIUM 2 — حدود tenant/owner غير متسقة

**الملفات:** `server/ivrEngine.ts:399-416`, `server/whatsappWebhook.ts:94-116`, `server/routes-whatsapp.ts:338-375`

بعض استعلامات call sid والفني/الحجز لا تحتوي owner_uid، وبعض شاشات admin تقرأ رسائل كل المالكين. اليوم النظام single-tenant، لكن هذا يمنع التوسع الآمن.

### MEDIUM 3 — زر تعطيل نظام الاتصال لا يوقف الـwebhooks

**الملفات:** `server/ivrEngine.ts:82-94`, `server/routes-telephony.ts:119-130`

`enabled` يُحفظ ويظهر في UI، لكنه لا يُفحص قبل بناء greeting أو معالجة status.

### MEDIUM 4 — حالة الرسالة يمكن أن تتراجع

**الملف:** `server/whatsapp.ts:667-686`

callback متأخر من `delivered` يستطيع استبدال `read`. نحتاج ترتيب حالات أو status history.

### MEDIUM 5 — الإحصاءات اليومية تستخدم UTC لا توقيت الرياض

**الملفات:** `server/whatsapp.ts:789-810`, `server/ivrEngine.ts:419-428`

اليوم يُحسب بـ`toISOString()`، فتظهر أرقام اليوم بصورة خاطئة حول منتصف الليل بتوقيت السعودية.

### MEDIUM 6 — direct mode قد يسجل notified بلا إرسال

**الملف:** `server/gateway.ts:206-225`

عند عدم وجود قسم لا تُرسل رسالة، ثم يضبط الكود `wa_customer_notified=1` خارج شرط وجود القسم.

### MEDIUM 7 — بوابة Android تعتمد token ثابتًا وقابلًا لإعادة التشغيل

**الملف:** `server/routes-gateway.ts:46-65,73-127`

لا يوجد timestamp/nonce/event id أو توقيع HMAC لكل حدث، كما يقبل token في query. تسريب token يسمح بإدخال أحداث وقراءة/ack outbox.

### MEDIUM 8 — الملفات المركزية كبيرة وتخلط المسؤوليات

`server/whatsapp.ts` قرابة 826 سطرًا، و`server/ivrEngine.ts` قرابة 665 سطرًا. الاتصال، النقل، policy، persistence، templates، والتسجيل موجودة في طبقات متداخلة و`any` مستخدم بكثرة في Baileys payloads.

## تقييم المعمارية والوراثة

عدم وجود شجرة وراثة Classes كبيرة ليس خطأ. الاختيار الصحيح هنا هو **composition + ports/adapters + state machines**، وليس إنشاء `BaseWhatsApp` و`BaseCall` بوراثة عميقة.

الجزء الجيد الحالي هو `TelephonyAdapter` كـinterface. المطلوب تعميم الفكرة:

```text
InboundCallPort
  -> UnifonicAdapter | AndroidGatewayAdapter | مزود آخر

MessagingPort
  -> WhatsAppCloudAdapter | WhatsAppWebAdapter | SmsGatewayAdapter

ConversationRouter
  -> SalesIntent | MaintenanceIntent | OrderIntent | InvoiceIntent | ComplaintIntent | HumanHandoff

Repositories
  -> CallRepository | ConversationRepository | MessageJobRepository | ConsentRepository
```

القواعد التجارية لا تستدعي Meta أو SQLite مباشرة. هي تنتج domain events/jobs، والـworker ينفذ الإرسال ويحدث الحالة.

## المعمارية المستهدفة

```text
Unifonic / Android / WhatsApp Call Event
               |
               v
     Signed Webhook Ingress
     normalize + validate + dedupe
               |
               v
        Call Session State Machine
 ringing -> routed -> answered | missed
               |
        MissedCallDetected event
               |
               +--> CRM activity + customer 360
               +--> create/update lead/task
               +--> Message Job Outbox
                          |
                          v
                 WhatsApp Cloud Adapter
                 approved template + idempotency
                          |
                          v
                 status webhook/history

Customer WhatsApp Reply
  -> webhook_events dedupe
  -> conversation state + intent router
  -> Salla order lookup / CRM deal / maintenance / invoice
  -> human handoff when uncertain
```

## قائمة الرد الآلي المقترحة: ست خدمات

رسالة المكالمة الفائتة المقترحة كقالب Utility معتمد:

> مرحبًا {{1}}، لاحظنا اتصالك بـBreeXe Pro ولم نتمكن من الرد. كيف نقدر نخدمك؟ اختر من القائمة، أو اكتب طلبك مباشرة.

1. المبيعات وطلب منتج.
2. الصيانة وحجز موعد.
3. حالة طلب سلة.
4. فاتورة أو دفع.
5. شكوى أو استرجاع.
6. التحدث مع موظف.

الرد لا يعتمد فقط على رقم؛ يقبل النص العربي أيضًا. أي ثقة منخفضة أو عميل غاضب أو تكرار فشل يتحول مباشرة لموظف.

## ربط الأنظمة

### سلة

- ربط OAuth من جديد؛ المفاتيح موجودة لكن لا توجد integration session حاليًا.
- استخدام رقم الهاتف canonical لربط العميل والطلب.
- intent «حالة طلبي» يعرض آخر طلب وحالته بعد تحقق بسيط من هوية العميل.
- أحداث order.created/order.updated تنتج automation jobs اختيارية، لا ترسل مباشرة من webhook.

### CRM Odoo

- الموجود حاليًا CRM محلي باسم Odoo وفيه 3 صفقات ومهمة وملاحظة، وليس external Odoo connector.
- نحدد القرار: إما إبقاؤه مصدر CRM داخليًا، أو إضافة `OdooAdapter` حقيقي عبر API/JSON-RPC مع mapping وsync cursor وconflict policy.
- كل مكالمة فائتة تنشئ activity، وكل اختيار مبيعات ينشئ/يحدث lead، وكل تسليم لموظف ينشئ task بمهلة SLA.

### واتساب

- Cloud API هو قناة الإنتاج الأساسية.
- WhatsApp Web يبقى أداة احتياط/اختبار، وليس مصدر الحقيقة للحملات.
- لكل template اسم Meta مستقل ونسخ ولغات وversion وحالة approval.

### المكالمات والرد الآلي

- مزود واحد فعلي في أول إطلاق، مع adapter contract موثق.
- call id فريد لكل مكالمة، وتسجيل كامل للحالات.
- SLA لمعاودة الاتصال، escalation تلقائي، وتأكيد الموظف «تم» مرتبط بالمكالمة المحددة لا بأحدث مكالمة للرقم فقط.

## خطة التنفيذ والآثار الجانبية

### المرحلة 0 — تجميد آمن

- تحويل outbound من production إلى allowlist أثناء البناء.
- لا رسائل حقيقية إلا لأرقام اختبار.

**الأثر:** تتوقف الرسائل الآلية للعملاء مؤقتًا، لكن يمنع الإرسال الخاطئ أثناء إصلاح token/templates.

### المرحلة 1 — إصلاح الاتصال

- token/system user، phone id، webhook verify/HMAC، القالب، وفحص health حقيقي.
- إعادة ربط سلة OAuth.
- إضافة الرقم الرئيسي والأقسام والموظفين.

**الأثر:** restart واحد للخدمة، وقد يحتاج قالب Meta وقت موافقة خارجي.

### المرحلة 2 — قلب موثوق للتواصل

- shared phone normalization.
- webhook_events + message_jobs + message_attempts + conversation_sessions + consents/suppressions.
- worker وretry/dead-letter/idempotency.

**الأثر:** migrations إضافية فقط؛ لا إعادة كتابة للرسائل والفواتير التاريخية. يلزم نسخ احتياطي قبل migration.

### المرحلة 3 — المكالمة الفائتة MVP

- event -> call state -> approved WhatsApp template -> status -> employee task.
- منع التكرار الذري، SLA، وإعادة إرسال مدروسة.

**الأثر:** ستظهر مهام CRM جديدة تلقائيًا، وقد يزيد عدد التنبيهات للموظفين حتى ضبط القواعد.

### المرحلة 4 — الرد الآلي بست خدمات

- conversation state، قائمة تفاعلية، intent router، human handoff.
- توحيد Cloud/Web inbound pipeline.

**الأثر:** تتغير طريقة تفسير كلمات مثل «تم» و«1»؛ يلزم اختبار regression لمسارات الصيانة والفنيين.

### المرحلة 5 — تكامل سلة وCRM/Odoo

- order lookup، lead/activity/task، customer 360 موحد.
- إن كان Odoo خارجيًا، adapter ومزامنة ثنائية باتفاق مصدر الحقيقة.

**الأثر:** احتمال تكرار leads/tasks في أول sync؛ نمنعه بمفاتيح خارجية وupsert.

### المرحلة 6 — Campaign Engine

- audience builder، consent/suppression، template versions، scheduling، rate limiting، pause/resume، A/B، metrics.
- منع الإرسال لمن قال «إلغاء/STOP» أو تجاوز frequency cap.

**الأثر:** الجمهور القابل للإرسال سيكون أقل من كل العملاء؛ هذا مقصود لحماية الامتثال وجودة الرقم.

### المرحلة 7 — إطلاق تدريجي

1. اختبارات وحدة وعقود.
2. E2E على أرقام الفريق.
3. allowlist من 5 عملاء موافقين.
4. 25 ثم 100 ثم الجمهور المؤهل.
5. مراقبة failure/read/block/opt-out والتوقف الآلي عند تجاوز الحدود.

## بوابات القبول قبل الإنتاج

- Graph health ناجح وtoken غير منتهي.
- webhook signed يعيد 200 ويخزن event مرة واحدة.
- القالب approved ومربوط بالمتغيرات الصحيحة.
- مكالمة حقيقية واحدة تنتج call row واحدًا ورسالة واحدة فقط.
- callback مكرر لا يرسل رسالة ثانية.
- فشل Meta ينتقل إلى retry ثم dead-letter ولا يضيع.
- رد `1` عبر Cloud API يفتح مسار المبيعات.
- `إلغاء` يضيف الرقم إلى suppression فورًا.
- سلة تعيد حالة الطلب الصحيحة.
- handoff ينشئ task وSLA ويظهر في Customer 360.
- جميع الاختبارات تعمل دون إرسال فعلي افتراضيًا.

## الخلاصة

الأساس الحالي مفيد لكنه prototype تشغيلي متعدد المسارات، وليس بعد منصة تواصل قوية. الأولوية ليست إضافة شاشات أكثر؛ الأولوية هي إصلاح قناة WhatsApp الحقيقية، توحيد inbound routing، إضافة outbox/idempotency، ثم بناء الرد الآلي والحملات فوق قلب موثوق.
