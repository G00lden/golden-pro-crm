import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("customer request flows through CRM assignment, booking, technician execution, and portal closure", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "breexe-maintenance-request-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/maintenance-request-case.ts"], {
      cwd: root,
      env: {
        ...process.env,
        DATA_PROVIDER: "sqlite",
        DB_PATH: path.join(directory, "crm.db"),
        NODE_ENV: "test",
        MAINTENANCE_PORTAL_SECRET: "test-only-maintenance-portal-secret-32-characters",
        MAINTENANCE_MIN_LEAD_HOURS: "0",
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.periodicProductIds, ["product-periodic-ro7"]);
    assert.deepEqual(output.periodicKitIds, ["kit-periodic-ro7"]);
    assert.deepEqual(output.splitKitIds, []);
    assert.equal(output.forgedPeriodicStatus, 400);
    assert.match(output.forgedPeriodicError, /غير متوافق/);
    assert.equal(output.periodicCreatedStatus, 201);
    assert.equal(output.periodicRequestType, "periodic");
    assert.equal(output.periodicKitName, "حزمة طقم تبديل فلاتر - إصدار الخاص");
    assert.equal(output.createdStatus, 201);
    assert.equal(output.duplicateStatus, 200);
    assert.equal(output.duplicate, true);
    assert.equal(output.sameRequestNumber, true);
    assert.equal(output.portalBeforeStatus, 200);
    assert.equal(output.portalBeforeLifecycle, "new");
    assert.equal(output.invalidPortalStatus, 404);
    assert.equal(output.approveStatus, 200);
    assert.equal(output.assignStatus, 200);
    assert.equal(output.assignedLifecycle, "scheduled");
    assert.equal(output.rescheduleStatus, 200);
    assert.equal(output.customerChangeRequested, true);
    assert.equal(output.fieldProgressLifecycle, "in_progress");
    assert.equal(output.closeWithoutEvidenceStatus, 409);
    assert.equal(output.closeStatus, 200);
    assert.equal(output.closedLifecycle, "closed");
    assert.equal(output.portalAfterStatus, "closed");
    assert.equal(output.resolutionNote, "تم تنظيف الوحدة وإعادة تعبئة الغاز.");
    assert.equal(output.bookingStatus, "completed");
    assert.equal(output.bookingSource, "maintenance_portal");
    assert.equal(output.customerCount, 1);
    assert.equal(output.eventCount, 6);
    assert.equal(output.tokenPersisted, false);
    assert.ok(output.queuedReasons.includes("maintenance_request_assigned"));
    assert.ok(output.queuedReasons.includes("maintenance_request_closed"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
