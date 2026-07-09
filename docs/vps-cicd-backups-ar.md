# تشغيل Golden Pro CRM على VPS + ربط GitHub + تحديثات ونسخ احتياطية

دليل عملي من الصفر إلى نظام إنتاجي: خادم VPS (Contabo أو غيره) يشغّل النظام في Docker خلف Caddy (HTTPS تلقائي)، يتحدّث تلقائيًا عند كل دفعة إلى `main` عبر GitHub Actions، ويأخذ نسخة احتياطية يومية مع إمكانية الاستعادة.

المكوّنات الجاهزة في المستودع:
- `Dockerfile` + `deploy/docker-compose.yml` + `deploy/Caddyfile` — الحاوية + الوكيل العكسي + HTTPS تلقائي.
- `deploy/bootstrap-vps.sh` — تجهيز أوبنتو (Docker + جدار ناري).
- `.github/workflows/ci.yml` — فحص (lint + build) على كل PR/دفعة.
- `.github/workflows/deploy.yml` — نشر تلقائي إلى الـVPS عند الدفع إلى `main`.
- `scripts/vps-update.sh` — سحب + إعادة بناء + فحص صحة + **تراجع تلقائي** عند الفشل.
- `scripts/vps-backup.sh` + `deploy/golden-crm-backup.{service,timer}` — نسخ احتياطية يومية.
- `scripts/vps-restore.sh` — استعادة من نسخة.

---

## 1) تجهيز الخادم (Contabo Ubuntu 24.04)

بعد إنشاء الـVPS، ادخل عليه وثبّت git:
```bash
ssh root@SERVER_IP
apt-get update && apt-get install -y git
```

> **DNS:** وجّه نطاقك (مثلاً `crm.breexe-pro.com`) بسجل A إلى IP الخادم قبل أول تشغيل — Caddy يحتاجه لإصدار شهادة HTTPS تلقائيًا.

---

## 2) منح الخادم صلاحية قراءة المستودع (المستودع خاص)

يحتاج الخادم مفتاح قراءة ليستنسخ ويسحب التحديثات:
```bash
ssh-keygen -t ed25519 -f ~/.ssh/github_ro -N ""
cat ~/.ssh/github_ro.pub
```
انسخ الناتج وأضِفه في GitHub → المستودع → Settings → **Deploy keys** → Add deploy key (اترك «Allow write access» **بدون** تفعيل — قراءة فقط).

اجعل git يستخدم هذا المفتاح مع GitHub:
```bash
cat >> ~/.ssh/config <<'EOF'
Host github.com
  IdentityFile ~/.ssh/github_ro
  IdentitiesOnly yes
EOF
```

---

## 3) الاستنساخ + الإعداد + الأسرار

```bash
git clone git@github.com:G00lden/golden-pro-crm.git /opt/golden-pro-crm
cd /opt/golden-pro-crm
bash deploy/bootstrap-vps.sh          # يثبّت Docker + git + جدار ناري (80/443/SSH)
cp .env.production.example .env.production
nano .env.production                   # املأ الأسرار (انظر .env.example للمفاتيح)
```
ملاحظات على `.env.production`:
- `CRM_DOMAIN=crm.your-domain.com` (يستخدمه Caddy).
- لو تستخدم الدخول المحلّي عبر النفق سابقًا: راجع `ALLOW_LOCAL_AUTH` و **`LOCAL_AUTH_TOKEN`** (وضعناه اختياريًا للأمان — إن فعّلته اضبط `VITE_LOCAL_AUTH_TOKEN` بنفس القيمة وأعد البناء).
- أبقِ `OUTBOUND_MODE` على `dry_run` حتى تجهز، ثم انقله (انظر `server/outboundSafety.ts`).

---

## 4) أول تشغيل يدوي

```bash
cd /opt/golden-pro-crm
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml ps
docker compose -f deploy/docker-compose.yml logs -f crm
```
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
| `VPS_USER` | مستخدم الدخول (`goldencrm` أو `root`) |
| `VPS_SSH_KEY` | المفتاح الخاص كاملًا (خرج `cat ~/.ssh/deploy_key`) |
| `APP_DIR` | `/opt/golden-pro-crm` |
| `VPS_PORT` | (اختياري) منفذ SSH إن لم يكن 22 |

بعدها: **كل دمج إلى `main` يشغّل النشر تلقائيًا** — يسحب الكود، يعيد البناء، يفحص الصحة، ويتراجع تلقائيًا لو فشل. تقدر تشغّله يدويًا من تبويب Actions → Deploy to VPS → Run workflow.

فحص الـCI (`ci.yml`) يعمل على كل PR (lint + build) فما يوصل كود مكسور إلى `main`.

> تحديث يدوي بأي وقت (على الخادم): `cd /opt/golden-pro-crm && bash scripts/vps-update.sh`

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
كل نسخة (يوميًا 03:15) في `/opt/golden-pro-crm/backups/<التاريخ>/`:
- `golden-crm.db.gz` — لقطة **متسقة** من قاعدة البيانات (VACUUM INTO، آمنة أثناء التشغيل).
- `wa-session.tar.gz` — جلسة واتساب (استعادة بدون إعادة مسح QR).
- `env.production` — الأسرار (صلاحية 600).

يُحتفظ بالنسخ 14 يومًا (`BACKUP_KEEP_DAYS`). 

**نسخ خارج الخادم (مُوصى به):** ثبّت `rclone` واضبط وجهة (Cloudflare R2 / S3 / Google Drive)، ثم في `golden-crm-backup.service` أزل التعليق عن `OFFSITE_RCLONE_REMOTE`. فقدان الخادم بدون نسخة خارجية = فقدان كل شيء.

---

## 7) الاستعادة (درّبها مرة قبل أن تحتاجها)

```bash
cd /opt/golden-pro-crm
ls backups/                                   # اختر نسخة
bash scripts/vps-restore.sh backups/20260707-031500
```
يوقف الحاوية، يأخذ لقطة أمان أولًا، يستعيد قاعدة البيانات (وجلسة واتساب إن وُجدت)، ثم يعيد التشغيل.

---

## ملخص التشغيل اليومي
- **تطوير:** ادفع/ادمج إلى `main` → ينشر تلقائيًا (مع تراجع آمن).
- **نسخ:** تلقائية يوميًا؛ راقبها بـ `systemctl status golden-crm-backup.timer` و`journalctl -u golden-crm-backup`.
- **سجلّات:** `docker compose -f deploy/docker-compose.yml logs -f crm`.
- **حالة:** `https://crm.your-domain.com/api/health`.
