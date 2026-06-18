# نشر Golden Pro CRM على VPS وربط الدومين

هذا هو المسار المستقر للاستخدام اليومي.

## 1. اشتر VPS

المواصفات المقترحة:

- Ubuntu 24.04 LTS
- 2GB RAM على الأقل
- 1 vCPU أو 2 vCPU
- 40GB SSD أو أكثر
- IP ثابت

بعد الشراء احتفظ بـ:

- IP السيرفر
- كلمة مرور root أو SSH key

## 2. قبل الرفع من جهازك

من PowerShell داخل المشروع:

```powershell
cd "C:\Users\owner\Documents\Codex\2026-04-25\files-mentioned-by-the-user-golden-2"
npm run doctor:prod
npm run lint
npm run build
```

يجب ألا يظهر `FAIL`.

## 3. الرفع التلقائي للسيرفر

استبدل `SERVER_IP` بعنوان IP الحقيقي:

```powershell
.\scripts\deploy-vps.ps1 -HostName "SERVER_IP"
```

إذا تستخدم SSH key:

```powershell
.\scripts\deploy-vps.ps1 -HostName "SERVER_IP" -SshKey "C:\path\to\key.pem"
```

السكربت يقوم بـ:

- تثبيت Docker وDocker Compose على Ubuntu.
- فتح المنافذ 80 و443.
- رفع المشروع بدون ملفات الأسرار.
- رفع `.env.production` وحده.
- تشغيل Docker Compose.
- محاولة تحديث DNS إذا كان `CLOUDFLARE_API_TOKEN` موجوداً.

## 4. ربط Cloudflare DNS يدوياً إذا لم تستخدم API token

في Cloudflare > DNS أضف:

```text
Type: A
Name: crm
Value: SERVER_IP
Proxy: ON
```

بعدها انتظر دقائق ثم افتح:

```text
https://crm.breexe-pro.com/api/health
```

يجب أن ترى:

```json
{"status":"ok"}
```

## 5. إعداد روابط سلة

بعد نجاح الدومين، ضع هذه الروابط في سلة:

```text
https://crm.breexe-pro.com/api/store/webhook
https://crm.breexe-pro.com/api/integrations/salla/callback
```

## 6. أوامر متابعة السيرفر

```bash
cd /opt/golden-pro-crm
docker compose -f deploy/docker-compose.yml ps
docker compose -f deploy/docker-compose.yml logs -f --tail=100
docker compose -f deploy/docker-compose.yml restart
```

## 7. الأمان قبل الإطلاق

اترك هذه القيم كما هي قبل التشغيل التجاري الكامل:

```env
OUTBOUND_MODE=code
OUTBOUND_CONFIRM_CODE=2232
OFFICIAL_LAUNCH_APPROVED=false
```

بهذا لا يرسل النظام رسالة حقيقية إلا بعد إدخال الكود.
