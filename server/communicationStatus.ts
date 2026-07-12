const DELIVERY_RANK: Record<string, number> = {
  pending: 0,
  queued: 0,
  sent: 1,
  delivered: 2,
  read: 3,
};

/**
 * Delivery receipts can arrive out of order. Preserve the highest confirmed
 * state and allow a later delivered/read receipt to recover an earlier failure.
 */
export function advanceMessageStatus(current: unknown, incoming: unknown): string {
  const previous = String(current || "").toLowerCase();
  const next = String(incoming || "unknown").toLowerCase();

  if (!previous) return next;
  if (previous === "dry_run" || previous === "blocked" || previous === "expired") return previous;
  if (next === "unknown") return previous;

  if (next === "failed") {
    return (DELIVERY_RANK[previous] ?? -1) >= DELIVERY_RANK.delivered ? previous : "failed";
  }
  if (previous === "failed") {
    return (DELIVERY_RANK[next] ?? -1) >= DELIVERY_RANK.delivered ? next : previous;
  }

  const previousRank = DELIVERY_RANK[previous];
  const nextRank = DELIVERY_RANK[next];
  if (previousRank === undefined) return next;
  if (nextRank === undefined) return previous;
  return nextRank >= previousRank ? next : previous;
}
