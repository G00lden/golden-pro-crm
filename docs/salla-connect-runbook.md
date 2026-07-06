# ربط تطبيق Salla بالـ CRM — دليل التشغيل

> الكود جاهز إنتاجيًا (OAuth + Webhook مُوقّع + مزامنة + منع تكرار). الربط **إعدادات فقط**، مش كود.
> راجع `docs/salla-api-integration.md` للمعمارية التفصيلية، و`server/salla.ts` للتنفيذ.

## المسارات المعنية
- **OAuth callback:** `https://crm.breexe-pro.com/api/integrations/salla/callback`
- **App Webhook:** `https://crm.breexe-pro.com/api/integrations/salla/webhook` (يتحقق من `x-salla-signature` عبر HMAC-SHA256)
- الحالة/المزامنة (داخل الـ CRM، محمية بتسجيل الدخول): `/api/integrations/salla/status` · `/api/integrations/salla/sync`

## الأحداث (Events) التي يدعمها الكود
اشترك فيها من لوحة Salla Partner:
`app.store.authorize` · `app.uninstalled` · `order.created` · `order.updated` · `order.refunded` · `order.cancelled` · `product.created` · `product.updated` · `product.deleted`

## 1) لوحة Salla Partner (التطبيق)
1. **Webhook URL** = مسار الـ App Webhook أعلاه.
2. **استراتيجية الأمان** = Signature، و**السر** = نفس قيمة `SALLA_APP_WEBHOOK_SECRET` في `.env`.
3. **Redirect URI** (لو Custom Mode) = مسار الـ callback أعلاه.
4. اشترك في الأحداث المذكورة أعلاه.
5. انسخ **Client ID** و**Client Secret**.

## 2) متغيّرات البيئة في `.env` (على جهاز الاستضافة)
```env
SALLA_AUTH_MODE=easy
SALLA_CLIENT_ID=<من صفحة التطبيق>
SALLA_CLIENT_SECRET=<من صفحة التطبيق>
SALLA_REDIRECT_URI=https://crm.breexe-pro.com/api/integrations/salla/callback
SALLA_SCOPES=offline_access orders.read products.read
SALLA_STATE_SECRET=<سر عشوائي 32+ حرف>
SALLA_APP_WEBHOOK_SECRET=<نفس السر في لوحة سلة>
SALLA_APP_OWNER_UID=<UID مالك الـ CRM = نفس STORE_WEBHOOK_OWNER_UID>
SALLA_SYNC_CRON_ENABLED=true
SALLA_SYNC_CRON_SCHEDULE=*/15 * * * *
```

توليد السرّين العشوائيين:
```bash
node -e "const c=require('crypto');console.log('STATE=',c.randomBytes(32).toString('hex'));console.log('WEBHOOK=',c.randomBytes(24).toString('hex'))"
```

> **`SALLA_APP_OWNER_UID`**: هو UID حساب مالك الـ CRM في Firebase — عادةً نفس قيمة `STORE_WEBHOOK_OWNER_UID` الموجودة. تجده في Firebase Console → Authentication → Users.
> بدون `SALLA_APP_OWNER_UID` يرفض الـ webhook (لا يعرف لمن ينسب البيانات)، وبدون `SALLA_APP_WEBHOOK_SECRET` يرد 503.

## 3) التشغيل والربط
1. أعد تشغيل الـ CRM ليقرأ `.env` الجديد (`update-local.cmd` أو `npm run ops:start-local`).
2. **تأكد أن الموقع شغّال** (السيرفر + نفق Cloudflare) — الـ webhook يصل عبر النفق.
3. **ثبّت التطبيق من متجر سلة** → سلة ترسل `app.store.authorize` → الـ CRM يخزّن التوكن وتصبح الحالة `connected`.
4. من الـ CRM → الإعدادات → Salla: الحالة «متصل»، وزر «مزامنة» يدوي متاح.

## 4) التحقق
- `GET /api/integrations/salla/status` يرجّع `linked: true`.
- بعد أول طلب/تثبيت: تظهر الطلبات في صفحة **Store Orders**، والمنتجات في المزامنة.
- سجل التدقيق: `.runtime/salla-webhook.log` يسجّل كل حدث تم التحقق منه.

## استكشاف الأخطاء
- **401 على الـ webhook:** السر في لوحة سلة ≠ `SALLA_APP_WEBHOOK_SECRET`.
- **503 على الـ webhook:** `SALLA_APP_WEBHOOK_SECRET` غير مضبوط في `.env`.
- **الحالة تبقى `ready_to_connect`:** التطبيق لم يُثبّت بعد من سلة، أو `app.store.authorize` لم يصل (الموقع كان نازلًا) — أعد التثبيت.
- **لا تصل أحداث إطلاقًا:** الموقع/النفق غير شغّال، أو الـ Webhook URL في لوحة سلة غير صحيح.
