import assert from "node:assert/strict";
import test from "node:test";
import { cloudTemplateEnvKey, templateToCloudParams, templateVariableNames } from "./whatsappTemplates";

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
