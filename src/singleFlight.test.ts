import assert from "node:assert/strict";
import test from "node:test";
import { singleFlight, singleFlightByKey } from "./singleFlight";

test("singleFlight coalesces concurrent requests and permits a later refresh", async () => {
  let calls = 0;
  let release: ((value: number) => void) | undefined;
  const load = singleFlight(() => {
    calls += 1;
    return new Promise<number>((resolve) => {
      release = resolve;
    });
  });

  const first = load();
  const duplicate = load();
  assert.equal(first, duplicate);
  assert.equal(calls, 1);
  release?.(7);
  assert.deepEqual(await Promise.all([first, duplicate]), [7, 7]);

  const refresh = load();
  await Promise.resolve();
  assert.equal(calls, 2);
  release?.(9);
  assert.equal(await refresh, 9);
});

test("singleFlight releases a failed request so retry is possible", async () => {
  let calls = 0;
  const load = singleFlight(async () => {
    calls += 1;
    if (calls === 1) throw new Error("temporary failure");
    return "ok";
  });

  const first = load();
  const duplicate = load();
  assert.equal(first, duplicate);
  await assert.rejects(first, /temporary failure/);
  assert.equal(await load(), "ok");
  assert.equal(calls, 2);
});

test("singleFlightByKey never shares a pending response across identities", async () => {
  const calls: string[] = [];
  const releases = new Map<string, (value: string) => void>();
  const load = singleFlightByKey((owner: string) => new Promise<string>((resolve) => {
    calls.push(owner);
    releases.set(owner, resolve);
  }));

  const ownerA = load("owner-a");
  const ownerADuplicate = load("owner-a");
  const ownerB = load("owner-b");
  assert.equal(ownerA, ownerADuplicate);
  assert.notEqual(ownerA, ownerB);
  assert.deepEqual(calls, ["owner-a", "owner-b"]);

  releases.get("owner-a")?.("A");
  releases.get("owner-b")?.("B");
  assert.deepEqual(await Promise.all([ownerA, ownerADuplicate, ownerB]), ["A", "A", "B"]);
});
