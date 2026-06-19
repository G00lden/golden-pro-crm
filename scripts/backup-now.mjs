import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { copyFile, cp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { readProjectEnv, root } from "./env-utils.mjs";

const env = readProjectEnv();
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const backupName = `breexe-pro-backup-${stamp}`;
const runtimeRoot = path.join(root, ".runtime", "backups");
const stagingDir = path.join(runtimeRoot, "staging", backupName);
const archivePath = path.join(runtimeRoot, `${backupName}.zip`);
const report = {
  backup: backupName,
  archive: archivePath,
  targets: [],
  skipped: [],
  warnings: [],
};

function bool(name, fallback = false) {
  const value = env[name];
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function commandExists(command) {
  const result = spawnSync(command, ["--version"], { cwd: root, stdio: "ignore", shell: false });
  return result.status === 0;
}

function safeEnvSnapshot() {
  const keys = [
    "APP_ENV",
    "NODE_ENV",
    "PORT",
    "APP_URL",
    "DATA_PROVIDER",
    "DB_PROVIDER",
    "VITE_DATA_PROVIDER",
    "VITE_DB_PROVIDER",
    "SALLA_AUTH_MODE",
    "SALLA_SYNC_CRON_ENABLED",
    "SALLA_SYNC_CRON_SCHEDULE",
    "WHATSAPP_PROVIDER",
    "OUTBOUND_MODE",
    "OFFICIAL_LAUNCH_APPROVED",
  ];
  return Object.fromEntries(keys.map((key) => [key, env[key] || ""]));
}

async function copyIfExists(from, to) {
  if (!existsSync(from)) return false;
  const stat = statSync(from);
  if (stat.isDirectory()) await cp(from, to, { recursive: true, force: true });
  else {
    mkdirSync(path.dirname(to), { recursive: true });
    await copyFile(from, to);
  }
  return true;
}

async function backupSqliteDatabase() {
  const dbPath = env.DB_PATH
    ? path.resolve(root, env.DB_PATH)
    : path.join(root, "data", "golden-crm.db");
  if (!existsSync(dbPath)) return false;
  try {
    const { default: Database } = await import("better-sqlite3");
    mkdirSync(path.join(stagingDir, "data"), { recursive: true });
    const source = new Database(dbPath, { readonly: true, fileMustExist: true });
    await source.backup(path.join(stagingDir, "data", path.basename(dbPath)));
    source.close();
    return true;
  } catch (error) {
    report.warnings.push(`SQLite online backup failed, copied data directory instead: ${error.message}`);
    return false;
  }
}

function gitRemoteRepo() {
  const explicit = env.BACKUP_GITHUB_REPO;
  if (explicit) return explicit;
  try {
    const remote = run("git", ["config", "--get", "remote.origin.url"]);
    const match = remote.match(/github\.com[:/](.+?)(?:\.git)?$/i);
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

async function writeManifest() {
  const git = {};
  for (const [key, args] of Object.entries({
    branch: ["rev-parse", "--abbrev-ref", "HEAD"],
    commit: ["rev-parse", "HEAD"],
    status: ["status", "--short"],
  })) {
    try {
      git[key] = run("git", args);
    } catch (error) {
      git[key] = `unavailable: ${error.message}`;
    }
  }

  const manifest = {
    app: "Breexe Pro CRM",
    created_at: new Date().toISOString(),
    machine: os.hostname(),
    node: process.version,
    git,
    env: safeEnvSnapshot(),
    contents: {
      data: existsSync(path.join(stagingDir, "data")),
      runtime_salla_integrations: existsSync(path.join(stagingDir, ".runtime", "salla-integrations.json")),
      repo_bundle: existsSync(path.join(stagingDir, "repo.bundle")),
      env_files: bool("BACKUP_INCLUDE_ENV"),
      wa_session: bool("BACKUP_INCLUDE_WA_SESSION"),
    },
  };
  await writeFile(path.join(stagingDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  await writeFile(path.join(stagingDir, "git-status.txt"), git.status || "", "utf8");
}

async function createArchive() {
  mkdirSync(runtimeRoot, { recursive: true });
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });

  await copyIfExists(path.join(root, "data"), path.join(stagingDir, "data"));
  await backupSqliteDatabase();
  await copyIfExists(
    path.join(root, ".runtime", "salla-integrations.json"),
    path.join(stagingDir, ".runtime", "salla-integrations.json"),
  );

  if (bool("BACKUP_INCLUDE_WA_SESSION")) {
    await copyIfExists(path.join(root, env.WA_SESSION_DIR || ".wa-session"), path.join(stagingDir, ".wa-session"));
  }
  if (bool("BACKUP_INCLUDE_ENV")) {
    for (const file of [".env", ".env.production"]) {
      await copyIfExists(path.join(root, file), path.join(stagingDir, "env", file));
    }
  }

  try {
    run("git", ["bundle", "create", path.join(stagingDir, "repo.bundle"), "--all"]);
  } catch (error) {
    report.warnings.push(`Git bundle skipped: ${error.message}`);
  }

  await writeManifest();
  rmSync(archivePath, { force: true });
  run("powershell", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `Compress-Archive -Path '${path.join(stagingDir, "*").replace(/'/g, "''")}' -DestinationPath '${archivePath.replace(/'/g, "''")}' -Force`,
  ]);
  return archivePath;
}

async function copyLocalTargets(zipPath) {
  const targets = new Set();
  targets.add(path.dirname(zipPath));
  if (env.BACKUP_LOCAL_DIR) targets.add(path.resolve(root, env.BACKUP_LOCAL_DIR));
  if (bool("BACKUP_DESKTOP_ENABLED", true)) targets.add(path.join(os.homedir(), "Desktop", "Breexe-Pro-Backups"));

  for (const dir of targets) {
    mkdirSync(dir, { recursive: true });
    const target = path.join(dir, path.basename(zipPath));
    if (path.resolve(target) !== path.resolve(zipPath)) await copyFile(zipPath, target);
    report.targets.push({ type: "local", path: target });
  }
}

async function sendTelegram(zipPath) {
  if (!bool("BACKUP_TELEGRAM_ENABLED")) {
    report.skipped.push({ type: "telegram", reason: "BACKUP_TELEGRAM_ENABLED is false" });
    return;
  }
  const token = env.BACKUP_TELEGRAM_BOT_TOKEN;
  const chatId = env.BACKUP_TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    report.skipped.push({ type: "telegram", reason: "bot token or chat id missing" });
    return;
  }

  const form = new FormData();
  form.set("chat_id", chatId);
  form.set("caption", `Breexe Pro CRM backup ${backupName}`);
  const bytes = await readFile(zipPath);
  form.set("document", new Blob([bytes], { type: "application/zip" }), path.basename(zipPath));
  const response = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
    method: "POST",
    body: form,
  });
  if (!response.ok) {
    throw new Error(`Telegram upload failed: HTTP ${response.status} ${await response.text()}`);
  }
  report.targets.push({ type: "telegram", chat_id: chatId });
}

function uploadGoogleDrive(zipPath) {
  if (!bool("BACKUP_GOOGLE_DRIVE_ENABLED")) {
    report.skipped.push({ type: "google_drive", reason: "BACKUP_GOOGLE_DRIVE_ENABLED is false" });
    return;
  }
  if (!commandExists("rclone")) {
    report.skipped.push({ type: "google_drive", reason: "rclone is not installed or not on PATH" });
    return;
  }
  const remote = env.BACKUP_GOOGLE_DRIVE_REMOTE || "gdrive:Breexe-Pro-Backups";
  run("rclone", ["copy", zipPath, remote]);
  report.targets.push({ type: "google_drive", remote });
}

function uploadGitHub(zipPath) {
  if (!bool("BACKUP_GITHUB_ENABLED")) {
    report.skipped.push({ type: "github", reason: "BACKUP_GITHUB_ENABLED is false" });
    return;
  }
  if (!commandExists("gh")) {
    report.skipped.push({ type: "github", reason: "GitHub CLI is not installed or not on PATH" });
    return;
  }
  const repo = gitRemoteRepo();
  if (!repo) {
    report.skipped.push({ type: "github", reason: "BACKUP_GITHUB_REPO or origin GitHub repo is missing" });
    return;
  }
  const tag = `backup-${stamp.toLowerCase().replace("z", "")}`;
  run("gh", [
    "release",
    "create",
    tag,
    zipPath,
    "--repo",
    repo,
    "--title",
    `Breexe Pro backup ${stamp}`,
    "--notes",
    "Automated Breexe Pro CRM backup archive.",
  ]);
  report.targets.push({ type: "github_release", repo, tag });
}

const archive = await createArchive();
await copyLocalTargets(archive);
try {
  await sendTelegram(archive);
} catch (error) {
  report.warnings.push(error.message);
}
try {
  uploadGoogleDrive(archive);
} catch (error) {
  report.warnings.push(error.message);
}
try {
  uploadGitHub(archive);
} catch (error) {
  report.warnings.push(error.message);
}

const hash = createHash("sha256").update(await readFile(archive)).digest("hex");
report.sha256 = hash;
console.log(JSON.stringify(report, null, 2));
