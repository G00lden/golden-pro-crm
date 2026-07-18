import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const configureScript = join(scriptsDir, "configure-google-contacts-env.mjs");

function envValues(content) {
  return Object.fromEntries(content.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    return match ? [[match[1], match[2]]] : [];
  }));
}

test("configures Google Contacts without printing secrets and preserves the encryption key", () => {
  const directory = mkdtempSync(join(tmpdir(), "breexe-google-contacts-"));
  try {
    const envPath = join(directory, ".env.production");
    const credentialsPath = join(directory, "oauth-client.json");
    const redirectUri = "https://crm.breexe-pro.com/api/integrations/google-contacts/callback";
    writeFileSync(envPath, "APP_ENV=production\nUNRELATED_SETTING=preserved\n", "utf8");
    writeFileSync(credentialsPath, JSON.stringify({
      web: {
        client_id: "client-id.apps.googleusercontent.com",
        client_secret: "first-client-secret",
        redirect_uris: [redirectUri],
      },
    }), "utf8");

    const first = spawnSync(process.execPath, [configureScript, "--credentials", credentialsPath, "--env", envPath], {
      encoding: "utf8",
    });
    assert.equal(first.status, 0, first.stderr);
    assert.doesNotMatch(first.stdout, /first-client-secret|client-id\.apps/);
    const configured = envValues(readFileSync(envPath, "utf8"));
    assert.equal(configured.UNRELATED_SETTING, "preserved");
    assert.equal(configured.GOOGLE_CONTACTS_CLIENT_ID, "client-id.apps.googleusercontent.com");
    assert.equal(configured.GOOGLE_CONTACTS_CLIENT_SECRET, "first-client-secret");
    assert.equal(configured.GOOGLE_CONTACTS_REDIRECT_URI, redirectUri);
    assert.match(configured.GOOGLE_CONTACTS_ENCRYPTION_KEY, /^[a-f0-9]{64}$/);

    const encryptionKey = configured.GOOGLE_CONTACTS_ENCRYPTION_KEY;
    writeFileSync(credentialsPath, JSON.stringify({
      web: {
        client_id: "client-id.apps.googleusercontent.com",
        client_secret: "rotated-client-secret",
        redirect_uris: [redirectUri],
      },
    }), "utf8");
    const second = spawnSync(process.execPath, [configureScript, "--credentials", credentialsPath, "--env", envPath], {
      encoding: "utf8",
    });
    assert.equal(second.status, 0, second.stderr);
    const rotated = envValues(readFileSync(envPath, "utf8"));
    assert.equal(rotated.GOOGLE_CONTACTS_CLIENT_SECRET, "rotated-client-secret");
    assert.equal(rotated.GOOGLE_CONTACTS_ENCRYPTION_KEY, encryptionKey);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects desktop OAuth clients and unregistered callback URLs", () => {
  const directory = mkdtempSync(join(tmpdir(), "breexe-google-contacts-invalid-"));
  try {
    const envPath = join(directory, ".env.production");
    const credentialsPath = join(directory, "oauth-client.json");
    writeFileSync(envPath, "APP_ENV=production\n", "utf8");
    writeFileSync(credentialsPath, JSON.stringify({
      installed: { client_id: "desktop-client", client_secret: "desktop-secret" },
    }), "utf8");
    const desktop = spawnSync(process.execPath, [configureScript, "--credentials", credentialsPath, "--env", envPath], {
      encoding: "utf8",
    });
    assert.notEqual(desktop.status, 0);
    assert.match(desktop.stderr, /type Web application/);

    writeFileSync(credentialsPath, JSON.stringify({
      web: {
        client_id: "web-client",
        client_secret: "web-secret",
        redirect_uris: ["https://crm.example.com/different-callback"],
      },
    }), "utf8");
    const mismatch = spawnSync(process.execPath, [
      configureScript,
      "--credentials", credentialsPath,
      "--env", envPath,
      "--redirect-uri", "https://crm.breexe-pro.com/api/integrations/google-contacts/callback",
    ], { encoding: "utf8" });
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /must register this exact redirect URI/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
