import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");
const appSource = read("../App.tsx");
const apiSource = read("../api.ts");
const billingSource = read("./BillingWorkspace.tsx");
const invoicesSource = read("./Invoices.tsx");
const quotesSource = read("./Quotes.tsx");
const stylesSource = read("../index.css");

test("sidebar exposes one billing destination while legacy quote URLs remain compatible", () => {
  assert.match(appSource, /label: "الفواتير والعروض"/);
  assert.doesNotMatch(appSource, /label: "عروض الأسعار", icon:/);
  assert.match(appSource, /if \(requested === "quotes"\) return "invoices"/);
  assert.match(appSource, /nextPage === "quotes" \? "quotes" : null/);
  assert.match(billingSource, /url\.searchParams\.get\("section"\) === "quotes"/);
  assert.match(billingSource, /window\.history\.replaceState\(\{\}, "", url\)/);
});

test("billing tabs are deep-linkable and keyboard operable in RTL", () => {
  assert.match(billingSource, /role="tablist"/);
  assert.match(billingSource, /role="tab"/);
  assert.match(billingSource, /aria-selected=\{location\.tab === id\}/);
  assert.match(billingSource, /tabIndex=\{location\.tab === id \? 0 : -1\}/);
  assert.match(billingSource, /getComputedStyle\(event\.currentTarget\)\.direction === "rtl"/);
  assert.match(billingSource, /url\.searchParams\.set\("billingTab", "quotes"\)/);
  assert.match(stylesSource, /\.billing-workspace-tabs\s*\{[\s\S]*?overflow-x:\s*auto/);
});

test("quote and invoice records keep reciprocal focusable links", () => {
  assert.match(quotesSource, /id=\{`quote-card-\$\{quote\.id\}`\}/);
  assert.match(quotesSource, /onOpenInvoice\?\.\(id\)/);
  assert.match(quotesSource, /quote\.invoice_id[\s\S]*?document-link-badge/);
  assert.match(invoicesSource, /id=\{`invoice-card-\$\{invoice\.id\}`\}/);
  assert.match(invoicesSource, /onOpenQuote\?\.\(invoice\.quote_id!\)/);
  assert.match(invoicesSource, /prefers-reduced-motion: reduce/);
  assert.match(quotesSource, /prefers-reduced-motion: reduce/);
});

test("local billing flow prevents duplicate or mutable quote-linked invoices", () => {
  assert.match(apiSource, /const existingInvoice = localDb\.invoices\.find\(/);
  assert.match(apiSource, /if \(existingInvoice\) return existingInvoice\.id/);
  assert.match(apiSource, /invoice\.idempotency_key = `quote:\$\{quote\.id\}`/);
  assert.match(apiSource, /if \(data\.quote_id\)[\s\S]*?أنشئ الفاتورة المرتبطة/);
  assert.match(apiSource, /assertQuoteMutable\(existing, localDb\.invoices\)/);
});
