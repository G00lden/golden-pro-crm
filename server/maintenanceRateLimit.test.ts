import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import express, { type RequestHandler } from "express";
import {
  maintenanceReadRateLimitOptions,
  maintenanceRequestRateLimitOptions,
  maintenanceVerificationRateLimitOptions,
  registerMaintenanceRequestPublicRoutes,
} from "./routes-maintenance-requests";

test("maintenance catalog reads, WhatsApp verification, and mutations use independent buckets", async () => {
  const hits = { read: 0, verification: 0, mutation: 0 };
  const counter = (name: keyof typeof hits): RequestHandler => (_req, _res, next) => {
    hits[name] += 1;
    next();
  };
  const app = express();
  app.use(express.json());
  registerMaintenanceRequestPublicRoutes(app, {
    rateLimit: counter("mutation"),
    readRateLimit: counter("read"),
    verificationRateLimit: counter("verification"),
    ownerUid: () => null,
    queueFieldTechSync: () => undefined,
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const readResponse = await fetch(`${base}/public/maintenance-products`);
    const verificationResponse = await fetch(`${base}/public/maintenance-phone-verification`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customer_phone: "x" }),
    });
    const mutationResponse = await fetch(`${base}/public/maintenance-requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    assert.equal(readResponse.status, 503);
    assert.equal(verificationResponse.status, 400);
    assert.equal(mutationResponse.status, 400);
    assert.deepEqual(hits, { read: 1, verification: 1, mutation: 1 });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("maintenance limiter defaults cannot share one bucket name", () => {
  const reads = maintenanceReadRateLimitOptions({});
  const verification = maintenanceVerificationRateLimitOptions({});
  const mutations = maintenanceRequestRateLimitOptions({});

  assert.deepEqual(
    new Set([reads.name, verification.name, mutations.name]).size,
    3,
  );
  assert.equal(reads.max, 180);
  assert.equal(verification.max, 12);
  assert.equal(mutations.max, 20);
  assert.ok(reads.max > mutations.max);
  assert.match(verification.message, /رمز التحقق/);
  assert.match(mutations.message, /طلب الصيانة/);
});
