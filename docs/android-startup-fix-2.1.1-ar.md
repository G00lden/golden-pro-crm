# إصلاح تشغيل BreeXe Connect 2.1.1

## سبب العطل

كان التطبيق ينشئ واجهة `GatewayViewModel` ويقرأ طابور Room المشفر فور فتح
`MainActivity`. تكامل `sqlcipher-android` يتطلب تحميل المكتبة الأصلية صراحةً
قبل أول استخدام، لكن الإصدار 2.1.0 لم ينفذ:

```kotlin
System.loadLibrary("sqlcipher")
```

لذلك كان التطبيق قد يُغلق قبل رسم أول شاشة. كما كانت المكتبة 4.6.1 قديمة
بالنسبة إلى أجهزة Android الحديثة ذات صفحات الذاكرة 16KB.

## الإصلاح

- إضافة `BreeXeApplication` كنقطة دخول للعملية وتحميل SQLCipher قبل Activity.
- إضافة حارس داخل `MobileDatabase` يضمن التحميل قبل بناء Room.
- تحديث SQLCipher إلى 4.15.0 وAndroidX SQLite إلى 2.6.2.
- حماية تعريف المتصل من فشل قاعدة البيانات، وإصلاح استدعاء API 29 ليبقى
  التطبيق متوافقًا مع الحد الأدنى Android 7.0 (API 24).
- رفع الإصدار إلى `2.1.1` ورقم البناء إلى `7`.
- نقل مشروع Android كاملًا إلى `android/BreeXeConnect` ليصبح جزءًا من مصدر
  المشروع ويُبنى بصورة قابلة للتكرار.

## التحقق

```powershell
$env:JAVA_HOME='C:\Program Files\Android\Android Studio\jbr'
cd android\BreeXeConnect
.\gradlew.bat testDebugUnitTest assembleDebug lintDebug --no-configuration-cache
```

يجب كذلك التحقق من APK باستخدام `aapt` و`zipalign -P 16` و`apksigner`، ومن
وجود `BreeXeApplication` وملف `libsqlcipher.so` لكل معماريات Android المدعومة.

## التثبيت

ثبّت 2.1.1 فوق النسخة الحالية للحفاظ على بيانات الربط. إذا رفض Android
التحديث بسبب اختلاف توقيع نسخة قديمة، احذف النسخة القديمة ثم ثبّت الجديدة
وأعد الربط من مركز الجوال في CRM عبر QR.
