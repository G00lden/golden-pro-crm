import assert from "node:assert/strict";
import test from "node:test";
import type { NextFunction, Request, Response } from "express";
import { createDemoDataEnvironmentGuard } from "./demoDataGuard";

function responseRecorder() {
  const state: { status?: number; body?: unknown } = {};
  const response = {
    status(code: number) {
      state.status = code;
      return this;
    },
    json(body: unknown) {
      state.body = body;
      return this;
    },
  } as unknown as Response;
  return { response, state };
}

test("production rejects demo data with an explicit 403 before the handler", () => {
  const { response, state } = responseRecorder();
  let continued = false;
  createDemoDataEnvironmentGuard(() => "production")(
    {} as Request,
    response,
    (() => { continued = true; }) as NextFunction,
  );

  assert.equal(continued, false);
  assert.equal(state.status, 403);
  assert.deepEqual(state.body, { error: "بيانات التجربة معطلة في بيئة الإنتاج." });
});

test("development permits the request to reach the admin role guard and handler", () => {
  const { response, state } = responseRecorder();
  let continued = false;
  createDemoDataEnvironmentGuard(() => "development")(
    {} as Request,
    response,
    (() => { continued = true; }) as NextFunction,
  );

  assert.equal(continued, true);
  assert.equal(state.status, undefined);
  assert.equal(state.body, undefined);
});
