# معمارية الرد الآلي وتوجيه المكالمات

يعالج Unifonic المكالمة الصوتية. بوابة أندرويد ليست بديلًا للرد الصوتي؛ وظيفتها
إرسال SMS احتياطيًا عندما يتعذر واتساب.

## التدفق التشغيلي

1. يستقبل الخادم الطلب الأول على:
   `GET /webhooks/telephony/ivr`
2. يتحقق من ترويسة `Authorization`، ويحدد مساحة الشركة من الرقم المطلوب في
   `telephony_numbers`.
3. ينشئ صفًا جديدًا في `call_logs` لكل اتصال، حتى لو تكرر رقم المتصل، ويولد رمز
   جلسة عشوائيًا صالحًا 30 دقيقة. لا تخزن قاعدة البيانات إلا بصمة الرمز.
4. يتضمن `responseUrl` المسار:
   `POST /webhooks/telephony/ivr/session/:token`
5. بعد اختيار القسم، يختار النظام مختصًا نشطًا واحدًا بالتناوب داخل معاملة قاعدة
   بيانات، ثم يصدر تعليمة تحويل مع تعطيل التسجيل الصوتي.
6. عند اختيار خاطئ تُعاد القائمة مرة واحدة. بعد الخطأ الثاني أو عدم توفر مختص أو
   الخروج عن ساعات العمل، تنتهي المكالمة وتُنشأ متابعة.
7. تصل حالات المكالمة إلى:
   `POST /webhooks/telephony/status`
   باستخدام Basic Authentication مستقل.
8. تُحفظ بصمة كل حدث في `telephony_events`. الحدث المكرر ينجح دون إعادة إنشاء
   Lead أو مهمة أو رسالة، وفشل الحفظ يعيد خطأ قابلًا لإعادة المحاولة.

## الهوية والصلاحيات

- `workspace_owner_uid` هو مالك مساحة بيانات الشركة المشتركة.
- `uid` يبقى هو المستخدم الذي نفذ الإجراء ويظهر في سجل التدقيق.
- المدير والمسؤول يعرضان سجل الشركة كاملًا ويديران الرقم والأقسام.
- المبيعات والفنيون يعرضون المكالمات المسندة إليهم فقط من شاشة «مكالماتي».
- المستخدم العادي لا يملك وصولًا لقسم الهاتف.
- يربط `telephony_numbers` كل رقم وارد بمالك المساحة بدل اختيار أول مسؤول.

## حالات مستقلة

حالة الاتصال في `call_status`:

- `new`, `menu`, `selected`, `forwarding`, `ringing`, `connected`
- `completed`, `no_answer`, `busy`, `failed`

حالة المتابعة في `follow_up_status`:

- `new`, `assigned`, `in_progress`, `done`

تسجيل نتيجة المتابعة لا يغير حالة الاتصال الأصلية.

## التكامل مع CRM

- يطابق المتصل مع العميل بالرقم الدولي الموحد.
- قسم `lead` ينشئ فرصة للرقم غير المسجل فقط، ويمنع Lead مفتوحًا آخر لنفس الرقم
  والقسم خلال 30 يومًا.
- قسم `service_task` ينشئ مهمة خدمة.
- قسم `none` يسجل المكالمة فقط.
- المكالمة الفائتة أو المشغولة أو الفاشلة تنشئ مهمة أولوية عالية تستحق خلال
  15 دقيقة، وتُسند للمختص أو طابور المدير.
- يعرض عميل 360 المكالمات والفرص الهاتفية والمهام ومحادثات واتساب.
- إنشاء العميل والحجز وعرض السعر إجراءات صريحة من واجهة المكالمة، ولا تُنشأ
  الحجوزات أو العروض أو الفواتير تلقائيًا.

## الإشعارات

يحجز `communication_outbox` مفتاحًا فريدًا لكل رسالة. يجرب النظام واتساب أولًا،
ثم يضع SMS واحدًا في `gateway_outbox` عند التعذر. إعادة Webhook لا تكرر الرسالة.

## الإعداد

```dotenv
WORKSPACE_OWNER_UID=<uid مالك بيانات الشركة>
TELEPHONY_PROVIDER=unifonic
TELEPHONY_MAIN_NUMBER=9665XXXXXXXX
TELEPHONY_RING_TIMEOUT_SEC=20
TELEPHONY_WEBHOOK_SECRET=<Authorization للطلب الأول>
TELEPHONY_STATUS_WEBHOOK_USER=<Basic username>
TELEPHONY_STATUS_WEBHOOK_PASSWORD=<Basic password>
PUBLIC_BASE_URL=https://crm.example.com
UNIFONIC_APP_SID=
UNIFONIC_API_KEY=
UNIFONIC_VOICE_BASE_URL=
```

## إعداد Unifonic

- اربط الرقم بـIncoming Call Application واجعل IVR Endpoint هو العنوان الذي
  تعرضه الواجهة، واضبط قيمة Authorization. راجع
  [Inbound IVR](https://docs.unifonic.com/articles/products-documentation/inbound-ivr).
- يستدعي Unifonic `responseUrl` باعتماد `POST` وبدون Authorization، لذلك يحميه
  رمز الجلسة وليس السر العام. راجع
  [Managing incoming calls](https://docs.unifonic.com/articles/api-documentation/managing-your-incoming-calls).
- اضبط Status Webhook مع Basic Authentication المستقل. راجع
  [Call status webhook](https://docs.unifonic.com/articles/products-documentation/setting-up-a-webhook-to-receive-all-call-statuses/).

## الفحص

```bash
npm run lint
npm run build
npm run test:smoke
npm run test:golden
npm run test:telephony
```

لا يُعتمد الإنتاج قبل مكالمة حقيقية تظهر في CRM، وتنشئ المتابعة الصحيحة، ولا
تكرر المهمة أو الرسائل. تظهر حالة ذلك منفصلة في الواجهة عن اكتمال الإعداد.
