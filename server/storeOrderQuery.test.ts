import assert from "node:assert/strict";
import test from "node:test";
import { normalizeStoreOrderRemoteFields } from "./storeOrderQuery";

test("store order query exposes one snake-case remote field contract for every adapter", () => {
  const normalized = normalizeStoreOrderRemoteFields({
    id: "order-a",
    remoteStatusId: "10",
    remoteStatusName: "تم",
    remoteStatusSlug: "completed",
    remoteUpdatedAt: "2026-07-13T00:00:00Z",
    remoteSyncedAt: "2026-07-13T00:01:00Z",
    syncOrigin: "salla_webhook",
  });
  assert.equal(normalized.remote_status_id, "10");
  assert.equal(normalized.remote_status_name, "تم");
  assert.equal(normalized.remote_status_slug, "completed");
  assert.equal(normalized.sync_origin, "salla_webhook");
});
