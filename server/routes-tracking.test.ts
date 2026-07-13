import assert from "node:assert/strict";
import test from "node:test";
import express, { type RequestHandler } from "express";
import {
  registerTrackingRoutes,
  trackingEventRateLimitOptions,
  type AcceptedTrackingEvent,
} from "./routes-tracking";

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
