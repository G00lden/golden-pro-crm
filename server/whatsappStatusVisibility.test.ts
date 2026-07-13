import assert from "node:assert/strict";
import test from "node:test";
import type { WhatsAppStatus } from "./whatsapp";
import { visibleWhatsAppStatus } from "./whatsappStatusVisibility";

const fullStatus: WhatsAppStatus = {
  provider: "web" as const,
  status: "qr_pending" as const,
  qr: "data:image/png;base64,pairing-secret",
  user: "966500000000:1@s.whatsapp.net",
  connectedAt: "2026-07-13T00:00:00.000Z",
  outbound: {
    mode: "dry_run",
    launchApproved: false,
    enabled: false,
    requiresCode: false,
    codeConfigured: false,
    allowlistCount: 0,
    dryRun: true,
    updatedAt: "2026-07-13T00:00:00.000Z",
  },
  updatedAt: "2026-07-13T00:00:01.000Z",
};

test("campaign managers receive readiness without pairing or account identifiers", () => {
  const visible = visibleWhatsAppStatus(fullStatus, false);
  assert.equal("qr" in visible, false);
  assert.equal("user" in visible, false);
  assert.equal(visible.status, "qr_pending");
  assert.deepEqual(visible.outbound, fullStatus.outbound);
});

test("WhatsApp administrators retain the complete status", () => {
  const visible = visibleWhatsAppStatus(fullStatus, true);
  assert.equal(visible.qr, fullStatus.qr);
  assert.equal(visible.user, fullStatus.user);
  assert.notEqual(visible, fullStatus);
});
