import assert from "node:assert/strict";
import test from "node:test";
import { unifonicAdapter } from "./unifonicAdapter";

test("normalizes Unifonic inbound calls and preserves explicit call ids", () => {
  const explicit = unifonicAdapter.parseInbound({
    callSid: "call-42",
    callerId: "+966 50 123 4567",
    recipient: "+966112233445",
    digits: "2",
  }, {});
  assert.equal(explicit.callSid, "call-42");
  assert.equal(explicit.from, "+966 50 123 4567");
  assert.equal(explicit.digit, "2");

  const correlated = unifonicAdapter.parseInbound({ callerId: "0501234567" }, {});
  assert.equal(correlated.callSid, "caller:966501234567");
});

test("maps provider-specific terminal statuses to the shared call lifecycle", () => {
  assert.equal(unifonicAdapter.parseStatus({ callerId: "0501234567", status: "No Answer" }, {}).status, "no_answer");
  assert.equal(unifonicAdapter.parseStatus({ callerId: "0501234567", status: "answered" }, {}).status, "completed");
  assert.equal(unifonicAdapter.parseStatus({ callerId: "0501234567", status: "bridged" }, {}).status, "in_progress");
});

test("renders gather and transfer instructions using Unifonic's documented shape", () => {
  const rendered = unifonicAdapter.renderInstructions([
    { action: "gather", text: "اختر القسم", responseUrl: "https://crm.example/webhooks/telephony/ivr" },
    { action: "dial", number: "0501234567", recording: true },
  ]) as Array<Record<string, unknown>>;

  assert.equal(rendered[0].responseUrl, "https://crm.example/webhooks/telephony/ivr");
  assert.equal(rendered[0].digitsLimit, "1");
  assert.equal(rendered[1].transfer, "+966501234567");
  assert.equal(rendered[1].recording, true);
});
