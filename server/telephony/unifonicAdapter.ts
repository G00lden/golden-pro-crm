/**
 * Unifonic telephony adapter.
 *
 * Implements Unifonic's documented Voice / inbound-IVR contract:
 *
 *  Inbound IVR Endpoint (GET) — Unifonic queries it once for an inbound call.
 *  The generated gather response sends DTMF to a tokenized POST responseUrl.
 *  Fields supported defensively across provider payload variants include:
 *     { callerId, recipient, digits, speechResult, confidence }
 *   - callerId  = the customer's number (E.164, e.g. +9665…)
 *   - recipient = the dialed number (our main number)
 *   - digits    = DTMF the caller pressed (present only on a response hit)
 *   If Unifonic includes a persistent call id we store it. If it does not, the
 *   engine correlates status by both normalized endpoints inside a five-minute
 *   window and rejects ambiguous matches.
 *
 *  Response — a bare JSON ARRAY of IVR objects. Verbs used here:
 *   - say:      { say, language, voice, ttsEngine }
 *   - gather:   { say, language, voice, responseUrl, digitsLimit, loop, onEmptyResponse }
 *   - transfer: { say, language, voice, transfer: "+9665…", recording }
 *   A `say` object with no `responseUrl` ends (hangs up) the call.
 *
 *  Status — call lifecycle is delivered to the account-level status webhook
 *  configured in the Unifonic dashboard (→ /webhooks/telephony/status).
 *
 * Refs: unifonic.readme.io/reference/different-voice-parameters-that-are-available,
 *       .../sending-multiple-ivr-objects-in-a-single-request,
 *       .../making-an-outgoing-call-to-collect-response
 */
import type {
  IvrInstruction,
  NormalizedCallStatus,
  NormalizedInboundCall,
  TelephonyAdapter,
} from "./types";

type AnyRecord = Record<string, unknown>;

/** First non-empty string value among the given keys. */
function pick(source: AnyRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = source?.[key];
    if (v !== undefined && v !== null && String(v).trim() !== "") {
      return String(v).trim();
    }
  }
  return undefined;
}

/** Normalize a phone to bare international digits for a stable correlation key. */
function normalizeDigits(phone: string | undefined): string {
  let d = String(phone || "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("0")) d = `966${d.slice(1)}`;
  if (d.length === 9 && d.startsWith("5")) d = `966${d}`;
  return d;
}

/** E.164 form Unifonic's `transfer` expects (+9665…). */
function toE164(phone: string): string {
  const d = normalizeDigits(phone);
  return d ? `+${d}` : "";
}

/** Unifonic uses spelled-out language names. */
function langName(language?: string): string {
  return (language || "ar").toLowerCase().startsWith("ar") ? "arabic" : "english";
}

// Confirmed field names (with defensive aliases for status, whose exact payload
// is account-specific).
const F = {
  caller: ["callerId", "CallerId", "from", "caller", "originator"],
  recipient: ["recipient", "Recipient", "to", "called", "destination", "DID"],
  digit: ["digits", "Digits", "digit", "dtmf", "input"],
  status: ["status", "Status", "callStatus", "CallStatus", "dialStatus", "DialCallStatus", "result", "event"],
  duration: ["duration", "Duration", "callDuration", "durationSec", "seconds"],
  callSid: ["callSid", "CallSid", "callId", "sessionId", "uniqueCallId", "externalCallsId", "id"],
  timestamp: ["timestamp", "Timestamp", "eventTime", "createdAt", "updatedAt", "callEndTime", "endTime"],
} as const;

function correlationId(src: AnyRecord): string {
  return pick(src, [...F.callSid]) || "";
}

function normalizeStatus(raw: string | undefined): NormalizedCallStatus["status"] {
  const s = String(raw || "").toLowerCase().replace(/[\s_-]/g, "");
  if (!s) return "unknown";
  if (["noanswer", "noreply", "unanswered", "timeout", "notanswered", "missed"].includes(s)) return "no_answer";
  if (["busy"].includes(s)) return "busy";
  if (["failed", "error", "rejected", "canceled", "cancelled", "declined"].includes(s)) return "failed";
  if (["voicemail", "machine", "answeringmachine"].includes(s)) return "voicemail";
  if (["completed", "answered", "complete", "ended", "hangup", "success"].includes(s)) return "completed";
  if (["inprogress", "ongoing", "bridged", "connected", "transferred"].includes(s)) return "in_progress";
  if (["ringing", "initiated", "started", "queued"].includes(s)) return "ringing";
  return "unknown";
}

export const unifonicAdapter: TelephonyAdapter = {
  provider: "unifonic",

  parseInbound(body: AnyRecord = {}, query: AnyRecord = {}): NormalizedInboundCall {
    const src: AnyRecord = { ...query, ...body };
    return {
      callSid: correlationId(src),
      from: pick(src, [...F.caller]) || "",
      to: pick(src, [...F.recipient]) || "",
      digit: pick(src, [...F.digit]),
      raw: src,
    };
  },

  parseStatus(body: AnyRecord = {}, query: AnyRecord = {}): NormalizedCallStatus {
    const src: AnyRecord = { ...query, ...body };
    const durationRaw = pick(src, [...F.duration]);
    return {
      callSid: correlationId(src),
      from: pick(src, [...F.caller]),
      to: pick(src, [...F.recipient]),
      status: normalizeStatus(pick(src, [...F.status])),
      durationSec: durationRaw ? Number(durationRaw) || 0 : undefined,
      occurredAt: pick(src, [...F.timestamp]),
      raw: src,
    };
  },

  /** Serialize to Unifonic's bare IVR-object array. */
  renderInstructions(instructions: IvrInstruction[]): unknown {
    const objects: AnyRecord[] = [];
    for (const ins of instructions) {
      switch (ins.action) {
        case "say":
          objects.push({ say: ins.text, language: langName(ins.language), voice: "male", ttsEngine: "standard" });
          break;
        case "gather":
          objects.push({
            say: ins.text,
            language: langName(ins.language),
            voice: "male",
            ttsEngine: "standard",
            responseUrl: ins.responseUrl,
            digitsLimit: String(ins.numDigits ?? 1),
            loop: "3",
            onEmptyResponse: "لم نستلم اختياركم. شكراً لاتصالكم.",
          });
          break;
        case "dial":
          objects.push({
            say: ins.text || "يتم تحويل مكالمتكم، يرجى الانتظار.",
            language: langName(),
            voice: "male",
            ttsEngine: "standard",
            transfer: toE164(ins.number),
            recording: ins.recording ?? false,
          });
          break;
        case "hangup":
          // No explicit hangup verb — a preceding `say` (no responseUrl) ends
          // the call on its own, so nothing is emitted here.
          break;
        default:
          break;
      }
    }
    return objects;
  },
};

export default unifonicAdapter;
