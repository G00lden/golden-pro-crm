const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseReleaseVersion(version) {
  const match = VERSION_PATTERN.exec(String(version || ""));
  if (!match) {
    throw new Error(`Invalid release version "${version}". Expected MAJOR.MINOR.PATCH.`);
  }

  const [, majorText, minorText, patchText] = match;
  const major = Number(majorText);
  const minor = Number(minorText);
  const patch = Number(patchText);

  if (major < 1 || minor > 9 || patch > 9) {
    throw new Error(
      `Invalid release version "${version}". Major starts at 1; minor and patch must be between 0 and 9.`,
    );
  }

  return { major, minor, patch };
}

export function nextReleaseVersion(version) {
  const { major, minor, patch } = parseReleaseVersion(version);
  if (patch < 9) return `${major}.${minor}.${patch + 1}`;
  if (minor < 9) return `${major}.${minor + 1}.0`;
  return `${major + 1}.0.0`;
}

export function validateReleaseMetadata(release, packageVersion) {
  if (!release || typeof release !== "object") {
    throw new Error("release.json must contain an object.");
  }

  parseReleaseVersion(release.version);

  if (release.version !== packageVersion) {
    throw new Error(
      `Version mismatch: release.json is ${release.version}, package.json is ${packageVersion}.`,
    );
  }

  if (typeof release.name !== "string" || release.name.trim().length < 3) {
    throw new Error("Every release must have a descriptive name in release.json.");
  }

  if (!new Set(["development", "candidate", "stable"]).has(release.channel)) {
    throw new Error("release.json channel must be development, candidate, or stable.");
  }

  return true;
}
