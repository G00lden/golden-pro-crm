import assert from "node:assert/strict";
import test from "node:test";
import {
  createPerItemActionLock,
  isOutboundSimulation,
  prepareManualOutboundAction,
} from "./outboundAction";

test("dry-run never asks for an outbound confirmation code", async () => {
  let prompts = 0;
  const prepared = await prepareManualOutboundAction(
    async () => ({ outbound: { mode: "dry_run", dryRun: true, requiresCode: true } }),
    () => {
      prompts += 1;
      return "should-not-be-used";
    },
  );

  assert.equal(prompts, 0);
  assert.equal(prepared.dryRun, true);
  assert.equal(prepared.requiresCode, false);
  assert.equal(prepared.outboundCode, undefined);
});

test("a real code-protected send asks once and trims the code", async () => {
  let prompts = 0;
  const prepared = await prepareManualOutboundAction(
    async () => ({ outbound: { mode: "code", dryRun: false, requiresCode: true } }),
    () => {
      prompts += 1;
      return " 2232 ";
    },
  );

  assert.equal(prompts, 1);
  assert.equal(prepared.dryRun, false);
  assert.equal(prepared.outboundCode, "2232");
});

test("a supplied code is used without opening a second prompt", async () => {
  let prompts = 0;
  const prepared = await prepareManualOutboundAction(
    async () => ({ outbound: { mode: "code", dryRun: false, requiresCode: true } }),
    () => {
      prompts += 1;
      return "unexpected";
    },
    " 7788 ",
  );

  assert.equal(prompts, 0);
  assert.equal(prepared.outboundCode, "7788");
});

test("dry-run discards a supplied code and still never prompts", async () => {
  let prompts = 0;
  const prepared = await prepareManualOutboundAction(
    async () => ({ outbound: { mode: "dry_run", dryRun: true, requiresCode: true } }),
    () => {
      prompts += 1;
      return "unexpected";
    },
    "7788",
  );

  assert.equal(prompts, 0);
  assert.equal(prepared.dryRun, true);
  assert.equal(prepared.outboundCode, undefined);
});

test("cancelled code entry and unavailable policy fail closed", async () => {
  await assert.rejects(
    prepareManualOutboundAction(
      async () => ({ outbound: { mode: "code", dryRun: false, requiresCode: true } }),
      () => null,
    ),
    /كود الإرسال مطلوب/,
  );
  await assert.rejects(
    prepareManualOutboundAction(async () => ({ status: "connected" } as never)),
    /تعذر التحقق من وضع الإرسال/,
  );
});

test("simulation detection accepts API and status response shapes", () => {
  assert.equal(isOutboundSimulation({ dry_run: true }), true);
  assert.equal(isOutboundSimulation({ dryRun: true }), true);
  assert.equal(isOutboundSimulation({ simulated: true }), true);
  assert.equal(isOutboundSimulation({ result: { dryRun: true } }), true);
  assert.equal(isOutboundSimulation({ whatsapp: { outbound: { dryRun: true } } }), true);
  assert.equal(isOutboundSimulation({ success: true }), false);
  assert.equal(isOutboundSimulation({ success: true }, true), true);
});

test("per-item action lock rejects a second acquisition until release", () => {
  const lock = createPerItemActionLock();
  assert.equal(lock.acquire("booking-1"), true);
  assert.equal(lock.acquire("booking-1"), false);
  assert.equal(lock.acquire("booking-2"), true);
  assert.equal(lock.has("booking-1"), true);
  lock.release("booking-1");
  assert.equal(lock.acquire("booking-1"), true);
});
