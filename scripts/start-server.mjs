import { accessSync, constants } from "node:fs";
import { spawn } from "node:child_process";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveServerMode, serverEnvironment } from "./lib/server-mode.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = resolveServerMode(process.argv.slice(2));
const environment = serverEnvironment(mode);
const envFile = path.isAbsolute(environment.ENV_FILE)
  ? environment.ENV_FILE
  : path.join(root, environment.ENV_FILE);
dotenv.config({ path: envFile, processEnv: environment, quiet: true });

if (mode === "production") {
  try {
    accessSync(path.join(root, "dist", "index.html"), constants.R_OK);
    accessSync(path.join(root, "dist-server", "server.mjs"), constants.R_OK);
  } catch {
    console.error("Production build is missing. Run `npm run build` before `npm start`.");
    process.exit(1);
  }
}

const serverArgs = mode === "development"
  ? ["--import", "tsx", "server.ts"]
  : [path.join("dist-server", "server.mjs")];
const child = spawn(process.execPath, serverArgs, {
  cwd: root,
  env: environment,
  stdio: "inherit",
  windowsHide: true,
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  console.error(`Server failed to start: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
