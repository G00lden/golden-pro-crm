import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import express, { type NextFunction, type Request, type Response } from "express";
import { registerSallaRoutes, toSallaDependencyError } from "./routes-salla";

const ENV_KEYS = [
  "NODE_ENV",
  "DATA_PROVIDER",
  "DB_PROVIDER",
  "SALLA_INTEGRATION_STORE_PATH",
  "SALLA_CLIENT_ID",
  "SALLA_CLIENT_SECRET",
] as const;

async function withSallaServer(run: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as Request & { user: { uid: string } }).user = { uid: "availability-owner" };
    next();
  });
  registerSallaRoutes(app);
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

test("Salla status discovery is typed and fail-closed before configuration or linking", async () => {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const root = await mkdtemp(path.join(tmpdir(), "crm-salla-availability-"));
  try {
    process.env.NODE_ENV = "test";
    process.env.DATA_PROVIDER = "sqlite";
    delete process.env.DB_PROVIDER;
    process.env.SALLA_INTEGRATION_STORE_PATH = path.join(root, "salla-integrations.json");
    delete process.env.SALLA_CLIENT_ID;
    delete process.env.SALLA_CLIENT_SECRET;

    await withSallaServer(async (baseUrl) => {
      const notConfigured = await fetch(`${baseUrl}/api/integrations/salla/order-statuses`);
      assert.equal(notConfigured.status, 200);
      assert.deepEqual(await notConfigured.json(), {
        data: [],
        available: false,
        configured: false,
        linked: false,
        status: "not_configured",
        reason: "تكامل سلة غير مهيأ على الخادم. أكمل إعداد مفاتيح التطبيق من الإعدادات أولًا.",
      });

      process.env.SALLA_CLIENT_ID = "test-client";
      process.env.SALLA_CLIENT_SECRET = "test-secret";
      const notLinked = await fetch(`${baseUrl}/api/integrations/salla/order-statuses`);
      assert.equal(notLinked.status, 200);
      assert.deepEqual(await notLinked.json(), {
        data: [],
        available: false,
        configured: true,
        linked: false,
        status: "ready_to_connect",
        reason: "متجر سلة غير متصل بهذا الحساب. اربط المتجر من الإعدادات قبل المزامنة أو تعديل الطلبات.",
      });
    });
  } finally {
    for (const key of ENV_KEYS) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("upstream Salla authorization and regional failures remain failed dependencies", () => {
  for (const status of [401, 403, 429, 500]) {
    const upstream = Object.assign(new Error(`upstream-${status}`), { status });
    const mapped = toSallaDependencyError(upstream) as Error & { status?: number };
    assert.equal(mapped.status, 424);
    assert.equal(mapped.message, `upstream-${status}`);
  }
});
