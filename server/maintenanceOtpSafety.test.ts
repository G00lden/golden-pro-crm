import assert from "node:assert/strict";
import test from "node:test";
import { decideMaintenanceOtpOutbound } from "./maintenanceOtpSafety";
import { WhatsAppService } from "./whatsapp";

test("maintenance OTP stays disabled independently of the general outbound mode", () => {
  const result = decideMaintenanceOtpOutbound("0500000000", {
    OUTBOUND_MODE: "production",
    OFFICIAL_LAUNCH_APPROVED: "true",
    MAINTENANCE_WHATSAPP_OTP_MODE: "disabled",
  });
  assert.equal(result.allowed, false);
  assert.equal(result.mode, "disabled");
});

test("maintenance OTP allowlist accepts only the configured canary phone", () => {
  const env = {
    MAINTENANCE_WHATSAPP_OTP_MODE: "allowlist",
    OUTBOUND_TEST_PHONE_ALLOWLIST: "966500000001",
  } as NodeJS.ProcessEnv;
  assert.equal(decideMaintenanceOtpOutbound("0500000001", env).allowed, true);
  assert.equal(decideMaintenanceOtpOutbound("0500000002", env).allowed, false);
});

test("maintenance OTP production requires its dedicated approval", () => {
  const blocked = decideMaintenanceOtpOutbound("0500000001", { MAINTENANCE_WHATSAPP_OTP_MODE: "production" });
  const allowed = decideMaintenanceOtpOutbound("0500000001", {
    MAINTENANCE_WHATSAPP_OTP_MODE: "production",
    MAINTENANCE_WHATSAPP_OTP_LAUNCH_APPROVED: "true",
  });
  assert.equal(blocked.allowed, false);
  assert.equal(allowed.allowed, true);
});

test("Cloud API authentication payload carries the same six-digit code in body and copy button", async () => {
  const previous = { ...process.env };
  const originalFetch = globalThis.fetch;
  let payload: any;
  try {
    process.env.WHATSAPP_PROVIDER = "cloud_api";
    process.env.WHATSAPP_CLOUD_API_TOKEN = "test-token";
    process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID = "123456";
    process.env.MAINTENANCE_WHATSAPP_OTP_MODE = "allowlist";
    process.env.OUTBOUND_TEST_PHONE_ALLOWLIST = "966500000001";
    process.env.MAINTENANCE_WHATSAPP_OTP_TEMPLATE = "breexe_maintenance_otp_ar";
    process.env.MAINTENANCE_WHATSAPP_OTP_LANGUAGE = "ar";
    globalThis.fetch = async (_input, init) => {
      payload = JSON.parse(String(init?.body || "{}"));
      return new Response(JSON.stringify({ messages: [{ id: "wamid.test" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const service = new WhatsAppService();
    const result = await service.sendMaintenanceOtp("0500000001", "123456");
    assert.equal(result.messageId, "wamid.test");
    assert.equal(payload.template.name, "breexe_maintenance_otp_ar");
    assert.equal(payload.template.language.code, "ar");
    assert.equal(payload.template.components[0].parameters[0].text, "123456");
    assert.equal(payload.template.components[1].parameters[0].text, "123456");
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});
