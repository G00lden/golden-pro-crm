import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type ReleaseInfo = {
  version: string;
  name: string;
  channel: "development" | "candidate" | "stable";
};

const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
const releasePath = path.resolve(serverDirectory, "..", "release.json");

export const releaseInfo = Object.freeze(
  JSON.parse(readFileSync(releasePath, "utf8")) as ReleaseInfo,
);

function gitShortSha() {
  if (process.env.BUILD_COMMIT?.trim()) return process.env.BUILD_COMMIT.trim();
  try {
    return execSync("git rev-parse --short HEAD", {
      cwd: path.resolve(serverDirectory, ".."),
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
  } catch {
    return "unknown";
  }
}

export const buildCommit = gitShortSha();
