import assert from "node:assert/strict";
import test from "node:test";
import { requestClientIp, TRUSTED_CLIENT_IP_HEADER } from "./clientIp";

function request(headers: Record<string, string>, remoteAddress = "203.0.113.10") {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    get: (name: string) => normalized[name.toLowerCase()],
    socket: { remoteAddress },
  };
}

test("direct requests cannot spoof their rate-limit identity", () => {
  const req = request({
    [TRUSTED_CLIENT_IP_HEADER]: "198.51.100.99",
    "cf-connecting-ip": "198.51.100.98",
    "x-real-ip": "198.51.100.97",
    "x-forwarded-for": "198.51.100.96",
  });
  assert.equal(requestClientIp(req, false), "203.0.113.10");
});

test("the bundled proxy may provide one validated internal client address", () => {
  const req = request({ [TRUSTED_CLIENT_IP_HEADER]: "2001:db8::42" }, "172.20.0.3");
  assert.equal(requestClientIp(req, true), "2001:db8::42");
});

test("malformed internal proxy values fall back to the socket peer", () => {
  const req = request({ [TRUSTED_CLIENT_IP_HEADER]: "1.2.3.4, 5.6.7.8" }, "172.20.0.3");
  assert.equal(requestClientIp(req, true), "172.20.0.3");
});
