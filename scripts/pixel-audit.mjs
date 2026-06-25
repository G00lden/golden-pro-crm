/**
 * pixel-audit.mjs — فاحص بكسلات قوي ودقيق لمتجر سلة (وأي متجر ويب).
 *
 * يفتح المتجر بمتصفح حقيقي (Chrome المثبّت)، يمشي على مسار الشراء
 * (الرئيسية → صفحة منتج → إضافة للسلة → السلة)، ويعترض كل طلبات
 * التتبّع الفعلية ليؤكد:
 *   - أي بكسل مركّب فعلاً (TikTok / Snapchat / Meta / GA4 / Google Ads / GTM)
 *   - معرّف كل بكسل (Pixel ID / Measurement ID / Container ID)
 *   - أي أحداث أطلقها كل بكسل في كل مرحلة (PageView / ViewContent / AddToCart …)
 *   - كود استجابة كل طلب (يكشف 4xx/5xx مثل 503 على GA)
 *   - التكرار (مثلاً بكسلين GA4 على نفس الموقع)
 *   - عدم تطابق المعرّف مع المتوقّع (لو ضبطت القيم المتوقّعة)
 *
 * التشغيل:
 *   node scripts/pixel-audit.mjs                       # يفحص goldenksa.store
 *   node scripts/pixel-audit.mjs --url https://متجرك   # متجر آخر
 *   node scripts/pixel-audit.mjs --headed              # يظهر المتصفح
 *   node scripts/pixel-audit.mjs --json                # JSON فقط
 *
 * القيم المتوقّعة (اختياري، لكشف عدم التطابق) عبر متغيرات البيئة:
 *   PIXEL_EXPECT_TIKTOK, PIXEL_EXPECT_SNAP, PIXEL_EXPECT_META,
 *   PIXEL_EXPECT_GA4, PIXEL_EXPECT_GADS, PIXEL_EXPECT_GTM
 *
 * ملاحظة أمان: لا يُتمّ أي عملية شراء حقيقية. يتوقّف عند السلة، فحدث
 * Purchase يجب التحقق منه يدويًا أو عبر Test Events في منصة الإعلان.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

// ---------------------------------------------------------------------------
// إعداد سطر الأوامر
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const STORE_URL = (opt("--url", process.env.PIXEL_STORE_URL || "https://goldenksa.store")).replace(/\/+$/, "");
const HEADED = flag("--headed");
const JSON_ONLY = flag("--json");
const OUT_PATH = opt("--out", join(root, "pixel-audit-report.json"));
const SETTLE_MS = Number(opt("--settle", "6000"));

const EXPECT = {
  tiktok: process.env.PIXEL_EXPECT_TIKTOK || "",
  snapchat: process.env.PIXEL_EXPECT_SNAP || "",
  meta: process.env.PIXEL_EXPECT_META || "",
  ga4: process.env.PIXEL_EXPECT_GA4 || "",
  google_ads: process.env.PIXEL_EXPECT_GADS || "",
  gtm: process.env.PIXEL_EXPECT_GTM || "",
};

// ---------------------------------------------------------------------------
// تعريف المنصّات وتصنيف الطلبات
// ---------------------------------------------------------------------------
const PLATFORMS = {
  tiktok: "تيك توك",
  snapchat: "سناب شات",
  meta: "ميتا/فيسبوك",
  ga4: "Google Analytics 4",
  google_ads: "Google Ads",
  gtm: "Google Tag Manager",
};

/** يصنّف عنوان طلب إلى {platform, kind} أو null لو ليس طلب تتبّع. */
function classify(url) {
  // مكتبات التحميل (السكربت نفسه)
  if (/googletagmanager\.com\/gtm\.js/.test(url)) return { platform: "gtm", kind: "lib" };
  if (/googletagmanager\.com\/gtag\/js/.test(url)) return { platform: "ga4", kind: "lib" };
  if (/connect\.facebook\.net\/.*fbevents\.js/.test(url)) return { platform: "meta", kind: "lib" };
  if (/analytics\.tiktok\.com\/i18n\/pixel\/.*\.js/.test(url)) return { platform: "tiktok", kind: "lib" };
  if (/sc-static\.net\/scevent/.test(url) || /tr\.snapchat\.com\/config\//.test(url)) return { platform: "snapchat", kind: "lib" };

  // أحداث (beacons)
  if (/analytics\.tiktok\.com\/api\/v[0-9]+\/pixel/.test(url)) return { platform: "tiktok", kind: "beacon" };
  if (/tr[0-9]*\.snapchat\.com\/p\b/.test(url)) return { platform: "snapchat", kind: "beacon" };
  if (/facebook\.com\/tr\b/.test(url)) return { platform: "meta", kind: "beacon" };
  if (/google-analytics\.com\/(g\/collect|collect|mp\/collect)/.test(url) || /analytics\.google\.com\/g\/collect/.test(url)) return { platform: "ga4", kind: "beacon" };
  if (/(googleads\.g\.doubleclick\.net|google(adservices)?\.com(\.[a-z]+)?)\/pagead\//.test(url) || /googleads\.g\.doubleclick\.net/.test(url)) return { platform: "google_ads", kind: "beacon" };

  return null;
}

function qp(url, key) {
  try {
    return new URL(url).searchParams.get(key) || "";
  } catch {
    return "";
  }
}

/** يستخرج {ids[], events[]} من طلب beacon حسب المنصّة. */
function extractBeacon(platform, url, postData) {
  const ids = new Set();
  const events = new Set();

  if (platform === "ga4") {
    const tid = qp(url, "tid");
    if (tid) ids.add(tid);
    const en = qp(url, "en");
    if (en) events.add(en);
  } else if (platform === "meta") {
    const id = qp(url, "id");
    if (id) ids.add(id);
    const ev = qp(url, "ev");
    if (ev) events.add(ev);
  } else if (platform === "google_ads") {
    const m = url.match(/\/pagead\/[^/]*\/(\d{6,})\//) || url.match(/[?&](?:tid|cid)=(AW-\d+)/);
    if (m) ids.add(m[1].startsWith("AW-") ? m[1] : `AW-${m[1]}`);
    const en = qp(url, "en");
    if (en) events.add(en);
    const label = qp(url, "label");
    if (label) events.add(`label:${label}`);
  } else if (platform === "tiktok") {
    // body عادة JSON يحوي event و context.pixel.code
    parseJsonLoose(postData).forEach((obj) => {
      const code = obj?.context?.pixel?.code || obj?.pixel_code || obj?.pixelCode;
      if (code) ids.add(code);
      const ev = obj?.event || obj?.event_type || obj?.type;
      if (ev) events.add(ev);
      if (Array.isArray(obj?.batch)) {
        obj.batch.forEach((b) => {
          const c = b?.context?.pixel?.code;
          if (c) ids.add(c);
          if (b?.event) events.add(b.event);
        });
      }
    });
  } else if (platform === "snapchat") {
    const fromQ = qp(url, "ev") || qp(url, "event");
    if (fromQ) events.add(fromQ);
    parseJsonLoose(postData).forEach((obj) => {
      if (obj?.event_conversion_type || obj?.event) events.add(obj.event_conversion_type || obj.event);
      const pid = obj?.pixel_id || obj?.["@context"]?.pixel_id;
      if (pid) ids.add(pid);
    });
  }

  return { ids: [...ids], events: [...events] };
}

function parseJsonLoose(data) {
  if (!data) return [];
  const out = [];
  try {
    const j = JSON.parse(data);
    out.push(...(Array.isArray(j) ? j : [j]));
  } catch {
    // أحياناً يكون form-encoded أو عدة JSON مفصولة بأسطر
    for (const line of String(data).split(/\n+/)) {
      try {
        out.push(JSON.parse(line));
      } catch {
        /* تجاهل */
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// اللقطة الحيّة من الصفحة (المتغيرات العامة + إعدادات سلة)
// ---------------------------------------------------------------------------
async function snapshotGlobals(page) {
  return page.evaluate(() => {
    const out = { globals: {}, ids: {}, services: [], scripts: [] };
    out.globals.tiktok = typeof window.ttq !== "undefined";
    out.globals.snapchat = typeof window.snaptr !== "undefined";
    out.globals.meta = typeof window.fbq !== "undefined";
    out.globals.gtag = typeof window.gtag !== "undefined";
    out.globals.dataLayer = Array.isArray(window.dataLayer);

    try { if (window.ttq && window.ttq._i) out.ids.tiktok = Object.keys(window.ttq._i); } catch {}
    try { if (window.fbq && window.fbq.getState) out.ids.meta = window.fbq.getState().pixels.map((p) => p.id); } catch {}

    try {
      out.scripts = [...document.scripts].map((s) => s.src).filter(Boolean)
        .filter((s) => /googletagmanager|google-analytics|tiktok|snapchat|sc-static|facebook|doubleclick/.test(s));
    } catch {}

    // إعدادات سلة المضمّنة (services::*.init) فيها كل المعرّفات المهيّأة
    try {
      out.services = (window.dataLayer || [])
        .filter((x) => x && typeof x.event === "string" && x.event.indexOf("services::") === 0)
        .map((x) => ({ event: x.event, services: x.services }));
    } catch {}
    return out;
  });
}

// ---------------------------------------------------------------------------
// تشغيل الفحص
// ---------------------------------------------------------------------------
const beacons = []; // كل طلبات التتبّع عبر كل المراحل
const libs = new Set(); // (platform) التي حُمّل سكربتها
const snapshots = {}; // لكل مرحلة

function log(...a) {
  if (!JSON_ONLY) console.log(...a);
}

async function loadBrowser() {
  let chromium;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    console.error("playwright-core غير مثبّت. ثبّته أولاً:\n  npm i -D playwright-core");
    process.exit(2);
  }
  const launchOpts = { headless: !HEADED };
  // نستخدم Chrome المثبّت على الجهاز لتفادي تنزيل متصفّح ثقيل
  for (const channel of ["chrome", "msedge", undefined]) {
    try {
      return await chromium.launch(channel ? { ...launchOpts, channel } : launchOpts);
    } catch (e) {
      if (channel === undefined) {
        console.error(
          "تعذّر تشغيل المتصفّح. إمّا Chrome غير موجود أو متصفّح Playwright غير منزّل.\n" +
            "حلّ سريع: تأكّد أن Google Chrome مثبّت، أو نزّل متصفّح Playwright:\n" +
            "  npx playwright install chromium\n" +
            `التفاصيل: ${e.message}`,
        );
        process.exit(2);
      }
    }
  }
}

async function runStage(page, name, action) {
  log(`\n▶ المرحلة: ${name}`);
  try {
    await action();
    await page.waitForTimeout(SETTLE_MS);
  } catch (e) {
    log(`  ⚠ تعذّر إكمال المرحلة "${name}": ${e.message}`);
  }
  try {
    snapshots[name] = await snapshotGlobals(page);
  } catch (e) {
    snapshots[name] = { error: e.message };
  }
}

async function findFirstProductUrl(page) {
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll("a")]
      .map((a) => a.href)
      .filter((h) => /\/(p\d+|product|item)/i.test(h) || /\.store\/[^/]+\/p?\d{3,}/i.test(h));
    // سلة: روابط المنتجات غالباً تحوي /pXXXXXX...
    const salla = [...document.querySelectorAll('a[href*="/p"]')].map((a) => a.href);
    return cards[0] || salla.find((h) => /\/p\d/.test(h)) || salla[0] || null;
  });
}

async function clickAddToCart(page) {
  // عناصر سلة الشائعة لزر الإضافة
  const selectors = [
    "salla-add-product-button button",
    "salla-add-product-button",
    'button[type="submit"].btn--add-to-cart',
    "button.s-button-element",
    'button:has-text("إضافة للسلة")',
    'button:has-text("أضف للسلة")',
    'button:has-text("اشتري الآن")',
  ];
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    if (await el.count().catch(() => 0)) {
      await el.click({ timeout: 4000 }).catch(() => {});
      return true;
    }
  }
  return false;
}

async function main() {
  const startedAt = new Date().toISOString();
  log(`فحص البكسلات للمتجر: ${STORE_URL}`);
  log(`المتصفّح: ${HEADED ? "ظاهر" : "خفي"} • وقت الاستقرار لكل مرحلة: ${SETTLE_MS}ms`);

  const browser = await loadBrowser();
  const context = await browser.newContext({
    locale: "ar-SA",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  });
  const page = await context.newPage();
  let stage = "home";

  page.on("response", (resp) => {
    const req = resp.request();
    const url = req.url();
    const cls = classify(url);
    if (!cls) return;
    if (cls.kind === "lib") {
      libs.add(cls.platform);
      return;
    }
    let status;
    try { status = resp.status(); } catch {}
    let postData;
    try { postData = req.postData(); } catch {}
    const { ids, events } = extractBeacon(cls.platform, url, postData);
    beacons.push({ stage, platform: cls.platform, status, method: req.method(), ids, events, url: url.slice(0, 220) });
  });
  // بعض البكسلات ترسل عبر sendBeacon بدون response — نلتقطها من الطلب أيضاً
  page.on("requestfinished", (req) => {
    const cls = classify(req.url());
    if (!cls || cls.kind !== "beacon") return;
    const already = beacons.find((b) => b.url === req.url().slice(0, 220) && b.stage === stage);
    if (already) return;
    const { ids, events } = extractBeacon(cls.platform, req.url(), (() => { try { return req.postData(); } catch { return ""; } })());
    beacons.push({ stage, platform: cls.platform, status: undefined, method: req.method(), ids, events, url: req.url().slice(0, 220) });
  });

  await runStage(page, "home", async () => {
    stage = "home";
    await page.goto(STORE_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
  });

  const productUrl = await findFirstProductUrl(page);
  await runStage(page, "product", async () => {
    stage = "product";
    if (!productUrl) throw new Error("لم أجد رابط منتج على الصفحة الرئيسية");
    await page.goto(productUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  });

  await runStage(page, "add_to_cart", async () => {
    stage = "add_to_cart";
    const clicked = await clickAddToCart(page);
    if (!clicked) throw new Error("لم أجد زر الإضافة للسلة");
  });

  await runStage(page, "cart", async () => {
    stage = "cart";
    await page.goto(`${STORE_URL}/cart`, { waitUntil: "domcontentloaded", timeout: 45000 });
  });

  await browser.close();

  const report = analyze({ startedAt, productUrl });
  output(report);
  process.exitCode = report.summary.fail > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// التحليل والاستنتاج
// ---------------------------------------------------------------------------
function collectConfiguredIds() {
  // من إعدادات سلة المضمّنة في كل اللقطات
  const map = {}; // platform -> Set(ids)
  const add = (p, id) => {
    if (!id) return;
    (map[p] ||= new Set()).add(String(id));
  };
  for (const snap of Object.values(snapshots)) {
    for (const s of snap?.services || []) {
      const sv = s.services || {};
      if (sv.tiktok_pixel?.pixel_id) add("tiktok", sv.tiktok_pixel.pixel_id);
      if (sv.snapchat_pixel?.pixel_id) add("snapchat", sv.snapchat_pixel.pixel_id);
      if (sv.facebook_pixel?.pixel_id) add("meta", sv.facebook_pixel.pixel_id);
      if (sv.google_analytics?.tracking_id) add("ga4", sv.google_analytics.tracking_id);
      if (sv.adwords?.conversion_id) add("google_ads", `AW-${sv.adwords.conversion_id}`);
    }
    for (const src of snap?.scripts || []) {
      const m = src.match(/[?&]id=(GTM-[A-Z0-9]+|G-[A-Z0-9]+|AW-[0-9]+)/);
      if (m) {
        if (m[1].startsWith("GTM-")) add("gtm", m[1]);
        else if (m[1].startsWith("G-")) add("ga4", m[1]);
        else add("google_ads", m[1]);
      }
    }
    if (snap?.ids?.tiktok) snap.ids.tiktok.forEach((id) => add("tiktok", id));
    if (snap?.ids?.meta) snap.ids.meta.forEach((id) => add("meta", id));
  }
  return map;
}

function analyze({ startedAt, productUrl }) {
  const configured = collectConfiguredIds();
  const platforms = {};
  let fail = 0;
  let warn = 0;

  for (const key of Object.keys(PLATFORMS)) {
    const myBeacons = beacons.filter((b) => b.platform === key);
    const beaconIds = new Set();
    const events = {}; // event -> {stages:Set, statuses:Set}
    const badStatus = [];
    myBeacons.forEach((b) => {
      b.ids.forEach((id) => beaconIds.add(id));
      b.events.forEach((ev) => {
        (events[ev] ||= { stages: new Set(), statuses: new Set() });
        events[ev].stages.add(b.stage);
        if (b.status != null) events[ev].statuses.add(b.status);
      });
      if (b.status != null && b.status >= 400) badStatus.push({ status: b.status, stage: b.stage });
    });

    const ids = new Set([...(configured[key] || []), ...beaconIds]);
    const installed = libs.has(key) || ids.size > 0 || Object.values(snapshots).some((s) => s?.globals?.[key]);
    const fired = myBeacons.length > 0;

    const issues = [];
    // 1) أكواد استجابة خاطئة
    if (badStatus.length) {
      const codes = [...new Set(badStatus.map((b) => b.status))].join(",");
      issues.push({ level: "fail", msg: `طلبات أعادت كود خطأ (${codes}) — الأحداث قد لا تُسجَّل` });
    }
    // 2) تكرار المعرّفات (لمنصّات يجب أن يكون لها معرّف واحد)
    if (["ga4", "meta", "tiktok", "snapchat"].includes(key) && ids.size > 1) {
      issues.push({ level: "warn", msg: `أكثر من معرّف على نفس الموقع (${[...ids].join(" , ")}) — احتمال ازدواج/تكرار` });
    }
    // 3) مركّب لكنه لا يطلق أي طلب (نستثني GTM لأنه حاوية تُحمّل وسوماً أخرى ولا يرسل أحداثه)
    if (installed && !fired && key !== "gtm") {
      issues.push({ level: "warn", msg: "السكربت محمّل لكن لم يُلتقط أي طلب تتبّع — تحقّق من الإطلاق" });
    }
    // 4) عدم تطابق مع المتوقّع
    if (EXPECT[key]) {
      if (!ids.has(EXPECT[key])) {
        issues.push({ level: "fail", msg: `المعرّف على الموقع لا يطابق المتوقّع (${EXPECT[key]}) — وجدت: ${[...ids].join(",") || "لا شيء"}` });
      }
    }
    // 5) غير مركّب أصلاً
    if (!installed) {
      issues.push({ level: "warn", msg: "غير مركّب على الموقع" });
    }

    issues.forEach((i) => (i.level === "fail" ? fail++ : warn++));

    platforms[key] = {
      name: PLATFORMS[key],
      installed,
      libLoaded: libs.has(key),
      ids: [...ids],
      events: Object.fromEntries(Object.entries(events).map(([ev, v]) => [ev, { stages: [...v.stages], statuses: [...v.statuses] }])),
      beaconCount: myBeacons.length,
      issues,
    };
  }

  return {
    store: STORE_URL,
    startedAt,
    productUrl,
    note: "حدث Purchase لا يُختبر تلقائياً (يتطلب طلباً حقيقياً) — تحقّق منه عبر Test Events.",
    summary: {
      fail,
      warn,
      platformsInstalled: Object.values(platforms).filter((p) => p.installed).length,
    },
    platforms,
    beacons,
  };
}

// ---------------------------------------------------------------------------
// الإخراج
// ---------------------------------------------------------------------------
function output(report) {
  try {
    writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
  } catch {}

  if (JSON_ONLY) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }

  const EVENTS_AR = {};
  console.log("\n══════════════════════════════════════════════");
  console.log(`نتيجة فحص البكسلات — ${report.store}`);
  console.log("══════════════════════════════════════════════");

  for (const [key, p] of Object.entries(report.platforms)) {
    const head = p.installed ? "● مركّب" : "○ غير مركّب";
    console.log(`\n[${p.name}] ${head}`);
    console.log(`  المعرّفات : ${p.ids.length ? p.ids.join(" , ") : "—"}`);
    const evs = Object.entries(p.events);
    if (evs.length) {
      console.log("  الأحداث  :");
      for (const [ev, info] of evs) {
        const st = info.statuses.length ? ` [${info.statuses.join(",")}]` : "";
        console.log(`     - ${ev}${st}  (${info.stages.join(", ")})`);
      }
    } else if (p.beaconCount > 0) {
      console.log(`  الأحداث  : أُرسلت ${p.beaconCount} طلب تتبّع (بدون تفاصيل حدث مقروءة — البكسل يعمل)`);
    } else if (key === "gtm") {
      console.log("  الأحداث  : حاوية وسوم (تُحمّل البكسلات الأخرى — لا ترسل أحداثها)");
    } else {
      console.log("  الأحداث  : لم يُلتقط أي طلب");
    }
    for (const i of p.issues) {
      console.log(`  ${i.level === "fail" ? "FAIL" : "WARN"}: ${i.msg}`);
    }
  }

  console.log("\n──────────────────────────────────────────────");
  console.log(`الإجمالي: ${report.summary.platformsInstalled}/${Object.keys(report.platforms).length} منصّة مركّبة • ${report.summary.fail} خطأ • ${report.summary.warn} تنبيه`);
  console.log(report.note);
  console.log(`التقرير الكامل: ${OUT_PATH}`);
  if (report.summary.fail > 0) console.log("\n⛔ يوجد أخطاء تمنع تسجيل بعض الأحداث — راجع أعلاه.");
  else console.log("\n✅ لا أخطاء مانعة.");
}

await main();
