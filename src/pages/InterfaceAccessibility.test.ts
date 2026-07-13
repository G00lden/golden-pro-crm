import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const appSource = read("../App.tsx");
const dialogSource = read("../dialogAccessibility.ts");
const sharedSource = read("../shared.tsx");
const stylesSource = read("../index.css");
const storeOrdersSource = read("./StoreOrders.tsx");
const invoicesSource = read("./Invoices.tsx");
const whatsAppSource = read("./WhatsAppConsole.tsx");
const callsSource = read("./CallSystem.tsx");
const usersSource = read("./AdminUsers.tsx");
const settingsSource = read("./Settings.tsx");

test("application navigation and shared modals expose keyboard landmarks", () => {
  assert.match(appSource, /className="skip-link" href="#main-content"/);
  assert.match(appSource, /<main id="main-content" tabIndex=\{-1\}>/);
  assert.match(appSource, /aria-controls="primary-sidebar"/);
  assert.match(appSource, /aria-expanded=\{sidebarOpen\}/);
  assert.match(appSource, /aria-hidden=\{isMobileLayout && !sidebarOpen \? "true" : undefined\}/);
  assert.match(appSource, /inert=\{isMobileLayout && !sidebarOpen\}/);
  assert.match(appSource, /role="dialog"[\s\S]*?aria-modal="true"[\s\S]*?aria-labelledby=\{titleId\}[\s\S]*?tabIndex=\{-1\}/);
  assert.match(appSource, /useDialogAccessibility\(dialogRef, onClose\)/);
  assert.match(appSource, /role=\{toast\.ok \? "status" : "alert"\}/);
  assert.match(dialogSource, /state\.element\.inert = true/);
  assert.match(dialogSource, /state\.element\.setAttribute\("aria-hidden", "true"\)/);
  assert.match(dialogSource, /previouslyFocused\?\.focus\(\)/);
});

test("shared loading and button states are announced without duplicate icon text", () => {
  assert.match(sharedSource, /aria-busy=\{loading \|\| undefined\}/);
  assert.match(sharedSource, /className="spin" aria-hidden="true"/);
  assert.match(sharedSource, /loading && <RefreshCcw[\s\S]{0,160}?\{children\}/);
  assert.match(stylesSource, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.spin\s*\{\s*animation: none;/);
  assert.ok(
    stylesSource.lastIndexOf("@media (prefers-reduced-motion: reduce)") > stylesSource.indexOf("animation: spin 900ms"),
    "the reduced-motion override must follow the base spinner animation in the cascade",
  );
  assert.match(stylesSource, /\.btn\[aria-busy="true"\] > svg:not\(\.spin\)/);
  assert.match(sharedSource, /className="empty" role="status" aria-live="polite"/);
  assert.match(sharedSource, /جاري التحميل…/);
  assert.match(sharedSource, /className="error-box" role="alert"/);
  assert.match(sharedSource, /<button className=\{`stat stat-button \$\{tone\}`\} type="button" onClick=\{onClick\}>/);
  assert.doesNotMatch(sharedSource, /<article className=\{`stat \$\{tone\}`\} onClick=/);
});

test("store order bulk controls remain reachable and horizontally scrollable on mobile", () => {
  assert.match(storeOrdersSource, /className="form-actions store-bulk-actions" role="region" aria-label="إجراءات الطلبات المحددة"/);
  assert.match(storeOrdersSource, /className="orders-table-wrap"[\s\S]*?role="region"[\s\S]*?tabIndex=\{0\}/);
  assert.match(storeOrdersSource, /<th scope="col">تاريخ الطلب<\/th>/);
  assert.match(stylesSource, /\.store-bulk-actions\s*\{[\s\S]*?position:\s*sticky/);
  assert.match(stylesSource, /@media \(max-width: 820px\)[\s\S]*?\.store-bulk-actions\s*\{[\s\S]*?flex-direction:\s*column/);
});

test("invoice editor traps focus, protects dirty changes, and describes fee controls", () => {
  assert.match(invoicesSource, /useDialogAccessibility\(dialogRef, onClose\)/);
  assert.match(invoicesSource, /إغلاق نموذج الفاتورة؟ ستفقد التغييرات غير المحفوظة/);
  assert.match(invoicesSource, /onChange=\{\(\) => onDirtyChange\(true\)\}/);
  assert.match(invoicesSource, /name="additional_fee"[\s\S]*?aria-describedby=\{additionalFeeHelpId\}/);
  assert.match(invoicesSource, /aria-pressed=\{discountMode === "fixed"\}/);
  assert.match(invoicesSource, /aria-pressed=\{discountMode === "percent"\}/);
});

test("WhatsApp templates lead back to a labelled send form and tables have keyboard regions", () => {
  assert.match(whatsAppSource, /sendFormRef\.current\?\.scrollIntoView/);
  assert.match(whatsAppSource, /templateSelectRef\.current\?\.focus\(\)/);
  assert.match(whatsAppSource, /className="scrollable-table-region" role="region" aria-label="طابور رسائل المكالمات والحملات" tabIndex=\{0\}/);
  assert.match(whatsAppSource, /name="whatsapp_conversation_phone"/);
  assert.match(whatsAppSource, /<h2 className="wa-panel-title">/);
});

test("call system forms and tables expose labels, names, submit semantics, and mobile layouts", () => {
  assert.match(callsSource, /name="telephony_main_number"/);
  assert.match(callsSource, /name="telephony_department_digit"/);
  assert.match(callsSource, /aria-label=\{`حذف الموظف \$\{i \+ 1\}`\}/);
  assert.match(callsSource, /className="call-test-form"[\s\S]*?<span>رقم جوال العميل<\/span>/);
  assert.match(callsSource, /className="scrollable-table-region" role="region" aria-label="سجل المكالمات" tabIndex=\{0\}/);
  assert.match(stylesSource, /\.call-departments-grid\s*\{[\s\S]*?grid-template-columns:/);
  assert.match(stylesSource, /@media \(max-width: 820px\)[\s\S]*?\.call-departments-grid,[\s\S]*?\.call-test-form\s*\{[\s\S]*?grid-template-columns:\s*1fr/);
});

test("admin and settings forms expose accessible names and busy states", () => {
  assert.match(usersSource, /aria-label="بحث في المستخدمين"/);
  assert.match(usersSource, /aria-label=\{`حذف المستخدم/);
  assert.match(usersSource, /function UserModal[\s\S]*?useDialogAccessibility[\s\S]*?role="dialog"/);
  assert.match(usersSource, /name="managed_user_email"[\s\S]*?autoComplete="email"/);
  assert.match(settingsSource, /<form className="form" aria-busy=\{saving\}/);
  assert.match(settingsSource, /name="seller_vat_number"[\s\S]*?inputMode="numeric"/);
  assert.match(settingsSource, /name="store_webhook_url"/);
});

test("focus, reduced-motion, modal overscroll, and mobile touch targets are explicit", () => {
  assert.match(stylesSource, /\.btn:focus-visible,[\s\S]*?\.mobile-menu:focus-visible/);
  assert.match(stylesSource, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.btn,[\s\S]*?\.icon-btn,[\s\S]*?\.skip-link/);
  assert.match(stylesSource, /\.modal\s*\{[\s\S]*?overscroll-behavior:\s*contain/);
  assert.match(stylesSource, /@media \(max-width: 820px\)[\s\S]*?\.icon-btn\s*\{[\s\S]*?min-height:\s*40px/);
  assert.match(stylesSource, /\.sidebar\s*\{[\s\S]*?visibility:\s*hidden;[\s\S]*?pointer-events:\s*none;[\s\S]*?translateX\(calc\(100% \+ 2px\)\)/);
  assert.match(stylesSource, /@media \(max-width: 520px\)[\s\S]*?\.stats-grid,[\s\S]*?\.ops-strip\s*\{[\s\S]*?grid-template-columns:\s*1fr/);
  assert.match(stylesSource, /@media \(max-width: 520px\)[\s\S]*?\.store-filters-bar\s*\{[\s\S]*?grid-template-columns:\s*1fr/);
});
