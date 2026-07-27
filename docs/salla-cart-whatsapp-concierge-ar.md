# مساعد واتساب للسلات المتروكة

الإصدار: `1.8.0`

## ما الذي ينفذه النظام؟

1. يستقبل أحداث سلة الرسمية:
   - `abandoned.cart`
   - `abandoned.cart.updated`
   - `abandoned.cart.status.changed`
   - `abandoned.cart.purchased`
2. يقرأ تفاصيل السلة من واجهة سلة باستخدام صلاحية `carts.read`.
3. يحفظ السلة ومنتجاتها ورابط إكمال الطلب في قاعدة البيانات.
4. ينشئ رسالة واتساب مؤجلة واحدة فقط لكل سلة.
5. يتحقق قبل الإرسال من:
   - أن السلة ما زالت نشطة.
   - وجود موافقة صريحة للتسويق عبر واتساب في سجل تفضيلات العميل.
   - بوابة الإرسال العامة (`OUTBOUND_MODE` و`OFFICIAL_LAUNCH_APPROVED`).
6. إذا رد العميل، يجيب النظام من بيانات المنتج المؤكدة عن السعر والتوفر
   والمواصفات وخدمة التركيب أو الصيانة.
7. إذا لم توجد إجابة مؤكدة، ينشئ مهمة عالية الأولوية في CRM بدل اختراع جواب.
8. إذا اشترى العميل قبل وقت الإرسال، يلغي النظام الرسالة المعلقة.

## الإعداد

```env
SALLA_SCOPES=offline_access orders.read_write products.read_write customers.read_write webhooks.read_write carts.read
SALLA_CART_WHATSAPP_ENABLED=true
SALLA_CART_WHATSAPP_DELAY_MINUTES=30
SALLA_CART_WHATSAPP_EXPIRY_MINUTES=1440
SALLA_CART_WHATSAPP_SESSION_MINUTES=1440
WHATSAPP_CLOUD_TEMPLATE_ABANDONED_CART_SUPPORT=
```

إضافة `carts.read` إلى الملف لا توسع صلاحية التوكن القديم تلقائيًا؛ يجب إعادة
تفويض المتجر مرة واحدة.

## قالب Meta

أنشئ قالبًا عربيًا معتمدًا من نوع Marketing أو Utility وفق تصنيف Meta الفعلي،
ويحتوي متغيرات الجسم بهذا الترتيب:

1. اسم العميل.
2. أسماء المنتجات.
3. رابط إكمال السلة.

ثم ضع الاسم المعتمد في:

```env
WHATSAPP_CLOUD_TEMPLATE_ABANDONED_CART_SUPPORT=approved_template_name
```

## ربط أحداث سلة

ابدأ بالمعاينة:

```powershell
npm run salla:webhooks
```

ثم طبّق بعد مراجعة قائمة الأحداث:

```powershell
npm run salla:webhooks -- --apply
```

الأداة لا تشترك إلا في الأحداث التي يعرضها متجر سلة على أنها متاحة، وتتحقق
بعد التطبيق من وجود كل اشتراك.

## المراقبة

يمكن للحساب المسجل قراءة آخر السلات وحالة التواصل من:

```text
GET /api/integrations/salla/abandoned-carts
```

الحالات المهمة:

- `queued`: الرسالة مؤجلة.
- `sent`: أرسل القالب وبدأت جلسة الأسئلة.
- `salla_cart_consent_missing`: لم توجد موافقة صريحة، لذلك لم تُرسل الرسالة.
- `salla_cart_purchased`: اشترى العميل قبل الإرسال.
- `checkout_url_missing`: وصل الحدث دون رابط صالح، ولم تُنشأ رسالة.

## الرجوع السريع

```env
SALLA_CART_WHATSAPP_ENABLED=false
```

هذا يوقف إنشاء رسائل جديدة مع استمرار حفظ أحداث السلة لأغراض المتابعة.
