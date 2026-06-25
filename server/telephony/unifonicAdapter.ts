/**
 * Unifonic telephony adapter.
 *
 * ⚠️ FIELD NAMES — CONFIRM AGAINST YOUR UNIFONIC ACCOUNT DOCS.
 * Unifonic's inbound-IVR + Voice REST contract is documented behind the
 * account login (docs.unifonic.com/docs/inbound-ivr). The field names below
 * follow Unifonic's public hints (responseUrl, digits, callSid, from/to) and
 * are written defensively to accept the most common variants. When the live
 * account contract is confirmed, adjust ONLY the constants/getters in this
 * file — the IVR engine and routes never touch provider field names.
 *
 * Known public hints used here:
 *  - Inbound calls hit an "IVR Endpoint" which returns IVR instructions.
 *  - DTMF input is delivered back as a `digits` field to a `responseUrl`.
 *  - Call status is shared via a status webhook.
 */
import type {
  IvrInstruction,
  NormalizedCallStatus,
  NormalizedInboundCall,
  TelephonyAdapter,
} from "./types";

type AnyRecord = Record<string, unknown>;

/** First non-empty string value among the given keys (case-insensitive-ish). */
function pick(source: AnyRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = source?.[key];
    if (v !== undefined && v !== null && String(v).trim() !== "") {
      return String(v).trim();
    }
  }
  return undefined;
}

// ── Provider field aliases (CONFIRM) ───────────────────────────────────────
const F = {
  callSid: ["callSid", "CallSid", "sessionId", "SessionID", "callId", "id"],
  from: ["from", "From", "caller", "callerId", "source", "originator"],
  to: ["to", "To", "called", "destination", "recipient", "DID"],
  digit: ["digits", "Digits", "digit", "Digit", "dtmf", "DTMF", "input"],
  status: ["status", "Status", "callStatus", "CallStatus", "dialStatus", "DialCallStatus", "result"],
  duration: ["duration", "Duration", "callDuration", "durationSec", "seconds"],
} as const;

/** Map Unifonic status strings onto our normalized lifecycle. */
function normalizeStatus(raw: string | undefined): NormalizedCallStatus["status"] {
  const s = String(raw || "").toLowerCase().replace(/[\s_-]/g, "");
  if (!s) return "unknown";
  if (["noanswer", "noreply", "unanswered", "timeout", "notanswered"].includes(s)) return "no_answer";
  if (["busy"].includes(s)) return "busy";
  if (["failed", "error", "rejected", "canceled", "cancelled", "declined"].includes(s)) return "failed";
  if (["voicemail", "machine", "answeringmachine"].includes(s)) return "voicemail";
  if (["completed", "answered", "complete", "ended", "hangup", "success"].includes(s)) return "completed";
  if (["inprogress", "ongoing", "bridged", "connected"].includes(s)) return "in_progress";
  if (["ringing", "initiated", "started", "queued"].includes(s)) return "ringing";
  return "unknown";
}

export const unifonicAdapter: TelephonyAdapter = {
  provider: "unifonic",

  parseInbound(body: AnyRecord = {}, query: AnyRecord = {}): NormalizedInboundCall {
    const src: AnyRecord = { ...query, ...body };
    return {
      callSid: pick(src, [...F.callSid]) || "",
      from: pick(src, [...F.from]) || "",
      to: pick(src, [...F.to]) || "",
      digit: pick(src, [...F.digit]),
      raw: src,
    };
  },

  parseStatus(body: AnyRecord = {}, query: AnyRecord = {}): NormalizedCallStatus {
    const src: AnyRecord = { ...query, ...body };
    const durationRaw = pick(src, [...F.duration]);
    return {
      callSid: pick(src, [...F.callSid]) || "",
      from: pick(src, [...F.from]),
      to: pick(src, [...F.to]),
      status: normalizeStatus(pick(src, [...F.status])),
      durationSec: durationRaw ? Number(durationRaw) || 0 : undefined,
      raw: src,
    };
  },

  /**
   * Serialize instructions into Unifonic's expected response JSON.
   *
   * ⚠️ CONFIRM the exact response envelope Unifonic's IVR Endpoint expects.
   * We emit a clear, self-describing `{ actions: [...] }` array; the mapping
   * from our action names to Unifonic verbs is centralized here so only this
   * function changes once the live contract is verified.
   */
  renderInstructions(instructions: IvrInstruction[]): unknown {
    const actions = instructions.map((ins) => {
      switch (ins.action) {
        case "say":
          return { action: "say", text: ins.text, language: ins.language || "ar" };
        case "gather":
          return {
            action: "gather",
            text: ins.text,
            numDigits: ins.numDigits ?? 1,
            timeout: ins.timeoutSec ?? 8,
            responseUrl: ins.responseUrl,
            language: ins.language || "ar",
          };
        case "dial":
          return {
            action: "dial",
            number: ins.number,
            callerId: ins.callerId,
            timeout: ins.ringTimeoutSec ?? 20,
            statusCallback: ins.statusCallbackUrl,
          };
        case "hangup":
          return { action: "hangup" };
        default:
          return ins;
      }
    });
    return { actions };
  },
};

export default unifonicAdapter;
