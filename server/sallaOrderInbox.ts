import crypto from "node:crypto";
import { adminDb } from "./firebaseAdmin";
import { compareAndSetDocument } from "./atomicDocumentUpdate";

export const SALLA_ORDER_EVENTS = new Set([
  "order.created",
  "order.updated",
  "order.status.updated",
  "order.cancelled",
  "order.refunded",
  "order.restored",
  "order.deleted",
  "order.products.updated",
  "order.payment.updated",
  "order.coupon.updated",
  "order.total.price.updated",
  "order.shipping.address.updated",
  "order.shipping.updated",
  "order.shipment.creating",
  "order.shipment.created",
  "order.shipment.updated",
  "order.shipment.cancelled",
  "order.shipment.return.created",
  "order.shipment.return.creating",
  "order.shipment.return.cancelled",
  "order.customer.updated",
]);

type InboxTask<T> = () => Promise<T>;

type SallaOrderInboxInput = {
  ownerUid: string;
  merchantId: string | null;
  eventType: string;
  remoteOrderId: string | null;
  rawBody: Buffer;
  occurredAt?: string | null;
};

type SallaOrderInboxResult<T> = {
  duplicate: boolean;
  inboxId: string;
  result: T | null;
};

const inboxLocks = new Map<string, Promise<unknown>>();

function nowIso() {
  return new Date().toISOString();
}

function digest(value: string | Buffer) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function isAlreadyExists(error: unknown) {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  return record.code === "ALREADY_EXISTS" || record.code === 6 ||
    /already exists|duplicate key|constraint/i.test(error instanceof Error ? error.message : String(error));
}

function inboxInProgressError(inboxId: string) {
  const error = new Error(`Salla order event ${inboxId} is already processing.`) as Error & { status?: number };
  error.status = 503;
  return error;
}

function inboxLeaseLostError(inboxId: string) {
  const error = new Error(`Salla order event ${inboxId} lost its processing lease.`) as Error & { status?: number };
  error.status = 503;
  return error;
}

function hasActiveLease(record: Record<string, unknown>, now = Date.now()) {
  if (record.status !== "processing") return false;
  const updatedAt = Date.parse(String(record.updatedAt || record.updated_at || record.receivedAt || record.received_at || ""));
  return Number.isFinite(updatedAt) && now - updatedAt < 2 * 60_000;
}

export function sallaOrderInboxIdentity(input: SallaOrderInboxInput) {
  const payloadHash = digest(input.rawBody);
  const identity = [
    input.ownerUid,
    input.merchantId || "unknown-merchant",
    input.eventType,
    input.remoteOrderId || "unknown-order",
    input.occurredAt || "unknown-time",
    payloadHash,
  ].join(":");
  return {
    id: `soi_${digest(identity).slice(0, 40)}`,
    payloadHash,
  };
}

async function withInboxLock<T>(key: string, task: InboxTask<T>) {
  const previous = inboxLocks.get(key) || Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  inboxLocks.set(key, run);
  try {
    return await run;
  } finally {
    if (inboxLocks.get(key) === run) inboxLocks.delete(key);
  }
}

export async function processSallaOrderInbox<T>(
  input: SallaOrderInboxInput,
  task: InboxTask<T>,
): Promise<SallaOrderInboxResult<T>> {
  const identity = sallaOrderInboxIdentity(input);
  return withInboxLock(identity.id, async () => {
    const ref = adminDb.collection("salla_order_inbox").doc(identity.id);
    const existing = await ref.get();
    const previous = existing.exists ? existing.data() || {} : {};
    if (previous.status === "processed") {
      return { duplicate: true, inboxId: identity.id, result: null };
    }
    if (hasActiveLease(previous)) throw inboxInProgressError(identity.id);

    const startedAt = nowIso();
    const leaseToken = crypto.randomUUID();
    const attempts = Math.max(0, Number(previous.attempts || 0)) + 1;
    const processingRecord = {
      ownerUid: input.ownerUid,
      merchantId: input.merchantId,
      eventType: input.eventType,
      remoteOrderId: input.remoteOrderId,
      payloadHash: identity.payloadHash,
      status: "processing",
      attempts,
      receivedAt: previous.receivedAt || startedAt,
      processedAt: null,
      nextAttemptAt: null,
      errorCode: null,
      error: null,
      leaseToken,
      createdAt: previous.createdAt || startedAt,
      updatedAt: startedAt,
    };
    if (existing.exists) {
      const claimed = await compareAndSetDocument(ref, {
        status: previous.status,
        leaseToken: previous.leaseToken ?? previous.lease_token ?? null,
      }, processingRecord);
      if (!claimed) {
        const competing = await ref.get();
        if (competing.exists && competing.data()?.status === "processed") {
          return { duplicate: true, inboxId: identity.id, result: null };
        }
        throw inboxInProgressError(identity.id);
      }
    } else {
      try {
        await ref.create(processingRecord);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        const competing = await ref.get();
        if (competing.exists && competing.data()?.status === "processed") {
          return { duplicate: true, inboxId: identity.id, result: null };
        }
        throw inboxInProgressError(identity.id);
      }
    }

    try {
      const orderLockKey = input.remoteOrderId
        ? `order:${digest(`${input.ownerUid}:${input.merchantId || "unknown-merchant"}:${input.remoteOrderId}`)}`
        : `event:${identity.id}`;
      const result = await withInboxLock(orderLockKey, task);
      const processedAt = nowIso();
      const completed = await compareAndSetDocument(ref, {
        status: "processing",
        leaseToken,
      }, {
        status: "processed",
        processedAt,
        nextAttemptAt: null,
        errorCode: null,
        error: null,
        leaseToken: null,
        updatedAt: processedAt,
      });
      if (!completed) throw inboxLeaseLostError(identity.id);
      return { duplicate: false, inboxId: identity.id, result };
    } catch (error) {
      const failedAt = nowIso();
      const code = String((error as { code?: unknown; status?: unknown })?.code ||
        (error as { status?: unknown })?.status || "PROCESSING_FAILED").slice(0, 80);
      const safeName = error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(error.name)
        ? error.name
        : "PROCESSING_FAILED";
      const message = `${safeName}:${code}`.slice(0, 200);
      await compareAndSetDocument(ref, {
        status: "processing",
        leaseToken,
      }, {
        status: "failed",
        processedAt: null,
        nextAttemptAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        errorCode: code,
        error: message,
        leaseToken: null,
        updatedAt: failedAt,
      });
      throw error;
    }
  });
}

export function resetSallaOrderInboxLocksForTests() {
  inboxLocks.clear();
}
