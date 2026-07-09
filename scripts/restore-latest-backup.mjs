import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { cp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { execFileSync } from "node:child_process";
import { readProjectEnv, root } from "./env-utils.mjs";

const env = readProjectEnv();
const args = new Set(process.argv.slice(2));
const runtimeRoot = path.join(root, ".runtime", "backups");
const restoreRoot = path.join(runtimeRoot, "restore");
const preflightRoot = path.join(runtimeRoot, "pre-restore");
const report = {
  restored: [],
  skipped: [],
  warnings: [],
};

function bool(name, fallback = false) {
  const value = env[name];
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function run(command, commandArgs) {
  return execFileSync(command, commandArgs, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function backupDirs() {
  const dirs = new Set();
  dirs.add(runtimeRoot);
  if (env.BACKUP_LOCAL_DIR) dirs.add(path.resolve(root, env.BACKUP_LOCAL_DIR));
  dirs.add(path.join(os.homedir(), "Desktop", "Breexe-Pro-Backups"));
  return [...dirs].filter((dir) => existsSync(dir));
}

function latestArchive() {
  const explicit = process.argv.includes("--archive")
    ? process.argv[process.argv.indexOf("--archive") + 1]
    : "";
  if (explicit) {
    const resolved = path.resolve(root, explicit);
    if (!existsSync(resolved)) throw new Error(`Archive not found: ${resolved}`);
    return resolved;
  }

  const archives = [];
  for (const dir of backupDirs()) {
    for (const file of readdirSync(dir)) {
      if (!/^breexe-pro-backup-.+\.zip$/i.test(file)) continue;
      const full = path.join(dir, file);
      archives.push({ path: full, mtime: statSync(full).mtimeMs });
    }
  }
  archives.sort((a, b) => b.mtime - a.mtime);
  if (!archives.length) throw new Error("No Breexe Pro backup archive was found.");
  return archives[0].path;
}

async function confirmRestore(archive) {
  if (args.has("--yes") || process.env.RESTORE_CONFIRM === "YES") return;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`Restore data from ${archive}? Type RESTORE to continue: `);
  rl.close();
  if (answer !== "RESTORE") {
    throw new Error("Restore cancelled.");
  }
}

async function readManifest(extractDir) {
  const manifestPath = path.join(extractDir, "manifest.json");
  if (!existsSync(manifestPath)) return null;
  return JSON.parse(await readFile(manifestPath, "utf8"));
}

async function copyRestoredDir(from, to, label) {
  if (!existsSync(from)) {
    report.skipped.push({ type: label, reason: "not present in archive" });
    return;
  }
  if (existsSync(to)) {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const saveAs = path.join(preflightRoot, stamp, path.basename(to));
    mkdirSync(path.dirname(saveAs), { recursive: true });
    await cp(to, saveAs, { recursive: true, force: true });
    report.restored.push({ type: `${label}_pre_restore_copy`, path: saveAs });
  }
  rmSync(to, { recursive: true, force: true });
  await cp(from, to, { recursive: true, force: true });
  report.restored.push({ type: label, path: to });
}

async function restoreArchive(archive) {
  if (!args.has("--dry-run")) await confirmRestore(archive);
  mkdirSync(restoreRoot, { recursive: true });
  const extractDir = path.join(restoreRoot, path.basename(archive, ".zip"));
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });

  run("powershell", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`,
  ]);

  const manifest = await readManifest(extractDir);
  report.archive = archive;
  report.manifest = manifest ? {
    created_at: manifest.created_at,
    commit: manifest.git?.commit || "",
    branch: manifest.git?.branch || "",
  } : null;

  if (args.has("--dry-run")) {
    report.skipped.push({ type: "restore", reason: "dry run only" });
    report.available = {
      data: existsSync(path.join(extractDir, "data")),
      salla_integrations: existsSync(path.join(extractDir, ".runtime", "salla-integrations.json")),
      wa_session: existsSync(path.join(extractDir, ".wa-session")),
      env_files: existsSync(path.join(extractDir, "env")),
    };
    return;
  }

  await copyRestoredDir(path.join(extractDir, "data"), path.join(root, "data"), "data");

  const sallaFile = path.join(extractDir, ".runtime", "salla-integrations.json");
  if (existsSync(sallaFile)) {
    mkdirSync(path.join(root, ".runtime"), { recursive: true });
    await cp(sallaFile, path.join(root, ".runtime", "salla-integrations.json"), { force: true });
    report.restored.push({ type: "salla_integrations", path: path.join(root, ".runtime", "salla-integrations.json") });
  } else {
    report.skipped.push({ type: "salla_integrations", reason: "not present in archive" });
  }

  if (args.has("--include-wa-session") || bool("RESTORE_INCLUDE_WA_SESSION")) {
    await copyRestoredDir(path.join(extractDir, ".wa-session"), path.join(root, env.WA_SESSION_DIR || ".wa-session"), "wa_session");
  } else {
    report.skipped.push({ type: "wa_session", reason: "requires --include-wa-session" });
  }

  if (args.has("--include-env") || bool("RESTORE_INCLUDE_ENV")) {
    const envDir = path.join(extractDir, "env");
    if (existsSync(envDir)) {
      for (const file of readdirSync(envDir)) {
        if (![".env", ".env.production"].includes(file)) continue;
        await cp(path.join(envDir, file), path.join(root, file), { force: true });
        report.restored.push({ type: "env_file", path: path.join(root, file) });
      }
    } else {
      report.skipped.push({ type: "env_files", reason: "not present in archive" });
    }
  } else {
    report.skipped.push({ type: "env_files", reason: "requires --include-env" });
  }

  if (manifest?.git?.commit) {
    report.skipped.push({
      type: "code_checkout",
      reason: `data restored only; code commit in archive is ${manifest.git.commit}`,
    });
  }
}

await restoreArchive(latestArchive());
console.log(JSON.stringify(report, null, 2));
