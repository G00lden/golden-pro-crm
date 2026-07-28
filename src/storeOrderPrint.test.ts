import assert from "node:assert/strict";
import test from "node:test";
import { buildStoreOrderPrintHtml, escapePrintHtml } from "./storeOrderPrint";

test("packing list escapes customer and item fields while keeping order details", () => {
  const html = buildStoreOrderPrintHtml({
    id: "store-1",
    order_id: "1001",
    order_number: "S-1001",
    journey_status: "received",
    customer_name: `<img src=x onerror="alert(1)">`,
    customer_phone: "0500000000",
    customer_address: "الرياض، حي الاختبار",
    total: 150,
    items: [{
      name: "<script>bad()</script> فلتر",
      sku: "FILTER-1",
      quantity: 2,
      unit_price: 75,
      total_price: 150,
      order_type: "sale_only",
      status: "sale_recorded",
    }],
  });

  assert.match(html, /S-1001/);
  assert.match(html, /FILTER-1/);
  assert.match(html, /١٥٠/);
  assert.doesNotMatch(html, /<script>bad/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;script&gt;bad/);
});

test("HTML escaping covers markup and quote characters", () => {
  assert.equal(escapePrintHtml(`<a x='1' y="2">&`), "&lt;a x=&#39;1&#39; y=&quot;2&quot;&gt;&amp;");
});
