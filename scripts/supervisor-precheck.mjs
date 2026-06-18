#!/usr/bin/env node
/**
 * Supervisor pre-check.
 * Produces a structured snapshot the Supervisor agent reads at the start of
 * every session. Always exits 0 — the Supervisor decides what to do with the
 * findings.
 *
 * Run: node scripts/supervisor-precheck.mjs
 * Or:  npm run supervisor:precheck
 */
import { execSync, spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const now = new Date().toISOString();

function sh(cmd, opts = {}) {
  try {
    return execSync(cmd, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
  } catch (err) {
    return { error: true, stderr: String(err.stderr || err.message || err).trim(), stdout: String(err.stdout || "").trim() };
  }
}

function shTry(cmd) {
  const r = spawnSync(cmd, { cwd: repoRoot, shell: true, encoding: "utf8" });
  return { code: r.status ?? -1, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

// 1. Git state
const branch = sh("git rev-parse --abbrev-ref HEAD");
const head = sh("git rev-parse --short HEAD");
const dirty = sh("git status --porcelain");
const aheadBehind = sh("git rev-list --left-right --count origin/main...HEAD") || "0\t0";
const [behind = "?", ahead = "?"] = aheadBehind.split("\t");
const recentCommits = sh("git log --oneline -10");

// 2. Lint + build (gated by --skip-lint/--skip-build for fast runs)
const skipLint = process.argv.includes("--skip-lint");
const skipBuild = process.argv.includes("--skip-build");
const lint = skipLint ? { code: 0, skipped: true } : shTry("npm run lint --silent");
const build = skipBuild ? { code: 0, skipped: true } : { code: 0, skipped: true, note: "run with --build to enable; build is slow" };

// 3. Secret scan (lightweight; gitleaks not required)
// Allow-list: known-safe matches that are NOT real secrets.
// - Public Firebase Web API keys are documented-safe by Firebase itself.
// - The security-audit script *defines* the detection regexes — it's not a leak.
const secretAllowlist = new Set([
  "firebase-applet-config.json",
  "scripts/security-audit.mjs",
]);
const secretPatterns = [
  { name: "GitHub PAT", re: /\bghp_[A-Za-z0-9]{20,}\b/ },
  { name: "OpenAI key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "Google API key", re: /\bAIza[A-Za-z0-9_-]{20,}\b/ },
  { name: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "Private key block", re: /-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/ },
];
const tracked = sh("git ls-files");
const secretHits = [];
if (typeof tracked === "string") {
  for (const file of tracked.split(/\r?\n/)) {
    if (!file || /\.(png|jpg|jpeg|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf)$/i.test(file)) continue;
    if (secretAllowlist.has(file.replace(/\\/g, "/"))) continue;
    const full = resolve(repoRoot, file);
    if (!existsSync(full)) continue;
    let content;
    try { content = readFileSync(full, "utf8"); } catch { continue; }
    for (const { name, re } of secretPatterns) {
      if (re.test(content)) secretHits.push({ file, kind: name });
    }
  }
}

// 4. npm audit summary (production only)
const audit = shTry("npm audit --omit=dev --json");
let auditSummary = { error: audit.code !== 0 && !audit.stdout, raw: audit.stdout.slice(0, 200) };
try {
  const parsed = JSON.parse(audit.stdout || "{}");
  const m = parsed.metadata?.vulnerabilities || {};
  auditSummary = { critical: m.critical || 0, high: m.high || 0, moderate: m.moderate || 0, low: m.low || 0, info: m.info || 0, total: m.total || 0 };
} catch { /* keep error shape */ }

// 5. Dev server health (best-effort; non-fatal)
let health = { reachable: false };
try {
  const r = shTry("curl -sS --max-time 2 http://localhost:3000/api/health");
  if (r.code === 0 && r.stdout) {
    const j = JSON.parse(r.stdout);
    health = { reachable: true, status: j.status, remindersEnabled: j.reminders?.enabled, webhookConfigured: j.storeWebhook?.configured, outboundMode: j.outbound?.mode };
  }
} catch { /* leave reachable:false */ }

// 6. Checklist progress (counts from commercial-release-checklist.md)
// Use the same row regex as supervisor-checklist-stats.mjs for consistency.
let checklist = { total: 0, done: 0, inProgress: 0, todo: 0, hardGateRemaining: 0 };
try {
  const md = readFileSync(resolve(repoRoot, "docs/commercial-release-checklist.md"), "utf8");
  const rowRe = /^\|\s*(\d+\.\d+)\s*(\S+)?\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|/gm;
  let r;
  while ((r = rowRe.exec(md)) !== null) {
    checklist.total++;
    const status = r[4] || "";
    const isHardGate = (r[2] || "").includes("🔒");
    if (status.includes("✓")) checklist.done++;
    else if (status.includes("◐")) checklist.inProgress++;
    else if (status.includes("✗")) checklist.todo++;
    if (isHardGate && !status.includes("✓")) checklist.hardGateRemaining++;
  }
} catch { /* file missing */ }

// 7. Open PRs (best effort)
const prs = shTry("gh pr list --state open --json number,title,author,headRefName 2>NUL");
let openPRs = [];
try { openPRs = JSON.parse(prs.stdout || "[]"); } catch {}

// ---- Report ----
const report = {
  generatedAt: now,
  repo: { branch, head, dirtyFiles: dirty ? dirty.split(/\r?\n/).length : 0, ahead: Number(ahead), behind: Number(behind), recentCommits: recentCommits.split(/\r?\n/) },
  lint: lint.skipped ? { skipped: true } : { passed: lint.code === 0, stderrTail: lint.stderr.split("\n").slice(-5).join("\n") },
  build: build,
  secrets: { matches: secretHits, clean: secretHits.length === 0 },
  npmAudit: auditSummary,
  devServer: health,
  checklist,
  openPRs,
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const c = (s) => s; // no color for cmd.exe
  const ok = (b) => (b ? "✓" : "✗");
  console.log(`\n=== Supervisor pre-check @ ${now} ===\n`);
  console.log(`Branch: ${branch} @ ${head}  (ahead ${ahead} / behind ${behind})  dirty=${report.repo.dirtyFiles}`);
  console.log(`Recent: ${report.repo.recentCommits[0] || "(no commits)"}`);
  console.log("");
  console.log(`Lint:        ${lint.skipped ? "skipped (--skip-lint)" : ok(lint.code === 0)}`);
  console.log(`Build:       ${build.skipped ? "skipped (default)" : ok(build.code === 0)}`);
  console.log(`Secrets:     ${ok(secretHits.length === 0)} (${secretHits.length} hits)`);
  if (secretHits.length) for (const h of secretHits) console.log(`             - ${h.kind} in ${h.file}`);
  if (auditSummary.error) console.log(`npm audit:   error (run "npm audit" manually)`);
  else console.log(`npm audit:   critical=${auditSummary.critical} high=${auditSummary.high} moderate=${auditSummary.moderate} low=${auditSummary.low}`);
  console.log(`Dev server:  ${health.reachable ? `up (status=${health.status})` : "down or unreachable"}`);
  console.log("");
  console.log(`Checklist:   ${checklist.done}/${checklist.total} done, ${checklist.inProgress} in-progress, ${checklist.todo} todo`);
  console.log(`             Hard-gate (🔒) remaining: ${checklist.hardGateRemaining}`);
  console.log(`Open PRs:    ${openPRs.length}`);
  if (openPRs.length) for (const p of openPRs) console.log(`             #${p.number} ${p.title} (${p.author?.login || "?"}) on ${p.headRefName}`);
  console.log("");
}
