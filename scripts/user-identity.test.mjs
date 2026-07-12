import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("identity bootstrap and local accounts fail closed", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "breexe-identity-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/user-identity-case.ts"], {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: "test",
        DB_PATH: path.join(directory, "identity.db"),
        LOCAL_AUTH_SHARED_UID: "local-owner",
        BOOTSTRAP_ADMIN_EMAILS: "owner@example.com",
        ADMIN_UIDS: "firebase-admin-uid",
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /"roles":\["admin","user","user","admin","manager"\]/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
