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

    if (env.WHATSAPP_PROVIDER === "cloud_api") {
      if (!env.WHATSAPP_CLOUD_PHONE_NUMBER_ID) fail("WHATSAPP_CLOUD_PHONE_NUMBER_ID مطلوب");
      else ok("WHATSAPP_CLOUD_PHONE_NUMBER_ID مضبوط");
      if (!env.WHATSAPP_CLOUD_API_TOKEN) fail("WHATSAPP_CLOUD_API_TOKEN مطلوب");
      else ok(`WHATSAPP_CLOUD_API_TOKEN مضبوط (${masked(env.WHATSAPP_CLOUD_API_TOKEN)})`);
    } else {
      warn("WHATSAPP_PROVIDER ليس cloud_api. WhatsApp Web أفضل على VPS دائم وليس Cloud Run/Cloudflare.");
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
