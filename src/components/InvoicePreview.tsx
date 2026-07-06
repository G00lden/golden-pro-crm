import { useMemo, useState, useEffect } from "react";
import { Copy, Download, Printer } from "lucide-react";
import QRCode from "qrcode";
import type * as api from "../api";

// ── Constants ────────────────────────────────────────────

const sellerLegalName = "شركة بريكس برو شخص واحد ذات مسؤولية محدودة";
const sellerEnglishName = "Breexe Pro Co.";
const sellerCrNumber = "7016449519";
const sellerPhone = "+966****1168";
export const invoiceSellerOptions = ["أبو عامر", "أبو سيف"] as const;

// ── Helpers ──────────────────────────────────────────────

const money = (value?: number, currency = "SAR") =>
  `${Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;

export const invoiceKind = (totalWithVat?: number) =>
  Number(totalWithVat || 0) >= 1000
    ? { ar: "فاتورة ضريبية", en: "Tax Invoice" }
    : { ar: "فاتورة ضريبية مبسطة", en: "Simplified Tax Invoice" };

export function invoiceTimestamp(invoice: api.Invoice): string {
  const source = invoice.createdAt || `${invoice.issue_date}T00:00:00Z`;
  const parsed = new Date(source);
  if (Number.isNaN(parsed.getTime())) return `${invoice.issue_date}T00:00:00Z`;
  return parsed.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function generateZATCAQR(invoice: api.Invoice): string {
  const timestamp = invoiceTimestamp(invoice);
  const total = invoice.total_with_vat.toFixed(2);
  const vatAmount = invoice.vat_amount.toFixed(2);
  const tlvData: Array<[number, string]> = [
    [1, invoice.seller_name || sellerEnglishName],
    [2, invoice.seller_vat_number],
    [3, timestamp],
    [4, total],
    [5, vatAmount],
  ];
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  for (const [tag, value] of tlvData) {
    const valueBytes = Array.from(encoder.encode(String(value)));
    bytes.push(tag, valueBytes.length);
    bytes.push(...valueBytes);
  }
  return btoa(String.fromCharCode(...bytes));
}

// ── QR Code ──────────────────────────────────────────────

function QRCodeDisplay({ data, size = 80 }: { data: string; size?: number }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let active = true;
    QRCode.toDataURL(data, { errorCorrectionLevel: "M", margin: 1, width: size, color: { dark: "#000000", light: "#ffffff" } })
      .then((v) => { if (active) setSrc(v); })
      .catch(() => { if (active) setSrc(""); });
    return () => { active = false; };
  }, [data, size]);
  return src
    ? <img src={src} width={size} height={size} className="zatca-qr-code" alt="ZATCA QR" />
    : <div className="zatca-qr-code qr-fallback" style={{ width: size, height: size }}>QR</div>;
}

// ── Line amounts ─────────────────────────────────────────

export function invoiceLineAmounts(item: api.InvoiceItem, vatPercent: number) {
  const rate = Math.max(0, Number(vatPercent || 0)) / 100;
  const quantity = Math.max(0, Number(item.quantity || 0));
  const enteredTotal = Math.max(0, Number(item.total || quantity * Number(item.unit_price || 0)));
  const net = item.vat_excluded === false && rate > 0 ? enteredTotal / (1 + rate) : enteredTotal;
  const gross = item.vat_excluded === false ? enteredTotal : enteredTotal * (1 + rate);
  return {
    quantity,
    net: Math.round(net * 100) / 100,
    unitNet: quantity ? Math.round((net / quantity) * 100) / 100 : 0,
    vat: Math.round((gross - net) * 100) / 100,
    gross: Math.round(gross * 100) / 100,
  };
}

// ── Component ────────────────────────────────────────────

export function InvoicePreview({ invoice, onCopy, onPrint }: {
  invoice: api.Invoice;
  onCopy: () => void;
  onPrint: (asPdf?: boolean) => void;
}) {
  const qrCode = useMemo(() => generateZATCAQR(invoice), [invoice]);
  const kind = invoiceKind(invoice.total_with_vat);
  const issueTime = invoiceTimestamp(invoice).replace("T", " ").replace("Z", " UTC");
  const [sellerOption, setSellerOption] = useState<string>(invoiceSellerOptions[0]);
  const [customSeller, setCustomSeller] = useState("");
  const exportSellerName = sellerOption === "custom" ? customSeller.trim() : sellerOption;

  return (
    <div className="quote-preview">
      <section className="invoice-a4-doc" dir="rtl">
        <header className="invoice-doc-head">
          <div className="invoice-brand-block">
            <img src="/brand/logo-256.png" alt="BreeXe Pro" height={48} style={{ objectFit: "contain", flexShrink: 0 }} />
            <div>
              <span dir="ltr">{invoice.seller_name || sellerEnglishName}</span>
              <strong>{sellerLegalName}</strong>
              <small>{invoice.seller_address || "الرياض، المملكة العربية السعودية"}</small>
              <small dir="ltr">{sellerPhone}</small>
            </div>
          </div>
          <div className="invoice-title-block">
            <span>{kind.en}</span>
            <h2>{kind.ar}</h2>
            {invoice.title && <em style={{ display: "block", fontStyle: "normal", fontSize: "0.8em", opacity: 0.7 }}>{invoice.title}</em>}
            <strong>{invoice.invoice_number}</strong>
          </div>
        </header>

        <section className="invoice-identity-grid">
          <article><span>رقم الفاتورة</span><strong>{invoice.invoice_number}</strong></article>
          <article><span>تاريخ الإصدار</span><strong>{invoice.issue_date}</strong><small>{issueTime}</small></article>
          <article><span>الرقم الضريبي للبائع</span><strong>{invoice.seller_vat_number || "-"}</strong></article>
          <article><span>اسم البائع</span><strong>{exportSellerName || "-"}</strong></article>
        </section>

        <section className="invoice-parties">
          <article>
            <h3>بيانات البائع</h3>
            <p><span>الاسم:</span> <bdi>{invoice.seller_name || sellerEnglishName}</bdi></p>
            <p><span>السجل/الاسم القانوني:</span> {sellerLegalName}</p>
            <p><span>الرقم الضريبي:</span> {invoice.seller_vat_number || "-"}</p>
            <p><span>السجل التجاري:</span> {sellerCrNumber}</p>
            <p><span>الجوال:</span> <bdi dir="ltr">{sellerPhone}</bdi></p>
            <p><span>العنوان:</span> {invoice.seller_address || "-"}</p>
          </article>
          <div className="invoice-party-side">
            <article>
              <h3>بيانات العميل</h3>
              <p><span>الاسم:</span> {invoice.customer_name}</p>
              <p><span>الجوال:</span> {invoice.customer_phone || "-"}</p>
              <p><span>المدينة:</span> {invoice.customer_city || "-"}</p>
              <p><span>الرقم الضريبي:</span> {invoice.customer_vat || "-"}</p>
            </article>
            <aside className="invoice-zatca-card">
              <QRCodeDisplay data={qrCode} size={132} />
              <span>رمز الاستجابة السريع — متوافق مع زاتكا</span>
            </aside>
          </div>
        </section>

        <table className="invoice-doc-table">
          <thead>
            <tr>
              <th>#</th><th>البيان</th><th>الكمية</th><th>سعر الوحدة قبل الضريبة</th>
              <th>الخاضع للضريبة</th><th>VAT</th><th>الإجمالي شامل الضريبة</th>
            </tr>
          </thead>
          <tbody>
            {invoice.items.map((item, i) => {
              const line = invoiceLineAmounts(item, invoice.vat_percent);
              return (
                <tr key={`${item.description}-${i}`}>
                  <td>{i + 1}</td>
                  <td>
                    {item.description}
                    {item.product_sku && <small style={{ display: "block", opacity: 0.6, fontSize: "0.85em", direction: "ltr", textAlign: "right" }}>{item.product_sku}</small>}
                  </td>
                  <td>{line.quantity}</td>
                  <td>{money(line.unitNet, invoice.currency)}</td>
                  <td>{money(line.net, invoice.currency)}</td>
                  <td>{money(line.vat, invoice.currency)}</td>
                  <td>{money(line.gross, invoice.currency)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <section className="invoice-bottom-grid">
          <div className="invoice-doc-totals">
            <p><span>الإجمالي غير شامل الضريبة</span><strong>{money(invoice.total_without_vat, invoice.currency)}</strong></p>
            <p><span>الخصم</span><strong>{money(invoice.discount, invoice.currency)}</strong></p>
            <p><span>ضريبة القيمة المضافة ({invoice.vat_percent}%)</span><strong>{money(invoice.vat_amount, invoice.currency)}</strong></p>
            <p className="grand"><span>الإجمالي شامل الضريبة</span><strong>{money(invoice.total_with_vat, invoice.currency)}</strong></p>
          </div>
        </section>

        {invoice.terms && <p className="invoice-doc-terms">{invoice.terms}</p>}
        <footer className="invoice-doc-foot"><strong>{sellerEnglishName}</strong></footer>
      </section>

      <div className="form-actions">
        <div className="invoice-export-options">
          <label>
            <span>اسم البائع عند التصدير</span>
            <select className="input" value={sellerOption} onChange={(e) => setSellerOption(e.target.value)}>
              {invoiceSellerOptions.map((n) => <option key={n} value={n}>{n}</option>)}
              <option value="custom">إضافة جديد</option>
            </select>
          </label>
          {sellerOption === "custom" && (
            <label>
              <span>اسم جديد</span>
              <input className="input" value={customSeller} onChange={(e) => setCustomSeller(e.target.value)} placeholder="اكتب اسم البائع" />
            </label>
          )}
        </div>
        <button className="btn primary" type="button" onClick={() => onPrint(false)}><Printer size={16} /> طباعة A4</button>
        <button className="btn muted" type="button" onClick={() => onPrint(true)}><Download size={16} /> حفظ PDF</button>
        <button className="btn muted" type="button" onClick={onCopy}><Copy size={16} /> نسخ نص الفاتورة</button>
      </div>
    </div>
  );
}
