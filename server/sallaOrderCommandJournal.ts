import crypto from "node:crypto";
import { adminDb } from "./firebaseAdmin";
import { compareAndSetDocument } from "./atomicDocumentUpdate";
import { sallaOrderPayloadHash } from "./sallaOrderControl";

type UnknownRecord = Record<string, unknown>;

export type SallaOrderCommandReconciliation<T> = boolean | {
  success: boolean;
  result?: T | null;
  afterSnapshot?: unknown;
  resultStatus?: string | null;
};

export type RunAuditedSallaOrderCommandInput<T> = {
  ownerUid: string;
  actorUid: string;
  orderDocId: string;
  remoteOrderId: string | null;
  commandType: string;
  payload: unknown;
  beforeSnapshot: unknown;
  execute: () => Promise<T>;
  reconcile: (error: unknown) => Promise<SallaOrderCommandReconciliation<T>>;
};

export type AuditedSallaOrderCommandResult<T> = {
  commandId: string;
  desiredHash: string;
  duplicate: boolean;
  reconciled: boolean;
  result: T | null;
};

const commandLocks = new Map<string, Promise<unknown>>();

function nowIso() {
  return new Date().toISOString();
}

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function requiredText(value: unknown, label: string, maximum = 240) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maximum) {
    throw new Error(`${label} is required and must not exceed ${maximum} characters.`);
  }
  return normalized;
}

function nullableText(value: unknown, maximum = 240) {
  if (value === null || value === undefined || value === "") return null;
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maximum) {
    throw new Error(`remoteOrderId must not exceed ${maximum} characters.`);
  }
  return normalized;
}

function safePayloadField(field: string) {
  return /^[A-Za-z0-9_.-]{1,64}$/.test(field) ? field : "[redacted]";
}

function sanitizePayloadForJournal(payload: unknown): UnknownRecord {
  if (Array.isArray(payload)) {
    return { redacted: true, kind: "array", itemCount: payload.length };
  }
  if (payload && typeof payload === "object") {
    const fields = [...new Set(Object.keys(payload as UnknownRecord).map(safePayloadField))]
      .sort()
      .slice(0, 100);
    return { redacted: true, kind: "object", fields };
  }
  return { redacted: true, kind: payload === null ? "null" : typeof payload };
}

function safeErrorSummary(error: unknown, fallback: string) {
  const record = asRecord(error);
  const name = error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(error.name)
    ? error.name
    : fallback;
  const code = typeof record.code === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(record.code)
    ? record.code
    : null;
  const status = Number.isInteger(Number(record.status))
    ? String(Number(record.status))
    : null;
  return [name, code, status].filter(Boolean).join(":").slice(0, 200) || fallback;
}

function safeResultStatus(value: unknown, fallback: string) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized && /^[\p{L}\p{N}_.:-]{1,80}$/u.test(normalized)
    ? normalized
    : fallback;
}

function commandIdentity(input: {
  ownerUid: string;
  orderDocId: string;
  commandType: string;
  desiredHash: string;
}) {
  return `soc_${sallaOrderPayloadHash(input).slice(0, 40)}`;
}

async function withCommandLock<T>(key: string, task: () => Promise<T>) {
  const previous = commandLocks.get(key) || Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  commandLocks.set(key, run);
  try {
    return await run;
  } finally {
    if (commandLocks.get(key) === run) commandLocks.delete(key);
  }
}

function isOutcomeUnknown(error: unknown) {
  return asRecord(error).outcomeUnknown === true;
}

function isAlreadyExists(error: unknown) {
  const record = asRecord(error);
  return record.code === "ALREADY_EXISTS" || record.code === 6 ||
    /already exists|duplicate key|constraint/i.test(error instanceof Error ? error.message : String(error));
}

function commandInProgressError(commandId: string) {
  const error = new Error(`Salla order command ${commandId} is already processing.`) as Error & { status?: number };
  error.status = 409;
  return error;
}

function commandOutcomeUnknownError(commandId: string) {
  const error = new Error(
    `Salla order command ${commandId} has an unconfirmed remote outcome and will not be sent again automatically.`,
  ) as Error & { status?: number; code?: string; outcomeUnknown?: boolean };
  error.status = 409;
  error.code = "SALLA_COMMAND_OUTCOME_UNKNOWN";
  error.outcomeUnknown = true;
  return error;
}

function hasActiveLease(record: UnknownRecord, now = Date.now()) {
  if (record.status !== "processing") return false;
  const updatedAt = Date.parse(String(record.updatedAt || record.updated_at || record.createdAt || record.created_at || ""));
  return Number.isFinite(updatedAt) && now - updatedAt < 2 * 60_000;
}

export async function runAuditedSallaOrderCommand<T>(
  input: RunAuditedSallaOrderCommandInput<T>,
): Promise<AuditedSallaOrderCommandResult<T>> {
  const ownerUid = requiredText(input.ownerUid, "ownerUid");
  const actorUid = requiredText(input.actorUid, "actorUid");
  const orderDocId = requiredText(input.orderDocId, "orderDocId");
  const remoteOrderId = nullableText(input.remoteOrderId);
  const commandType = requiredText(input.commandType, "commandType", 120);
  if (typeof input.execute !== "function" || typeof input.reconcile !== "function") {
    throw new Error("execute and reconcile callbacks are required.");
  }

  const beforeHash = sallaOrderPayloadHash(input.beforeSnapshot);
  // Include the observed pre-command snapshot so a legitimate A -> B -> A
  // transition is not mistaken for the earlier command that also desired A.
  // Exact retries from the same observed state still collapse to one command.
  const desiredHash = sallaOrderPayloadHash({ payload: input.payload, beforeHash });
  const commandId = commandIdentity({ ownerUid, orderDocId, commandType, desiredHash });

  return withCommandLock(commandId, async () => {
    const ref = adminDb.collection("salla_order_commands").doc(commandId);
    const existing = await ref.get();
    const previous = existing.exists ? existing.data() || {} : {};
    if (previous.status === "completed") {
      return {
        commandId,
        desiredHash,
        duplicate: true,
        reconciled: false,
        result: null,
      };
    }
    if (hasActiveLease(previous)) throw commandInProgressError(commandId);
    const recoveringUnknownOutcome = previous.status === "processing" || previous.status === "outcome_unknown";
    const startedAt = nowIso();
    const leaseToken = crypto.randomUUID();
    const attemptCount = Math.max(0, Number(previous.attemptCount ?? previous.attempt_count ?? 0)) + 1;
    const processingRecord = {
      ownerUid,
      orderDocId,
      remoteOrderId,
      commandType,
      desiredHash,
      payload: sanitizePayloadForJournal(input.payload),
      status: "processing",
      attemptCount,
      beforeHash,
      afterHash: null,
      resultStatus: recoveringUnknownOutcome ? "reconciling" : "executing",
      lastError: null,
      actorUid,
      leaseToken,
      createdAt: previous.createdAt || previous.created_at || startedAt,
      updatedAt: startedAt,
      completedAt: null,
    };
    if (existing.exists) {
      const claimed = await compareAndSetDocument(ref, {
        status: previous.status,
        leaseToken: previous.leaseToken ?? previous.lease_token ?? null,
      }, processingRecord);
      if (!claimed) {
        const competing = await ref.get();
        if (competing.exists && competing.data()?.status === "completed") {
          return {
            commandId,
            desiredHash,
            duplicate: true,
            reconciled: false,
            result: null,
          };
        }
        throw commandInProgressError(commandId);
      }
    } else {
      try {
        await ref.create(processingRecord);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        const competing = await ref.get();
        if (competing.exists && competing.data()?.status === "completed") {
          return {
            commandId,
            desiredHash,
            duplicate: true,
            reconciled: false,
            result: null,
          };
        }
        throw commandInProgressError(commandId);
      }
    }

    if (recoveringUnknownOutcome) {
      const recoveryError = Object.assign(
        new Error("A previous Salla command ended without a confirmed remote outcome."),
        { outcomeUnknown: true, code: "PREVIOUS_OUTCOME_UNKNOWN" },
      );
      let reconciliation: SallaOrderCommandReconciliation<T>;
      try {
        reconciliation = await input.reconcile(recoveryError);
      } catch (error) {
        const unresolvedAt = nowIso();
        await compareAndSetDocument(ref, { status: "processing", leaseToken }, {
          status: "outcome_unknown",
          resultStatus: "reconciliation_failed",
          lastError: safeErrorSummary(error, "RECONCILIATION_FAILED"),
          leaseToken: null,
          updatedAt: unresolvedAt,
          completedAt: null,
        });
        throw commandOutcomeUnknownError(commandId);
      }
      const record = typeof reconciliation === "object" && reconciliation ? reconciliation : null;
      if (reconciliation === true || record?.success === true) {
        const completedAt = nowIso();
        const completed = await compareAndSetDocument(ref, { status: "processing", leaseToken }, {
          status: "completed",
          afterHash: sallaOrderPayloadHash(record?.afterSnapshot ?? record?.result ?? { reconciled: true }),
          resultStatus: safeResultStatus(record?.resultStatus, "stale_reconciled"),
          lastError: null,
          leaseToken: null,
          updatedAt: completedAt,
          completedAt,
        });
        if (!completed) throw commandInProgressError(commandId);
        return {
          commandId,
          desiredHash,
          duplicate: false,
          reconciled: true,
          result: record?.result ?? null,
        };
      }
      const unresolvedAt = nowIso();
      await compareAndSetDocument(ref, { status: "processing", leaseToken }, {
        status: "outcome_unknown",
        resultStatus: safeResultStatus(record?.resultStatus, "reconciliation_unconfirmed"),
        lastError: "OUTCOME_UNKNOWN",
        leaseToken: null,
        updatedAt: unresolvedAt,
        completedAt: null,
      });
      throw commandOutcomeUnknownError(commandId);
    }

    try {
      const result = await input.execute();
      const completedAt = nowIso();
      const completed = await compareAndSetDocument(ref, { status: "processing", leaseToken }, {
        status: "completed",
        afterHash: sallaOrderPayloadHash(result),
        resultStatus: "executed",
        lastError: null,
        leaseToken: null,
        updatedAt: completedAt,
        completedAt,
      });
      if (!completed) throw commandOutcomeUnknownError(commandId);
      return {
        commandId,
        desiredHash,
        duplicate: false,
        reconciled: false,
        result: result ?? null,
      };
    } catch (error) {
      if (isOutcomeUnknown(error)) {
        try {
          const reconciliation = await input.reconcile(error);
          const reconciliationRecord = typeof reconciliation === "object" && reconciliation
            ? reconciliation
            : null;
          if (reconciliation === true || reconciliationRecord?.success === true) {
            const completedAt = nowIso();
            const afterSnapshot = reconciliationRecord?.afterSnapshot ??
              reconciliationRecord?.result ??
              { reconciled: true };
            const completed = await compareAndSetDocument(ref, { status: "processing", leaseToken }, {
              status: "completed",
              afterHash: sallaOrderPayloadHash(afterSnapshot),
              resultStatus: safeResultStatus(reconciliationRecord?.resultStatus, "reconciled"),
              lastError: null,
              leaseToken: null,
              updatedAt: completedAt,
              completedAt,
            });
            if (!completed) throw commandOutcomeUnknownError(commandId);
            return {
              commandId,
              desiredHash,
              duplicate: false,
              reconciled: true,
              result: reconciliationRecord?.result ?? null,
            };
          }

          const unresolvedAt = nowIso();
          await compareAndSetDocument(ref, { status: "processing", leaseToken }, {
            status: "outcome_unknown",
            resultStatus: safeResultStatus(reconciliationRecord?.resultStatus, "reconciliation_unconfirmed"),
            lastError: safeErrorSummary(error, "OUTCOME_UNKNOWN"),
            leaseToken: null,
            updatedAt: unresolvedAt,
            completedAt: null,
          });
        } catch (reconciliationError) {
          const unresolvedAt = nowIso();
          await compareAndSetDocument(ref, { status: "processing", leaseToken }, {
            status: "outcome_unknown",
            resultStatus: "reconciliation_failed",
            lastError: safeErrorSummary(reconciliationError, "RECONCILIATION_FAILED"),
            leaseToken: null,
            updatedAt: unresolvedAt,
            completedAt: null,
          });
        }
      } else {
        const failedAt = nowIso();
        await compareAndSetDocument(ref, { status: "processing", leaseToken }, {
          status: "failed",
          resultStatus: "failed",
          lastError: safeErrorSummary(error, "COMMAND_FAILED"),
          leaseToken: null,
          updatedAt: failedAt,
          completedAt: null,
        });
      }
      throw error;
    }
  });
}

export function resetSallaOrderCommandJournalForTests() {
  commandLocks.clear();
}
