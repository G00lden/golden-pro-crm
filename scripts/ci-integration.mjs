import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(path.join(os.tmpdir(), "breexe-ci-"));
const port = 3400 + (process.pid % 500);
const appUrl = `http://127.0.0.1:${port}`;
const sharedEnv = {
  ...process.env,
  PORT: String(port),
  APP_URL: appUrl,
  DB_PATH: path.join(directory, "ci.db"),
  DATA_PROVIDER: "sqlite",
  DB_PROVIDER: "sqlite",
  ALLOW_LOCAL_AUTH: "true",
  LOCAL_AUTH_SHARED_UID: "ci-owner",
  LOCAL_AUTH_TOKEN: "ci-integration-secret-with-at-least-32-characters",
  GOLDEN_PATH_UID: "ci-owner",
  SMOKE_TEST_UID: "ci-owner",
  DISABLE_OUTBOUND: "true",
  DISABLE_HMR: "true",
};

const server = spawn(process.execPath, ["scripts/start-server.mjs", "--dev"], {
  cwd: root,
  env: sharedEnv,
  stdio: ["ignore", "pipe", "pipe"],
  shell: false,
  windowsHide: true,
});

let serverOutput = "";
server.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
server.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${appUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // retry while the process initializes
    }
    if (server.exitCode !== null) throw new Error(`Test server exited early.\n${serverOutput}`);
    await delay(250);
  }
  throw new Error(`Test server did not become healthy.\n${serverOutput}`);
}

async function run(script) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: root,
      env: sharedEnv,
      stdio: "inherit",
      shell: false,
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${script} failed with exit code ${code}`)));
  });
}

try {
  await waitForServer();
  await run("scripts/smoke.mjs");
  await run("scripts/golden-path.mjs");
  console.log(`CI integration passed against ${appUrl}`);
} finally {
  if (process.platform === "win32" && server.pid) {
    spawnSync("taskkill.exe", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    server.kill("SIGTERM");
  }
  await Promise.race([new Promise((resolve) => server.once("exit", resolve)), delay(3000)]);
  rmSync(directory, { recursive: true, force: true });
}
