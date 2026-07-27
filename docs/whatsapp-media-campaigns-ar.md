# حملات واتساب الجماعية بالصور والفيديو والأزرار

## ما تم تنفيذه

مركز الحملات يدعم الآن عرضًا جماعيًا يحتوي:

- صورة `JPEG/PNG` حتى 5 MB أو فيديو `MP4` حتى 16 MB.
- نص عرض متغير لكل حملة واسم عميل متغير لكل مستلم.
- زر `اطلب الآن` يفتح رابطًا داخل نطاق المتجر المعتمد.
- زر `غيّر الفلاتر` يجمع طلب العميل وينشئ مهمة مبيعات عالية الأولوية في CRM.
- زر `احجز موعد` يبدأ الحجز الذاتي الحالي، يحفظ بيانات العميل والموعد في CRM، ثم يرسل تعيين الموعد للفني.
- رفع ملف من الجهاز إلى مسار عام ذي اسم عشوائي، أو استخدام رابط وسائط HTTPS خارجي.
- معاينة الوسائط والأزرار قبل الإطلاق.

كل حملة تبقى خلف بوابات الموافقة التسويقية، قائمة الإلغاء، حد التكرار، منع الأرقام المكررة، تحديد السرعة، الجدولة، والإيقاف/الإلغاء.

## قوالب Meta المطلوبة

يجب إنشاء قالبين من فئة `Marketing` في WhatsApp Manager. يكون كل شيء متطابقًا بينهما عدا نوع الرأس:

### قالب الصورة

- Header: `IMAGE`
- Body:

```text
مرحبًا {{1}} 👋
{{2}}
```

- Button 0: نوع `URL`، العنوان `اطلب الآن`
- URL:

```text
https://goldenksa.store/{{1}}
```

- Button 1: نوع `QUICK_REPLY`، العنوان `غيّر الفلاتر`
- Button 2: نوع `QUICK_REPLY`، العنوان `احجز موعد`

### قالب الفيديو

نفس الجسم والأزرار تمامًا، ويكون Header من نوع `VIDEO`.

بعد اعتماد القالبين، تُضبط أسماؤهما الفعلية في بيئة الإنتاج:

```dotenv
WHATSAPP_CLOUD_TEMPLATE_CAMPAIGN_OFFER_IMAGE=approved_image_template_name
WHATSAPP_CLOUD_TEMPLATE_CAMPAIGN_OFFER_VIDEO=approved_video_template_name
WHATSAPP_CLOUD_TEMPLATE_LANGUAGE=ar
WHATSAPP_CAMPAIGN_ORDER_URL_PREFIX=https://goldenksa.store/
PUBLIC_BASE_URL=https://crm.example.com
WHATSAPP_CAMPAIGN_MEDIA_DIR=.runtime/whatsapp-campaign-media
```

قيمة `WHATSAPP_CAMPAIGN_ORDER_URL_PREFIX` يجب أن تطابق الجزء الثابت في زر URL داخل قالب Meta وتنتهي بـ`/`. يمنع النظام روابط الطلب خارج هذا الجزء الثابت.

## متطلبات التشغيل الفعلي

لا يكفي إنشاء المسودة. تشغيل الحملة يرفض الطلب ما لم تتحقق جميع الشروط:

1. `WHATSAPP_PROVIDER=cloud_api`.
2. تحقق اتصال Cloud API حيًا.
3. القالب الموافق لنوع الوسائط معتمد ومربوط بمتغير البيئة الصحيح.
4. `OUTBOUND_MODE=production`.
5. `OFFICIAL_LAUNCH_APPROVED=true`.
6. لدى كل مستلم موافقة تسويق صريحة وغير موجود في قائمة الإلغاء.
7. الوسائط متاحة من رابط HTTPS عام.
8. رابط `اطلب الآن` يبدأ بالجزء المعتمد في `WHATSAPP_CAMPAIGN_ORDER_URL_PREFIX`.

## سلوك الأزرار

### اطلب الآن

قالب Meta يحتوي URL ديناميكيًا. يرسل CRM الجزء المتغير فقط، بعد التحقق من أنه ينتمي إلى بادئة المتجر المعتمدة.

### غيّر الفلاتر

يرسل الزر payload بالشكل:

```text
campaign:change_filters:<campaign_id>
```

يطلب CRM من العميل نوع الفلتر أو الجهاز والمقاس والكمية، ثم ينشئ مهمة:

- `related_type=whatsapp_campaign`
- أولوية `high`
- مرتبطة بالحملة والعميل إن كان رقمه معروفًا.

### احجز موعد

يرسل الزر payload بالشكل:

```text
campaign:book_appointment:<campaign_id>
```

ثم يستخدم نفس مسار الحجز الذاتي: الاسم، العنوان، نوع الخدمة، الموعد المتاح، تعيين الفني، وحفظ الحجز وإشعار الفني.

## ملاحظات تشغيلية

- أسماء الأزرار وترتيبها ثابتة لأن Meta تعتمد بنية القالب قبل الإرسال.
- رابط الوسائط المرفوع لا يحتوي اسم الملف الأصلي؛ يستخدم اسمًا عشوائيًا غير قابل للتخمين.
- الملفات المرفوعة جزء من بيانات التشغيل ويجب تضمين مجلدها في نسخ VPS الاحتياطية.
- الضغط على إلغاء الاشتراك أو كتابة كلمة إلغاء تسويقي يبقى أعلى أولوية من أي تفاعل مع الحملة.

المراجع الرسمية: [Meta WhatsApp Business Platform collection](https://www.postman.com/meta/whatsapp-business-platform/overview)، [Meta WhatsApp Node.js SDK template components](https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/types/component_object/).
