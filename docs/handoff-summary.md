# ملخص تسليم Golden Pro CRM

## سياق المحادثة

المطلوب كان تحويل المشروع إلى CRM عملي يعمل محليا الآن وقابل للنقل لاحقا إلى VPS/Cloud Run، مع Firestore، واتساب ويب، تذكيرات صيانة، وبيانات تجربة. بعد ذلك ظهرت مشكلة أن الإرسال والجدولة لا تعملان، فتم بناء محرك تذكيرات واضح يوقف الإرسال إذا كان واتساب غير متصل ويعرض التشخيص في الواجهة. الطلب الأخير هو ربط النظام مع متجر عبر Webhook.

## أهم الملفات المعدلة

- `server.ts`: مسارات API، الحماية، health، التذكيرات، وWebhook المتجر.
- `server/reminderEngine.ts`: منطق التذكيرات والجدولة.
- `server/whatsapp.ts`: اتصال واتساب عبر Baileys.
- `server/storeWebhook.ts`: منطق استقبال طلبات المتجر وتطبيعها وكتابتها في Firestore.
- `src/api.ts`: طبقة API للواجهة وأنواع البيانات.
- `src/App.tsx`: صفحات CRM، لوحة واتساب، تشخيص التذكيرات، ولوحة Webhook في الإعدادات.
- `firestore.rules`: قواعد الأمان للمجموعات.
- `firestore.indexes.json`: الفهارس المطلوبة للاستعلامات.
- `.env.example`: متغيرات التشغيل بدون أسرار.
- `docs/reminder-architecture.md`: معمارية التذكيرات.
- `docs/store-webhook-architecture.md`: معمارية Webhook المتجر.

## حالة التنفيذ

- تسجيل الدخول المحلي موجود كحل تطوير عندما لا تكون Firebase Auth مفعلة.
- Firestore يعمل عبر Firebase client في الواجهة، والعمليات الحساسة عبر Firebase Admin في السيرفر.
- واتساب يعتمد على Baileys وجلسة `.wa-session/`.
- التذكيرات لا تُرسل إذا كان واتساب غير متصل، وتظهر رسالة السبب في الواجهة.
- Webhook المتجر يستقبل الطلبات، يتحقق من السر/التوقيع، ثم ينشئ أو يحدث العميل والمنتج والتركيب، والحجز اختياريا.
- إشعار الفنيين مضاف: عند إنشاء/تعديل حجز مؤكد يرسل النظام موعد الصيانة إلى رقم الفني عبر قناة واتساب الحالية.
- قناة واتساب قابلة للتبديل عبر `WHATSAPP_PROVIDER=web` أو `WHATSAPP_PROVIDER=cloud_api`.

## متغيرات مهمة

```env
PORT=3000
APP_TIMEZONE=Asia/Riyadh
ENABLE_DAILY_CRON=false
REMINDER_CRON_SCHEDULE=0 10 * * *
WA_SESSION_DIR=.wa-session
WHATSAPP_PROVIDER=web
WHATSAPP_CLOUD_API_VERSION=v23.0
WHATSAPP_CLOUD_PHONE_NUMBER_ID=
WHATSAPP_CLOUD_API_TOKEN=
FIREBASE_SERVICE_ACCOUNT_PATH=
FIREBASE_SERVICE_ACCOUNT_JSON=
ALLOW_LOCAL_AUTH=true
VITE_LOCAL_AUTH=true

STORE_WEBHOOK_SECRET=
STORE_WEBHOOK_OWNER_UID=
STORE_WEBHOOK_DEFAULT_MAINTENANCE_MONTHS=3
STORE_WEBHOOK_CREATE_BOOKINGS=false
STORE_WEBHOOK_DEFAULT_TECHNICIAN_ID=
STORE_WEBHOOK_DEFAULT_TECHNICIAN_NAME=
```

## أوامر التحقق

```bash
npm install
npm run lint
npm run build
npm run test:smoke
npm run dev
```

## نقاط تحتاج انتباه الوكيل التالي

- يجب ضبط `STORE_WEBHOOK_OWNER_UID` على UID المستخدم الحقيقي في Firebase.
- يجب ضبط `STORE_WEBHOOK_SECRET` في السيرفر والمتجر بنفس القيمة.
- إن كان المطلوب منصة متجر محددة مثل Shopify أو Salla أو Zid، يمكن إضافة mapper خاص لها داخل `server/storeWebhook.ts` مع إبقاء المعالج العام.
- إرسال واتساب الحقيقي يتطلب ربط QR وظهور الحالة `connected`.
- في الإنتاج، الأفضل تشغيل واتساب على VPS أو خدمة طويلة العمر، وليس Cloud Run فقط.

---

## آخر تحديث: 2026-06-19 — Supervisor Sprint #2 kickoff

### حالة Git
- المستودع البعيد: https://github.com/G00lden/golden-pro-crm (private)
- آخر commit في `main`: `e3853dc` — security: harden daily-use readiness and backups
- Working tree نظيف على main. مستعد لإستقبال الـ branches الجديدة.

### حالة Dev Server
- يعمل على http://localhost:3000 — `/api/health` = ok
- واتساب: غير متصل (يحتاج QR)، outbound mode: `code`
- التذكيرات: cron مفعّل كل 10 دقائق، لكنها متوقفة لأن واتساب غير متصل
- Salla: متكامل، Cron مزامنة كل 15 دقيقة

### Supervisor snapshot (2026-06-19)
```
Lint:        ✓
Build:       ✓ (skipped by default but verified)
Secrets:     ✓ (0 hits)
npm audit:   critical=1 high=2 (both baileys/protobuf transitive)
Checklist:   10/71 done, 10 in-progress, 51 todo, 9 hard-gate remaining
Open PRs:    0
```

### Sprint #2 — 3 task briefs written (docs/templates/)

| # | الوكيل | البنود | الفرع |
|---|--------|--------|-------|
| 1 | **Codex** | `2.5 🔒` Rate limiting (per-UID) + `2.6 🔒` Zod input validation | `codex/security-rate-limit-zod` |
| 2 | **Claude Code** | `5.9` GTM container + `5.10` GA4 + `5.11` Meta Pixel | `claude/ad-tracking-gtm-pixels` |
| 3 | **Hermes** | `3.1` Arabic copy audit + `5.31` Brand voice guideline | `hermes/arabic-copy-brand` |

### أبدا مع أي وكيل؟
كل task brief مكتوب كـ `docs/templates/task-brief-<agent>-sprint2.md`. افتح الوكيل المطلوب والصق الـ brief كأول رسالة.

### أولويات المحادثة (next-in-line بعد Sprint #2)
- `1.6` Dockerfile produces runnable image
- `1.7` Cloud Run + VPS deploy scripts
- `5.12-5.15` باقي pixels (TikTok, Snap, Google Ads, Clarity)
- `4.1` Payment gateway (Tap or Moyasar)
- `4.3` Terms of Service + Privacy Policy pages

---

## آخر تحديث: 2026-06-25 — نظام المكالمات والتحويل (IVR + واتساب) [Claude Code]

### ماذا أُضيف
نظام رد على المكالمات الهاتفية العادية وتوجيهها عبر **Unifonic**:
- رقم أساسي يُنشر في الإعلانات → قائمة صوتية (IVR) → تحويل لجوال الموظف المختص.
- عند عدم الرد (no_answer/busy/failed/voicemail) → واتساب للعميل (`missed_call_customer`) وللموظف (`missed_call_agent`).

### الملفات الجديدة
- `server/telephony/types.ts`، `server/telephony/unifonicAdapter.ts` — طبقة مزوّد معزولة.
- `server/ivrEngine.ts` — منطق القرار + DB + تدفق المكالمة الفائتة.
- `server/routes-telephony.ts` — webhooks عامة + admin CRUD + `test-missed`.
- `src/pages/CallSystem.tsx` — لوحة «نظام المكالمات».
- `docs/telephony-architecture.md` — المعمارية الكاملة.

### الملفات المعدّلة
- `server/db.ts` (+4 جداول: telephony_config, ivr_departments, ivr_department_agents, call_logs)،
  `server/whatsappTemplates.ts` (+قالبان)، `server/validation.ts` (+مخططات)، `server.ts` (تسجيل المسارات)،
  `.env.example` (+مفاتيح TELEPHONY_*/UNIFONIC_*)، `src/api.ts` + `src/App.tsx` + `src/shared.tsx` (الواجهة).

### الحالة
- `npm run lint` ✓ ، `npm run build` ✓.
- تم اختبار التدفق محلياً end-to-end (قائمة → تحويل برقم مُطبّع 9665.. → مكالمة فائتة → واتساب للطرفين).

### إضافة: البوابة الذاتية (بدون مزوّد خارجي ولا QR واتساب)
- شريحة الشركة في جوال أندرويد + تطبيق أتمتة مجاني (MacroDroid/Tasker) يرسل أحداث المكالمات/الـ SMS للخادم ويرسل ردود SMS من الشريحة.
- ملفات: `server/gateway.ts`، `server/routes-gateway.ts`، `server/smsTemplates.ts`، جدول `gateway_outbox` في `db.ts`، قسم في `src/pages/CallSystem.tsx`، دليل `docs/gateway-setup.md`.
- قناة الرد ذكية: `dispatchMessage()` يفضّل واتساب إن اتصل، وإلا يضع SMS في طابور `gateway_outbox` ليرسلها الجوال.
- نمطان عبر `GATEWAY_ROUTING_MODE`: `menu` (قائمة عبر SMS يرد العميل برقم) أو `direct`.
- نقاط: `POST /api/gateway/event`، `GET /api/gateway/outbox`، `POST /api/gateway/outbox/ack` (توكن `GATEWAY_TOKEN`)، و`GET /api/gateway/status` (admin).
- مُختبَر end-to-end: مكالمة فائتة → SMS قائمة في الطابور → رد العميل "1" → تحويل للمبيعات + إشعار الموظف → ack يفرّغ الطابور. lint/build/smoke ✓.

### يحتاج انتباه الوكيل التالي / المالك
- **عقد Unifonic مؤكَّد** من التوثيق العام: الوارد `{callerId, recipient, digits}`، والاستجابة مصفوفة كائنات `say/responseUrl/digitsLimit` و`transfer:"+9665.."`. الربط بالمكالمة عبر `callerId` (لا يوجد callSid ثابت). حقول حمولة **الحالة** فقط تبقى account-specific و`parseStatus` دفاعي.
- ضبط `TELEPHONY_WEBHOOK_SECRET` و`PUBLIC_BASE_URL` و`UNIFONIC_*` في `.env`، وربط IVR Endpoint + Status Callback في لوحة Unifonic.
- `TELEPHONY_WEBHOOK_SECRET` إلزامي في الإنتاج (الـ webhook يُرفض 503 بدونه).

---

## آخر تحديث: 2026-06-26 — إغلاق دورة المكالمة + Deploy Stack [Claude Code]

> ملاحظة: هذا التحديث بيغطي شغل اتعمل على `main` بين 2026-06-19 و2026-06-26 ومكنش موثّق هنا أول بأول (الفجوة كانت موجودة، مش شغل جديد). التفاصيل الأمنية لـ 2026-06-24 موثّقة فعليًا في `docs/commercial-release-checklist.md` ("Current standing — 2026-06-24") فمكنتش مكررة تحت.

### ماذا أُضيف (بترتيب زمني تقريبي)

1. **نظام الفواتير ZATCA** (`913e87e` → `8ebd237`, 2026-06-19/20): فواتير ضريبية متوافقة مع ZATCA (QR + VAT modes)، تحويل من عرض سعر لفاتورة، تصدير/طباعة PDF معزولة عن باقي الصفحة، واجهة Odoo-style + تبديل الوضع الفاتح.
2. **تشديد أمني P0** (`0070728`, `d75bfdd`, `396f370`, `d336a46`, 2026-06-21/24): إغلاق R-008 (HMAC webhook الواتساب)، R-009 (بوابة `send-template`)، R-010 (consent gating للتراكرز)، حذف مسار JWT الميت (`routes-auth.ts`/`localAuth.ts`) اللي كان بيصدر tokens إدارية غير قابلة للاستخدام (ثغرة privesc كامنة).
3. **التوجيه: round-robin + anti-spam cooldown** (`7bf9c47`, 2026-06-25): توزيع المكالمات على الموظفين النشطين بالتناوب (`ivr_departments.rr_counter`) بدل أول موظف دايمًا؛ قمع الرد التلقائي المكرر لنفس المتصل خلال `GATEWAY_REPLY_COOLDOWN_MIN` (افتراضي 10 دقايق). **إصلاح مهم:** migrations أعمدة `bookings`/`technician_notifications` كانت بتشتغل قبل إنشاء الجداول، فكانت قاعدة بيانات جديدة (تنصيب جديد / VPS / Cloud Run) بتفشل بـ"no such table: bookings" — اتصلح الترتيب واتأكد إن قاعدة بيانات جديدة بتشتغل.
4. **دورة المكالمة الكاملة: تعرّف على العميل + إقرار الموظف + حالة "متعامل معها"** (`8042f70`, 2026-06-26): رقم المكالمة يتطابق مع جدول العملاء ويظهر اسمه بدل الرقم الخام؛ رد الموظف بـ"تم/استلمت/done" عبر واتساب/SMS يقفل المكالمة الفائتة تلقائيًا (`handled_by=agent`)؛ إغلاق يدوي من اللوحة (`POST /api/telephony/calls/:id/handle`)؛ أعمدة جديدة في `call_logs`. مُختبر على قاعدة بيانات نظيفة، lint/build/smoke (15/15) ✓.
5. **حزمة النشر (Deploy Stack)** (`e226a21`, 2026-06-26): `docker-compose.yml` بخدمة واحدة + volumes دائمة لقاعدة SQLite (`.runtime`) وجلسة الواتساب (`.wa-session`) + healthcheck + restart؛ `.dockerignore` يستبعد `data/`، `*.db`، `.git`، النسخ الاحتياطية؛ إضافة مفاتيح telephony/gateway لـ `.env.production.example`؛ `docs/deployment.md` (Compose، reverse-proxy + HTTPS، نسخ احتياطي، go-live). تم التحقق محليًا في وضع الإنتاج (frontend static + backend health 200 + SQLite).
6. **بطاقة المكالمات الفائتة في الداشبورد** (`a3dfa12`, 2026-06-26): `GET /api/telephony/calls/summary` (missed_unhandled/missed_today/total_today) + بطاقة قابلة للنقر في الصفحة الرئيسية بتتحول لأحمر لما فيه متابعات معلّقة. مُختبر: الملخص يرجع 0 ثم `missed_unhandled:1` بعد مكالمة فايتة، lint/build/smoke (15/15) ✓.

### فجوة توثيق لوحظت ولازم انتباه Supervisor
- `docs/commercial-release-checklist.md` بند **4.2 (ZATCA-compliant invoice)** لسه معلّم ✗ رغم إن النظام مبني وشغال فعليًا (انظر البند 1 فوق). الـ checklist بينص إن الـ Supervisor بس هو اللي يقلب ✗→✓، فمكنتش أغيّرها هنا مباشرة — محتاجة مراجعة Supervisor وتأكيد قبل القلب.
- بنود **1.6/1.7** (Dockerfile/deploy scripts) ممكن تبقى أقرب للجاهزية بعد حزمة `docker-compose` أعلاه — يستاهل تحقق فعلي على staging قبل القلب لـ ✓.
- نظام المكالمات (IVR + gateway + round-robin + دورة الحياة الكاملة) مش موجود كقسم في الـ checklist أصلاً — يستاهل قسم جديد "6. Telephony" أو إضافة تحت "1. Engineering" لو الـ Supervisor شايف كده.

### حالة Git عند هذا التحديث
- آخر commit على `main`: `cfbba82` (merge لبطاقة المكالمات الفائتة)
- الفرع `claude/project-recall-0lhr3z` مطابق تمامًا لـ `main`، working tree نظيف، مفيش PRs مفتوحة.
- فرع `codex/p0-security-backup-salla` فيه commits قديمة (`e3853dc`, `f042b68`) مش داخلة `main` — يبدو تم استبدالها بمسار مختلف لنفس الميزة (ZATCA) وصل main فعليًا؛ يستاهل تأكيد إنه ممكن يتقفل/يتمسح بدل ما يفضل معلّق.

---

## آخر تحديث: 2026-07-05 — Hermes: الصفحات القانونية وتدقيق النصوص العربية [Hermes]

### الفرع
`hermes/legal-and-copy` — PR draft جاهز للمراجعة على:
https://github.com/G00lden/golden-pro-crm/pull/new/hermes/legal-and-copy

### ما تم إنجازه

#### 4.3 — الصفحات القانونية (شروط الخدمة وسياسة الخصوصية)
- تحسين `public/legal/terms.html` و `public/legal/privacy.html`:
  - إضافة الاسم القانوني الكامل: **شركة بريكس برو شخص واحد ذات مسؤولية محدودة**
  - إضافة الرقم الضريبي: **313049114100003**
  - إضافة السجل التجاري: **7016449519**
  - توثيق الامتثال لـ PDPL ونظام التجارة الإلكترونية السعودي
  - روابط متبادلة بين الصفحات الثلاث في الفوتر

#### 4.4 — سياسة الاسترجاع والاستبدال (جديد)
- إنشاء `public/legal/refund.html` — سياسة كاملة بالعربية تغطي:
  - المنتجات المادية: استرجاع 7 أيام، استبدال للعيب المصنعي مجاناً
  - خدمات التركيب: إلغاء قبل 24 ساعة، ضمان سنة
  - عقود الصيانة: إلغاء خلال 14 يوم مع استرداد جزئي
  - المنتجات التالفة أثناء الشحن: إبلاغ 24 ساعة مع توثيق بالصور
  - القطع الاستهلاكية وقطع الغيار
  - إجراءات تقديم الطلب (5 خطوات)
  - حالات الاستثناء والضمانات
  - متوافقة مع متطلبات Meta/TikTok/Google لجودة الإعلانات

#### 3.1 — تدقيق النصوص العربية
- إصلاح نصوص مخلوطة (إنجليزي/عربي):
  - `Dashboard.tsx`: "Cloud Design" ← "لوحة المعلومات"
  - `Invoices.tsx`: "Tax Invoices" ← "الفواتير الضريبية"
- النصوص الباقية (التوستات، التسميات، رسائل الخطأ) متوافقة مع brand-voice

#### بنية تحتية
- إضافة مسارات `GET /legal/terms` و `/legal/privacy` و `/legal/refund` في `server.ts` (قبل وسيط Vite/static)
- إضافة رابط الاسترجاع في فوتر `Landing.tsx` ونص موافقة النموذج

### تحقق
- ✅ `npm run build` ناجح (13.4 ثانية، 0 أخطاء)
- ✅ جميع الصفحات الثلاث تخدم بشكل صحيح عبر مسارات السيرفر
- ✅ روابط متبادلة بين الصفحات الثلاث

### حالة Git
- آخر commit على الفرع: `61807fa`
- الفرع مرفوع على `origin/hermes/legal-and-copy`
- PR draft يحتاج إنشاء يدوي (GitHub CLI غير مصادق عليه): https://github.com/G00lden/golden-pro-crm/pull/new/hermes/legal-and-copy

### ملاحظة للـ Supervisor
- البنود 4.3 / 4.4 / 3.1 في `docs/commercial-release-checklist.md` جاهزة للمراجعة — لم أقلب ✗→✓ لأن الدور للـ Supervisor فقط.
- الصفحات القانونية مخدّمة عبر مسارات صريحة في السيرفر (`GET /legal/*`) لتجنب مشكلة catch-all في وضع الإنتاج.
- ملفات HTML منسوخة أيضًا لـ `dist/` تلقائياً عبر Vite build (من مجلد `public/`).

---

## آخر تحديث: 2026-07-05 — مراجعة Supervisor لـ PR #12 (القانوني + النصوص) [Claude Code كـ Supervisor]

### القرار: تمت الموافقة والدمج
راجعتُ PR #12 (`hermes/legal-and-copy`) بندًا ببند وفق معايير الطلب، ودمجته في `main`.

### ما تم التحقق منه فعليًا
- **الصفحات الثلاث** (`terms.html` / `privacy.html` / `refund.html`): عربية سليمة، تذكر PDPL ونظام التجارة الإلكترونية السعودي، وتعرّف المنشأة (الاسم القانوني «شركة بريكس برو شخص واحد ذات مسؤولية محدودة»، الرقم الضريبي 313049114100003، السجل التجاري 7016449519)، ومربوطة ببعضها.
- **الربط**: المسارات `GET /legal/terms|privacy|refund` مسجّلة في `server.ts` قبل الـ catch-all؛ والروابط ظاهرة في فوتر `Landing.tsx` وفي نص موافقة النموذج.
- **الجودة**: `refund.html` (جديد، متوافق مع سياسات إعلانات Meta: استرجاع 7 أيام، استبدال العيب المصنعي، استرداد خلال 5–14 يوم عمل) — عُرِض بصريًا وتأكدت سلامته.
- **تعديل أثناء المراجعة**: أضفتُ الرقم الضريبي والسجل التجاري إلى `terms.html` للاتساق مع الصفحتين الأخريين.
- `npm run build` ✓ و`npm run lint` ✓. تلميع النصوص (eyebrows) لم يمسّ منطق الفاتورة.

### تحديث الـ checklist
- **4.3 ✓** (شروط + خصوصية) و**4.4 ✓** (استرجاع) — قُلبت إلى ✓.
- **3.1 → ◐** — تدقيق نصوص أولي؛ التدقيق الكامل لكل صفحة/توست ما زال مطلوبًا.
- العدّاد: 24 → **26 / 81**. بند الإطلاق القانوني (4.3) اتقفل.

### حالة النشر
- الموقع محلي خلف Cloudflare Tunnel (لا VPS). بعد الدمج، التحديث ينزل عبر `update-local.cmd` أو المهمة المجدولة `Breexe Pro CRM Auto Update`.

### للوكيل التالي
- بقايا Definition-of-Done: 4.1 (بوابة دفع — Codex)، بنود الأمان (2.7/2.8/2.9/2.11/2.12)، وبنود التتبع/التشغيل.
- 3.1 يستحق تدقيقًا كاملًا لكل النصوص الظاهرة (Hermes).

---

## آخر تحديث: 2026-07-05 — فحص تكامل Salla + دليل الربط [Claude Code]

### فحص شامل (تم)
راجعت تكامل Salla بالكامل (`server/salla.ts`, `routes-salla.ts`, `routes-store.ts`, `storeWebhook.ts`, التسجيل في `server.ts`). **النتيجة: جاهز إنتاجيًا، مفيش ثغرات حاجبة.**
- أمان الـ webhook: HMAC-SHA256 على rawBody (محفوظ عبر `express.json({verify})` سطر 180)، مقارنة ثابتة الزمن، fail-closed (503/401). ✓
- OAuth + Easy Mode + تجديد توكن تلقائي. ✓
- الأحداث: app.store.authorize / app.uninstalled / order.* / product.* كلها معالَجة. ✓
- منع تكرار عبر معرّفات مستندات ثابتة + merge. ✓
- الراوتس مسجّلة (296)، الكرون كل 15د لو `SALLA_SYNC_CRON_ENABLED=true` (440). ✓

### ملاحظة كفاءة (غير حاجبة)
- كل حدث `product.*` يشغّل مزامنة منتجات كاملة — يستحق debounce لاحقًا لو زادت أحجام التحديثات.

### أُضيف
- `docs/salla-connect-runbook.md` — دليل ربط تطبيق سلة بالـ CRM (مسارات، env vars، أحداث، تحقق، استكشاف أخطاء).

### الخطوة المتبقية (إعداد فقط — مهمة على جهاز الاستضافة)
- ضبط env vars الخاصة بـ Salla في `.env` + إعداد لوحة Salla Partner + تثبيت التطبيق من المتجر. الكود لا يحتاج تعديلًا.

---

## آخر تحديث: 2026-07-06 — تنفيذ إصلاحات تدقيق الأخطاء الشامل [Claude Code]

بعد التدقيق الشامل (`docs/bug-audit-2026-07-06.md` — 49 خطأ + 8 أنماط جذرية، PR #19)، تم إصلاح كل الأخطاء المؤكدة عبر PRs مستقلة (فرع → PR → squash merge)، كل واحدة مبنية على أحدث `main` ومُتحقَّق منها (lint + build + اختبار وقت التشغيل حيث أمكن):

- **PR #20** — حرِج: عمود `store_orders` معرّف مرتين في `db.ts` فكانت 12 عمودًا لا تُنشأ على قاعدة جديدة + إصلاحات المحوّل (`sqliteFirestoreAdapter`: orderBy alias، الحفاظ على `id`).
- **PR #21** — أمان: ثغرة توكن `local-dev:` (أي أحد يرسله يصبح admin عبر النفق العام). أُضيف سرّ اختياري `LOCAL_AUTH_TOKEN` (آمن افتراضيًا: بدونه السلوك كما هو + تحذير؛ معه تحقّق ثابت الزمن). + `requireAdmin` fail-closed + منع تعطيل حسابك.
- **PR #22** — مال: `|| 15` كان يحوّل ضريبة 0% إلى 15%؛ و`numericValue("")` كان يصفّر الأسعار من حقول فارغة. → `resolveVatPercent` + تجاهل النص بلا أرقام.
- **PR #23** — مال/زاتكا: أرقام الفواتير/العروض من `list.length` تُعيد استخدام رقم بعد الحذف → أصبحت `max(الأرقام الموجودة)+1`.
- **PR #24** — مال: `paid_at`/`confirmed_at` تُمسح أو تُعاد كتابتها عند تغيير الحالة → تُحفظ الطابع الأصلي (تُختم مرة واحدة).
- **PR #25** — تذكيرات: تعديل صيانة مكتملة كان يعيد تسليح دورة التذكير (`|| "first"`) → يُحفَظ `null`. (بند ivrEngine كان مُصلَحًا مسبقًا — الربط بـ `call_sid`.)
- **PR #26** — تتبّع: Meta Pixel/GA4 لم يتهيّآ (stub غير قانوني)؛ `trackEvent` لم يستدعِ GA4/Meta؛ `VITE_ENABLE_TRACKING` لم يبوّب GA4/Meta؛ `captureUtm` يمحو first-touch. كلها أُصلحت (تحقّق: 14/14 harness).
- **PR #27** — واجهة: 5 فورمات (عميل/منتج/فني/صيانة/حجز) تبتلع أخطاء الحفظ صامتة → try/catch + toast.
- **PR #28** — واجهة: تنبيه الطلب الجديد كان مكتومًا في الاستطلاع الخلفي؛ عدّاد عمر QR لا يُصفَّر عند التدوير؛ تعذّر تعديل صيانة لعميل/منتج خارج أول صفحة.
- **PR #29** — استضافة: `/legal/refund` كان يفتح صفحة الخصوصية على Firebase (rewrite للـ SPA) → rewrites صريحة للصفحات الثلاث.

**لم يُغيَّر عمدًا** (بنود ضعيفة/غير مؤكدة في `public/quotation-template.html`): نسبة الدفع الفارغة → 70/30 (سلوك مقصود، الصفر الصريح محفوظ)، وتسمية «الإجمالي شامل الضريبة» (قرار المالك: الأسعار شاملة الضريبة، فالتسمية صحيحة — لا تغيير).

### إصلاح واتساب «Waiting for this message» (PR #31 + #32)
رسائل واتساب كانت توصل للطرف الآخر كـ «Waiting for this message» (فشل فك تشفير). أُصلح: (#31) إضافة `getMessage` ليعيد Baileys الإرسال عند retry receipt؛ (#32) قفل جلسة يمنع تشغيل نفس `.wa-session` من عمليتين (السبب الجذري)، + `getMessage` يقرأ من قاعدة البيانات بعد إعادة التشغيل. **مطلوب من المالك مرّة وحدة**: إعادة ربط واتساب (QR جديد) + تشغيل نسخة واحدة فقط.

## آخر تحديث: 2026-07-06 — توزيع مهام متوازية (Claude Code + Hermes)
- **Claude Code** يدقّق مسار الرسائل/الواتساب/التذكيرات/الهاتف بحثًا عن أخطاء تشغيلية إضافية (مثل خطأ «Waiting» الذي لم يلتقطه التدقيق). **ملكية مؤقتة**: `server/whatsapp*.ts`, `reminderEngine.ts`, `maintenanceLifecycle.ts`, `ivrEngine.ts`, `routes-telephony.ts`, `routes-whatsapp.ts`, `outboundSafety.ts`.
- **Hermes**: راجع `docs/tasks/hermes-salla-hardening-2026-07-06.md` — تدقيق وتقوية تكامل سلة (تطبيع الهاتف السعودي، اسم عميل سلة المشوّه «عميلamribrahim49»، الأسعار، مخطط store_orders، أمان الـ webhook). ملفات سلة/المتجر فقط، **لا تلمس** ملفات واتساب/التذكيرات.

### نتائج فحص مسار الرسائل [Claude Code] — 6 أخطاء تشغيلية مصلَّحة ومدموجة
فحص عميق للمراسلة لقى 12 خطأً لم يلتقطها التدقيق الأصلي. المُصلَح (كل واحد PR مستقل + محاكاة/اختبار):
- **PR #34** (الأهم): التذكيرات كانت ترسل نفس المرحلة 3–7 مرات بتواريخ خطأ («غداً» يوم الموعد، «اليوم» متأخّر)، ودورة مكتملة تُعاد. الآن نوافذ غير متداخلة + بوابة تقدّم = كل مرحلة مرة وحدة بالتاريخ الصحيح.
- **PR #35**: تسريب `{customer_name}` الحرفي للعميل عند نقص متغيّر (strict:false)؛ + رقم العميل الخام في تنبيه الفني يُطبَّع الآن.
- **PR #36**: عدم منع تكرار الرسائل الواردة → إعادة الاتصال كانت تعيد تأكيد التذكيرات. الآن dedup بـ id + تجاهل history sync + dedup على webhook.
- **PR #37**: مطابقة التأكيد كانت بآخر 8 أرقام substring → قد تؤكّد عميلًا خطأ. الآن آخر 9 أرقام suffix.
- **PR #38**: منع تشغيل متزامن (يدوي+مجدول) يسبّب إرسالًا مزدوجًا؛ + التصعيد يُسجَّل مرة عند إرسال حقيقي فقط.
- **PR #39**: توثيق: بوابة الإرسال الحقيقية هي `OUTBOUND_MODE`/`OUTBOUND_CONFIRM_CODE`/`OFFICIAL_LAUNCH_APPROVED` (لا `OUTBOUND_LAUNCH_CODE` — كان اسمًا وهميًا في التوثيق فقط).

**متبقٍّ منخفض الأولوية** (لمن يكمل لاحقًا، `server/whatsapp.ts` + `ivrEngine.ts`): (10) `handledCalls.clear()` يمسح كل مفاتيح الـdedup — استبدله بـ LRU/زمني، و`answeredCalls` لا يُقلَّم؛ (11) تداخل كلمات التأكيد/إقرار الفني («موافق»/«ok») — غير مؤثّر غالبًا؛ (12) مؤشّر round-robin يتقدّم مع كل ضغطة DTMF (يتأثّر بإعادة إرسال الـwebhook).
> **حُلّت كلها في PR #41** (dedup محدود بدل clear، round-robin idempotent حسب call sid، تخطّي إقرار الفني إذا كانت الرسالة تأكيد عميل).

## آخر تحديث: 2026-07-07 — فحص مسار الفوترة/زاتكا/PDF [Claude Code]
فحص عميق لمسار الفواتير/العروض/زاتكا. **الترميز TLV صحيح** (طول البايت UTF-8 للأسماء العربية سليم — لا يوجد الخطأ الكلاسيكي)، والوسوم 1–5 والطابع الزمني وBase64 صحيحة، وضريبة 0% مُصانة.
- **PR #42**: `escapeHtml` (سيرفر + عميل) ما كان يهرّب `'` — أُضيف (تحصين XSS كامن).
- **PR #43** (امتثال): خانة «اسم البائع» كانت تعرض اسم المندوب («أبو عامر»/«أبو سيف») بينما QR وكتلة البائع يعرضان اسم الشركة → عدم تطابق زاتكا. بقرار المالك (هم مندوبون): أُعيدت تسمية الخانة إلى «المندوب»، واسم البائع في كل مكان + الـQR صار موحّدًا = اسم الشركة.
- **قرارات المالك**: أسعار عرض السعر شاملة الضريبة (فالتسمية «شامل الضريبة» صحيحة — لا تغيير)؛ ويُصدر فواتير ≥1000 لأفراد أيضًا → **لا يُلزَم** الرقم الضريبي للمشتري.

**متبقٍّ في الفوترة (يحتاج قرار/عمل دقيق — لمن يكمل)**:
- (#4، متوسط) عند وجود **خصم**: عمود ضريبة البند لا يُجمَع لضريبة الترويسة (الترويسة تحسب على الأساس بعد الخصم، والبنود تتجاهل الخصم وتُقرَّب مستقلة). الـQR (المرحلة 1) صحيح لأنه يستخدم إجماليات الترويسة. الإصلاح: توزيع الخصم على البنود بالتناسب ثم اشتقاق ضريبة الترويسة من مجموع ضرائب البنود — تغيير حساس ماليًا يُفضَّل تنفيذه مع مراجعة محاسبية.
- (#5) محدِّد «شامل/غير شامل الضريبة» لكل بند في **عرض السعر** مُخزَّن لكن غير مُستخدَم في الحساب (يُتجاهل). إمّا إزالته من الفورم أو تفعيله.
- (#6/#7) عرض: سطر الخصم يظهر تحت «الإجمالي غير شامل الضريبة» (الذي هو صافٍ بعد الخصم أصلًا)؛ وتنسيق أرقام قالب العرض `ar-SA` قد يظهر 3 خانات عشرية. تجميلي.

## آخر تحديث: 2026-07-09 — تدقيق أنظمة فرعية (16 نتيجة) + بنية VPS/CI + إصلاح بناء main [Claude Code]

**تدقيق متعدد الوكلاء (26 وكيلًا، تحقّق تصادمي)** أنتج 16 نتيجة مؤكَّدة — **حُلّت كلها** عبر PRs مستقلة (branch → PR → squash-merge)، كل واحدة موثّقة ومُختبَرة وقت التشغيل:

- **#46** إضافة أعمدة `seller_*` المفقودة لجدول `settings` (كانت هوية البائع لا تُحفَظ على قاعدة جديدة).
- **#47** (HIGH) منع mass-assignment: `updateOwned` يجرّد `createdBy/owner_uid/id/createdAt` — لا يمكن سرقة/تيتيم ملكية سجل عبر PUT.
- **#48** (HIGH) ربط/تنصيب حساب Firebase يتطلّب `email_verified` — بريد غير موثّق لا يرث دور دعوة.
- **#49** تصحيح إجماليات لوحة/خط أنابيب Odoo: استبعاد العروض/الفواتير الميتة (مرفوض/منتهي/ملغى/مسترجع)، وقف عدّ العرض المحوَّل لفاتورة مرتين، فلتر متابعة العروض `('issued','follow_up')` بدل `'sent'` الوهمي، و«اليوم» بتوقيت الرياض لا UTC.
- **#50** (عاجل) إصلاح فشل `tsc` على main (أنواع `installments` للعروض + استدعاءات `logEvent` في مسار Tap) — كان يُفشِل CI لكل PR.
- **#51** تحصين server: مفتاح الـrate-limit خلف `TRUST_PROXY_HEADERS` (افتراضي true للنفق) + سقف صلب لخريطة الدلاء (منع تضخّم الذاكرة)، ووقف تسريب أسرار سلسلة الاستعلام (توكن البوابة/أكواد Salla) في سجلّ الأخطاء.
- **#52** بوابة تنصيب أول مسؤول تُقاس بـ`countAdmins()` (أي مزوّد) لا `countFirebaseAdmins()` (كان أول دخول Firebase يترقّى تلقائيًا حين المسؤول الوحيد محلي/يدوي)؛ + حماية «آخر مسؤول نشط» على PUT/deactivate/delete + حارس التعطيل الذاتي على PUT.
- **#53** محوّل SQLite: التحقّق من الأعمدة يقابل **مخطّط الجدول الفعلي** (لا قائمة يدوية ناقصة) وتعيين كل أسماء camelCase عبر `fieldToColumn` — كان `where/orderBy` يرمي «Invalid column» على أعمدة سليمة.
- **#54** إكمال الحجز من الفورم يشغّل دورة الحياة (تقديم صيانة التركيب القادمة) بدل `updateBooking` الصامت؛ + `addMonths` (عميل + سيرفر) يثبّت نهاية الشهر (31 يناير + شهر = 28/29 فبراير)؛ + حارس مطابقة عناصر الطلب عند `installation_id` غير معرّف.
- **#55** حارس تسلسل طلبات AdminUsers (منع كتابة نتيجة قديمة فوق أحدث) + معالجة فشل نسخ الحافظة في CustomerCare.
- **#56** منع حذف عميل/منتج/فني مرتبط بتركيبات/حجوزات (409 برسالة واضحة، RESTRICT لا cascade) — لا FKs يتيمة.

**بنية التشغيل (#45)**: CI (lint+build) + CD (نشر SSH للـVPS عند الدمج، يتخطّى بأمان قبل ضبط الأسرار) + `vps-update.sh` (سحب→بناء→فحص صحّة→تراجع تلقائي) + نسخ احتياطي يومي (VACUUM INTO + جلسة واتساب، تدوير 14 يومًا) + استعادة موجَّهة + runbook عربي (`docs/vps-cicd-backups-ar.md`). ملاحظة: النسخ الاحتياطي المحلي (`scripts/*.mjs` من codex) مكمّل لهذا (VPS/Docker) لا متعارض.

**مُعلَّم لهيرميز** (ملفات المتجر — لم ألمسها): `server/routes-store.ts:37` يسجّل `req.originalUrl` بسلسلة الاستعلام مثل الخطأ المُصلَح في #51 — يُنصَح بنفس المعالجة (`loggablePath`).

**متبقٍّ من تدقيق الفوترة السابق** (بلا تغيير — يحتاج قرار محاسبي): بنود الخصم/ضريبة الترويسة (#4)، ومحدِّد شامل/غير شامل لكل بند غير مفعّل (#5). لا نتائج تدقيق مفتوحة أخرى من هذه الجولة.
# 2026-07-13 — Asset maintenance, QR activation and warranty

- Added independent customer assets with pre-printed unassigned QR labels and authenticated technician activation.
- Added per-product service policies with multiple independent tasks, optional WhatsApp media, dynamic CTA metadata, and invoice-date warranty countdown.
- Added overdue cadence (10 days for 12 attempts, then monthly) and next-cycle scheduling from actual completion.
- Added manual wholesale campaigns, explicit customer type, Odoo CSV preview/import plus optional JSON-RPC customer sync.
- Salla policy-enabled device orders stage assets for technician activation; compatible consumables auto-link to one device or enter a staff selection queue.
- Added SQLite schema/adapters, Supabase migration/RLS, Firestore indexes/rules, unit tests, docs, and responsive React UI under **الأجهزة والتذكيرات**.

# آخر تحديث: 2026-07-13 — جاهزية الرد الآلي والتوجيه [Codex]

- أضيف `GET /api/telephony/readiness` وبطاقة جاهزية داخل «نظام المكالمات»؛ تفحص التفعيل، الرقم الأساسي، رابط HTTPS العام، سر Webhook، الأقسام، ووجود مختص نشط في كل قسم من دون كشف أي سر.
- صار زر إيقاف النظام فعلياً: المكالمة تسمع رسالة اعتذار قصيرة ولا تدخل القائمة أو تُسجّل محاولة تحويل جديدة.
- أُلغي السلوك الذي كان قد يعيد موظفاً غير نشط عند خلو القسم من موظفين نشطين، كما صارت محاكاة المكالمة الفائتة تتجاهل الأقسام والموظفين المتوقفين.
- أضيف `npm run test:telephony` بخمس حالات على قاعدة بيانات مؤقتة: الإيقاف، الموظف غير النشط، رقم موظف غير صالح، الجاهزية المكتملة، ورفض رابط شبكة محلية.
- التحقق: `npm run test:telephony` (5/5)، و`npm run test:smoke` (15/15)، وفحص TypeScript، وVite production build نجحت، مع فحص الواجهة الفعلية عبر `agent-browser`. يبقى الربط التجاري محتاجاً رقم Unifonic فعلياً، رابط HTTPS عاماً، وأرقام المختصين الصحيحة من المالك.

## استكمال 2026-07-13 — دورة المكالمة الآمنة والتكامل الكامل [Codex]

- أضيفت مساحة شركة مشتركة عبر `workspace_owner_uid` مع بقاء هوية المنفذ الفعلية في التدقيق، وصار مالك الرقم يُحل من `telephony_numbers` بدلاً من أول مسؤول.
- صار لكل اتصال سجل داخلي ورمز جلسة عشوائي مستقل مدته 30 دقيقة؛ لا يُخزن الرمز خاماً، ولا تندمج مكالمتان من الرقم نفسه.
- فُصلت حالة الاتصال عن حالة المتابعة، وأضيف صندوق أحداث idempotent يمنع تكرار Webhooks والـLead والمهام والرسائل، ويرفض المطابقة الملتبسة.
- التوجيه لمختص واحد بالتناوب داخل معاملة، مع تجاهل الحساب المتوقف والرقم غير الصالح، ورسالة اعتذار ومهمة متابعة خارج الدوام أو عند غياب مختص.
- عقد Unifonic الحالي: `GET /webhooks/telephony/ivr` مع Authorization، و`POST /webhooks/telephony/ivr/session/:token` برمز جلسة، و`POST /webhooks/telephony/status` مع Basic Authentication مستقل. المسار القديم باقٍ إصدار توافق واحد مع تحذير إهمال.
- أضيف `communication_outbox`: واتساب أولاً ثم SMS واحد عبر بوابة Android عند الفشل. البوابة لا تجيب عن المكالمة الصوتية.
- المتصل الجديد ينشئ Lead أو مهمة خدمة حسب القسم من دون إنشاء عميل تلقائي، مع منع Lead مفتوح مكرر 30 يوماً، وربط المكالمات بصفحة العميل 360 والإجراءات الصريحة للحجز/العرض/العميل/واتساب.
- الواجهة مقسمة إلى التشغيل، الأقسام، الربط، والاختبار؛ وللمبيعات والفنيين شاشة «مكالماتي» فقط، مع فلاتر وجداول جوال وتسميات لوحة مفاتيح وتحذير تعديلات غير محفوظة.
- فحص المتصفح المحلي أثبت: حفظ الرقم، إنشاء القسم، المحاكي، ظهور المكالمة، تسجيل النتيجة مع بقاء حالة الاتصال، وإخفاء مكالمات الآخرين عن المختص.
- اختبارات الإطلاق الحالية: TypeScript، build، smoke (15/15)، golden (7/7)، وtelephony (20/20). ما يزال التحويل إلى الإنتاج محجوباً حتى تنجح مكالمة Unifonic حقيقية وتظهر شارة التحقق الحي.

---
