# تشغيل Golden Pro CRM على VPS + ربط GitHub + تحديثات ونسخ احتياطية

دليل عملي من الصفر إلى نظام إنتاجي: خادم VPS (Contabo أو غيره) يشغّل النظام في Docker خلف Caddy (HTTPS تلقائي)، يتحدّث تلقائيًا عند كل دفعة إلى `main` عبر GitHub Actions، ويأخذ نسخة احتياطية يومية مع إمكانية الاستعادة.

المكوّنات الجاهزة في المستودع:
- `Dockerfile` + `deploy/docker-compose.yml` + `deploy/Caddyfile` — الحاوية + الوكيل العكسي + HTTPS تلقائي.
- `deploy/bootstrap-vps.sh` — تجهيز أوبنتو (Docker + جدار ناري).
- `.github/workflows/ci.yml` — فحص (lint + build) على كل PR/دفعة.
- `.github/workflows/deploy.yml` — ينشر SHA نفسه بعد نجاح CI على `main` فقط.
- `scripts/vps-update.sh` — مدخل داخلي لحزمة CI نحو معاملة النشر المقفلة، وليس أمر تحديث مستقلًا على الخادم.
- `scripts/vps-backup.sh` + `deploy/golden-crm-backup.{service,timer}` — نسخ احتياطية يومية.
- `scripts/vps-restore.sh` — استعادة من نسخة.

---

## 1) تجهيز الخادم (Contabo Ubuntu 24.04)

بعد إنشاء الـVPS، يكفي فحص النظام والمساحة دون تثبيت أو تشغيل التطبيق يدويًا:
```bash
ssh root@SERVER_IP
uname -a
df -h /opt
```

تثبيت Docker والجدار الناري وإنشاء مجلد التطبيق ينفذها bootstrap داخل معاملة أول نشر.

> **DNS:** وجّه نطاقك (مثلاً `crm.breexe-pro.com`) بسجل A إلى IP الخادم قبل أول تشغيل — Caddy يحتاجه لإصدار شهادة HTTPS تلقائيًا.

---

## 2) وصول حزمة CI إلى الخادم

الخادم لا يستنسخ المستودع ولا يحتاج Deploy Key للقراءة. يرسل GitHub Actions
أرشيف SHA الذي اجتاز CI عبر مفتاح الدخول `VPS_SSH_KEY` المقيّد بالخادم، وبذلك
يطابق المصدر المنشور المصدر الذي تم اختباره.

---

## 3) الاستنساخ + الإعداد + الأسرار

```powershell
# على جهاز الإدارة داخل المستودع، وليس على VPS
Copy-Item .env.production.example .env.production
notepad .env.production
```

لا تستنسخ المصدر ولا تشغّل `bootstrap-vps.sh` أو Compose يدويًا على الخادم.
`deploy-vps.ps1` يرفع حزمة نظيفة ويجري التجهيز والنسخ والحفظ والاستبدال تحت قفل واحد.
ملاحظات على `.env.production`:
- `CRM_DOMAIN=crm.your-domain.com` (يستخدمه Caddy).
- الدخول المحلي ممنوع في الإنتاج وعبر النفق. أبقِ `ALLOW_LOCAL_AUTH=false` واستخدم Firebase Auth للمستخدمين الحقيقيين؛ `LOCAL_AUTH_TOKEN` مخصص لاختبارات loopback فقط ولا يوضع أبدًا في متغير `VITE_`.
- أبقِ `OUTBOUND_MODE` على `dry_run` حتى تجهز، ثم انقله (انظر `server/outboundSafety.ts`).

---

## 4) أول تشغيل آمن

نفّذ من جهاز الإدارة الذي يحتوي المستودع ومفتاح SSH. هذا المسار يتحقق من البيئة، يأخذ النسخة الاحتياطية، يمسك قفل النشر، ويطبّق فحص الإصدار والتراجع:

```powershell
npm run deploy:vps -- -HostName YOUR_VPS_HOST -SshKey YOUR_SSH_KEY -SkipDns -AllowFirstDeployWithoutBackup
```

الخيار `-AllowFirstDeployWithoutBackup` خاص بأول نشر موثّق فقط عندما لا توجد حاوية
أو بيانات CRM سابقة. احذفه من كل تحديث لاحق؛ فالمعاملة ترفض النشر إذا لم تستطع أخذ
نسخة وحفظ الحالة القديمة. تحتفظ المعاملة بشجرة المصدر السابقة كاملة داخل
`/opt/.golden-pro-crm-source-trees/` بصلاحية خاصة، ولا تحذفها تلقائيًا.

بعد نجاحه، أوامر المشاهدة الآمنة على الخادم هي:

```bash
cd /opt/golden-pro-crm
docker compose --env-file .env.production -f deploy/docker-compose.yml ps
docker compose --env-file .env.production -f deploy/docker-compose.yml logs -f crm
```
لا تستخدم `docker compose up --build` مباشرة؛ فهو يتجاوز النسخ الاحتياطي وقفل النشر وفحص Caddy والإصدار والتراجع التلقائي.
تحقّق: افتح `https://crm.your-domain.com/api/health` — يجب أن يرد `ok`.

**اربط واتساب مرة واحدة:** ادخل لوحة النظام → واتساب → امسح رمز QR. الجلسة تُحفظ في مجلّد دائم (`crm_wa_session`) فتصمد عبر التحديثات.

---

## 5) ربط GitHub — تحديث تلقائي عند كل دفعة

**أ. مفتاح نشر SSH** (على الخادم):
```bash
ssh-keygen -t ed25519 -f ~/.ssh/deploy_key -N ""       # بدون كلمة مرور
cat ~/.ssh/deploy_key.pub >> ~/.ssh/authorized_keys      # اسمح للمفتاح بالدخول
cat ~/.ssh/deploy_key                                     # ← انسخ المفتاح الخاص كاملًا
```

**ب. أسرار المستودع** في GitHub → Settings → Secrets and variables → Actions → New repository secret:

| الاسم | القيمة |
|-------|--------|
| `VPS_HOST` | IP الخادم أو النطاق |
| `VPS_USER` | `root`؛ المعاملة تحتاج إعادة تسمية ذرية داخل `/opt` وإنشاء مجلد الاحتفاظ المحمي |
| `VPS_SSH_KEY` | المفتاح الخاص كاملًا (خرج `cat ~/.ssh/deploy_key`) |
| `VPS_KNOWN_HOSTS` | سطر مفتاح مضيف SSH المثبّت الذي تحققت من بصمته عبر قناة موثوقة؛ لا تعتمد على `ssh-keyscan` داخل عملية النشر نفسها |
| `APP_DIR` | `/opt/golden-pro-crm` |
| `VPS_PORT` | (اختياري) منفذ SSH إن لم يكن 22 |

بعدها: **كل دمج إلى `main` ينشر فقط بعد نجاح CI**. يأخذ workflow نسخة SHA التي
اجتازت الفحص، يرسل أرشيفًا نظيفًا بلا أسرار، ثم يعيد البناء ويفحص الصحة ويتراجع عند الفشل.

فحص الـCI (`ci.yml`) يعمل على كل PR (type-check + `test:unit` بما فيها اختبارات معاملة النشر + build)، فلا يُنشر SHA لم يجتز بوابة النشر نفسها.

> للتحديث اليدوي شغّل `scripts/deploy-vps.ps1` من جهاز الإدارة الذي يحتوي المستودع
> ومفتاح SSH. لا تشغّل `vps-update.sh` مباشرة؛ فهو يحتاج الحزمة الموقعة سياقيًا من CI.

---

## 6) النسخ الاحتياطية اليومية

فعّل مؤقّت systemd (كـ root):
```bash
cp /opt/golden-pro-crm/deploy/golden-crm-backup.service /etc/systemd/system/
cp /opt/golden-pro-crm/deploy/golden-crm-backup.timer   /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now golden-crm-backup.timer
systemctl list-timers golden-crm-backup.timer            # تأكّد من الجدولة
bash /opt/golden-pro-crm/scripts/vps-backup.sh           # نسخة فورية للاختبار
```
كل نسخة (يوميًا 03:15) في `/var/backups/golden-pro-crm/<التاريخ>/`:
- `golden-crm.db.gz` — لقطة **متسقة** من قاعدة البيانات (VACUUM INTO، آمنة أثناء التشغيل).
- `wa-session.tar.gz` — جلسة واتساب (استعادة بدون إعادة مسح QR).
- `env.production` — الأسرار (صلاحية 600).

يُحتفظ بالنسخ 14 يومًا (`BACKUP_KEEP_DAYS`). 

**نسخ خارج الخادم (مُوصى به):** ثبّت `rclone` واضبط وجهة (Cloudflare R2 / S3 / Google Drive)، ثم في `golden-crm-backup.service` أزل التعليق عن `OFFSITE_RCLONE_REMOTE`. فقدان الخادم بدون نسخة خارجية = فقدان كل شيء.

---

## 7) الاستعادة (درّبها مرة قبل أن تحتاجها)

```bash
cd /opt/golden-pro-crm
ls /var/backups/golden-pro-crm/               # اختر نسخة
bash scripts/vps-restore.sh /var/backups/golden-pro-crm/20260707-031500
```
يوقف الحاوية، يأخذ لقطة أمان أولًا، يستعيد قاعدة البيانات (وجلسة واتساب إن وُجدت)، ثم يعيد التشغيل.

---

## ملخص التشغيل اليومي
- **تطوير:** ادفع/ادمج إلى `main` → ينشر تلقائيًا (مع تراجع آمن).
- **نسخ:** تلقائية يوميًا؛ راقبها بـ `systemctl status golden-crm-backup.timer` و`journalctl -u golden-crm-backup`.
- **سجلّات:** `docker compose --env-file .env.production -f deploy/docker-compose.yml logs -f crm`.
- **حالة:** `https://crm.your-domain.com/api/health`.
