import type { StoreOrder } from "./api";

export function escapePrintHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function printableMoney(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${new Intl.NumberFormat("ar-SA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)} ر.س`;
}

function itemTotal(item: NonNullable<StoreOrder["items"]>[number]) {
  if (typeof item.total_price === "number" && Number.isFinite(item.total_price)) return item.total_price;
  if (typeof item.unit_price === "number" && Number.isFinite(item.unit_price)) {
    return item.unit_price * Math.max(1, Number(item.quantity || 1));
  }
  return null;
}

export function buildStoreOrderPrintHtml(order: StoreOrder, companyName = "BreeXe Pro") {
  const items = order.items || [];
  const total = typeof order.total === "number" && Number.isFinite(order.total)
    ? order.total
    : items.reduce((sum, item) => sum + (itemTotal(item) || 0), 0);
  const rows = items.length
    ? items.map((item, index) => `
      <tr>
        <td>${new Intl.NumberFormat("ar-SA").format(index + 1)}</td>
        <td>${escapePrintHtml(item.name || "-")}</td>
        <td dir="ltr">${escapePrintHtml(item.sku || "-")}</td>
        <td>${new Intl.NumberFormat("ar-SA").format(Math.max(1, Number(item.quantity || 1)))}</td>
        <td>${escapePrintHtml(printableMoney(item.unit_price))}</td>
        <td>${escapePrintHtml(printableMoney(itemTotal(item)))}</td>
      </tr>`).join("")
    : `<tr><td colspan="6">لا توجد بنود محفوظة لهذا الطلب.</td></tr>`;

  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>قائمة الطلب ${escapePrintHtml(order.order_number || order.order_id)}</title>
  <style>
    :root{font-family:Arial,Tahoma,sans-serif;color:#172033;background:#fff}
    body{margin:0;padding:24px;font-size:14px;line-height:1.6}
    header{display:flex;justify-content:space-between;gap:20px;border-bottom:2px solid #172033;padding-bottom:14px;margin-bottom:18px}
    h1,p{margin:0}.muted{color:#667085}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 24px;margin-bottom:20px}
    table{width:100%;border-collapse:collapse;margin-top:12px}th,td{border:1px solid #d0d5dd;padding:8px;text-align:right;vertical-align:top}
    th{background:#f2f4f7}.total{margin-top:16px;text-align:left;font-size:18px;font-weight:700}
    footer{margin-top:28px;padding-top:12px;border-top:1px solid #d0d5dd;color:#667085}
    @media print{body{padding:0}@page{size:A4;margin:14mm}}
    @media(max-width:600px){.grid{grid-template-columns:1fr}header{display:block}}
  </style>
</head>
<body>
  <header>
    <div><h1>${escapePrintHtml(companyName)}</h1><p class="muted">قائمة تجهيز وتسليم الطلب</p></div>
    <div><strong>رقم الطلب: ${escapePrintHtml(order.order_number || order.order_id || "-")}</strong><p>${escapePrintHtml(order.order_created_at || order.order_date || "-")}</p></div>
  </header>
  <section class="grid" aria-label="بيانات الطلب">
    <div><strong>العميل:</strong> ${escapePrintHtml(order.customer_name || "-")}</div>
    <div><strong>الجوال:</strong> <span dir="ltr">${escapePrintHtml(order.customer_phone || "-")}</span></div>
    <div><strong>المدينة:</strong> ${escapePrintHtml(order.customer_city || "-")}</div>
    <div><strong>العنوان:</strong> ${escapePrintHtml(order.customer_address || "-")}</div>
    <div><strong>حالة سلة:</strong> ${escapePrintHtml(order.remote_status_name || order.status || "-")}</div>
    <div><strong>الدفع:</strong> ${escapePrintHtml(order.payment_method || "-")}</div>
    <div><strong>شركة الشحن:</strong> ${escapePrintHtml(order.shipping_company || "-")}</div>
    <div><strong>رقم التتبع:</strong> <span dir="ltr">${escapePrintHtml(order.tracking_number || "-")}</span></div>
  </section>
  <table>
    <thead><tr><th>#</th><th>المنتج</th><th>SKU</th><th>الكمية</th><th>سعر الوحدة</th><th>الإجمالي</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p class="total">إجمالي الطلب: ${escapePrintHtml(printableMoney(total || null))}</p>
  <footer>توقيع المستلم: ____________________ &nbsp;&nbsp; التاريخ: ____________________</footer>
</body>
</html>`;
}

export function printStoreOrder(order: StoreOrder) {
  const popup = window.open("", "_blank", "popup");
  if (!popup) throw new Error("المتصفح منع نافذة الطباعة. اسمح بالنوافذ المنبثقة ثم أعد المحاولة.");
  popup.opener = null;
  popup.document.open();
  popup.document.write(buildStoreOrderPrintHtml(order));
  popup.document.close();
  popup.focus();
  window.setTimeout(() => popup.print(), 150);
}
