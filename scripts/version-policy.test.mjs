import assert from "node:assert/strict";
import test from "node:test";
import {
  nextReleaseVersion,
  parseReleaseVersion,
  validateReleaseMetadata,
} from "./lib/version-policy.mjs";

test("parses the first supported release", () => {
  assert.deepEqual(parseReleaseVersion("1.0.0"), { major: 1, minor: 0, patch: 0 });
});

test("increments patch releases from 1.0.0 through 1.0.9", () => {
  assert.equal(nextReleaseVersion("1.0.0"), "1.0.1");
  assert.equal(nextReleaseVersion("1.0.8"), "1.0.9");
});

test("rolls 1.0.9 to 1.1.0 and 1.9.9 to 2.0.0", () => {
  assert.equal(nextReleaseVersion("1.0.9"), "1.1.0");
  assert.equal(nextReleaseVersion("1.9.9"), "2.0.0");
});

test("rejects skipped two-digit minor and patch components", () => {
  assert.throws(() => parseReleaseVersion("1.10.0"));
  assert.throws(() => parseReleaseVersion("1.0.10"));
});

test("requires package version, release name, and channel to match policy", () => {
  assert.equal(
    validateReleaseMetadata(
      { version: "1.0.0", name: "الأساس الآمن", channel: "stable" },
      "1.0.0",
    ),
    true,
  );
  assert.throws(() =>
    validateReleaseMetadata(
      { version: "1.0.0", name: "الأساس الآمن", channel: "stable" },
      "1.0.1",
    ),
  );
});
