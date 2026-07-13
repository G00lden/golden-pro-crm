import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import express, { type RequestHandler } from "express";
import Database from "better-sqlite3";
import { PUBLIC_LEAD_SCHEMA_SQL, type PublicLeadRecord } from "./publicLeadStorage";
import {
  publicLeadRateLimitOptions,
  registerPublicLeadRoutes,
  resolvePublicLeadOwnerUid,
} from "./routes-public-leads";

const passThrough: RequestHandler = (_req, _res, next) => next();

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

function storedLeadCount(database: Database.Database) {
  return (database.prepare("SELECT COUNT(*) AS count FROM public_leads").get() as { count: number }).count;
}

async function withServer(
  rateLimit: RequestHandler,
  run: (baseUrl: string, database: Database.Database) => Promise<void>,
  options: {
    ownerUid?: () => string | null;
    includeCrmDeals?: boolean;
    idFactory?: () => string;
  } = {},
) {
  const database = new Database(":memory:");
  database.exec(PUBLIC_LEAD_SCHEMA_SQL);
  if (options.includeCrmDeals !== false) database.exec(CRM_DEALS_TEST_SCHEMA_SQL);
  const app = express();
  app.use(express.json({ limit: "32kb" }));
  registerPublicLeadRoutes(app, {
    database,
    rateLimit,
    ownerUid: options.ownerUid || (() => "crm-owner"),
    idFactory: options.idFactory || (() => "lead-fixed"),
    now: () => "2026-07-13T09:00:00.000Z",
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`, database);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    database.close();
  }
}

test("POST /api/leads/public validates and stores a public lead with ownership", async () => {
  await withServer(passThrough, async (baseUrl, database) => {
    const response = await fetch(`${baseUrl}/api/leads/public`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "عميل تجريبي",
        phone: "00 966 55 123 4567",
        service: "صيانة",
        message: "أحتاج موعداً",
        source: "landing-v2",
        utm: { utm_source: "google", utm_campaign: "summer" },
      }),
    });

    assert.equal(response.status, 201);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      success: true,
      lead_id: "lead-fixed",
      received_at: "2026-07-13T09:00:00.000Z",
    });

    const row = database.prepare("SELECT * FROM public_leads WHERE id = ?").get("lead-fixed") as PublicLeadRecord;
    assert.equal(row.owner_uid, "crm-owner");
    assert.equal(row.phone, "+966551234567");
    assert.equal(row.status, "new");
    assert.deepEqual(JSON.parse(row.utm_json), { utm_source: "google", utm_campaign: "summer" });
    const projection = database.prepare(
      "SELECT status, target_id, attempts FROM public_lead_projections WHERE lead_id = ?",
    ).get("lead-fixed") as { status: string; target_id: string; attempts: number };
    assert.equal(projection.status, "projected");
    assert.equal(projection.attempts, 1);
    const deal = database.prepare(
      "SELECT owner_uid, customer_name, customer_phone, source FROM crm_deals WHERE id = ?",
    ).get(projection.target_id) as Record<string, unknown>;
    assert.equal(deal.owner_uid, "crm-owner");
    assert.equal(deal.customer_name, "عميل تجريبي");
    assert.equal(deal.customer_phone, "+966551234567");
    assert.equal(deal.source, "public_lead");
  });
});

test("POST /api/leads/public deduplicates an identical recent submission and one CRM deal", async () => {
  await withServer(passThrough, async (baseUrl, database) => {
    const payload = {
      name: "عميل متكرر",
      phone: "+966551234567",
      service: "صيانة",
      message: "أحتاج موعداً",
      source: "landing-v2",
      utm: { utm_campaign: "summer", utm_source: "google" },
    };
    const submit = () => fetch(`${baseUrl}/api/leads/public`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const first = await submit();
    const second = await submit();
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), await first.json());
    assert.equal(storedLeadCount(database), 1);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM crm_deals").get() as { count: number }).count, 1);
  });
});

test("POST /api/leads/public keeps the lead when CRM projection fails", async () => {
  await withServer(passThrough, async (baseUrl, database) => {
    const response = await fetch(`${baseUrl}/api/leads/public`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "عميل محفوظ", phone: "+966551234567" }),
    });
    assert.equal(response.status, 201);
    assert.equal(storedLeadCount(database), 1);
    const projection = database.prepare(
      "SELECT status, attempts, last_error, next_retry_at FROM public_lead_projections WHERE lead_id = ?",
    ).get("lead-fixed") as Record<string, unknown>;
    assert.equal(projection.status, "failed");
    assert.equal(projection.attempts, 1);
    assert.equal(projection.last_error, "projection_failed");
    assert.ok(projection.next_retry_at);
  }, { includeCrmDeals: false });
});

test("public lead intake fails closed when no owner is configured", async () => {
  await withServer(passThrough, async (baseUrl, database) => {
    const response = await fetch(`${baseUrl}/api/leads/public`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "عميل جديد", phone: "+966551234567" }),
    });
    assert.equal(response.status, 503);
    assert.equal(storedLeadCount(database), 0);
  }, { ownerUid: () => null });
});

test("the public lead endpoint exposes no public read route", async () => {
  await withServer(passThrough, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/leads/public`);
    assert.equal(response.status, 404);
  });
});

test("POST /api/leads/public rejects invalid payloads without storage", async () => {
  await withServer(passThrough, async (baseUrl, database) => {
    const response = await fetch(`${baseUrl}/api/leads/public`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", phone: "123", source: "landing" }),
    });
    assert.equal(response.status, 400);
    assert.equal(storedLeadCount(database), 0);
  });
});

test("POST /api/leads/public silently drops a filled honeypot", async () => {
  await withServer(passThrough, async (baseUrl, database) => {
    const response = await fetch(`${baseUrl}/api/leads/public`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "عميل تجريبي",
        phone: "+966551234567",
        source: "landing",
        website: "https://spam.example",
      }),
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { success: true });
    assert.equal(storedLeadCount(database), 0);
  });
});

test("POST /api/leads/public honors its dedicated rate limiter", async () => {
  const blocked: RequestHandler = (_req, res) => {
    res.status(429).json({ error: "Too many public lead requests" });
  };
  await withServer(blocked, async (baseUrl, database) => {
    const response = await fetch(`${baseUrl}/api/leads/public`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "عميل تجريبي", phone: "+966551234567" }),
    });
    assert.equal(response.status, 429);
    assert.equal(storedLeadCount(database), 0);
  });
});

test("public lead ownership uses the explicit public setting first", () => {
  assert.equal(resolvePublicLeadOwnerUid({
    PUBLIC_LEADS_OWNER_UID: " public-owner ",
    STORE_WEBHOOK_OWNER_UID: "store-owner",
  }), "public-owner");
  assert.equal(resolvePublicLeadOwnerUid({ STORE_WEBHOOK_OWNER_UID: "store-owner" }), "store-owner");
  assert.equal(resolvePublicLeadOwnerUid({}), null);
});

test("public lead rate-limit settings fail safely on malformed environment values", () => {
  assert.deepEqual(publicLeadRateLimitOptions({}), {
    windowMs: 900_000,
    max: 10,
    name: "public-leads",
  });
  assert.deepEqual(publicLeadRateLimitOptions({
    PUBLIC_LEAD_RATE_LIMIT_WINDOW_MS: "not-a-number",
    PUBLIC_LEAD_RATE_LIMIT_MAX: "0",
  }), {
    windowMs: 900_000,
    max: 10,
    name: "public-leads",
  });
  assert.equal(publicLeadRateLimitOptions({ PUBLIC_LEAD_RATE_LIMIT_MAX: "99999" }).max, 1_000);
});
