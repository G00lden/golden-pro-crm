# External Agent Brief - Golden Pro CRM

استخدم هذا الملخص عند طلب تعديل من منصة أخرى أو وكيل آخر. انسخه مع الطلب الجديد حتى يفهم السياق بسرعة.

## وصف النظام

Golden Pro CRM هو نظام لإدارة العملاء والصيانة والحجوزات والتذكيرات. يعمل محليا الآن، ومجهز للعمل سحابيا مع Firebase Firestore وExpress API. الهدف الأساسي: عدم ترك أي عميل بدون متابعة أو استهداف.

## البنية المختصرة

- Frontend: React + Vite في `src/App.tsx`.
- Frontend data layer: `src/api.ts`.
- Server: Express في `server.ts`.
- Server services: مجلد `server/`.
- Database: Firestore.
- Auth: Firebase Auth، مع local auth للتجربة فقط.
- Store integration: Salla Webhook في `server/storeWebhook.ts`.
- Messaging: `server/whatsapp.ts` يدعم WhatsApp Web عبر Baileys أو WhatsApp Cloud API.
- Reminders: `server/reminderEngine.ts`.
- Booking completion: `server/bookingLifecycle.ts`.
- Technician notifications: `server/bookingNotifications.ts`.

## أهم الملفات

- `src/App.tsx`: الصفحات، النماذج، التنقل، رسائل الواجهة.
- `src/api.ts`: Types ودوال CRUD واستدعاءات API وحساب رعاية العملاء.
- `server.ts`: routes وحماية API وcron.
- `server/storeWebhook.ts`: رحلة الطلب من سلة.
- `server/reminderEngine.ts`: التذكيرات المجدولة واليدوية.
- `server/whatsapp.ts`: WhatsApp Web/Cloud API.
- `firestore.rules`: قواعد الأمان.
- `firestore.indexes.json`: الفهارس.
- `scripts/smoke.mjs`: فحص الدخان.
- `scripts/doctor.mjs`: فحص البيئة.
- `docs/architecture-development-guide.md`: الدليل الكامل للتطوير.

## رحلة العميل والطلب

مصادر العملاء:

- `manual`: إدخال يدوي من الواجهة.
- `salla`: طلب متجر عبر Webhook.

أنواع بنود سلة:

- `SALE-` أو `sale_only`: بيع فقط، يحفظ العميل والطلب ولا ينشئ تركيب أو حجز.
- `INSTALL-` أو `install_maintenance`: منتج جديد يحتاج تركيب وصيانة.
- `MAINT-` أو `maintenance_existing`: طلب صيانة لمنتج سابق.
- `EXT-` أو `external_maintenance`: صيانة لجهاز خارجي ليس من Golden Pro.
- غير مصنف: `needs_review`.

المنطق:

1. Webhook يستقبل الطلب ويتحقق من secret أو HMAC.
2. ينشئ/يحدث العميل والمنتج.
3. يصنف كل بند حسب SKU أو tags.
4. `INSTALL-` ينشئ `installation` بحالة `pending_installation`.
5. `MAINT-` يبحث عن تركيب نشط بنفس الجوال ومفتاح SKU normalized، مثل مطابقة `MAINT-GP-FILTER` مع `INSTALL-GP-FILTER`.
6. `EXT-` ينشئ `installation` بحالة `pending_external_service`.
7. إذا يوجد موعد من سلة وفني افتراضي، ينشئ `booking`.
8. إذا فشل ربط الصيانة السابقة، يدخل الطلب `needs_review`.
9. صفحة "طلبات المتجر" تسمح بالربط اليدوي.
10. عند الربط اليدوي، إذا يوجد موعد وفني افتراضي، ينشأ حجز تلقائيا.
11. عند إكمال الحجز، تصبح الخدمة `active` ويحسب `next_maintenance`.
12. التذكيرات تعمل فقط على `installations.status == active`.
13. صفحة "رعاية العملاء" تعرض من يحتاج متابعة أو استهداف.

## قاعدة البيانات

Collections:

- `customers`
- `products`
- `installations`
- `technicians`
- `bookings`
- `reminders`
- `technician_notifications`
- `settings`
- `store_orders`
- `store_webhook_events`

قاعدة أمان مركزية: كل مستند مستخدم يحتوي `createdBy`. لا تكسر هذا الشرط.

## قواعد عند طلب تعديل جديد

- لو التعديل واجهة فقط: ابدأ من `src/App.tsx`.
- لو التعديل قراءة/كتابة بيانات: عدل `src/api.ts`.
- لو التعديل حساس أو يرسل رسالة أو يتعامل مع Webhook: أضف route في `server.ts` وخدمة في `server/`.
- لو أضفت حقول Firestore يكتبها العميل: حدّث `firestore.rules`.
- لو أضفت query جديد: راجع `firestore.indexes.json`.
- لو أضفت رحلة أساسية: حدّث `scripts/smoke.mjs`.
- لا تحفظ secrets داخل الملفات.
- لا تعتبر رسالة مرسلة إلا إذا رجع WhatsApp بنجاح.
- لا تنشئ تركيب من طلب غير مصنف؛ استخدم `needs_review`.

## أوامر الفحص

```powershell
npm run doctor
npm run lint
npm run build
npm run test:smoke
```

قبل الإنتاج:

```powershell
npm run doctor:prod
```

## حالة جاهزية مهمة

- محليا: يعمل عبر `npm run dev` على `http://localhost:3000`.
- Firestore جاهز لكن يحتاج إعداد Firebase Auth وAdmin credentials.
- Salla Webhook يحتاج `STORE_WEBHOOK_SECRET` و`STORE_WEBHOOK_OWNER_UID`.
- WhatsApp Web يحتاج QR وجلسة `.wa-session`.
- WhatsApp Cloud API يحتاج `WHATSAPP_PROVIDER=cloud_api` وبيانات Meta.
- رسائل Cloud API الإنتاجية يفضل لها قالب معتمد باسم `WHATSAPP_CLOUD_TEMPLATE_NAME`.

## طلب تعديل مقترح لوكيل آخر

استخدم الصيغة التالية:

```text
اعمل على مشروع Golden Pro CRM. اقرأ أولا:
- docs/architecture-development-guide.md
- docs/external-agent-brief.md
- docs/store-webhook-architecture.md إذا كان التعديل يخص المتجر
- docs/reminder-architecture.md إذا كان التعديل يخص التذكيرات

التزم بالمعمارية:
- الواجهة في src/App.tsx
- data layer في src/api.ts
- العمليات الحساسة في server.ts وخدمات server/
- كل مستند Firestore يجب أن يحتوي createdBy
- حدّث firestore.rules وfirestore.indexes.json عند الحاجة
- حدّث scripts/smoke.mjs لأي رحلة أساسية

بعد التنفيذ شغل:
npm run lint
npm run build
npm run test:smoke
npm run doctor

المطلوب الآن: [اكتب التعديل المطلوب هنا]
```
