import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDepartmentDeletionMessage,
  createDepartmentDeletionController,
  type DepartmentDeletionTarget,
} from "./callSystemDelete";

const department: DepartmentDeletionTarget = {
  id: "department-sales",
  name: "المبيعات",
  digit: "1",
};

test("department deletion dismissal leaves the department untouched", async () => {
  let removeCalls = 0;
  const controller = createDepartmentDeletionController({
    confirm: () => false,
    remove: async () => {
      removeCalls += 1;
    },
  });

  assert.equal(await controller.request(department), "dismissed");
  assert.equal(removeCalls, 0);
  assert.equal(controller.getPendingDepartmentId(), null);
});

test("department deletion confirmation identifies the impact and deletes once", async () => {
  const pendingChanges: Array<string | null> = [];
  const removedIds: string[] = [];
  let confirmationMessage = "";
  const controller = createDepartmentDeletionController({
    confirm: (message) => {
      confirmationMessage = message;
      return true;
    },
    remove: async (id) => {
      removedIds.push(id);
    },
    onPendingChange: (id) => pendingChanges.push(id),
  });

  assert.equal(await controller.request(department), "deleted");
  assert.deepEqual(removedIds, [department.id]);
  assert.deepEqual(pendingChanges, [department.id, null]);
  assert.match(confirmationMessage, /المبيعات/);
  assert.match(confirmationMessage, /الاختيار 1/);
  assert.match(confirmationMessage, /لا يمكن التراجع/);
});

test("rapid repeated department deletion clicks issue only one request", async () => {
  let releaseDeletion: (() => void) | undefined;
  let removeCalls = 0;
  const deletionFinished = new Promise<void>((resolve) => {
    releaseDeletion = resolve;
  });
  const controller = createDepartmentDeletionController({
    confirm: () => true,
    remove: async () => {
      removeCalls += 1;
      await deletionFinished;
    },
  });

  const first = controller.request(department);
  const second = controller.request(department);

  assert.equal(await second, "ignored");
  assert.equal(removeCalls, 1);
  assert.equal(controller.getPendingDepartmentId(), department.id);

  releaseDeletion?.();
  assert.equal(await first, "deleted");
  assert.equal(controller.getPendingDepartmentId(), null);
});

test("failed department deletion always releases the pending guard", async () => {
  const expected = new Error("delete failed");
  const controller = createDepartmentDeletionController({
    confirm: () => true,
    remove: async () => {
      throw expected;
    },
  });

  await assert.rejects(controller.request(department), expected);
  assert.equal(controller.getPendingDepartmentId(), null);
});
