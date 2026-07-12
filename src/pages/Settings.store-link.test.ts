import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { normalizeSallaStoreUrl } from "../sallaStoreUrl";

const settingsSource = readFileSync(new URL("./Settings.tsx", import.meta.url), "utf8");
const stylesSource = readFileSync(new URL("../index.css", import.meta.url), "utf8");

test("Salla store action is a semantic and safe external link", () => {
  assert.match(settingsSource, /<a[\s\S]*?className="btn muted store-link"[\s\S]*?href=\{storeUrl\}/);
  assert.match(settingsSource, /target="_blank"/);
  assert.match(settingsSource, /rel="noopener noreferrer"/);
  assert.match(settingsSource, /<ExternalLink[^>]*aria-hidden="true"[^>]*focusable="false"/);
  assert.match(settingsSource, /فتح صفحة المتجر/);
});

test("missing Salla store URL renders guidance instead of a disabled action", () => {
  assert.match(settingsSource, /storeUrl \? \([\s\S]*?\) : \([\s\S]*?className="store-link-empty"/);
  assert.match(settingsSource, /اربط متجر سلة أولاً/);
  assert.doesNotMatch(settingsSource, /store-link[^\n>]*disabled/);
});

test("Salla store link exposes hover and keyboard focus states", () => {
  assert.match(stylesSource, /\.store-link:hover\s*\{/);
  assert.match(stylesSource, /\.store-link:focus-visible\s*\{/);
  assert.match(stylesSource, /\.light-mode \.store-link:focus-visible\s*\{/);
  assert.match(stylesSource, /transition:\s*transform 160ms ease/);
  assert.match(stylesSource, /@media \(prefers-reduced-motion: reduce\)/);
});

test("Salla store URL normalization only permits credential-free HTTPS links", () => {
  assert.equal(normalizeSallaStoreUrl("store.example.com"), "https://store.example.com/");
  assert.equal(normalizeSallaStoreUrl("https://store.example.com/path"), "https://store.example.com/path");
  assert.equal(normalizeSallaStoreUrl("http://store.example.com"), null);
  assert.equal(normalizeSallaStoreUrl("javascript:alert(1)"), null);
  assert.equal(normalizeSallaStoreUrl("https://user:pass@store.example.com"), null);
  assert.equal(normalizeSallaStoreUrl(""), null);
});

test("Salla settings expose customer sync progress and include customers in the manual action", () => {
  assert.match(settingsSource, /مزامنة العملاء/);
  assert.match(settingsSource, /last_customer_sync_count/);
  assert.match(settingsSource, /last_customer_sync_complete/);
  assert.match(settingsSource, /last_customer_sync_error/);
  assert.match(settingsSource, /last_customer_sync_advertised_count/);
  assert.match(settingsSource, /last_customer_sync_warning/);
  assert.match(settingsSource, /role="status"/);
  assert.match(settingsSource, /tone="warn">فرق في عدّ سلة/);
  assert.match(settingsSource, /اكتملت المزامنة وسيُعاد التحقق تلقائيًا/);
  assert.match(settingsSource, /مزامنة العملاء والمنتجات والطلبات/);
});
