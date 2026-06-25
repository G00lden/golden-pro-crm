/**
 * Provider-agnostic telephony types.
 *
 * The IVR engine (server/ivrEngine.ts) speaks only in these normalized shapes.
 * Each provider adapter (e.g. server/telephony/unifonicAdapter.ts) is the only
 * place that knows the provider's real request/response field names.
 */

/** A single instruction the provider should execute on the live call. */
export type IvrInstruction =
  | { action: "say"; text: string; language?: string }
  | {
      // Play a prompt and collect a single DTMF digit, then POST the digit back
      // to `responseUrl` (the provider re-invokes our IVR webhook).
      action: "gather";
      text: string;
      numDigits?: number;
      timeoutSec?: number;
      responseUrl: string;
      language?: string;
    }
  | {
      // Forward (bridge) the call to an external phone number. When the dial
      // ends, the provider posts the outcome to `statusCallbackUrl`.
      action: "dial";
      number: string;
      callerId?: string;
      ringTimeoutSec?: number;
      statusCallbackUrl?: string;
    }
  | { action: "hangup" };

/** Normalized view of an inbound-call / DTMF webhook hit. */
export type NormalizedInboundCall = {
  /** Provider call identifier (Unifonic call SID / session id). */
  callSid: string;
  /** Caller's phone (the customer). */
  from: string;
  /** Dialed number (our advertised main number). */
  to: string;
  /** DTMF digit collected, if this hit is a menu response. */
  digit?: string;
  /** Raw provider payload for logging/debugging. */
  raw: Record<string, unknown>;
};

/** Normalized call-status callback (used to detect missed calls). */
export type NormalizedCallStatus = {
  callSid: string;
  from?: string;
  to?: string;
  /** Normalized lifecycle status. */
  status:
    | "ringing"
    | "in_progress"
    | "completed"
    | "no_answer"
    | "busy"
    | "failed"
    | "voicemail"
    | "unknown";
  durationSec?: number;
  raw: Record<string, unknown>;
};

/** Contract every telephony adapter implements. */
export interface TelephonyAdapter {
  readonly provider: string;
  /** Parse an inbound IVR webhook request body/query into a normalized call. */
  parseInbound(body: Record<string, unknown>, query: Record<string, unknown>): NormalizedInboundCall;
  /** Parse a status-callback webhook into a normalized status. */
  parseStatus(body: Record<string, unknown>, query: Record<string, unknown>): NormalizedCallStatus;
  /** Serialize IVR instructions into the provider's expected response JSON. */
  renderInstructions(instructions: IvrInstruction[]): unknown;
}
