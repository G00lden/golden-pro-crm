import { recordEscalation } from "./escalationEngine";
import { adminDb } from "./firebaseAdmin";
import { isDryRunSendResult, outboundSafetyStatus } from "./outboundSafety";
import { whatsappService, type WhatsAppStatus } from "./whatsapp";

const timeZone = process.env.APP_TIMEZONE || "Asia/Riyadh";
const retryCooldownMinutes = Number(process.env.REMINDER_RETRY_COOLDOWN_MINUTES || 30);

type ReminderType = "first" | "second" | "third" | "last" | "overdue";

// Smart 4-stage schedule (REMINDER_SMART_SCHEDULE=true by default in v2):
//   first   → 7 days before due  (early heads-up)
//   second  → 1 day before due   (final pre-confirmation)
//   third   → on the due date    (day-of nudge)
//   overdue → 3 days past due    (escalation reminder)
// Legacy "last" alias is preserved as an alternate label for "overdue" so old
// rows written before this upgrade keep flowing through the pipeline.
// The offset→stage mapping lives in computeDueStage() below.

function smartScheduleEnabled() {
  return process.env.REMINDER_SMART_SCHEDULE !== "false";
}

function diffDays(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / 86_400_000);
}

// Progression order of the stages, used to guarantee each stage sends once.
const STAGE_ORDER: Record<string, number> = { first: 0, second: 1, third: 2, last: 3, overdue: 3 };

/**
 * Given the due date and today (in the configured timezone), returns the single
 * stage whose day this is, or null when no stage is due today.
 *
 * Each `offset` (= today − due) maps to EXACTLY ONE stage — the windows do not
 * overlap — so the same stage isn't recomputed on several consecutive days.
 * `runDueReminders` additionally gates on the stage progression, so together a
 * stage is sent at most once and always with the date-correct copy.
 *
 *   offset ≤ -2 → first    (early heads-up; also recovers missed runs up to 2d out)
 *   offset = -1 → second   ("tomorrow")
 *   offset =  0 → third    ("today")
 *   offset 1..2 → null     (grace period — nothing)
 *   offset ≥  3 → overdue  (escalation)
 */
function computeDueStage(nextMaintenance: string, today: string): ReminderType | null {
  const offset = diffDays(today, nextMaintenance);
  if (offset <= -2) return "first";
  if (offset === -1) return "second";
  if (offset === 0) return "third";
  if (offset >= 3) return "overdue";
  return null; // 1–2 days past due: grace period
}

type Installation = {
  createdBy: string;
  customer_id: string;
  customer_name: string;
  customer_phone: string;
  product_id: string;
  product_name: string;
  next_maintenance: string;
  next_remind_type?: ReminderType | null;
  last_remind_at?: string | null;
  last_remind_attempt_at?: string | null;
  remind_count?: number;
  status?: string;
};

type ReminderRunMode = "manual" | "scheduled" | "automatic";

type ReminderResult = {
  success: boolean;
  skipped?: boolean;
  dry_run?: boolean;
  simulated?: boolean;
  installation_id?: string;
  reminder_id?: string;
  remind_count?: number;
  next_remind_type?: ReminderType | null;
  error?: string;
  reason?: string;
};

type ReminderRunOptions = {
  uid?: string;
  mode?: ReminderRunMode;
  limit?: number;
  outboundCode?: string;
};

type SchedulerState = {
  running: boolean;
  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastMode?: ReminderRunMode;
  lastUid?: string;
  lastResult?: {
    checked: number;
    sent: number;
    failed: number;
    skipped: number;
    blocked: boolean;
    error?: string;
  };
};

const schedulerState: SchedulerState = {
  running: false,
};

export function todayInTimeZone() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function timeZoneOffsetMs(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - date.getTime();
}

function zonedDateStartIso(dateString: string) {
  const [year, month, day] = dateString.split("-").map(Number);
  const utcMidnight = new Date(Date.UTC(year, month - 1, day));
  const firstPass = new Date(Date.UTC(year, month - 1, day) - timeZoneOffsetMs(utcMidnight));
  return new Date(Date.UTC(year, month - 1, day) - timeZoneOffsetMs(firstPass)).toISOString();
}

function addDaysToDateString(dateString: string, days: number) {
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function todayWindowInTimeZone() {
  const today = todayInTimeZone();
  const tomorrowString = addDaysToDateString(today, 1);

  return {
    start: zonedDateStartIso(today),
    end: zonedDateStartIso(tomorrowString),
  };
}

const COMPANY_NAME = process.env.COMPANY_NAME || "BreeXe Pro";

type RenderedReminder = (inst: Installation, daysUntilDue: number) => string;

const REMINDER_MESSAGES: Record<ReminderType | "escalation", RenderedReminder> = {
  first: (inst, days) =>
    `عزيزي ${inst.customer_name}،
نذكركم بأن موعد صيانة ${inst.product_name} يقترب (بعد ${Math.max(0, days)} أيام).
تاريخ الصيانة: ${inst.next_maintenance}
يرجى تأكيد حضوركم بالرد بـ "نعم" أو إعادة الجدولة بـ "لا".
فريق ${COMPANY_NAME}`,
  second: (inst) =>
    `عزيزي ${inst.customer_name}،
تذكير: غداً موعد صيانة ${inst.product_name}.
يرجى تأكيد حضوركم بالرد بـ "نعم".
فريق ${COMPANY_NAME}`,
  third: (inst) =>
    `عزيزي ${inst.customer_name}،
اليوم موعد صيانة ${inst.product_name}.
نرجو الالتزام بالموعد المحدد. للاستفسار تواصل معنا واتساب.
فريق ${COMPANY_NAME}`,
  // Preserved alias for legacy rows whose next_remind_type='last'.
  last: (inst) =>
    `عزيزي ${inst.customer_name}،
نشير إلى أن موعد صيانة ${inst.product_name} قد تجاوز تاريخه (${inst.next_maintenance}).
نرجو التواصل معنا فوراً لحجز موعد جديد.
فريق ${COMPANY_NAME}`,
  overdue: (inst) =>
    `عزيزي ${inst.customer_name}،
نشير إلى أن موعد صيانة ${inst.product_name} قد تجاوز تاريخه (${inst.next_maintenance}).
نرجو التواصل معنا فوراً لحجز موعد جديد.
فريق ${COMPANY_NAME}`,
  escalation: (inst) =>
    `⚠️ تنبيه للمشرف ⚠️
العميل: ${inst.customer_name} (${inst.customer_phone})
المنتج: ${inst.product_name}
تم إرسال 3 تذكيرات دون استجابة.
تاريخ الصيانة الفائت: ${inst.next_maintenance}
يرجى متابعة العميل يدوياً.`,
};

function buildReminderMessage(inst: Installation, stage?: ReminderType) {
  const today = todayInTimeZone();
  const days = inst.next_maintenance ? diffDays(inst.next_maintenance, today) : 0;
  const resolvedStage: ReminderType = (stage && REMINDER_MESSAGES[stage] ? stage : inst.next_remind_type || "first") as ReminderType;
  const render = REMINDER_MESSAGES[resolvedStage] || REMINDER_MESSAGES.first;
  return render(inst, days);
}

export function buildEscalationMessage(inst: Installation) {
  return REMINDER_MESSAGES.escalation(inst, 0);
}

function getNextReminderType(current?: string | null, countAfterSend = 1): ReminderType | null {
  // Cap remind_count at 4 in smart schedule (first → second → third → overdue),
  // 3 in legacy mode (first → second → last).
  const cap = smartScheduleEnabled() ? 4 : 3;
  if (countAfterSend >= cap) return null;
  if (current === "first") return "second";
  if (current === "second") return smartScheduleEnabled() ? "third" : "last";
  if (current === "third") return "overdue";
  if (current === "last") return null;
  if (current === "overdue") return null;
  return "second";
}

function httpError(status: number, message: string) {
  const err = new Error(message) as Error & { status?: number };
  err.status = status;
  return err;
}

function isSentToday(inst: Installation) {
  const todayWindow = todayWindowInTimeZone();
  return Boolean(inst.last_remind_at && inst.last_remind_at >= todayWindow.start && inst.last_remind_at < todayWindow.end);
}

function isRecentAttempt(inst: Installation) {
  if (!inst.last_remind_attempt_at) return false;
  const attemptMs = Date.parse(inst.last_remind_attempt_at);
  if (!Number.isFinite(attemptMs)) return false;
  return attemptMs >= Date.now() - retryCooldownMinutes * 60_000;
}

function hasGlobalBlocker(whatsapp: WhatsAppStatus) {
  const outbound = outboundSafetyStatus();
  if (outbound.mode === "production" && !outbound.launchApproved) {
    return "Outbound messages are blocked until OFFICIAL_LAUNCH_APPROVED=true.";
  }
  if (outbound.mode === "dry_run") return "";
  if (whatsapp.status !== "connected") {
    return "واتساب غير متصل. افتح تبويب واتساب والسجل واربط الجلسة أولا.";
  }
  return "";
}

async function recordFailedReminderAttempt(
  installationId: string,
  uid: string,
  inst: Installation,
  message: string,
  reminderType: string,
  error: unknown,
  trigger: ReminderRunMode,
) {
  const now = new Date().toISOString();
  const errorMessage = error instanceof Error ? error.message : String(error);
  const reminderRef = adminDb.collection("reminders").doc();

  await reminderRef.set({
    installation_id: installationId,
    customer_id: inst.customer_id,
    customer_name: inst.customer_name,
    customer_phone: inst.customer_phone,
    product_id: inst.product_id,
    product_name: inst.product_name,
    message,
    reminder_type: reminderType,
    status: "failed",
    trigger,
    sent_at: now,
    error: errorMessage,
    whatsapp_message_id: null,
    createdBy: uid,
  });

  return {
    success: false,
    reminder_id: reminderRef.id,
    installation_id: installationId,
    error: errorMessage,
  };
}

export function getReminderSchedulerState() {
  return {
    ...schedulerState,
    timeZone,
    today: todayInTimeZone(),
    schedule: process.env.REMINDER_CRON_SCHEDULE || "0 10 * * *",
    enabled: process.env.ENABLE_DAILY_CRON === "true",
    retryCooldownMinutes,
  };
}

function rememberRunResult(result: {
  checked: number;
  sent: number;
  failed: number;
  skipped: number;
  blocked?: boolean;
  error?: string;
}) {
  schedulerState.lastResult = {
    checked: result.checked,
    sent: result.sent,
    failed: result.failed,
    skipped: result.skipped,
    blocked: Boolean(result.blocked),
    error: result.error,
  };
}

export async function sendReminderForInstallation(
  installationId: string,
  uid: string,
  requestedType?: string,
  trigger: ReminderRunMode = "manual",
  outboundCode?: string,
) {
  const whatsapp = whatsappService.getStatus();
  const blocker = hasGlobalBlocker(whatsapp);
  if (blocker) throw httpError(503, blocker);

  const ref = adminDb.collection("installations").doc(installationId);
  const snap = await ref.get();

  if (!snap.exists) throw httpError(404, "لم يتم العثور على الصيانة.");

  const inst = snap.data() as Installation;
  if (inst.createdBy !== uid) throw httpError(403, "لا تملك صلاحية هذه الصيانة.");
  if (inst.status && inst.status !== "active") {
    throw httpError(400, "يمكن إرسال التذكيرات للصيانات النشطة فقط.");
  }
  if (!inst.customer_phone) throw httpError(400, "رقم العميل غير موجود.");
  if (isSentToday(inst)) throw httpError(409, "تم إرسال تذكير لهذه الصيانة اليوم.");

  const reminderType = (requestedType || inst.next_remind_type || "first") as ReminderType;
  const message = buildReminderMessage(inst, reminderType);
  const now = new Date().toISOString();

  await ref.update({
    last_remind_attempt_at: now,
    updatedAt: now,
  });

  let whatsAppResult: Awaited<ReturnType<typeof whatsappService.sendText>>;
  try {
    whatsAppResult = await whatsappService.sendText(inst.customer_phone, message, {
      confirmationCode: outboundCode,
    });
  } catch (error) {
    await recordFailedReminderAttempt(installationId, uid, inst, message, reminderType, error, trigger);
    throw httpError(502, error instanceof Error ? error.message : "تعذر إرسال واتساب.");
  }

  if (isDryRunSendResult(whatsAppResult)) {
    const reminderRef = adminDb.collection("reminders").doc();
    await reminderRef.set({
      installation_id: installationId,
      customer_id: inst.customer_id,
      customer_name: inst.customer_name,
      customer_phone: inst.customer_phone,
      product_id: inst.product_id,
      product_name: inst.product_name,
      message,
      reminder_type: reminderType,
      status: "dry_run",
      trigger,
      sent_at: now,
      error: whatsAppResult.reason,
      whatsapp_jid: whatsAppResult.jid,
      whatsapp_message_id: null,
      createdBy: uid,
    });

    return {
      success: false,
      skipped: true,
      dry_run: true,
      simulated: true,
      reminder_id: reminderRef.id,
      installation_id: installationId,
      remind_count: Number(inst.remind_count || 0),
      next_remind_type: inst.next_remind_type || null,
      reason: whatsAppResult.reason,
    };
  }

  const remindCount = Number(inst.remind_count || 0) + 1;
  // Advance from the stage we actually SENT (reminderType), not the stored
  // next_remind_type — in smart mode the date can jump the stage forward, and
  // the pointer must follow what went out so the next stage is correct.
  const nextReminderType = getNextReminderType(reminderType, remindCount);
  const reminderRef = adminDb.collection("reminders").doc();
  await reminderRef.set({
    installation_id: installationId,
    customer_id: inst.customer_id,
    customer_name: inst.customer_name,
    customer_phone: inst.customer_phone,
    product_id: inst.product_id,
    product_name: inst.product_name,
    message,
    reminder_type: reminderType,
    status: "sent",
    trigger,
    sent_at: now,
    whatsapp_jid: whatsAppResult.jid,
    whatsapp_message_id: whatsAppResult.messageId,
    createdBy: uid,
  });

  await ref.update({
    remind_count: remindCount,
    last_remind_at: now,
    last_remind_attempt_at: now,
    next_remind_type: nextReminderType,
    updatedAt: now,
  });

  return {
    success: true,
    reminder_id: reminderRef.id,
    installation_id: installationId,
    remind_count: remindCount,
    next_remind_type: nextReminderType,
  };
}

function dueQuery(uid?: string, queryLimit = 25) {
  const today = todayInTimeZone();
  let query = adminDb
    .collection("installations")
    .where("status", "==", "active")
    .where("next_maintenance", "<=", today)
    .orderBy("next_maintenance")
    .limit(queryLimit);

  if (uid) {
    query = adminDb
      .collection("installations")
      .where("createdBy", "==", uid)
      .where("status", "==", "active")
      .where("next_maintenance", "<=", today)
      .orderBy("next_maintenance")
      .limit(queryLimit);
  }

  return query;
}

/**
 * Smart-schedule query: widens the window to include upcoming installations
 * (next_maintenance up to 8 days ahead). The original dueQuery only sees past-
 * due rows, so it can never trigger the 7-days-before "first" reminder.
 */
function smartDueQuery(uid?: string, limit?: number) {
  const today = todayInTimeZone();
  const future = addDaysToDateString(today, 8);
  const queryLimit = limit ?? 200;

  let query = adminDb
    .collection("installations")
    .where("status", "==", "active")
    .where("next_maintenance", "<=", future)
    .orderBy("next_maintenance")
    .limit(queryLimit);

  if (uid) {
    query = adminDb
      .collection("installations")
      .where("createdBy", "==", uid)
      .where("status", "==", "active")
      .where("next_maintenance", "<=", future)
      .orderBy("next_maintenance")
      .limit(queryLimit);
  }

  return query;
}

/**
 * Append-only escalation log: when an installation hits remind_count >= 3 with
 * no confirmation, write an "escalation_required" event to maintenance_history
 * so the admin sees it in the timeline. Best-effort; never throws.
 */
function escalateIfNeeded(installationId: string, inst: Installation, performedBy: string) {
  if ((inst.remind_count || 0) < 3) return;
  try {
    // 1) Append-only audit trail entry — mirrors the original behavior so
    //    timeline consumers still surface the escalation event.
    const dbMod = require("./db").default;
    dbMod.prepare(
      `INSERT INTO maintenance_history (id, installation_id, customer_id, action, old_value, new_value, performed_by, notes, metadata, created_at)
       VALUES (?, ?, ?, 'reminded', ?, 'escalation_required', ?, ?, ?, datetime('now'))`,
    ).run(
      `mh_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      installationId,
      inst.customer_id,
      String(inst.remind_count || 0),
      performedBy,
      "Customer has not responded to 3+ reminders.",
      JSON.stringify({ customer_phone: inst.customer_phone, product_name: inst.product_name }),
    );
    // 2) Admin queue entry — idempotent: existing active/assigned escalation
    //    for the same installation is updated in place by recordEscalation.
    recordEscalation({
      installation_id: installationId,
      customer_id: inst.customer_id,
      customer_name: inst.customer_name,
      customer_phone: inst.customer_phone,
      product_name: inst.product_name,
      original_maintenance_date: inst.next_maintenance,
      remind_count: inst.remind_count,
      last_reminded_at: inst.last_remind_at || new Date().toISOString(),
      owner_uid: performedBy,
      notes: "Auto-escalated by reminderEngine.",
    });
  } catch {
    // Best-effort logging; never block the reminder flow.
  }
}

export async function getReminderDiagnostics(uid?: string) {
  const snap = await dueQuery(uid, 50).get();
  const whatsapp = whatsappService.getStatus();
  const blocker = hasGlobalBlocker(whatsapp);
  const due = snap.docs
    .map((doc) => ({ id: doc.id, ...(doc.data() as Installation) }))
    .filter((inst) => inst.next_remind_type && !isSentToday(inst));
  const ready = due.filter((inst) => !isRecentAttempt(inst));

  return {
    success: true,
    today: todayInTimeZone(),
    timeZone,
    whatsapp,
    blocker: blocker || null,
    scheduler: getReminderSchedulerState(),
    due: due.length,
    ready: ready.length,
    retryCooldownMinutes,
    preview: ready.slice(0, 10).map((inst) => ({
      installation_id: inst.id,
      customer_name: inst.customer_name,
      customer_phone: inst.customer_phone,
      product_name: inst.product_name,
      next_maintenance: inst.next_maintenance,
      next_remind_type: inst.next_remind_type,
    })),
  };
}

export async function runDueReminders(options: ReminderRunOptions = {}) {
  const mode = options.mode || "manual";
  const startedAt = new Date().toISOString();

  // Block ANY overlapping run (manual or scheduled). Previously only scheduled
  // runs were guarded, so a manual run started while the cron run was mid-flight
  // (or two manual runs) could both read isSentToday=false and send twice.
  if (schedulerState.running) {
    return {
      success: false,
      checked: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      blocked: true,
      error: "مهمة تذكير أخرى تعمل حاليا.",
      results: [] as ReminderResult[],
      scheduler: getReminderSchedulerState(),
    };
  }

  schedulerState.running = true;
  schedulerState.lastStartedAt = startedAt;
  schedulerState.lastMode = mode;
  schedulerState.lastUid = options.uid;

  const results: ReminderResult[] = [];

  try {
    const whatsapp = whatsappService.getStatus();
    const blocker = hasGlobalBlocker(whatsapp);
    if (blocker) {
      const blockedResult = {
        success: false,
        checked: 0,
        sent: 0,
        failed: 0,
        skipped: 0,
        blocked: true,
        error: blocker,
        whatsapp,
        results,
        scheduler: getReminderSchedulerState(),
      };
      rememberRunResult(blockedResult);
      return blockedResult;
    }

    const today = todayInTimeZone();
    const useSmart = smartScheduleEnabled();
    const snap = useSmart
      ? await smartDueQuery(options.uid, options.limit || 50).get()
      : await dueQuery(options.uid, options.limit || 25).get();

    for (const doc of snap.docs) {
      const inst = doc.data() as Installation;

      // Smart schedule: the stage is decided purely by today's date (no fallback
      // to the stored stage — that reintroduced early/duplicate sends). Legacy
      // mode still walks next_remind_type directly.
      let effectiveStage: ReminderType | null;
      if (useSmart && inst.next_maintenance) {
        effectiveStage = computeDueStage(inst.next_maintenance, today);
      } else {
        effectiveStage = inst.next_remind_type || null;
      }

      if (!effectiveStage) {
        results.push({ success: false, skipped: true, installation_id: doc.id, reason: "لا يوجد تذكير مستحق اليوم." });
        continue;
      }

      // Progression gate (smart mode): send a stage only if it hasn't been sent
      // yet. next_remind_type == null means the cycle already finished, so the
      // date window must not re-arm it (e.g. resending "overdue" every day).
      if (useSmart) {
        if (inst.next_remind_type == null) {
          results.push({ success: false, skipped: true, installation_id: doc.id, reason: "اكتملت دورة التذكير." });
          continue;
        }
        const dueIdx = STAGE_ORDER[effectiveStage] ?? 0;
        const expectedIdx = STAGE_ORDER[inst.next_remind_type] ?? 0;
        if (dueIdx < expectedIdx) {
          results.push({ success: false, skipped: true, installation_id: doc.id, reason: "تم إرسال هذه المرحلة مسبقًا." });
          continue;
        }
      }
      if (isSentToday(inst)) {
        results.push({ success: false, skipped: true, installation_id: doc.id, reason: "تم إرسال تذكير اليوم." });
        continue;
      }
      if (isRecentAttempt(inst)) {
        results.push({
          success: false,
          skipped: true,
          installation_id: doc.id,
          reason: `تمت محاولة الإرسال خلال آخر ${retryCooldownMinutes} دقيقة.`,
        });
        continue;
      }

      try {
        const sendResult = await sendReminderForInstallation(
          doc.id,
          inst.createdBy,
          effectiveStage,
          mode,
          options.outboundCode,
        );
        // Escalate only on a genuine send. Escalating after a dry-run/skipped
        // result re-appended an escalation_required history row on every run
        // (in dry-run mode the cycle never advances, so it repeated daily).
        if (sendResult?.success) escalateIfNeeded(doc.id, inst, inst.createdBy);
        results.push(sendResult);
      } catch (error) {
        results.push({
          success: false,
          installation_id: doc.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const simulated = results.some((item) => item.dry_run === true || item.simulated === true);
    const runResult = {
      success: true,
      checked: snap.size,
      sent: results.filter((item) => item.success).length,
      failed: results.filter((item) => !item.success && !item.skipped).length,
      skipped: results.filter((item) => item.skipped).length,
      dry_run: simulated,
      simulated,
      blocked: false,
      whatsapp,
      results,
      scheduler: getReminderSchedulerState(),
    };
    rememberRunResult(runResult);
    return runResult;
  } finally {
    schedulerState.running = false;
    schedulerState.lastFinishedAt = new Date().toISOString();
  }
}
