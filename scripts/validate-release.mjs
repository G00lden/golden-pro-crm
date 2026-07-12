import { readFile } from "node:fs/promises";
import { validateReleaseMetadata } from "./lib/version-policy.mjs";

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
}

const release = await readJson("../release.json");
const packageJson = await readJson("../package.json");

validateReleaseMetadata(release, packageJson.version);
console.log(`Release metadata valid: ${release.version} — ${release.name} (${release.channel})`);
