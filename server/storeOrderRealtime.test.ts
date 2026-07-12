import assert from "node:assert/strict";
import test from "node:test";
import {
  publishStoreOrderChange,
  storeOrderRealtimeListenerCount,
  subscribeStoreOrderChanges,
} from "./storeOrderRealtime";

test("store order events are isolated by owner and unsubscribe cleanly", () => {
  const ownerA: string[] = [];
  const ownerB: string[] = [];
  const unsubscribeA = subscribeStoreOrderChanges("owner-a", (event) => ownerA.push(event.type));
  const unsubscribeB = subscribeStoreOrderChanges("owner-b", (event) => ownerB.push(event.type));

  publishStoreOrderChange("owner-a", { type: "order.updated", source: "salla_webhook" });
  assert.deepEqual(ownerA, ["order.updated"]);
  assert.deepEqual(ownerB, []);
  assert.equal(storeOrderRealtimeListenerCount(), 2);

  unsubscribeA();
  unsubscribeB();
  assert.equal(storeOrderRealtimeListenerCount(), 0);
});

test("one broken realtime listener cannot block other listeners", () => {
  let delivered = false;
  const stopBroken = subscribeStoreOrderChanges("owner-c", () => {
    throw new Error("disconnected");
  });
  const stopHealthy = subscribeStoreOrderChanges("owner-c", () => {
    delivered = true;
  });

  publishStoreOrderChange("owner-c", { type: "sync.completed", source: "salla_sync" });
  assert.equal(delivered, true);
  stopBroken();
  stopHealthy();
});
