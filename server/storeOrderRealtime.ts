export type StoreOrderRealtimeEvent = {
  type: "order.created" | "order.updated" | "order.deleted" | "sync.completed";
  orderId?: string | null;
  remoteOrderId?: string | null;
  source: "salla_webhook" | "salla_command" | "salla_sync" | "crm";
  at: string;
};

type StoreOrderRealtimeListener = (event: StoreOrderRealtimeEvent) => void;

const listenersByOwner = new Map<string, Set<StoreOrderRealtimeListener>>();

export function subscribeStoreOrderChanges(ownerUid: string, listener: StoreOrderRealtimeListener) {
  const ownerListeners = listenersByOwner.get(ownerUid) || new Set<StoreOrderRealtimeListener>();
  ownerListeners.add(listener);
  listenersByOwner.set(ownerUid, ownerListeners);

  return () => {
    const current = listenersByOwner.get(ownerUid);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listenersByOwner.delete(ownerUid);
  };
}

export function publishStoreOrderChange(
  ownerUid: string,
  event: Omit<StoreOrderRealtimeEvent, "at"> & { at?: string },
) {
  const normalized: StoreOrderRealtimeEvent = {
    ...event,
    at: event.at || new Date().toISOString(),
  };
  for (const listener of listenersByOwner.get(ownerUid) || []) {
    try {
      listener(normalized);
    } catch {
      // A disconnected browser must never block order ingestion or commands.
    }
  }
}

/** Test-only visibility without exposing listener identities. */
export function storeOrderRealtimeListenerCount(ownerUid?: string) {
  if (ownerUid) return listenersByOwner.get(ownerUid)?.size || 0;
  return [...listenersByOwner.values()].reduce((count, listeners) => count + listeners.size, 0);
}
