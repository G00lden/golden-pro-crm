import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import express, { type NextFunction, type Request, type Response } from "express";
import Database from "better-sqlite3";
import {
  capturePublicLeadRecord,
  projectPublicLeadToCrm,
  PUBLIC_LEAD_SCHEMA_SQL,
} from "./publicLeadStorage";
import { registerPublicLeadInboxRoutes } from "./routes-public-lead-inbox";

const CRM_DEALS_TEST_SCHEMA_SQL = `
  CREATE TABLE crm_deals (
    id TEXT PRIMARY KEY,
    owner_uid TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    customer_id TEXT,
    customer_name TEXT DEFAULT '',
    customer_phone TEXT DEFAULT '',
    stage TEXT DEFAULT 'lead',
    amount NUMERIC DEFAULT 0,
    currency TEXT DEFAULT 'SAR',
    probability INTEGER DEFAULT 10,
    expected_close TEXT,
    assigned_to TEXT,
    source TEXT DEFAULT 'manual',
    quote_id TEXT,
    invoice_id TEXT,
    notes TEXT DEFAULT '',
    created_at TEXT,
    updated_at TEXT
  );
`;

const leadInput = {
  name: "عميل الموقع",
  phone: "+966551234567",
  service: "صيانة",
  message: "أحتاج موعداً",
  source: "landing" as const,
  utm: {},
  website: "",
};

function capture(database: Database.Database, ownerUid: string, id: string) {
  return capturePublicLeadRecord(database, leadInput, {
    ownerUid,
    idFactory: () => id,
    now: () => "2026-07-13T09:00:00.000Z",
  }).lead;
}

async function withInboxServer(
  database: Database.Database,
  run: (baseUrl: string) => Promise<void>,
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const role = String(req.headers["x-test-role"] || "");
    if (role) {
      (req as Request & { user?: { uid: string; role: string } }).user = {
        uid: `${role}-actor`,
        role,
      };
    }
    next();
  });
  registerPublicLeadInboxRoutes(app, {
    database,
    ownerUid: () => "configured-owner",
    now: () => "2026-07-13T10:00:00.000Z",
    reconcileOnRegister: false,
  });
  app.use((error: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error.status || 500).json({ error: error.message });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test("public lead inbox is admin/manager-only and stays in the configured owner partition", async () => {
  const database = new Database(":memory:");
  try {
    database.exec(PUBLIC_LEAD_SCHEMA_SQL);
    database.exec(CRM_DEALS_TEST_SCHEMA_SQL);
    capture(database, "configured-owner", "lead-visible");
    capture(database, "other-owner", "lead-hidden");

    await withInboxServer(database, async (baseUrl) => {
      const anonymous = await fetch(`${baseUrl}/api/odoo/public-leads`);
      assert.equal(anonymous.status, 401);

      const viewer = await fetch(`${baseUrl}/api/odoo/public-leads`, {
        headers: { "x-test-role": "user" },
      });
      assert.equal(viewer.status, 403);

      const manager = await fetch(`${baseUrl}/api/odoo/public-leads`, {
        headers: { "x-test-role": "manager" },
      });
      assert.equal(manager.status, 200);
      assert.equal(manager.headers.get("cache-control"), "no-store");
      const body = await manager.json() as { data: Array<{ id: string }>; total: number };
      assert.equal(body.total, 1);
      assert.deepEqual(body.data.map((item) => item.id), ["lead-visible"]);

      const admin = await fetch(`${baseUrl}/api/odoo/public-leads`, {
        headers: { "x-test-role": "admin" },
      });
      assert.equal(admin.status, 200);
    });
  } finally {
    database.close();
  }
});

test("public lead status updates validate values and cannot cross owner partitions", async () => {
  const database = new Database(":memory:");
  try {
    database.exec(PUBLIC_LEAD_SCHEMA_SQL);
    capture(database, "configured-owner", "lead-visible");
    capture(database, "other-owner", "lead-hidden");

    await withInboxServer(database, async (baseUrl) => {
      const invalid = await fetch(`${baseUrl}/api/odoo/public-leads/lead-visible/status`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-test-role": "manager" },
        body: JSON.stringify({ status: "deleted" }),
      });
      assert.equal(invalid.status, 400);

      const hidden = await fetch(`${baseUrl}/api/odoo/public-leads/lead-hidden/status`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-test-role": "manager" },
        body: JSON.stringify({ status: "contacted" }),
      });
      assert.equal(hidden.status, 404);

      const updated = await fetch(`${baseUrl}/api/odoo/public-leads/lead-visible/status`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-test-role": "manager" },
        body: JSON.stringify({ status: "qualified" }),
      });
      assert.equal(updated.status, 200);
      const row = database.prepare("SELECT status FROM public_leads WHERE id = ?").get("lead-visible") as { status: string };
      const other = database.prepare("SELECT status FROM public_leads WHERE id = ?").get("lead-hidden") as { status: string };
      assert.equal(row.status, "qualified");
      assert.equal(other.status, "new");
    });
  } finally {
    database.close();
  }
});

test("a failed projection remains durable and retry creates exactly one CRM deal", async () => {
  const database = new Database(":memory:");
  try {
    database.exec(PUBLIC_LEAD_SCHEMA_SQL);
    capture(database, "configured-owner", "lead-retry");
    const failed = projectPublicLeadToCrm(database, "lead-retry", {
      ownerUid: "configured-owner",
      now: () => "2026-07-13T09:00:00.000Z",
    });
    assert.equal(failed.projection.status, "failed");
    assert.equal(failed.projection.attempts, 1);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM public_leads").get() as { count: number }).count, 1);

    database.exec(CRM_DEALS_TEST_SCHEMA_SQL);
    await withInboxServer(database, async (baseUrl) => {
      const retry = () => fetch(`${baseUrl}/api/odoo/public-leads/lead-retry/retry`, {
        method: "POST",
        headers: { "x-test-role": "manager" },
      });
      const first = await retry();
      assert.equal(first.status, 200);
      const firstBody = await first.json() as { lead: { projection_status: string; projection_attempts: number } };
      assert.equal(firstBody.lead.projection_status, "projected");
      assert.equal(firstBody.lead.projection_attempts, 2);

      const second = await retry();
      assert.equal(second.status, 200);
      const secondBody = await second.json() as { lead: { projection_status: string; projection_attempts: number } };
      assert.equal(secondBody.lead.projection_status, "projected");
      assert.equal(secondBody.lead.projection_attempts, 2);
      assert.equal((database.prepare("SELECT COUNT(*) AS count FROM crm_deals").get() as { count: number }).count, 1);
    });
  } finally {
    database.close();
  }
});
