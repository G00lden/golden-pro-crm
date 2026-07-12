import db from "./db";
import { communicationJobStore, type CommunicationJob } from "./communicationJobs";
import { isDryRunSendResult } from "./outboundSafety";
import { listTemplateNames, type TemplateName } from "./whatsappTemplates";
import { sendWhatsAppTemplate } from "./whatsapp";
import { logError, logEvent } from "./logger";
import type { RenderVars } from "./whatsappTemplates";

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

export async function processNextCommunicationJob(): Promise<CommunicationJob | null> {
  const job = communicationJobStore.claimNext();
  if (!job) return null;
  updateCall(job, "processing");

  try {
    if (job.kind !== "whatsapp_template" || !isTemplateName(job.template_name)) {
      throw new Error(`Unsupported communication job: ${job.kind}/${job.template_name || "missing-template"}`);
    }
    const vars = renderVars(job.payload.vars && typeof job.payload.vars === "object" ? job.payload.vars : job.payload);
    const result = await sendWhatsAppTemplate({
      phone: job.recipient_phone,
      template: job.template_name,
      vars,
      owner_uid: job.owner_uid,
    });
    if (isDryRunSendResult(result)) {
      const blocked = communicationJobStore.markBlocked(job.id, result.reason);
      if (blocked) updateCall(blocked, "blocked");
      return blocked;
    }
    const sent = communicationJobStore.markSent(job.id, result.messageId);
    if (sent) updateCall(sent, "sent", true);
    logEvent("info", "communication.job.sent", { jobId: job.id, kind: job.kind, role: job.role });
    return sent;
  } catch (error) {
    const failed = communicationJobStore.markFailed(job.id, error);
    if (failed) updateCall(failed, failed.status);
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
      for (let i = 0; i < 10; i += 1) {
        if (!await processNextCommunicationJob()) break;
      }
    } finally {
      running = false;
    }
  };
  timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();
  logEvent("info", "communication.worker.enabled", { intervalMs });
}
