import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { readProjectEnv, root, masked } from "./env-utils.mjs";

const env = readProjectEnv();
const findings = [];

const skipDirs = new Set([
  ".git",
  "node_modules",
  "dist",
  ".runtime",
  ".wa-session",
  ".npm-cache",
  ".tools",
]);

const allowedSecretFiles = new Set([
  ".env",
  ".env.local",
  ".env.production",
]);

const sourceExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".json",
  ".md",
  ".sql",
  ".yml",
  ".yaml",
  ".toml",
  ".example",
  ".dockerignore",
]);

function add(level, message) {
  findings.push({ level, message });
}

function pass(message) {
  add("PASS", message);
}

function warn(message) {
  add("WARN", message);
}

function fail(message) {
  add("FAIL", message);
}

function fileText(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    if (skipDirs.has(name)) continue;
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, files);
      continue;
    }
    if (stat.size > 2_000_000) continue;
    files.push(full);
  }
  return files;
}

function extensionOf(file) {
  const base = file.split(/[\\/]/).pop() || "";
  if (base.endsWith(".example")) return ".example";
  const index = base.lastIndexOf(".");
  return index >= 0 ? base.slice(index).toLowerCase() : base;
}

function checkEnv() {
  if (env.APP_ENV !== "production" && env.NODE_ENV !== "production") warn("APP_ENV/NODE_ENV is not production in the current environment.");
  else pass("Production environment marker is set.");

  if (env.ALLOW_LOCAL_AUTH === "true" || env.VITE_LOCAL_AUTH === "true") {
    fail("Local login is enabled. Set ALLOW_LOCAL_AUTH=false and VITE_LOCAL_AUTH=false before public deployment.");
  } else {
    pass("Local login is disabled.");
  }

  if ((env.DATA_PROVIDER || env.DB_PROVIDER) !== "supabase") {
    fail("Production database provider should be supabase.");
  } else {
    pass("Server database provider is Supabase.");
  }

  if ((env.VITE_DATA_PROVIDER || env.VITE_DB_PROVIDER) !== "supabase") {
    fail("Frontend data provider should be supabase.");
  } else {
    pass("Frontend data provider is Supabase.");
  }

  if (!env.APP_URL || !String(env.APP_URL).startsWith("https://")) {
    fail("APP_URL must be the final HTTPS domain.");
  } else {
    pass(`APP_URL is HTTPS (${env.APP_URL})`);
  }

  if (!env.STORE_WEBHOOK_SECRET || env.STORE_WEBHOOK_SECRET.length < 32) {
    fail("STORE_WEBHOOK_SECRET is missing or too short.");
  } else {
    pass(`STORE_WEBHOOK_SECRET is strong-looking (${masked(env.STORE_WEBHOOK_SECRET)})`);
  }

  if (!env.SALLA_APP_WEBHOOK_SECRET && !env.STORE_WEBHOOK_SECRET) {
    fail("Salla app webhook secret is missing.");
  } else {
    pass("Salla app webhook secret fallback is configured.");
  }

  if (!env.SUPABASE_SERVICE_ROLE_KEY && !env.SUPABASE_SERVICE_KEY) {
    fail("Supabase service role key is missing.");
  } else {
    pass("Supabase service role key is present in server environment.");
  }

  if (env.WHATSAPP_PROVIDER !== "cloud_api") {
    warn("WHATSAPP_PROVIDER is not cloud_api. WhatsApp Web requires a persistent VPS and protected session volume.");
  } else {
    pass("WhatsApp Cloud API mode is selected.");
  }

  const outboundMode = env.OUTBOUND_MODE || "dry_run";
  if (outboundMode === "production" && env.OFFICIAL_LAUNCH_APPROVED !== "true") {
    fail("Outbound production mode is blocked without OFFICIAL_LAUNCH_APPROVED=true.");
  } else if (outboundMode === "production") {
    pass("Outbound production mode is explicitly approved.");
  } else if (outboundMode === "code") {
    if (!env.OUTBOUND_CONFIRM_CODE) fail("OUTBOUND_MODE=code requires OUTBOUND_CONFIRM_CODE.");
    else pass("Outbound requires a per-send confirmation code.");
  } else if (outboundMode === "allowlist") {
    if (!env.OUTBOUND_TEST_PHONE_ALLOWLIST) fail("OUTBOUND_MODE=allowlist requires OUTBOUND_TEST_PHONE_ALLOWLIST.");
    else pass("Outbound is restricted to the test phone allowlist.");
  } else {
    pass("Outbound is in dry_run mode; real customer messages are blocked.");
  }
}

function checkDocker() {
  const dockerfile = fileText(join(root, "Dockerfile"));
  if (!dockerfile) {
    fail("Dockerfile is missing.");
    return;
  }
  if (/USER\s+node/i.test(dockerfile)) pass("Dockerfile runs as non-root node user.");
  else fail("Dockerfile should run the app as a non-root user.");

  if (/HEALTHCHECK/i.test(dockerfile)) pass("Dockerfile has a healthcheck.");
  else warn("Dockerfile has no healthcheck.");

  const dockerignore = fileText(join(root, ".dockerignore"));
  for (const entry of [".env", ".env.*", ".wa-session", "service-account*.json", "*.log"]) {
    if (dockerignore.includes(entry)) pass(`.dockerignore excludes ${entry}`);
    else fail(`.dockerignore should exclude ${entry}`);
  }
}

function checkSecretLeakage() {
  const patterns = [
    { name: "Telegram bot token", regex: /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/ },
    { name: "Firebase private key", regex: /-----BEGIN PRIVATE KEY-----/ },
    { name: "Supabase service role JWT", regex: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/ },
    { name: "Long API-like secret", regex: /\b(?:sk|sb_secret|sb_service|xoxb|ghp)_[A-Za-z0-9_-]{20,}\b/ },
  ];

  let leaks = 0;
  for (const file of walk(root)) {
    const rel = relative(root, file).replace(/\\/g, "/");
    const base = rel.split("/").pop() || "";
    if (rel === "scripts/security-audit.mjs") continue;
    if (allowedSecretFiles.has(base)) continue;
    if (!sourceExtensions.has(extensionOf(file))) continue;
    const text = fileText(file);
    for (const pattern of patterns) {
      if (pattern.regex.test(text)) {
        leaks += 1;
        fail(`${pattern.name} appears in ${rel}`);
      }
    }
  }

  if (!leaks) pass("No obvious secrets found in source/config files outside local env files.");
}

async function checkRunningHeaders() {
  const base = env.APP_HEALTHCHECK_URL || "http://localhost:3000";
  try {
    const response = await fetch(`${base.replace(/\/+$/, "")}/api/health`);
    if (!response.ok) {
      warn(`Health endpoint returned ${response.status}; skipped header verification.`);
      return;
    }
    const required = [
      "x-content-type-options",
      "referrer-policy",
      "x-frame-options",
      "permissions-policy",
    ];
    for (const header of required) {
      if (response.headers.get(header)) pass(`Security header present: ${header}`);
      else fail(`Security header missing: ${header}`);
    }
  } catch (error) {
    warn(`Could not reach local health endpoint: ${error.message}`);
  }
}

function print() {
  for (const item of findings) console.log(`${item.level} ${item.message}`);
  const failed = findings.filter((item) => item.level === "FAIL");
  const warned = findings.filter((item) => item.level === "WARN");
  console.log("");
  if (failed.length) {
    console.error(`Security audit failed: ${failed.length} blocking issue(s), ${warned.length} warning(s).`);
    process.exitCode = 1;
  } else {
    console.log(`Security audit passed with ${warned.length} warning(s).`);
  }
}

checkEnv();
checkDocker();
checkSecretLeakage();
await checkRunningHeaders();
print();
