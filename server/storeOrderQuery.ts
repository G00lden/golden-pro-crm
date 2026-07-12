import { adminDb } from "./firebaseAdmin";
import { MAX_OWNED_SCAN_LIMIT, type OwnedRecord } from "./repositories/ownedRepository";
import {
  filterStoreOrderRecords,
  paginateStoreOrderRecords,
  parseStoreOrderListQuery,
  type StoreOrderPage,
} from "./storeOrderPagination";

export function normalizeStoreOrderRemoteFields<T extends Record<string, unknown>>(order: T) {
  return {
    ...order,
    remote_status_id: order.remote_status_id ?? order.remoteStatusId ?? null,
    remote_status_name: order.remote_status_name ?? order.remoteStatusName ?? null,
    remote_status_slug: order.remote_status_slug ?? order.remoteStatusSlug ?? null,
    remote_updated_at: order.remote_updated_at ?? order.remoteUpdatedAt ?? null,
    remote_synced_at: order.remote_synced_at ?? order.remoteSyncedAt ?? null,
    sync_origin: order.sync_origin ?? order.syncOrigin ?? null,
    remote_deleted_at: order.remote_deleted_at ?? order.remoteDeletedAt ?? null,
  };
}

export async function getStoreOrderPageForUser(
  ownerUid: string,
  rawQuery: Record<string, unknown> = {},
): Promise<StoreOrderPage> {
  const query = parseStoreOrderListQuery(rawQuery);
  const snapshot = await adminDb
    .collection("store_orders")
    .where("createdBy", "==", ownerUid)
    .orderBy("imported_at", "desc")
    .limit(MAX_OWNED_SCAN_LIMIT + 1)
    .get();
  const loaded = snapshot.docs.map((doc) => normalizeStoreOrderRemoteFields({
    id: doc.id,
    ...(doc.data() || {}),
  })) as OwnedRecord[];
  const capped = loaded.length > MAX_OWNED_SCAN_LIMIT;
  const accessible = loaded.slice(0, MAX_OWNED_SCAN_LIMIT);
  const filtered = filterStoreOrderRecords(accessible, query);
  return paginateStoreOrderRecords(filtered, query, {
    total: filtered.length,
    capped,
  });
}
