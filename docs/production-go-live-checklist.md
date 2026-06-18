# Golden Pro CRM - قائمة الإطلاق النهائي

## الحالة الحالية

- قاعدة البيانات: Supabase مفعلة ومتصلة من إعدادات الإنتاج.
- الدومين المستهدف: `https://crm.breexe-pro.com`
- رابط Salla OAuth callback:

```text
https://crm.breexe-pro.com/api/integrations/salla/callback
```

- رابط Webhook سلة:

```text
https://crm.breexe-pro.com/api/store/webhook
```

- الإرسال مفعّل فقط بشرط كود التأكيد:

```env
OUTBOUND_MODE=code
OUTBOUND_CONFIRM_CODE=2232
OFFICIAL_LAUNCH_APPROVED=false
```

## قاعدة عدم إرسال رسائل قبل الإطلاق

أي رسالة من الواجهة أو API يجب أن تمر عبر بوابة `server/outboundSafety.ts`.
إذا لم يدخل المستخدم كود الإرسال الصحيح، يرجع السيرفر نتيجة `dryRun/blocked` ولا يرسل شيئاً.

## أوامر الفحص الآمنة

هذه الأوامر لا ترسل رسائل ولا تعدل بيانات العملاء:

```powershell
cd "C:\Users\owner\Documents\Codex\2026-04-25\files-mentioned-by-the-user-golden-2"
npm run lint
npm run build
npm run test:smoke
npm run doctor:prod
$env:ENV_FILE=".env.production"; npm run db:verify
$env:ENV_FILE=".env.production"; npm run security:audit
```

## ما يلزم لإتمام الربط بالدومين

اختر مساراً واحداً:

للمسار العملي المفصل راجع:

```text
docs/vps-deployment-ar.md
```

### المسار الأفضل: VPS دائم

المطلوب منك:

- عنوان IP للسيرفر.
- صلاحية SSH للسيرفر.
- تثبيت Docker وDocker Compose على السيرفر.
- في Cloudflare: سجل DNS باسم `crm` يشير إلى IP السيرفر.

بعدها يستخدم المشروع:

```text
deploy/docker-compose.yml
deploy/Caddyfile
.env.production
```

### مسار Cloudflare Tunnel

المطلوب منك:

- تسجيل دخول Cloudflare Tunnel على الجهاز أو السيرفر:

```powershell
cloudflared tunnel login
```

- بعد اكتمال تسجيل الدخول وظهور ملف `cert.pem`، شغل:

```powershell
.\scripts\setup-cloudflare-tunnel.ps1
.\scripts\run-cloudflare-tunnel.ps1
```

هذا ينشئ tunnel باسم `golden-pro-crm` ويربطه بـ `crm.breexe-pro.com`.

هذا يصلح للتجربة أو كسيرفر دائم إذا كان الجهاز/السيرفر يعمل 24/7.

## إعدادات سلة بعد تشغيل الدومين

في تطبيق سلة Partner:

- Callback/Redirect URL:

```text
https://crm.breexe-pro.com/api/integrations/salla/callback
```

- Webhook URL:

```text
https://crm.breexe-pro.com/api/store/webhook
```

- Webhook protection: Token أو Signature حسب إعداد سلة.
- إذا كان Token: استخدم نفس قيمة `SALLA_APP_WEBHOOK_SECRET`.

## قبل الإطلاق الرسمي

- لا تغيّر `OUTBOUND_MODE` إلى `production`.
- لا تضع `OFFICIAL_LAUNCH_APPROVED=true`.
- استخدم فقط وضع `code` أو `allowlist`.
- بدّل أي مفاتيح تم نشرها في محادثات أو صور قبل فتح النظام للعملاء.
