import assert from "node:assert/strict";
import test from "node:test";
import express, { type RequestHandler } from "express";
import Database from "better-sqlite3";
import {
  registerTrackingRoutes,
  trackingEventRateLimitOptions,
  type AcceptedTrackingEvent,
} from "./routes-tracking";
import { TIKTOK_ATTRIBUTION_SCHEMA_SQL } from "./tiktokAttributionStorage";

async function withServer(
  rateLimit: RequestHandler,
  run: (baseUrl: string, acceptedEvents: AcceptedTrackingEvent[]) => Promise<void>,
) {
  const acceptedEvents: AcceptedTrackingEvent[] = [];
  const app = express();
  app.use(express.json());
  registerTrackingRoutes(app, {
    rateLimit,
    onAccepted: (event) => acceptedEvents.push(event),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    await run(`http://127.0.0.1:${address.port}`, acceptedEvents);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

const allow: RequestHandler = (_req, _res, next) => next();

test("tracking intake accepts known events and strips PII, secrets, and attribution ids", async () => {
  await withServer(allow, async (baseUrl, acceptedEvents) => {
    const response = await fetch(`${baseUrl}/api/track/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "lead_submit",
        event_id: "event-12345678",
        value: 125.5,
        currency: "SAR",
        page: "/landing",
        ts: "2026-07-13T10:00:00.000Z",
        phone: "+966551234567",
        email: "customer@example.com",
        authorization: "Bearer should-never-survive",
        utm: { gclid: "private-click-id", landing_url: "https://example.test/?token=secret" },
        meta: { service: "private free text" },
      }),
    });

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { accepted: true });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(acceptedEvents, [{
      event: "lead_submit",
      event_id: "event-12345678",
      value: 125.5,
      currency: "SAR",
      page: "/landing",
      ts: "2026-07-13T10:00:00.000Z",
    }]);
  });
});

test("tracking intake rejects unknown events before accepting them", async () => {
  await withServer(allow, async (baseUrl, acceptedEvents) => {
    const response = await fetch(`${baseUrl}/api/track/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "email_customer@example.com",
        event_id: "event-12345678",
        page: "/",
        ts: "2026-07-13T10:00:00.000Z",
      }),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(acceptedEvents, []);
  });
});

test("tracking intake runs its dedicated limiter before validation", async () => {
  const blocked: RequestHandler = (_req, res) => {
    res.status(429).json({ error: "Too many tracking requests" });
  };
  await withServer(blocked, async (baseUrl, acceptedEvents) => {
    const response = await fetch(`${baseUrl}/api/track/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    assert.equal(response.status, 429);
    assert.deepEqual(acceptedEvents, []);
  });
});

test("tracking rate-limit settings use safe defaults and bounded overrides", () => {
  assert.deepEqual(trackingEventRateLimitOptions({}), {
    windowMs: 60_000,
    max: 120,
    name: "tracking-events",
  });
  assert.deepEqual(trackingEventRateLimitOptions({
    TRACK_EVENT_RATE_LIMIT_WINDOW_MS: "invalid",
    TRACK_EVENT_RATE_LIMIT_MAX: "0",
  }), {
    windowMs: 60_000,
    max: 120,
    name: "tracking-events",
  });
  assert.equal(trackingEventRateLimitOptions({ TRACK_EVENT_RATE_LIMIT_MAX: "999999" }).max, 10_000);
});

test("consented WhatsApp redirect persists the click before adding its message reference", async () => {
  const previous = process.env.TIKTOK_ATTRIBUTION_ENABLED;
  process.env.TIKTOK_ATTRIBUTION_ENABLED = "true";
  const database = new Database(":memory:");
  database.exec(TIKTOK_ATTRIBUTION_SCHEMA_SQL);
  const app = express();
  registerTrackingRoutes(app, {
    rateLimit: allow,
    database,
    ownerUid: () => "owner-a",
    clientIp: () => "203.0.113.10",
    publicContactPhone: () => "+966551234567",
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const params = new URLSearchParams({
      reference: "0123456789ABCDEF",
      consent: "granted",
      message: "أرغب بعرض سعر",
      page: "/landing-ac",
      ttclid: "test-click-123456",
      ts: "2026-07-21T10:00:00.000Z",
    });
    const response = await fetch(`http://127.0.0.1:${address.port}/api/track/whatsapp?${params}`, {
      redirect: "manual",
    });
    assert.equal(response.status, 302);
    const location = decodeURIComponent(response.headers.get("location") || "");
    assert.match(location, /^https:\/\/wa\.me\/966551234567\?text=/);
    assert.match(location, /مرجع الطلب:\n0123456789ABCDEF/);
    const session = database.prepare(
      "SELECT ttclid, landing_path, client_ip FROM marketing_attribution_sessions WHERE reference = ?",
    ).get("0123456789ABCDEF");
    assert.deepEqual(session, {
      ttclid: "test-click-123456",
      landing_path: "/landing-ac",
      client_ip: "203.0.113.10",
    });
    const event = database.prepare("SELECT event_name, status FROM marketing_attribution_events").get();
    assert.deepEqual(event, { event_name: "ClickButton", status: "pending" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    database.close();
    if (previous === undefined) delete process.env.TIKTOK_ATTRIBUTION_ENABLED;
    else process.env.TIKTOK_ATTRIBUTION_ENABLED = previous;
  }
});
