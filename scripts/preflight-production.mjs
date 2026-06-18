import { spawnSync } from "node:child_process";

const env = { ...process.env, ENV_FILE: ".env.production", APP_HEALTHCHECK_URL: process.env.APP_HEALTHCHECK_URL || "http://localhost:3000" };

const commands = [
  ["node", ["scripts/doctor.mjs", "--production"]],
  ["node", ["scripts/supabase-verify.mjs"]],
  ["node", ["scripts/security-audit.mjs"]],
  ["npm", ["run", "lint"]],
  ["npm", ["run", "build"]],
  ["npm", ["run", "test:smoke"]],
];

for (const [command, args] of commands) {
  console.log(`\n> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    env,
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

