#!/usr/bin/env node
/**
 * Parse commercial-release-checklist.md and emit a per-section breakdown.
 * Run: node scripts/supervisor-checklist-stats.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const md = readFileSync(resolve(repoRoot, "docs/commercial-release-checklist.md"), "utf8");

const sectionRe = /^##\s+(\d+)\.\s+(.+)$/gm;
const sections = [];
let m;
while ((m = sectionRe.exec(md)) !== null) {
  sections.push({ num: m[1], title: m[2].trim(), start: m.index, end: md.length, items: [] });
}
for (let i = 0; i < sections.length - 1; i++) sections[i].end = sections[i + 1].start;

const rowRe = /^\|\s*(\d+\.\d+)\s*(🔒)?\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|/gm;

for (const s of sections) {
  const block = md.slice(s.start, s.end);
  let r;
  rowRe.lastIndex = 0;
  while ((r = rowRe.exec(block)) !== null) {
    const status = r[4].includes("✓") ? "done" : r[4].includes("◐") ? "in-progress" : r[4].includes("✗") ? "todo" : "unknown";
    s.items.push({ id: r[1], hardGate: Boolean(r[2]), title: r[3], status, owner: (r[5] || "").trim() });
  }
}

const overall = { total: 0, done: 0, inProgress: 0, todo: 0, hardGateRemaining: 0 };
console.log("\n=== Release checklist by section ===\n");
for (const s of sections) {
  const c = { total: s.items.length, done: 0, inProgress: 0, todo: 0, hardGateRemaining: 0 };
  for (const it of s.items) {
    if (it.status === "done") c.done++;
    else if (it.status === "in-progress") c.inProgress++;
    else if (it.status === "todo") c.todo++;
    if (it.hardGate && it.status !== "done") c.hardGateRemaining++;
  }
  overall.total += c.total;
  overall.done += c.done;
  overall.inProgress += c.inProgress;
  overall.todo += c.todo;
  overall.hardGateRemaining += c.hardGateRemaining;
  const pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
  console.log(`${s.num}. ${s.title.padEnd(28)} ${c.done}/${c.total} done  (${pct}%)  in-prog=${c.inProgress}  todo=${c.todo}  hard-gate=${c.hardGateRemaining}`);
}
const pct = overall.total ? Math.round((overall.done / overall.total) * 100) : 0;
console.log("");
console.log(`TOTAL: ${overall.done}/${overall.total} done (${pct}%) — hard-gate remaining: ${overall.hardGateRemaining}\n`);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ overall, sections }, null, 2));
}

// Owner breakdown
const byOwner = {};
for (const s of sections) for (const it of s.items) {
  const o = it.owner || "unassigned";
  byOwner[o] = byOwner[o] || { total: 0, done: 0, todo: 0 };
  byOwner[o].total++;
  if (it.status === "done") byOwner[o].done++;
  else byOwner[o].todo++;
}
console.log("=== By owner ===");
for (const [owner, c] of Object.entries(byOwner).sort()) {
  console.log(`  ${owner.padEnd(20)} ${c.done}/${c.total} done, ${c.todo} todo`);
}
console.log("");
