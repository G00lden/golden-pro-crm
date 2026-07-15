import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { NextFunction, Request, Response } from "express";
import { requireCapability } from "./capabilityGuard";

function invoke(role: "admin" | "manager" | "user", capability: Parameters<typeof requireCapability>[0]) {
  const state: { status?: number; continued: boolean } = { continued: false };
  const request = { user: { uid: `${role}-uid`, role } } as unknown as Request;
  const response = {
    status(code: number) {
      state.status = code;
      return this;
    },
    json() {
      return this;
    },
  } as unknown as Response;
  const next = (() => { state.continued = true; }) as NextFunction;
  requireCapability(capability)(request, response, next);
  return state;
}

test("admin reaches user, WhatsApp, campaign, public-lead, and setup handlers", () => {
  for (const capability of ["users.manage", "whatsapp.manage", "campaigns.manage", "public_leads.manage", "operations.prepare"] as const) {
    assert.deepEqual(invoke("admin", capability), { continued: true });
  }
});

test("manager reaches campaigns and operational preparation but not admin surfaces", () => {
  assert.deepEqual(invoke("manager", "campaigns.manage"), { continued: true });
  assert.deepEqual(invoke("manager", "public_leads.manage"), { continued: true });
  assert.deepEqual(invoke("manager", "operations.prepare"), { continued: true });
  assert.deepEqual(invoke("manager", "users.manage"), { continued: false, status: 403 });
  assert.deepEqual(invoke("manager", "whatsapp.manage"), { continued: false, status: 403 });
});

test("viewer persisted as user receives 403 for every privileged capability", () => {
  for (const capability of ["users.manage", "whatsapp.manage", "campaigns.manage", "public_leads.manage", "operations.prepare", "demo.seed"] as const) {
    assert.deepEqual(invoke("user", capability), { continued: false, status: 403 });
  }
});

test("legacy gateway inventory remains restricted to device managers", () => {
  const source = readFileSync(new URL("./routes-gateway.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /app\.get\("\/api\/gateway\/devices", requireCapability\("mobile\.devices\.manage"\)/,
  );
  assert.doesNotMatch(
    source,
    /app\.get\("\/api\/gateway\/devices", requireCapability\("mobile\.devices\.view"\)/,
  );
});
