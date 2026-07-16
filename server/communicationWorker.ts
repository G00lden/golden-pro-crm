import db from "./db";
import { communicationJobStore, type CommunicationJob } from "./communicationJobs";
import { isDryRunSendResult } from "./outboundSafety";
import { listTemplateNames, type TemplateName } from "./whatsappTemplates";
import { sendWhatsAppTemplate } from "./whatsapp";
import { logError, logEvent } from "./logger";
import type { RenderVars } from "./whatsappTemplates";
import { communicationCampaignStore } from "./communicationCampaigns";
import { evaluateCallReplyRecipient, evaluateCallReplySource } from "./callReplyPolicy";

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
      const blocked = communicationJobStore.markBlocked(job.id, result.reason);
      if (blocked) updateCall(blocked, "blocked");
      if (blocked) communicationCampaignStore.updateRecipient(blocked, "blocked", result.reason);
      if (blocked) updateBulkRun(blocked);
      return blocked;
    }
    const sent = communicationJobStore.markSent(job.id, result.messageId);
    if (sent) updateCall(sent, "sent", true);
    if (sent) communicationCampaignStore.updateRecipient(sent, "sent", null, result.messageId);
    if (sent) updateBulkRun(sent);
    logEvent("info", "communication.job.sent", { jobId: job.id, kind: job.kind, role: job.role });
    return sent;
  } catch (error) {
    const failed = communicationJobStore.markFailed(job.id, error);
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
