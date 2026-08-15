# تشغيل مطابقة طلبات INV90 بين سلة وGA4 وGoogle Ads

## تحديث أمني: مطالبة تتبع موقّعة

لا يقبل الخادم بيانات النقرة مباشرة مع رقم طلب مكتمل. أثناء خطوات الدفع يرسل الملحق `checkout_id` ومعرّفات القياس المسموح بها إلى `POST /api/storefront/attribution-claim` مع رمز عشوائي بطول 192 بت. يحفظ الخادم المطالبة مرة واحدة ويعيد رمزًا قصير العمر موقّعًا بـHMAC؛ ويبقى سر التوقيع على الخادم فقط.

عند `Order Completed` يرسل المتصفح إلى `POST /api/storefront/order-attribution` رقم الطلب و`checkout_id` والقيمة والعملة والرمز الموقّع فقط. لا يتم الربط إلا بعد أن يصل Webhook سلة الموثّق ويحفظ `checkout_id` نفسه على الطلب، ولا يمكن استبدال مطالبة مرتبطة سابقًا. إذا وصل Webhook قبل إنشاء المطالبة يُغلق المعرّف دون مطالبة، منعًا لإصدار رمز بعد معرفة تفاصيل الطلب.

```dotenv
STORE_ATTRIBUTION_SIGNING_SECRET=server_only_random_secret_at_least_32_characters
STORE_ATTRIBUTION_CLAIM_TTL_SECONDS=14400
ANALYTICS_RESERVATION_TTL_MS=300000
```

## النتيجة التي ينفذها هذا الفرع

- يستقبل مسار سلة الحالي `POST /api/integrations/salla/webhook` أحداث الطلب والدفعة والإلغاء والاسترجاع.
- يحفظ داخل `store_orders` سجلًا خاصًا يضم رقم الطلب، اسم العميل، طريقة الدفع، SKU، معرّف منتج سلة، الكمية، المبالغ، الكوبون وحالة القياس.
- يبني حدث GA4 `purchase` أو `refund` باستخدام `transaction_id = order_number` و`item_id = SKU`.
- يمنع إرسال اسم العميل أو الهاتف أو طريقة الدفع الخام أو معرّفات النقر إلى GA4. المسموح تحليليًا هو تصنيف عام مثل `Mada` أو `Apple Pay` في `payment_type_group`.
- لا يخترع `client_id`. إذا لم تنقل واجهة المتجر `client_id` الحقيقي من جلسة الشراء إلى الطلب، يسجل `blocked_missing_client_id` ولا يرسل الحدث.
- يحتفظ بسجل مطابقة Google Ads خاص عندما يصل أحد `gclid` أو `gbraid` أو `wbraid`. الحالة تبقى `pending_configuration` أو `pending_adjustment`؛ هذا الفرع لا يدّعي رفع تحويل أو تعديل قيمة إلى Google Ads API.

## ملتقط واجهة سلة

- ملف الإنتاج هو `https://crm.breexe-pro.com/inv90-tracker.js` ويضاف في بوابة شركاء سلة كـApp Snippet.
- يسجل نفسه عبر `Salla.analytics.registerTracker`. ينشئ المطالبة عند `Checkout Step Viewed` أو `Checkout Step Completed` أو `Payment Info Entered`، ثم يستخدمها عند `Order Completed`.
- لا يقرأ أو يرسل الاسم أو الهاتف أو البريد أو طريقة الدفع. لا يبدأ الالتقاط إلا عند وجود كوكي `_ga`. طلب إنشاء المطالبة إلى `POST /api/storefront/attribution-claim` هو:

```json
{
  "checkout_id": "...",
  "claim_nonce": "192-bit-random-value",
  "client_id": "123456789.987654321",
  "session_id": "1723456789",
  "gclid": "...",
  "gbraid": "...",
  "wbraid": "...",
  "utm_source": "google",
  "utm_medium": "cpc",
  "utm_campaign": "SA_INV90_..."
}
```

وبعد توقيع المطالبة يرسل حدث اكتمال الطلب الحقول الآتية فقط:

```json
{
  "order_id": "123456789",
  "checkout_id": "...",
  "claim_token": "signed-payload.signature",
  "total": 199,
  "currency": "SAR"
}
```

المسار يقبل فقط أصل المتجر المسموح، ويحتاج `STORE_WEBHOOK_OWNER_UID`، ويرفض الربط ما لم يكن رقم الطلب موجودًا فعلًا في سجل CRM وكانت قيمة الطلب وعملته مطابقتين للسجل الموثوق. يعيد الملتقط المحاولة بتأخير متزايد إذا سبق حدث المتصفح وصول Webhook سلة. لا ترسل الاسم أو الهاتف أو البريد أو مرجع الدفع إلى GA4. البريد والهاتف المجزآن لـEnhanced Conversions يحتاجان مسارًا منفصلًا وموافقة وسياسة واضحة.

## أوضاع GA4 الآمنة

```dotenv
GA4_MEASUREMENT_MODE=disabled
GA4_MEASUREMENT_ID=G-XXXXXXXXXX
GA4_API_SECRET=secret_from_ga4
STORE_ATTRIBUTION_ALLOWED_ORIGINS=https://goldenksa.store
```

1. ابدأ بـ`disabled`: حفظ خاص فقط، ولا اتصال بـGoogle.
2. بعد وصول `client_id` الحقيقي استخدم `validate`: يرسل إلى `/debug/mp/collect` مع `ENFORCE_RECOMMENDATIONS`، ولا تظهر الأحداث في التقارير.
3. لا تستخدم `collect` إلا بعد أن تكون رسائل التحقق فارغة وينجح طلب حقيقي منخفض القيمة مرة واحدة فقط في سلة وGA4 وAds.
4. أبق الحملات متوقفة إذا كان فرق الطلبات أو قيمة البضاعة أكثر من 5% بعد مهلة المعالجة.

## منع التكرار والاسترجاع

- الشراء له مفتاح ثابت واحد داخل `analytics.purchase`، و`transaction_id` هو رقم طلب سلة.
- إعادة إرسال نفس webhook بعد نجاح `sent` أو `validated` لا ترسل الحدث مرة أخرى.
- الإلغاء والاسترجاع يبنيان حدث `refund` منفصلًا مع نفس `transaction_id` وبنود SKU.
- تعديل Google Ads عند الإلغاء لا يتم تلقائيًا في هذا الفرع؛ يلزم إعداد Conversion Adjustment/Google Ads API والتحقق من بيانات اعتماد الحساب قبل تفعيله.

## تقرير المطابقة الخاص

للمستخدم المسجل فقط:

```http
GET /api/store/reconciliation?from=2026-08-12&to=2026-08-13
```

يعيد أرقام الطلبات وتفاصيل العميل والدفع وSKU وحالة GA4 وحالة مطابقة Ads. هذا المسار خاص داخل CRM ولا يرسل بياناته إلى Google.

## اختبارات ما قبل النشر

```powershell
npm run test:analytics
npm run lint
npm run build
```

ثم نفذ طلبًا حقيقيًا منخفض القيمة وتحقق من الآتي:

1. رقم الطلب وSKU وطريقة الدفع والقيم صحيحة داخل تقرير المطابقة الخاص.
2. حدث GA4 واحد فقط يحمل نفس `transaction_id` بعد تحديث صفحة النجاح.
3. قيمة GA4 هي قيمة البضاعة دون الشحن والضريبة، بينما يبقى إجمالي المبلغ المشحون محفوظًا في `total` للمراجعة.
4. الإلغاء/الاسترجاع ينشئ `refund` ويُجهز تعديل Ads بدل ترك الإيراد القديم.
5. لا يوجد اسم أو هاتف أو طريقة دفع خام في DebugView أو Tag Assistant أو طلب Measurement Protocol.

## مراجع التنفيذ

- [Salla Device Mode واشتراط App Snippet](https://docs.salla.dev/1724504m0)
- [أحداث الطلب في Salla ومنها payment.updated وrefunded](https://docs.salla.dev/1894252m0)
- [مرجع GA4 Measurement Protocol](https://developers.google.com/analytics/devguides/collection/protocol/ga4/reference)
- [التحقق عبر GA4 debug endpoint](https://developers.google.com/analytics/devguides/collection/protocol/ga4/validating-events)
