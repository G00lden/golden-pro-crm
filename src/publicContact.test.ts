import test from "node:test";
import assert from "node:assert/strict";
import { buildPublicContactHref, normalizePublicContactPhone } from "./publicContact";

test("public contact normalization accepts explicit international numbers only", () => {
  assert.equal(normalizePublicContactPhone(" +966 55 123 4567 "), "+966551234567");
  assert.equal(normalizePublicContactPhone("00966551234567"), "+966551234567");
  assert.equal(normalizePublicContactPhone("966551234567"), "+966551234567");
  assert.equal(normalizePublicContactPhone("0551234567"), null);
  assert.equal(normalizePublicContactPhone(""), null);
  assert.equal(normalizePublicContactPhone("not-a-phone"), null);
});

test("public contact links do not invent a fallback number", () => {
  assert.equal(buildPublicContactHref("call", undefined), null);
  assert.equal(buildPublicContactHref("whatsapp", "0551234567"), null);
  assert.equal(buildPublicContactHref("call", "+966551234567"), "tel:+966551234567");
  assert.equal(
    buildPublicContactHref("whatsapp", "+966551234567", "مرحبا"),
    "https://wa.me/966551234567?text=%D9%85%D8%B1%D8%AD%D8%A8%D8%A7",
  );
});
