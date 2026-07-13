export type OutboundStatusSnapshot = {
  outbound?: {
    mode?: "dry_run" | "allowlist" | "code" | "production" | string;
    dryRun?: boolean;
    requiresCode?: boolean;
  };
};

export type PreparedOutboundAction = {
  mode: string;
  dryRun: boolean;
  requiresCode: boolean;
  outboundCode?: string;
};

type PromptForCode = (message: string) => string | null;

function browserPrompt(message: string) {
  if (typeof window === "undefined") return null;
  return window.prompt(message);
}

/**
 * Resolve the server-owned outbound policy before asking for a confirmation
 * code. A dry run must never prompt because it cannot send a real message.
 */
export async function prepareManualOutboundAction(
  loadStatus: () => Promise<OutboundStatusSnapshot>,
  promptForCode: PromptForCode = browserPrompt,
  suppliedCode?: string,
): Promise<PreparedOutboundAction> {
  let status: OutboundStatusSnapshot;
  try {
    status = await loadStatus();
  } catch {
    throw new Error("تعذر التحقق من وضع الإرسال. حدّث الصفحة ثم حاول مرة أخرى.");
  }

  const outbound = status?.outbound;
  if (!outbound?.mode) {
    throw new Error("تعذر التحقق من وضع الإرسال. افتح إعدادات واتساب ثم حاول مرة أخرى.");
  }

  const mode = String(outbound.mode);
  const dryRun = outbound.dryRun === true || mode === "dry_run";
  const requiresCode = !dryRun && (mode === "code" || outbound.requiresCode === true);

  if (dryRun || !requiresCode) {
    return { mode, dryRun, requiresCode, outboundCode: undefined };
  }

  const code = suppliedCode?.trim() || promptForCode("أدخل كود الإرسال الفعلي");
  if (!code?.trim()) throw new Error("كود الإرسال مطلوب قبل إرسال رسالة فعلية.");
  return { mode, dryRun: false, requiresCode: true, outboundCode: code.trim() };
}

export function isOutboundSimulation(
  result: unknown,
  preparedDryRun = false,
) {
  if (preparedDryRun) return true;
  if (!result || typeof result !== "object") return false;
  const value = result as {
    dry_run?: boolean;
    dryRun?: boolean;
    simulated?: boolean;
    result?: unknown;
    whatsapp?: { outbound?: { dryRun?: boolean } };
  };
  if (value.dry_run === true || value.dryRun === true || value.simulated === true || value.whatsapp?.outbound?.dryRun === true) {
    return true;
  }
  return value.result !== result && isOutboundSimulation(value.result);
}

export function createPerItemActionLock() {
  const active = new Set<string>();
  return {
    acquire(key: string) {
      if (active.has(key)) return false;
      active.add(key);
      return true;
    },
    release(key: string) {
      active.delete(key);
    },
    has(key: string) {
      return active.has(key);
    },
  };
}
