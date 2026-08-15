import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const mode = process.argv.includes("--production") ? "production" : "local";
const defaultEnvFile = mode === "production" && existsSync(join(root, ".env.production")) ? ".env.production" : ".env";
const envPath = join(root, process.env.ENV_FILE || defaultEnvFile);
const examplePath = join(root, ".env.example");
const firebaseConfigPath = join(root, "firebase-applet-config.json");

const findings = [];

function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const env = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index < 0) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    env[key] = value;
  }
  return env;
}

function masked(value) {
  if (!value) return "";
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function ok(message) {
  findings.push({ level: "ok", message });
}

function warn(message) {
  findings.push({ level: "warn", message });
}

function fail(message) {
  findings.push({ level: "fail", message });
}

async function validateSupabaseServiceKey(url, key) {
  if (!url || !key) return;

  try {
    const endpoint = `${url.replace(/\/+$/, "")}/rest/v1/customers?select=id&limit=0`;
    const response = await fetch(endpoint, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
    });

    if (response.ok) {
      ok("Supabase REST يقبل مفتاح السيرفر وجدول customers جاهز بدون قراءة بيانات العملاء");
      return;
    }

    const detail = await response.text();
    if (response.status === 401) {
      fail("Supabase رفض مفتاح السيرفر: انسخ Secret key أو service_role من نفس المشروع");
      return;
    }

    warn(`تعذر فحص Supabase REST (${response.status}): ${detail.slice(0, 120)}`);
  } catch (error) {
    warn(`تعذر الاتصال بـ Supabase REST: ${error.message}`);
  }
}

async function main() {
  const fileEnv = parseEnvFile(envPath);
  const env = { ...fileEnv, ...process.env };

  if (existsSync(examplePath)) ok(".env.example موجود");
  else fail(".env.example غير موجود");

  if (existsSync(firebaseConfigPath)) {
    try {
      const config = JSON.parse(readFileSync(firebaseConfigPath, "utf8"));
      if (config.apiKey && config.projectId && config.appId) {
        ok(`Firebase client config جاهز للمشروع ${config.projectId}`);
      } else {
        warn("firebase-applet-config.json موجود لكنه ناقص apiKey/projectId/appId");
      }
    } catch {
      fail("firebase-applet-config.json ليس JSON صالحا");
    }
  } else {
    warn("firebase-applet-config.json غير موجود؛ هذا مقبول فقط إذا كان Supabase Auth هو مصدر الدخول الوحيد لاحقا");
  }

  if (mode === "production") {
    const dataProvider = env.DATA_PROVIDER || env.DB_PROVIDER || "firebase";
    if (dataProvider === "supabase") {
      if (!env.SUPABASE_URL) {
        fail("SUPABASE_URL مطلوب عند استخدام DATA_PROVIDER=supabase");
      } else {
        ok(`Supabase URL مضبوط (${env.SUPABASE_URL})`);
      }

      const supabaseServiceKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
      if (!supabaseServiceKey) {
        fail("SUPABASE_SERVICE_ROLE_KEY مطلوب في السيرفر عند استخدام Supabase");
      } else {
        ok(`Supabase service role key موجود (${masked(supabaseServiceKey)})`);
        await validateSupabaseServiceKey(env.SUPABASE_URL, supabaseServiceKey);
      }

      if (env.VITE_DATA_PROVIDER !== "supabase" && env.VITE_DB_PROVIDER !== "supabase") {
        warn("VITE_DATA_PROVIDER ليس supabase؛ الواجهة قد تستخدم Firestore بدل API الجديد");
      } else {
        ok("واجهة الإنتاج مضبوطة لاستخدام Supabase API");
      }
    } else {
      ok(`مزود قاعدة البيانات الحالي: ${dataProvider}`);
    }

    if (env.ALLOW_LOCAL_AUTH === "true" || env.VITE_LOCAL_AUTH === "true") {
      fail("أوقف تسجيل الدخول المحلي في الإنتاج: ALLOW_LOCAL_AUTH=false و VITE_LOCAL_AUTH=false");
    } else {
      ok("تسجيل الدخول المحلي متوقف للإنتاج");
    }

    const outboundMode = env.OUTBOUND_MODE || "dry_run";
    if (outboundMode === "production" && env.OFFICIAL_LAUNCH_APPROVED !== "true") {
      fail("OUTBOUND_MODE=production يحتاج OFFICIAL_LAUNCH_APPROVED=true قبل إرسال رسائل حقيقية");
    } else if (outboundMode === "production") {
      ok("الإرسال الحقيقي مفعل بعد اعتماد الإطلاق الرسمي");
    } else if (outboundMode === "code") {
      if (!env.OUTBOUND_CONFIRM_CODE) {
        fail("OUTBOUND_MODE=code يحتاج OUTBOUND_CONFIRM_CODE قبل السماح بأي رسالة");
      } else {
        ok("الإرسال مفعل بشرط إدخال كود التأكيد لكل رسالة");
      }
    } else if (outboundMode === "allowlist") {
      ok("الإرسال محصور على قائمة أرقام الاختبار");
    } else {
      ok("الإرسال في وضع dry_run: لن ترسل رسائل حقيقية");
    }

    if (!env.STORE_WEBHOOK_SECRET) fail("STORE_WEBHOOK_SECRET مطلوب لربط سلة");
    else ok(`STORE_WEBHOOK_SECRET مضبوط (${masked(env.STORE_WEBHOOK_SECRET)})`);

    if (!env.STORE_WEBHOOK_OWNER_UID) {
      fail("STORE_WEBHOOK_OWNER_UID مطلوب لربط طلبات سلة بمستخدم CRM");
    } else {
      ok("STORE_WEBHOOK_OWNER_UID مضبوط");
    }

    if (String(env.STORE_ATTRIBUTION_SIGNING_SECRET || "").length < 32) {
      fail("STORE_ATTRIBUTION_SIGNING_SECRET must be a unique server-only secret of at least 32 characters");
    } else {
      ok(`Storefront attribution signing secret is configured (${masked(env.STORE_ATTRIBUTION_SIGNING_SECRET)})`);
    }
    const ga4Mode = String(env.GA4_MEASUREMENT_MODE || "disabled").trim().toLowerCase();
    if (!["disabled", "validate", "collect"].includes(ga4Mode)) {
      fail("GA4_MEASUREMENT_MODE must be disabled, validate, or collect");
    } else if (ga4Mode !== "disabled" && (!env.GA4_MEASUREMENT_ID || !env.GA4_API_SECRET)) {
      fail("GA4_MEASUREMENT_ID and GA4_API_SECRET are required when Measurement Protocol is enabled");
    } else {
      ok(`GA4 Measurement Protocol mode: ${ga4Mode}`);
    }

    const maintenanceOwner = env.MAINTENANCE_REQUEST_OWNER_UID || env.PUBLIC_LEADS_OWNER_UID || env.STORE_WEBHOOK_OWNER_UID;
    if (!maintenanceOwner) fail("MAINTENANCE_REQUEST_OWNER_UID مطلوب لربط طلبات الصيانة بمساحة CRM");
    else ok("مالك مساحة طلبات الصيانة مضبوط");

    if (String(env.MAINTENANCE_PORTAL_SECRET || "").length < 32) {
      fail("MAINTENANCE_PORTAL_SECRET يجب أن يكون سراً فريداً بطول 32 حرفاً على الأقل");
    } else {
      ok(`سر بوابة العميل مضبوط (${masked(env.MAINTENANCE_PORTAL_SECRET)})`);
    }
    const portalTtlDays = Number(env.MAINTENANCE_PORTAL_TOKEN_TTL_DAYS || 30);
    if (!Number.isFinite(portalTtlDays) || portalTtlDays <= 0 || portalTtlDays > 365) {
      fail("MAINTENANCE_PORTAL_TOKEN_TTL_DAYS يجب أن يكون بين 0 و365 يوماً");
    } else {
      ok(`صلاحية رابط العميل محددة (${portalTtlDays} يوم)`);
    }
    const maintenanceOtpMode = String(env.MAINTENANCE_WHATSAPP_OTP_MODE || "disabled").trim();
    if (!["disabled", "allowlist", "production"].includes(maintenanceOtpMode)) {
      fail("MAINTENANCE_WHATSAPP_OTP_MODE يجب أن يكون disabled أو allowlist أو production");
    } else if (!env.MAINTENANCE_WHATSAPP_OTP_TEMPLATE) {
      fail("قالب تحقق واتساب للصيانة غير مضبوط");
    } else if (maintenanceOtpMode === "production" && env.MAINTENANCE_WHATSAPP_OTP_LAUNCH_APPROVED !== "true") {
      fail("تشغيل OTP للإنتاج يتطلب MAINTENANCE_WHATSAPP_OTP_LAUNCH_APPROVED=true");
    } else if (maintenanceOtpMode !== "disabled" && env.WHATSAPP_PROVIDER !== "cloud_api") {
      fail("تحقق واتساب للصيانة يتطلب WHATSAPP_PROVIDER=cloud_api");
    } else {
      ok(`بوابة تحقق واتساب للصيانة مضبوطة بوضع ${maintenanceOtpMode}`);
    }
    if (maintenanceOtpMode === "production") {
      const otpCanaryEvidence = String(env.MAINTENANCE_WHATSAPP_OTP_CANARY_EVIDENCE || "").trim();
      const otpCanaryAt = Date.parse(String(env.MAINTENANCE_WHATSAPP_OTP_CANARY_AT || ""));
      const otpCanaryAge = Date.now() - otpCanaryAt;
      if (!/^\/app\/\.runtime\/maintenance-otp-canary-[A-Za-z0-9:-]+\.json$/.test(otpCanaryEvidence)) {
        fail("تشغيل OTP للإنتاج يتطلب مسار دليل Canary داخلي صالح");
      } else if (!Number.isFinite(otpCanaryAt) || otpCanaryAge < 0 || otpCanaryAge > 30 * 24 * 60 * 60_000) {
        fail("دليل Canary تحقق واتساب مفقود أو أقدم من 30 يوماً");
      } else {
        ok("دليل Canary تحقق واتساب حديث ومسجل");
      }
    }
    const leadHours = Number(env.MAINTENANCE_MIN_LEAD_HOURS || 2);
    if (!Number.isFinite(leadHours) || leadHours < 0 || leadHours > 168) {
      fail("MAINTENANCE_MIN_LEAD_HOURS يجب أن يكون بين 0 و168 ساعة");
    } else {
      ok(`الحد الأدنى لمهلة الموعد مضبوط (${leadHours} ساعة)`);
    }

    if (!env.FIELDTECH_SERVER_URL || !/^https:\/\//i.test(env.FIELDTECH_SERVER_URL)) {
      fail("FIELDTECH_SERVER_URL مطلوب ويجب أن يستخدم HTTPS في الإنتاج");
    } else {
      ok("رابط FieldTech الآمن مضبوط");
    }
    if (String(env.FIELDTECH_INTEGRATION_SECRET || "").length < 32) {
      fail("FIELDTECH_INTEGRATION_SECRET مطلوب بطول 32 حرفاً على الأقل");
    } else {
      ok(`سر تكامل FieldTech مضبوط (${masked(env.FIELDTECH_INTEGRATION_SECRET)})`);
    }
    if (!env.FIELDTECH_OWNER_UID || env.FIELDTECH_OWNER_UID !== maintenanceOwner) {
      fail("FIELDTECH_OWNER_UID يجب أن يطابق مالك مساحة طلبات الصيانة");
    } else {
      ok("مالك FieldTech يطابق مالك مساحة طلبات الصيانة");
    }
    const canaryEvidence = String(env.MAINTENANCE_FIELDTECH_CANARY_EVIDENCE || "").trim();
    const canaryAt = Date.parse(String(env.MAINTENANCE_FIELDTECH_CANARY_AT || ""));
    const canaryAgeMs = Date.now() - canaryAt;
    if (canaryEvidence.length < 8 || !Number.isFinite(canaryAt)) {
      fail("يلزم توثيق تجربة FieldTech داخلية ناجحة في MAINTENANCE_FIELDTECH_CANARY_EVIDENCE وMAINTENANCE_FIELDTECH_CANARY_AT");
    } else if (canaryAgeMs < 0 || canaryAgeMs > 30 * 24 * 60 * 60_000) {
      fail("دليل تجربة FieldTech أقدم من 30 يوماً أو مؤرخ في المستقبل؛ أعد التجربة قبل النشر");
    } else {
      ok("دليل تجربة FieldTech حديث وموجود");
    }

    if (env.SALLA_CLIENT_ID && env.SALLA_CLIENT_SECRET) {
      ok("Salla OAuth app credentials are configured");
    } else {
      warn("Salla OAuth app credentials are missing; API sync and official store linking will stay unavailable");
    }

    ok(`Salla auth mode: ${env.SALLA_AUTH_MODE === "custom" ? "custom" : "easy"}`);

    if (env.SALLA_REDIRECT_URI) {
      ok(`Salla redirect URI is set (${env.SALLA_REDIRECT_URI})`);
    } else {
      warn("SALLA_REDIRECT_URI is missing; callback URL will fall back to the current host");
    }

    if (env.SALLA_AUTH_MODE === "custom") {
      warn("Salla custom callback mode is intended for testing only; published Salla apps should use Easy Mode");
    } else {
      if (!env.SALLA_APP_WEBHOOK_SECRET && !env.STORE_WEBHOOK_SECRET) {
        fail("SALLA_APP_WEBHOOK_SECRET مطلوب لتوثيق app.store.authorize في Easy Mode");
      } else {
        ok(`Salla app webhook secret is set (${masked(env.SALLA_APP_WEBHOOK_SECRET || env.STORE_WEBHOOK_SECRET)})`);
      }

      if (!env.SALLA_APP_OWNER_UID && !env.STORE_WEBHOOK_OWNER_UID) {
        fail("SALLA_APP_OWNER_UID أو STORE_WEBHOOK_OWNER_UID مطلوب لربط توكنات سلة بمستخدم CRM");
      } else {
        ok("Salla app owner uid is configured");
      }
    }

    if (env.SALLA_SYNC_CRON_ENABLED === "true") {
      ok(`Salla sync schedule is enabled: ${env.SALLA_SYNC_CRON_SCHEDULE || "*/15 * * * *"}`);
    } else {
      warn("Salla API sync scheduler is disabled");
    }

    if (env.SALLA_CART_WHATSAPP_ENABLED !== "false") {
      const scopes = new Set(String(env.SALLA_SCOPES || "").split(/\s+/).filter(Boolean));
      if (!scopes.has("carts.read")) {
        fail("SALLA_SCOPES يحتاج carts.read لقراءة تفاصيل السلة المتروكة");
      } else {
        ok("صلاحية carts.read مضافة لتكامل سلة");
      }
      if (env.WHATSAPP_PROVIDER === "cloud_api" && !env.WHATSAPP_CLOUD_TEMPLATE_ABANDONED_CART_SUPPORT) {
        fail("WHATSAPP_CLOUD_TEMPLATE_ABANDONED_CART_SUPPORT مطلوب لقالب استعادة السلة");
      } else if (env.WHATSAPP_CLOUD_TEMPLATE_ABANDONED_CART_SUPPORT) {
        ok("قالب واتساب لاستعادة السلة مربوط");
      }
    } else {
      warn("SALLA_CART_WHATSAPP_ENABLED=false؛ متابعة السلات المتروكة متوقفة");
    }

    if (env.SALLA_DELIVERY_REVIEW_ENABLED !== "false") {
      const deliveredSlugs = String(env.SALLA_DELIVERED_STATUS_SLUGS || "delivered")
        .split(/[,\s]+/)
        .filter(Boolean);
      if (!deliveredSlugs.includes("delivered")) {
        warn("SALLA_DELIVERED_STATUS_SLUGS لا يحتوي delivered؛ تحقق من حالة تم التوصيل في سلة");
      } else {
        ok("حالة سلة delivered مفعلة لطلب تقييم ما بعد التوصيل");
      }
      if (env.WHATSAPP_PROVIDER === "cloud_api" && !env.WHATSAPP_CLOUD_TEMPLATE_DELIVERY_REVIEW_REQUEST) {
        fail("WHATSAPP_CLOUD_TEMPLATE_DELIVERY_REVIEW_REQUEST مطلوب لقالب طلب تقييم التوصيل");
      } else if (env.WHATSAPP_CLOUD_TEMPLATE_DELIVERY_REVIEW_REQUEST) {
        ok("قالب واتساب لطلب تقييم التوصيل مربوط");
      }
    } else {
      warn("SALLA_DELIVERY_REVIEW_ENABLED=false؛ طلب تقييم ما بعد التوصيل متوقف");
    }

    if (env.WHATSAPP_BOOKING_TECHNICIAN_NOTIFY_ENABLED !== "false") {
      if (env.WHATSAPP_PROVIDER === "cloud_api" && !env.WHATSAPP_CLOUD_TEMPLATE_TECHNICIAN_ASSIGNED) {
        fail("WHATSAPP_CLOUD_TEMPLATE_TECHNICIAN_ASSIGNED مطلوب لإشعار المندوب بالحجز");
      } else if (env.WHATSAPP_CLOUD_TEMPLATE_TECHNICIAN_ASSIGNED) {
        ok("قالب واتساب لإشعار المندوب بالحجز مربوط");
      } else {
        warn("إشعار المندوب مفعل، لكن الإرسال الحالي يعتمد WhatsApp Web وليس قالب Cloud API");
      }
    } else {
      warn("WHATSAPP_BOOKING_TECHNICIAN_NOTIFY_ENABLED=false؛ إشعار المندوب بالحجز متوقف");
    }

    if (env.WHATSAPP_PROVIDER === "cloud_api") {
      if (!env.WHATSAPP_CLOUD_PHONE_NUMBER_ID) fail("WHATSAPP_CLOUD_PHONE_NUMBER_ID مطلوب");
      else ok("WHATSAPP_CLOUD_PHONE_NUMBER_ID مضبوط");
      if (!env.WHATSAPP_CLOUD_API_TOKEN) fail("WHATSAPP_CLOUD_API_TOKEN مطلوب");
      else ok(`WHATSAPP_CLOUD_API_TOKEN مضبوط (${masked(env.WHATSAPP_CLOUD_API_TOKEN)})`);
      if (!env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
        fail("WHATSAPP_WEBHOOK_VERIFY_TOKEN مطلوب للتحقق من ربط Meta");
      } else {
        ok("WHATSAPP_WEBHOOK_VERIFY_TOKEN مضبوط");
      }
      if (!env.WHATSAPP_APP_SECRET && !env.WHATSAPP_WEBHOOK_SECRET) {
        fail("WHATSAPP_APP_SECRET مطلوب لتوثيق رسائل Meta الواردة مباشرة");
      } else {
        ok("توقيع Webhook الوارد من واتساب مضبوط");
      }
    } else {
      warn("WHATSAPP_PROVIDER ليس cloud_api. WhatsApp Web أفضل على VPS دائم وليس Cloud Run/Cloudflare.");
    }

    if (env.WHATSAPP_COMMERCE_ENABLED !== "false") {
      if (!env.TAP_SECRET_KEY) {
        fail("TAP_SECRET_KEY مطلوب لإنشاء روابط الدفع من واتساب");
      } else {
        ok(`TAP_SECRET_KEY مضبوط (${masked(env.TAP_SECRET_KEY)})`);
      }
    } else {
      warn("WHATSAPP_COMMERCE_ENABLED=false؛ الدفع والحجز الذاتي عبر واتساب متوقفان");
    }

    if (env.STORE_WEBHOOK_CREATE_BOOKINGS === "true") {
      if (!env.STORE_WEBHOOK_DEFAULT_TECHNICIAN_ID || !env.STORE_WEBHOOK_DEFAULT_TECHNICIAN_NAME) {
        warn("إنشاء الحجوزات من سلة مفعل، لكن الفني الافتراضي ناقص");
      } else {
        ok("الفني الافتراضي للحجوزات مضبوط");
      }
    }

    if (env.ENABLE_DAILY_CRON !== "true") {
      warn("ENABLE_DAILY_CRON ليس true؛ التذكيرات المجدولة لن تعمل من السيرفر");
    } else {
      ok(`جدولة التذكيرات مفعلة: ${env.REMINDER_CRON_SCHEDULE || "0 10 * * *"}`);
    }

    if (env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_DNS_TARGET) {
      ok("Cloudflare DNS automation جاهز");
    } else {
      warn("Cloudflare DNS يحتاج CLOUDFLARE_API_TOKEN و CLOUDFLARE_DNS_TARGET قبل الربط الفعلي");
    }
  } else {
    if (env.ALLOW_LOCAL_AUTH === "true" || env.VITE_LOCAL_AUTH === "true") {
      ok("وضع الدخول المحلي مفعل للتجربة");
    } else {
      warn("وضع الدخول المحلي غير مفعل؛ تأكد من تفعيل مزود تسجيل الدخول");
    }
    ok(`وضع الإرسال الحالي: ${env.WHATSAPP_PROVIDER || "web"}`);
    ok(`مزود البيانات الحالي: ${env.DATA_PROVIDER || env.DB_PROVIDER || "firebase"}`);
  }

  const icons = { ok: "PASS", warn: "WARN", fail: "FAIL" };
  for (const item of findings) {
    console.log(`${icons[item.level]} ${item.message}`);
  }

  const failed = findings.filter((item) => item.level === "fail");
  if (failed.length) {
    console.error(`\n${failed.length} مشكلة تمنع الجاهزية.`);
    process.exitCode = 1;
  } else {
    console.log(`\nجاهزية ${mode}: لا توجد أخطاء مانعة.`);
  }
}

await main();
