import assert from "node:assert/strict";
import test from "node:test";
import {
  createSignedLocalToken,
  getLocalAuthPolicy,
  isAllowedLocalRequest,
  verifySignedLocalToken,
} from "./localAuthPolicy";

const secret = "test-only-secret-with-at-least-32-characters";

test("local authentication is disabled unless explicitly requested", () => {
  assert.equal(getLocalAuthPolicy({ NODE_ENV: "development" }).enabled, false);
});

test("local authentication is always disabled in production", () => {
  const policy = getLocalAuthPolicy({ NODE_ENV: "production", ALLOW_LOCAL_AUTH: "true", LOCAL_AUTH_TOKEN: secret });
  assert.equal(policy.enabled, false);
  assert.match(policy.reason || "", /forbidden/i);
});

test("local authentication requires a strong server-only secret", () => {
  const policy = getLocalAuthPolicy({ NODE_ENV: "development", ALLOW_LOCAL_AUTH: "true", LOCAL_AUTH_TOKEN: "short" });
  assert.equal(policy.enabled, false);
  assert.match(policy.reason || "", /32/);
});

test("request must use an allowlisted host and a loopback connection", () => {
  const policy = getLocalAuthPolicy({ NODE_ENV: "test", ALLOW_LOCAL_AUTH: "true", LOCAL_AUTH_TOKEN: secret });
  assert.equal(isAllowedLocalRequest("localhost", "127.0.0.1", policy), true);
  assert.equal(isAllowedLocalRequest("crm.breexe-pro.com", "127.0.0.1", policy), false);
  assert.equal(isAllowedLocalRequest("localhost", "192.168.1.10", policy), false);
});

test("signed local tokens expire and reject tampering", () => {
  const now = Date.UTC(2026, 6, 12);
  const token = createSignedLocalToken("qa-owner", secret, now);
  assert.equal(verifySignedLocalToken(token, secret, now), "qa-owner");
  assert.equal(verifySignedLocalToken(token.replace("qa-owner", "qa-admin"), secret, now), null);
  assert.equal(verifySignedLocalToken(token, secret, now + 16 * 60 * 1000), null);
});
