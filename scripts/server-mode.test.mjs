import assert from "node:assert/strict";
import test from "node:test";
import { resolveServerMode, serverEnvironment } from "./lib/server-mode.mjs";

test("start defaults to production", () => {
  assert.equal(resolveServerMode([]), "production");
  const env = serverEnvironment("production", {});
  assert.equal(env.NODE_ENV, "production");
  assert.equal(env.ENABLE_VITE_DEV_SERVER, "false");
  assert.equal(env.ENV_FILE, ".env.production");
});

test("development requires the explicit --dev flag", () => {
  assert.equal(resolveServerMode(["--dev"]), "development");
  const env = serverEnvironment("development", {});
  assert.equal(env.NODE_ENV, "development");
  assert.equal(env.ENABLE_VITE_DEV_SERVER, "true");
  assert.equal(env.ENV_FILE, ".env");
});

test("an explicit environment file is preserved", () => {
  assert.equal(serverEnvironment("production", { ENV_FILE: "custom.env" }).ENV_FILE, "custom.env");
});
