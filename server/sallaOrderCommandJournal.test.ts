import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

process.env.NODE_ENV = "test";
process.env.DATA_PROVIDER = "sqlite";
process.env.DB_PROVIDER = "sqlite";
process.env.DB_PATH = ":memory:";

const {
  resetSallaOrderCommandJournalForTests,
  runAuditedSallaOrderCommand,
} = await import("./sallaOrderCommandJournal");
const { sallaOrderPayloadHash } = await import("./sallaOrderControl");
const { adminDb } = await import("./firebaseAdmin");

beforeEach(() => {
  resetSallaOrderCommandJournalForTests();
});

function input(
  suffix: string,
  overrides: Partial<Parameters<typeof runAuditedSallaOrderCommand>[0]> = {},
) {
  return {
    ownerUid: `owner-${suffix}`,
    actorUid: `actor-${suffix}`,
    orderDocId: `order-doc-${suffix}`,
    remoteOrderId: `remote-${suffix}`,
    commandType: "status.update",
    payload: { slug: "completed", customer: { name: "Private Customer", phone: "+966500000000" } },
    beforeSnapshot: { status: { slug: "processing" }, customer: { email: "private@example.test" } },
    execute: async () => ({ status: { slug: "completed" } }),
    reconcile: async () => ({ success: false }),
    ...overrides,
  };
}

async function commandData(commandId: string) {
  const snapshot = await adminDb.collection("salla_order_commands").doc(commandId).get();
  assert.equal(snapshot.exists, true);
  return snapshot.data() as Record<string, unknown>;
}

test("a completed matching command is returned as a duplicate without executing twice", async () => {
  let executions = 0;
  const command = input("duplicate", {
    execute: async () => {
      executions += 1;
      return { status: { slug: "completed" } };
    },
  });

  const first = await runAuditedSallaOrderCommand(command);
  const second = await runAuditedSallaOrderCommand(command);

  assert.equal(executions, 1);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(first.commandId, second.commandId);
  assert.match(first.commandId, /^soc_[a-f0-9]{40}$/);
  const stored = await commandData(first.commandId);
  assert.equal(stored.status, "completed");
  assert.equal(stored.attemptCount, 1);
  assert.equal(stored.beforeHash, sallaOrderPayloadHash(command.beforeSnapshot));
  assert.equal(stored.afterHash, sallaOrderPayloadHash(first.result));
  const serialized = JSON.stringify(stored.payload);
  assert.equal(serialized.includes("Private Customer"), false);
  assert.equal(serialized.includes("+966500000000"), false);
  assert.deepEqual(stored.payload, {
    redacted: true,
    kind: "object",
    fields: ["customer", "slug"],
  });
});

test("concurrent matching commands share one in-process execution", async () => {
  let executions = 0;
  let releaseExecution!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseExecution = resolve;
  });
  const command = input("concurrent", {
    execute: async () => {
      executions += 1;
      markStarted();
      await gate;
      return { status: { slug: "completed" } };
    },
  });

  const firstPromise = runAuditedSallaOrderCommand(command);
  await started;
  const secondPromise = runAuditedSallaOrderCommand(command);
  releaseExecution();
  const results = await Promise.all([firstPromise, secondPromise]);

  assert.equal(executions, 1);
  assert.deepEqual(results.map((result) => result.duplicate).sort(), [false, true]);
});

test("an unknown outcome is reconciled once and recorded as completed", async () => {
  const uncertain = Object.assign(new Error("timeout for private@example.test"), {
    outcomeUnknown: true,
    status: 503,
  });
  let reconciliations = 0;
  const afterSnapshot = { status: { slug: "completed" }, customer: { phone: "+966511111111" } };
  const command = input("reconciled", {
    execute: async () => {
      throw uncertain;
    },
    reconcile: async (error) => {
      assert.equal(error, uncertain);
      reconciliations += 1;
      return {
        success: true,
        result: { status: { slug: "completed" } },
        afterSnapshot,
        resultStatus: "completed",
      };
    },
  });

  const result = await runAuditedSallaOrderCommand(command);
  assert.equal(result.reconciled, true);
  assert.equal(result.duplicate, false);
  assert.equal(reconciliations, 1);
  const stored = await commandData(result.commandId);
  assert.equal(stored.status, "completed");
  assert.equal(stored.resultStatus, "completed");
  assert.equal(stored.afterHash, sallaOrderPayloadHash(afterSnapshot));
  assert.equal(stored.lastError, null);
  assert.equal(JSON.stringify(stored).includes("private@example.test"), false);
  assert.equal(JSON.stringify(stored).includes("+966511111111"), false);
});

test("a known failure is recorded without reconciliation or leaked PII and is rethrown", async () => {
  const failure = Object.assign(new Error("customer private@example.test was rejected"), {
    code: "INVALID_ORDER",
    status: 422,
  });
  let reconciliations = 0;
  const command = input("failed", {
    execute: async () => {
      throw failure;
    },
    reconcile: async () => {
      reconciliations += 1;
      return { success: true };
    },
  });

  let caught: unknown;
  try {
    await runAuditedSallaOrderCommand(command);
  } catch (error) {
    caught = error;
  }
  assert.equal(caught, failure);
  assert.equal(reconciliations, 0);

  const desiredHash = sallaOrderPayloadHash({
    payload: command.payload,
    beforeHash: sallaOrderPayloadHash(command.beforeSnapshot),
  });
  const commandId = `soc_${sallaOrderPayloadHash({
    ownerUid: command.ownerUid,
    orderDocId: command.orderDocId,
    commandType: command.commandType,
    desiredHash,
  }).slice(0, 40)}`;
  const stored = await commandData(commandId);
  assert.equal(stored.status, "failed");
  assert.equal(stored.resultStatus, "failed");
  assert.equal(stored.lastError, "Error:INVALID_ORDER:422");
  assert.equal(String(stored.lastError).includes("private@example.test"), false);
  assert.equal(stored.completedAt, null);
});

test("the same desired state can be sent again after the remote state changes", async () => {
  let executions = 0;
  const first = await runAuditedSallaOrderCommand(input("cycle", {
    beforeSnapshot: { status: { slug: "in_progress" } },
    execute: async () => {
      executions += 1;
      return { status: { slug: "completed" } };
    },
  }));
  const second = await runAuditedSallaOrderCommand(input("cycle", {
    beforeSnapshot: { status: { slug: "restoring" } },
    execute: async () => {
      executions += 1;
      return { status: { slug: "completed" } };
    },
  }));

  assert.equal(executions, 2);
  assert.notEqual(first.commandId, second.commandId);
  assert.equal(second.duplicate, false);
});

test("a stale processing lease is quarantined when reconciliation cannot confirm the outcome", async () => {
  let executions = 0;
  const command = input("stale", {
    execute: async () => {
      executions += 1;
      return { status: { slug: "completed" } };
    },
  });
  const beforeHash = sallaOrderPayloadHash(command.beforeSnapshot);
  const desiredHash = sallaOrderPayloadHash({ payload: command.payload, beforeHash });
  const commandId = `soc_${sallaOrderPayloadHash({
    ownerUid: command.ownerUid,
    orderDocId: command.orderDocId,
    commandType: command.commandType,
    desiredHash,
  }).slice(0, 40)}`;
  await adminDb.collection("salla_order_commands").doc(commandId).set({
    ownerUid: command.ownerUid,
    orderDocId: command.orderDocId,
    remoteOrderId: command.remoteOrderId,
    commandType: command.commandType,
    desiredHash,
    payload: {},
    status: "processing",
    attemptCount: 1,
    beforeHash,
    actorUid: command.actorUid,
    createdAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
  });

  await assert.rejects(
    () => runAuditedSallaOrderCommand(command),
    /unconfirmed remote outcome/,
  );
  assert.equal(executions, 0);
  assert.equal((await commandData(commandId)).status, "outcome_unknown");
});

test("an unconfirmed mutation is never sent again by an identical retry", async () => {
  let executions = 0;
  let reconciliations = 0;
  const uncertain = Object.assign(new Error("network timeout"), { outcomeUnknown: true });
  const command = input("unknown-no-retry", {
    execute: async () => {
      executions += 1;
      throw uncertain;
    },
    reconcile: async () => {
      reconciliations += 1;
      return { success: false, resultStatus: "not_applied" };
    },
  });

  await assert.rejects(() => runAuditedSallaOrderCommand(command), /network timeout/);
  await assert.rejects(
    () => runAuditedSallaOrderCommand(command),
    /unconfirmed remote outcome/,
  );

  assert.equal(executions, 1);
  assert.equal(reconciliations, 2);
  const beforeHash = sallaOrderPayloadHash(command.beforeSnapshot);
  const desiredHash = sallaOrderPayloadHash({ payload: command.payload, beforeHash });
  const commandId = `soc_${sallaOrderPayloadHash({
    ownerUid: command.ownerUid,
    orderDocId: command.orderDocId,
    commandType: command.commandType,
    desiredHash,
  }).slice(0, 40)}`;
  assert.equal((await commandData(commandId)).status, "outcome_unknown");
});

test("a stale lease reconciles a remote success before considering another write", async () => {
  let executions = 0;
  const command = input("stale-success", {
    execute: async () => {
      executions += 1;
      return { status: { slug: "completed" } };
    },
    reconcile: async () => ({
      success: true,
      result: { status: { slug: "completed" } },
      afterSnapshot: { status: { slug: "completed" } },
      resultStatus: "completed",
    }),
  });
  const beforeHash = sallaOrderPayloadHash(command.beforeSnapshot);
  const desiredHash = sallaOrderPayloadHash({ payload: command.payload, beforeHash });
  const commandId = `soc_${sallaOrderPayloadHash({
    ownerUid: command.ownerUid,
    orderDocId: command.orderDocId,
    commandType: command.commandType,
    desiredHash,
  }).slice(0, 40)}`;
  await adminDb.collection("salla_order_commands").doc(commandId).set({
    ownerUid: command.ownerUid,
    orderDocId: command.orderDocId,
    remoteOrderId: command.remoteOrderId,
    commandType: command.commandType,
    desiredHash,
    payload: {},
    status: "processing",
    attemptCount: 1,
    beforeHash,
    actorUid: command.actorUid,
    createdAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
  });

  const result = await runAuditedSallaOrderCommand(command);
  assert.equal(result.reconciled, true);
  assert.equal(executions, 0);
  assert.equal((await commandData(commandId)).status, "completed");
});
