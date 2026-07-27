import db from "./db";
import { communicationJobStore, type CommunicationJob } from "./communicationJobs";
import { isDryRunSendResult } from "./outboundSafety";
import { listTemplateNames, type TemplateName } from "./whatsappTemplates";
import { sendWhatsAppTemplate } from "./whatsapp";
import { logError, logEvent } from "./logger";
import type { RenderVars } from "./whatsappTemplates";
import { communicationCampaignStore } from "./communicationCampaigns";
import { evaluateCallReplyRecipient, evaluateCallReplySource } from "./callReplyPolicy";
import { communicationPreferenceStore } from "./communicationPreferences";
import { sallaCartConciergeStore } from "./sallaCartConcierge";
import { saveWhatsAppCommerceSession } from "./whatsappCommerceStorage";
import { deliveryReviewStore } from "./deliveryReview";

let timer: ReturnType<typeof setInterval> | undefined;
let running = false;

function isTemplateName(value: string | null): value is TemplateName {
  return Boolean(value && listTemplateNames().includes(value as TemplateName));
}

function renderVars(value: unknown): RenderVars {
  if (!value || typeof value !== "object") return {};
  const output: RenderVars = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string" || typeof item === "number" || item === null || item === undefined) {
      output[key] = item as string | number | null | undefined;
    }
  }
  return output;
}

function updateCall(job: CommunicationJob, status: string, notified = false) {
  if (!job.call_id) return;
  const customer = job.role === "customer";
  const statusColumn = customer ? "wa_customer_status" : "wa_agent_status";
  const jobColumn = customer ? "wa_customer_job_id" : "wa_agent_job_id";
  const notifiedColumn = customer ? "wa_customer_notified" : "wa_agent_notified";
  db.prepare(
    `UPDATE call_logs SET ${statusColumn} = ?, ${jobColumn} = ?, ${notifiedColumn} = ?, updated_at = ?
     WHERE owner_uid = ? AND id = ?`,
  ).run(status, job.id, notified ? 1 : 0, new Date().toISOString(), job.owner_uid, job.call_id);
}

function bulkAuthorization(job: CommunicationJob) {
  if (job.payload.purpose !== "call_bulk_manual") return { allowed: true, outboundCode: undefined as string | undefined };
  const runId = String(job.payload.bulkRunId || "");
  if (!runId) return { allowed: false, outboundCode: undefined };
  const run = db.prepare(
    `SELECT status FROM call_bulk_runs WHERE id = ? AND owner_uid = ? AND action = 'whatsapp' LIMIT 1`,
  ).get(runId, job.owner_uid) as { status?: string } | undefined;
  if (!run || !["confirmed", "queued", "processing"].includes(String(run.status || ""))) {
    return { allowed: false, outboundCode: undefined };
  }
  return { allowed: true, outboundCode: process.env.OUTBOUND_CONFIRM_CODE || undefined };
}

function updateBulkRun(job: CommunicationJob) {
  const runId = String(job.payload.bulkRunId || "");
  if (!runId) return;
  const counts = db.prepare(
    `SELECT status, COUNT(*) AS count FROM communication_jobs
     WHERE owner_uid = ? AND json_extract(payload, '$.bulkRunId') = ? GROUP BY status`,
  ).all(job.owner_uid, runId) as Array<{ status: string; count: number }>;
  const byStatus = new Map(counts.map((item) => [item.status, Number(item.count || 0)]));
  const waiting = ["pending", "processing", "retry"].reduce((sum, status) => sum + (byStatus.get(status) || 0), 0);
  const failures = ["failed", "blocked", "expired"].reduce((sum, status) => sum + (byStatus.get(status) || 0), 0);
  if (waiting > 0) {
    db.prepare("UPDATE call_bulk_runs SET status = 'processing' WHERE id = ? AND owner_uid = ?")
      .run(runId, job.owner_uid);
    return;
  }
  db.prepare(
    `UPDATE call_bulk_runs SET status = ?, completed_at = ? WHERE id = ? AND owner_uid = ?`,
  ).run(failures ? "completed_with_errors" : "completed", new Date().toISOString(), runId, job.owner_uid);
}

function sallaCartId(job: CommunicationJob) {
  return job.payload.purpose === "salla_abandoned_cart"
    ? String(job.payload.cartId || "").trim()
    : "";
}

function blockSallaCartJob(job: CommunicationJob, reason: string) {
  const blocked = communicationJobStore.markBlocked(job.id, reason);
  const cartId = sallaCartId(job);
  if (cartId) {
    sallaCartConciergeStore.setOutreach(job.owner_uid, cartId, {
      status: reason,
      jobId: job.id,
    });
  }
  return blocked;
}

function sallaCartAuthorization(job: CommunicationJob) {
  const cartId = sallaCartId(job);
  if (!cartId) return { allowed: true as const };
  const cart = sallaCartConciergeStore.get(job.owner_uid, cartId);
  if (!cart || cart.status !== "active") {
    return { allowed: false as const, reason: cart ? `salla_cart_${cart.status}` : "salla_cart_missing" };
  }
  const consent = communicationPreferenceStore.marketingEligibility(
    job.owner_uid,
    job.recipient_phone,
    "whatsapp",
  );
  if (!consent.eligible) {
    return { allowed: false as const, reason: `salla_cart_${consent.reason || "not_eligible"}` };
  }
  return { allowed: true as const };
}

function startSallaCartConversation(job: CommunicationJob) {
  const cartId = sallaCartId(job);
  if (!cartId) return;
  const checkoutUrl = String(job.payload.checkoutUrl || "").trim();
  const products = Array.isArray(job.payload.products) ? job.payload.products : [];
  saveWhatsAppCommerceSession(db, {
    ownerUid: job.owner_uid,
    phone: job.recipient_phone,
    step: "awaiting_cart_question",
    context: {
      cart: {
        cartId,
        checkoutUrl,
        customerName: String(job.payload.customerName || ""),
        products,
      },
    },
    ttlMinutes: Math.max(
      60,
      Math.min(7 * 24 * 60, Number(process.env.SALLA_CART_WHATSAPP_SESSION_MINUTES || 1440)),
    ),
  });
}

function deliveryReviewId(job: CommunicationJob) {
  return job.payload.purpose === "salla_delivery_review"
    ? String(job.payload.orderId || "").trim()
    : "";
}

function blockDeliveryReviewJob(job: CommunicationJob, reason: string) {
  const blocked = communicationJobStore.markBlocked(job.id, reason);
  const orderId = deliveryReviewId(job);
  if (orderId) {
    deliveryReviewStore.setOutreach(job.owner_uid, orderId, {
      status: reason,
      jobId: job.id,
    });
  }
  return blocked;
}

function deliveryReviewAuthorization(job: CommunicationJob) {
  const orderId = deliveryReviewId(job);
  if (!orderId) return { allowed: true as const };
  const review = deliveryReviewStore.get(job.owner_uid, orderId);
  if (!review || !["queued", "retry"].includes(review.status)) {
    return {
      allowed: false as const,
      reason: review ? `salla_delivery_review_${review.status}` : "salla_delivery_review_missing",
    };
  }
  if (process.env.SALLA_DELIVERY_REVIEW_ENABLED === "false") {
    return { allowed: false as const, reason: "salla_delivery_review_feature_disabled" };
  }
  const consent = communicationPreferenceStore.marketingEligibility(
    job.owner_uid,
    job.recipient_phone,
    "whatsapp",
  );
  if (!consent.eligible) {
    return {
      allowed: false as const,
      reason: `salla_delivery_review_${consent.reason || "not_eligible"}`,
    };
  }
  return { allowed: true as const };
}

function startDeliveryReviewConversation(job: CommunicationJob) {
  const orderId = deliveryReviewId(job);
  if (!orderId) return;
  saveWhatsAppCommerceSession(db, {
    ownerUid: job.owner_uid,
    phone: job.recipient_phone,
    step: "awaiting_delivery_rating",
    context: {
      deliveryReview: {
        orderId,
        orderNumber: String(job.payload.orderNumber || orderId),
        customerName: String(job.payload.customerName || ""),
      },
    },
    ttlMinutes: Math.max(
      60,
      Math.min(7 * 24 * 60, Number(process.env.SALLA_DELIVERY_REVIEW_SESSION_MINUTES || 10080)),
    ),
  });
}

export async function processNextCommunicationJob(): Promise<CommunicationJob | null> {
  const job = communicationJobStore.claimNext();
  if (!job) return null;
  updateCall(job, "processing");
  if (job.campaign_id) communicationCampaignStore.updateRecipient(job, "processing");

  try {
    const bulkAuth = bulkAuthorization(job);
    if (!bulkAuth.allowed) {
      const blocked = communicationJobStore.markBlocked(job.id, "call_bulk_authorization_missing");
      if (blocked) updateCall(blocked, "blocked");
      if (blocked) updateBulkRun(blocked);
      return blocked;
    }
    if (job.role === "customer" && job.payload.purpose === "call_auto") {
      const decision = evaluateCallReplyRecipient(job.owner_uid, job.recipient_phone);
      const source = evaluateCallReplySource(decision.policy, {
        source: job.payload.source,
        deviceId: job.payload.deviceId,
        simKey: job.payload.simKey,
      });
      if (!decision.allowed || !source.allowed) {
        const blocked = communicationJobStore.markBlocked(
          job.id,
          `call_reply_policy:${decision.allowed ? source.reason : decision.reason}`,
        );
        if (blocked) updateCall(blocked, "blocked");
        return blocked;
      }
    }
    const cartAuthorization = sallaCartAuthorization(job);
    if (!cartAuthorization.allowed) {
      return blockSallaCartJob(job, cartAuthorization.reason);
    }
    const reviewAuthorization = deliveryReviewAuthorization(job);
    if (!reviewAuthorization.allowed) {
      return blockDeliveryReviewJob(job, reviewAuthorization.reason);
    }
    const guard = communicationCampaignStore.guardJob(job);
    if (guard.action === "defer") {
      const deferred = communicationJobStore.defer(job.id, 60_000, guard.reason);
      if (deferred) communicationCampaignStore.updateRecipient(deferred, "queued", guard.reason);
      return deferred;
    }
    if (guard.action === "block") {
      const blocked = communicationJobStore.markBlocked(job.id, guard.reason);
      if (blocked) communicationCampaignStore.updateRecipient(blocked, "blocked", guard.reason);
      return blocked;
    }
    if (job.kind !== "whatsapp_template" || !isTemplateName(job.template_name)) {
      throw new Error(`Unsupported communication job: ${job.kind}/${job.template_name || "missing-template"}`);
    }
    const vars = renderVars(job.payload.vars && typeof job.payload.vars === "object" ? job.payload.vars : job.payload);
    const result = await sendWhatsAppTemplate({
      phone: job.recipient_phone,
      template: job.template_name,
      vars,
      owner_uid: job.owner_uid,
      outboundCode: bulkAuth.outboundCode,
    });
    if (isDryRunSendResult(result)) {
      const blocked = sallaCartId(job)
        ? blockSallaCartJob(job, result.reason)
        : deliveryReviewId(job)
          ? blockDeliveryReviewJob(job, result.reason)
          : communicationJobStore.markBlocked(job.id, result.reason);
      if (blocked) updateCall(blocked, "blocked");
      if (blocked) communicationCampaignStore.updateRecipient(blocked, "blocked", result.reason);
      if (blocked) updateBulkRun(blocked);
      return blocked;
    }
    const sent = communicationJobStore.markSent(job.id, result.messageId);
    const cartId = sallaCartId(job);
    if (sent && cartId) {
      sallaCartConciergeStore.setOutreach(job.owner_uid, cartId, {
        status: "sent",
        jobId: job.id,
        providerMessageId: result.messageId,
        sentAt: sent.sent_at,
      });
      startSallaCartConversation(job);
    }
    const orderId = deliveryReviewId(job);
    if (sent && orderId) {
      deliveryReviewStore.setOutreach(job.owner_uid, orderId, {
        status: "sent",
        jobId: job.id,
        providerMessageId: result.messageId,
        requestedAt: sent.sent_at,
      });
      startDeliveryReviewConversation(job);
    }
    if (sent) updateCall(sent, "sent", true);
    if (sent) communicationCampaignStore.updateRecipient(sent, "sent", null, result.messageId);
    if (sent) updateBulkRun(sent);
    logEvent("info", "communication.job.sent", { jobId: job.id, kind: job.kind, role: job.role });
    return sent;
  } catch (error) {
    const failed = communicationJobStore.markFailed(job.id, error);
    const cartId = sallaCartId(job);
    if (failed && cartId) {
      sallaCartConciergeStore.setOutreach(job.owner_uid, cartId, {
        status: failed.status,
        jobId: job.id,
      });
    }
    const orderId = deliveryReviewId(job);
    if (failed && orderId) {
      deliveryReviewStore.setOutreach(job.owner_uid, orderId, {
        status: failed.status,
        jobId: job.id,
      });
    }
    if (failed) updateCall(failed, failed.status);
    if (failed) communicationCampaignStore.updateRecipient(failed, failed.status, failed.last_error);
    if (failed && ["failed", "blocked", "expired"].includes(failed.status)) updateBulkRun(failed);
    logError("communication.job.failed", error, { jobId: job.id, attempts: job.attempts });
    return failed;
  }
}

export function startCommunicationWorker() {
  if (timer || process.env.COMMUNICATION_WORKER_ENABLED === "false") return;
  const intervalMs = Math.max(500, Number(process.env.COMMUNICATION_WORKER_INTERVAL_MS || 2_000));
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      communicationCampaignStore.activateDue();
      for (let i = 0; i < 10; i += 1) {
        if (!await processNextCommunicationJob()) break;
      }
    } catch (error) {
      logError("communication.worker.tick_failed", error);
    } finally {
      running = false;
    }
  };
  timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();
  logEvent("info", "communication.worker.enabled", { intervalMs });
}
