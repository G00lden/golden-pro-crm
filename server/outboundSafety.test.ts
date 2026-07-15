import assert from "node:assert/strict";
import test from "node:test";
import { decideOutbound } from "./outboundSafety";

test("allowlist mode cannot be bypassed by a request-supplied one-time phone", () => {
  const previous = {
    mode: process.env.OUTBOUND_MODE,
    allowlist: process.env.OUTBOUND_TEST_PHONE_ALLOWLIST,
    code: process.env.OUTBOUND_CONFIRM_CODE,
  };
  try {
    process.env.OUTBOUND_MODE = "allowlist";
    process.env.OUTBOUND_TEST_PHONE_ALLOWLIST = "0535848176";
    delete process.env.OUTBOUND_CONFIRM_CODE;

    assert.equal(decideOutbound("0535848176").allowed, true);
    assert.equal(decideOutbound("0500000000").allowed, false);
    assert.equal(decideOutbound(
      "0500000000",
      { oneTimeTestPhone: "0500000000" } as never,
    ).allowed, false);
  } finally {
    if (previous.mode === undefined) delete process.env.OUTBOUND_MODE;
    else process.env.OUTBOUND_MODE = previous.mode;
    if (previous.allowlist === undefined) delete process.env.OUTBOUND_TEST_PHONE_ALLOWLIST;
    else process.env.OUTBOUND_TEST_PHONE_ALLOWLIST = previous.allowlist;
    if (previous.code === undefined) delete process.env.OUTBOUND_CONFIRM_CODE;
    else process.env.OUTBOUND_CONFIRM_CODE = previous.code;
  }
});
