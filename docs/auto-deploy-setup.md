# النشر التلقائي إلى crm.breexe-pro.com

كل ما يتحدّث فرع `main` (دمج PR مثلاً)، يشتغل GitHub Action وينشر تلقائيًا إلى الـ VPS — بدون أي أمر يدوي. الملف: `.github/workflows/deploy-vps.yml`.

## إعداد لمرة واحدة — أضف الأسرار في GitHub

من صفحة المستودع على GitHub:
**Settings → Secrets and variables → Actions → New repository secret**

| الاسم | إلزامي؟ | القيمة |
|------|---------|--------|
| `VPS_HOST` | نعم | IP السيرفر أو اسم الدومين (مثلاً `123.45.67.89`) |
| `VPS_SSH_KEY` | نعم | محتوى مفتاح SSH الخاص (private key) كامل — نفس المفتاح اللي بتدخل بيه السيرفر |
| `VPS_USER` | لا (افتراضي `root`) | مستخدم SSH لو مش root |
| `VPS_SSH_PORT` | لا (افتراضي `22`) | منفذ SSH لو مختلف |

> ملاحظة أمان: الـ Action **لا يرفع أي أسرار** من المستودع. ملف `.env.production` لازم يكون موجود مسبقًا على السيرفر في `/opt/golden-pro-crm/.env.production` (وهو موجود من أول نشر يدوي). الـ Action يحدّث الكود فقط ويعيد تشغيل الحاويات.

## إزاي تشتغل

1. يبني أرشيف من الكود بدون الأسرار (نفس استثناءات `scripts/deploy-vps.ps1`).
2. يرفعه للسيرفر ويفك ضغطه في `/opt/golden-pro-crm`.
3. يشغّل `deploy/remote-start.sh` → `docker compose up -d --build`.
4. يعمل فحص صحة على `http://127.0.0.1/api/health`.

## قبل ما تضيف الأسرار

الـ Action يتخطّى النشر بأمان (تحذير أصفر، مش فشل أحمر) طالما `VPS_HOST` غير مضبوط — فمفيش أي ضرر لحد ما تجهّز الأسرار.

## تشغيل يدوي وقت الحاجة

من تبويب **Actions → Deploy to VPS → Run workflow** تقدر تنشر يدويًا أي وقت بدون أي دفع كود.
