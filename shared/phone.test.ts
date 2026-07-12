import assert from "node:assert/strict";
import test from "node:test";
import { normalizePhone, normalizePhoneDigits, phonesMatch, requirePhoneDigits } from "./phone";

test("normalizes Saudi local mobile formats to international digits", () => {
  assert.equal(normalizePhoneDigits("050 123 4567"), "966501234567");
  assert.equal(normalizePhoneDigits("501234567"), "966501234567");
  assert.equal(normalizePhoneDigits("00966 50 123 4567"), "966501234567");
});

test("preserves genuine international numbers and exposes E.164", () => {
  const phone = normalizePhone("+1 (202) 555-0198");
  assert.equal(phone.digits, "12025550198");
  assert.equal(phone.e164, "+12025550198");
  assert.equal(phone.valid, true);
});

test("rejects malformed outbound phones while retaining compatibility tail", () => {
  const phone = normalizePhone("123");
  assert.equal(phone.valid, false);
  assert.equal(phone.tail, "123");
  assert.throws(() => requirePhoneDigits("123"), /Invalid phone number/);
});

test("matches legacy and international storage forms by the last nine digits", () => {
  assert.equal(phonesMatch("0501234567", "+966501234567"), true);
  assert.equal(phonesMatch("0501234567", "+966509999999"), false);
});
