import { useMemo, useState, useEffect } from "react";
import { Copy, Download, Printer } from "lucide-react";
import QRCode from "qrcode";
import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";
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

// ── Print helpers (shared) ───────────────────────────────

const safeFilePart = (value?: string) =>
  String(value || "العميل").trim().replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").slice(0, 80) || "العميل";

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const invoiceStandaloneCss = `
  @page { size: A4; margin: 0; }
  html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
  body { width: 210mm !important; min-height: 297mm !important; overflow: visible !important; }
  .invoice-print-shell { width: 210mm !important; margin: 0 !important; padding: 0 !important; background: #fff !important; }
  .quote-a4-doc {
    width: 210mm !important; min-height: 297mm !important; margin: 0 !important;
    border: 0 !important; border-radius: 0 !important; box-shadow: none !important;
  }
  .invoice-head-slim { padding: 18px 24px 16px !important; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  .invoice-type-strip { padding: 14px 24px !important; }
  .invoice-parties-slim { margin: 0 24px !important; }
  .invoice-bottom-row { margin: 14px 24px !important; }
  .quote-doc-table, .invoice-doc-table { width: 100% !important; }
`;

async function replaceInvoiceQrInClone(clone: HTMLElement, invoice: api.Invoice) {
  const qrTarget = clone.querySelector<HTMLElement>(".zatca-qr-code");
  if (!qrTarget) return;
  const qrSrc = await QRCode.toDataURL(generateZATCAQR(invoice), {
    errorCorrectionLevel: "M", margin: 1, width: 140,
    color: { dark: "#000000", light: "#ffffff" },
  });
  const qrImage = document.createElement("img");
  qrImage.src = qrSrc; qrImage.width = 140; qrImage.height = 140;
  qrImage.className = "zatca-qr-code"; qrImage.alt = "ZATCA QR code";
  qrTarget.replaceWith(qrImage);
}

function invoiceStylesMarkup() {
  return Array.from(document.querySelectorAll<HTMLLinkElement | HTMLStyleElement>('link[rel="stylesheet"], style'))
    .map((el) => el.outerHTML).join("\n");
}

export async function buildInvoiceDocumentHtml(invoice: api.Invoice) {
  const node = document.querySelector<HTMLElement>(".quote-a4-doc");
  if (!node) throw new Error("Invoice preview not ready — open preview first.");
  const clone = node.cloneNode(true) as HTMLElement;
  await replaceInvoiceQrInClone(clone, invoice);
  const title = `فاتورة إلى ${safeFilePart(invoice.customer_name)}`;
  return `<!doctype html>\n<html lang="ar" dir="rtl">\n<head>\n  <meta charset="utf-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1" />\n  <base href="${window.location.origin}/" />\n  <title>${escapeHtml(title)}</title>\n  ${invoiceStylesMarkup()}\n  <style>${invoiceStandaloneCss}</style>\n</head>\n<body class="invoice-print-body">\n  <main class="invoice-print-shell">${clone.outerHTML}</main>\n</body>\n</html>`;
}

function waitForDocumentAssets(doc: Document) {
  const fontsReady = doc.fonts?.ready?.catch(() => undefined) || Promise.resolve();
  const imagesReady = Promise.all(Array.from(doc.images).map((img) => {
    if (img.complete) return Promise.resolve();
    return new Promise<void>((resolve) => { img.onload = () => resolve(); img.onerror = () => resolve(); });
  }));
  return Promise.all([fontsReady, imagesReady]);
}

async function writeInvoiceHtmlToFrame(frame: HTMLIFrameElement, html: string) {
  const doc = frame.contentDocument;
  if (!doc) throw new Error("Invoice frame not available.");
  await new Promise<void>((resolve) => { frame.onload = () => resolve(); doc.open(); doc.write(html); doc.close(); });
  await waitForDocumentAssets(doc);
  return doc;
}

export async function saveInvoicePdf(invoice: api.Invoice) {
  const html = await buildInvoiceDocumentHtml(invoice);
  const frame = document.createElement("iframe");
  frame.title = "invoice-pdf-frame";
  Object.assign(frame.style, { position: "fixed", left: "-10000px", top: "0", width: "210mm", height: "297mm", border: "0", background: "#fff" });
  document.body.appendChild(frame);
  try {
    const doc = await writeInvoiceHtmlToFrame(frame, html);
    const node = doc.querySelector<HTMLElement>(".quote-a4-doc");
    if (!node) throw new Error("PDF node not available.");
    const canvas = await html2canvas(node, { backgroundColor: "#ffffff", logging: false, scale: 2, useCORS: true });
    const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    const imgData = canvas.toDataURL("image/png");
    const pw = 210, ph = 297, ih = (canvas.height * pw) / canvas.width;
    if (ih <= ph + 2) { pdf.addImage(imgData, "PNG", 0, 0, pw, ph); }
    else { let off = 0; pdf.addImage(imgData, "PNG", 0, off, pw, ih); while (ih + off > ph) { off -= ph; pdf.addPage(); pdf.addImage(imgData, "PNG", 0, off, pw, ih); } }
    pdf.save(`${safeFilePart(invoice.invoice_number)}-${safeFilePart(invoice.customer_name)}.pdf`);
  } finally { frame.remove(); }
}

export async function printInvoiceWindow(invoice: api.Invoice, printWindow: Window | null) {
  if (!printWindow) throw new Error("Popup blocked — allow popups for this site.");
  const html = await buildInvoiceDocumentHtml(invoice);
  const doc = printWindow.document;
  doc.open(); doc.write(html); doc.close();
  await waitForDocumentAssets(doc);
  printWindow.focus();
  window.setTimeout(() => printWindow.print(), 250);
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
      <div className="quote-document-stage">
        {/* ── A4 Page ─────────────────────────────── */}
        <section className="quote-a4-doc invoice-doc-page" dir="rtl">

          {/* Header — like quote cover-top */}
          <header className="quote-cover-top invoice-head-slim">
            <div>
              <strong>{invoice.seller_name || sellerEnglishName}</strong>
              <span>{sellerLegalName}</span>
              <small style={{ display: "block", color: "rgba(255,255,255,0.65)", fontSize: 11, marginTop: 6 }}>
                س.ت {sellerCrNumber} · الرقم الضريبي {invoice.seller_vat_number || "-"}
              </small>
            </div>
            <div style={{ textAlign: "left" }}>
              <img src="/brand/icon-256.png" alt="BreeXe Pro" className="invoice-brand-icon" />
            </div>
          </header>

          {/* Invoice type & number */}
          <div className="invoice-type-strip">
            <div>
              <span className="invoice-kind-en">{kind.en}</span>
              <h2>{kind.ar}</h2>
              {invoice.title && <em style={{ display: "block", fontStyle: "normal", fontSize: 13, opacity: 0.7, marginTop: 2 }}>{invoice.title}</em>}
            </div>
            <strong className="invoice-number-big">{invoice.invoice_number}</strong>
          </div>

          {/* Meta grid — invoice details */}
          <div className="quote-client-grid" style={{ marginBottom: 14 }}>
            <span>تاريخ الإصدار<br /><strong>{invoice.issue_date}</strong><br /><small style={{ direction: "ltr", display: "inline-block" }}>{issueTime}</small></span>
            <span>تاريخ الاستحقاق<br /><strong>{invoice.due_date || "-"}</strong></span>
            <span>اسم البائع<br /><strong>{exportSellerName || "-"}</strong></span>
            <span>طريقة الدفع<br /><strong>{invoice.payment_method || "تحويل بنكي"}</strong></span>
          </div>

          {/* Parties — seller + client side by side */}
          <div className="invoice-parties-slim">
            <article>
              <h3>بيانات العميل</h3>
              <p><span>الاسم</span> <strong>{invoice.customer_name}</strong></p>
              <p><span>الجوال</span> <strong dir="ltr">{invoice.customer_phone || "-"}</strong></p>
              <p><span>المدينة</span> <strong>{invoice.customer_city || "-"}</strong></p>
              <p><span>الرقم الضريبي</span> <strong>{invoice.customer_vat || "-"}</strong></p>
            </article>
            <article>
              <h3>بيانات البائع</h3>
              <p><span>الاسم التجاري</span> <strong dir="ltr">{invoice.seller_name || sellerEnglishName}</strong></p>
              <p><span>السجل التجاري</span> <strong>{sellerCrNumber}</strong></p>
              <p><span>العنوان</span> <strong>{invoice.seller_address || "الرياض، المملكة العربية السعودية"}</strong></p>
              <p><span>الجوال</span> <strong dir="ltr">{sellerPhone}</strong></p>
            </article>
          </div>

          {/* Table */}
          <table className="quote-doc-table">
            <thead>
              <tr><th>#</th><th>البيان</th><th>الكمية</th><th>السعر</th><th>الإجمالي</th></tr>
            </thead>
            <tbody>
              {invoice.items.map((item, i) => {
                const line = invoiceLineAmounts(item, invoice.vat_percent);
                return (
                  <tr key={`${item.description}-${i}`}>
                    <td>{i + 1}</td>
                    <td>
                      {item.description}
                      {item.product_sku && <small style={{ display: "block", opacity: 0.55, fontSize: 10, direction: "ltr", textAlign: "right" }}>{item.product_sku}</small>}
                    </td>
                    <td>{line.quantity}</td>
                    <td>{money(line.unitNet, invoice.currency)}</td>
                    <td>{money(line.gross, invoice.currency)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Totals + QR */}
          <div className="invoice-bottom-row">
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
              <QRCodeDisplay data={qrCode} size={110} />
              <span style={{ fontSize: 9, color: "var(--gray-500)" }}>رمز ZATCA</span>
            </div>
            <div className="invoice-doc-totals-slim">
              <p><span>الإجمالي قبل الضريبة</span> <strong>{money(invoice.total_without_vat, invoice.currency)}</strong></p>
              <p><span>الخصم</span> <strong>{money(invoice.discount, invoice.currency)}</strong></p>
              <p><span>ضريبة القيمة المضافة {invoice.vat_percent}%</span> <strong>{money(invoice.vat_amount, invoice.currency)}</strong></p>
              <p className="grand"><span>الإجمالي شامل الضريبة</span> <strong>{money(invoice.total_with_vat, invoice.currency)}</strong></p>
            </div>
          </div>

          {/* Terms & Notes Section — always visible as template */}
          <div className="invoice-terms-section">
            <div className="invoice-terms-block">
              <h4>الشروط والأحكام</h4>
              <p>{invoice.terms || "شروط الدفع، سياسة الاسترجاع، فترة الضمان، والرسوم الإضافية إن وجدت."}</p>
            </div>
            {invoice.notes && (
              <div className="invoice-terms-block invoice-notes-block">
                <h4>ملاحظات</h4>
                <p>{invoice.notes}</p>
              </div>
            )}
          </div>

          <footer className="quote-doc-foot" style={{ marginTop: "auto", paddingTop: 16, borderTop: "1px solid var(--line)" }}>
            <span>{sellerEnglishName}</span>
            <span>صدرت بواسطة BreeXe Pro CRM</span>
          </footer>
        </section>
      </div>

      {/* Export actions */}
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
