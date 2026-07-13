import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { cloudTemplateEnvKey, listTemplateNames, templateToCloudParams, templateVariableNames } from "./whatsappTemplates";

const consoleSource = readFileSync(new URL("../src/pages/WhatsAppConsole.tsx", import.meta.url), "utf8");

test("cloud template mapping is explicit per logical use case", () => {
  assert.equal(cloudTemplateEnvKey("missed_call_customer"), "WHATSAPP_CLOUD_TEMPLATE_MISSED_CALL_CUSTOMER");
  assert.deepEqual(templateVariableNames("missed_call_agent"), ["department_name", "customer_phone", "call_time"]);
});

test("cloud parameters follow placeholder order instead of sending one opaque body", () => {
  const payload = templateToCloudParams("missed_call_customer", {
    department_name: "المبيعات",
    agent_name: "أحمد",
  });
  assert.equal(payload.isFreeform, false);
  assert.deepEqual(payload.parameters?.map((item) => item.text), ["Breexe Pro", "المبيعات", "أحمد"]);
});

test("campaign reminder maps its message into the approved Cloud placeholder", () => {
  const payload = templateToCloudParams("general_reminder", { message: "عرض خاص" });
  assert.equal(payload.isFreeform, false);
  assert.deepEqual(payload.parameters, [{ type: "text", text: "عرض خاص" }]);
});

test("manual maintenance templates require every operational variable", () => {
  assert.match(
    consoleSource,
    /maintenance_reminder_first:\s*fieldsFor\("customer_name", "product_name", "maintenance_date"\)/,
  );
  assert.match(consoleSource, /missingTemplateFields\.length/);
  assert.match(consoleSource, /أكمل متغيرات القالب المطلوبة/);
  assert.match(consoleSource, /vars: normalizedTemplateVars/);
  assert.match(consoleSource, /Object\.fromEntries\([\s\S]*?selectedTemplateFields\.map/);
});

test("manual template field definitions stay aligned with server placeholders", () => {
  for (const templateName of listTemplateNames()) {
    const line = consoleSource.match(new RegExp(`${templateName}:\\s*fieldsFor\\(([^\\n]*)\\)`));
    assert.ok(line, `missing UI field definition for ${templateName}`);
    const actual = [...line[1].matchAll(/"([a-z_][a-z0-9_]*)"/gi)].map((match) => match[1]);
    const expected = templateVariableNames(templateName).filter((name) => name !== "company_name");
    assert.deepEqual(actual, expected, `UI fields drifted from ${templateName}`);
  }
});

test("manual template sending fails closed for unknown or unresolved placeholders", () => {
  assert.match(consoleSource, /if \(!configured\) return null/);
  assert.match(consoleSource, /if \(!selectedTemplateFields\)/);
  assert.match(consoleSource, /هذا القالب لا يملك تعريف متغيرات آمن/);
  assert.match(consoleSource, /\{\[a-z_\]\[a-z0-9_\]\*\\\}/i);
  assert.match(consoleSource, /placeholder غير محلول/);
});

test("template preview marks empty values instead of rendering silent blanks", () => {
  assert.match(consoleSource, /renderSafeTemplatePreview/);
  assert.match(consoleSource, /⟦مطلوب:/);
  assert.match(consoleSource, /معاينة آمنة للقالب/);
  assert.match(consoleSource, /المعاينة مكتملة ولا تحتوي متغيرات فارغة/);
  assert.match(consoleSource, /aria-live="polite"/);
});

test("daily outbound attempts and dry runs are not presented as confirmed sends", () => {
  assert.match(consoleSource, /Stat label="عمليات اليوم"/);
  assert.doesNotMatch(consoleSource, /Stat label="أرسلت اليوم"/);
  assert.match(consoleSource, /بما فيها المحاكاة الآمنة/);
  assert.match(consoleSource, /result\.simulated === true \|\| result\.dry_run === true/);
  assert.match(consoleSource, /لم تُرسل رسالة فعلية/);
  assert.match(consoleSource, /محاكاة الإرسال/);
});
