import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

test("gateway pairing codes are one-time and device credentials are revocable", async () => {
  const dbPath = path.join(os.tmpdir(), `golden-gateway-pairing-${process.pid}-${Date.now()}.db`);
  process.env.DB_PATH = dbPath;
  process.env.GATEWAY_TOKEN = "test-server-secret-that-is-not-stored";
  let openedDb: { close: () => void } | null = null;

  try {
    // Simulate a server that already created the first device table revision;
    // server/db.ts must add idempotency columns without dropping its data.
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE gateway_devices (
        id TEXT PRIMARY KEY,
        owner_uid TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        company_number TEXT NOT NULL DEFAULT '',
        token_hash TEXT NOT NULL,
        last_seen_at TEXT,
        created_by TEXT,
        created_at TEXT,
        revoked_at TEXT
      )
    `);
    legacyDb.close();

    const [{ default: db }, pairing] = await Promise.all([
      import("./db"),
      import("./gatewayPairing"),
    ]);
    openedDb = db;
    const migratedColumns = (db.prepare("PRAGMA table_info(gateway_devices)").all() as Array<{ name: string }>)
      .map((column) => column.name);
    assert.ok(migratedColumns.includes("pairing_code_id"));
    assert.ok(migratedColumns.includes("pairing_nonce_hash"));
    const ownerUid = "pairing-test-owner";
    const now = Date.parse("2026-07-14T08:00:00.000Z");
    const issued = pairing.createGatewayPairingCode(ownerUid, "admin-1", { now });

    assert.match(issued.code, /^\d{8}$/);
    assert.equal(issued.expiresAt, "2026-07-14T08:10:00.000Z");
    const storedCode = db.prepare("SELECT code_hash FROM gateway_pairing_codes WHERE owner_uid = ?")
      .get(ownerUid) as { code_hash: string };
    assert.notEqual(storedCode.code_hash, issued.code);

    const redeemed = pairing.redeemGatewayPairingCode({
      code: issued.code,
      deviceName: "جوال المبيعات",
      companyNumber: "+966500000000",
      clientNonce: "pairing-attempt-0001",
      now: now + 1_000,
    });
    assert.ok(redeemed);
    assert.match(redeemed.token, /^gwd_/);
    assert.equal(redeemed.ownerUid, ownerUid);
    const repeatedResponse = pairing.redeemGatewayPairingCode({
      code: issued.code,
      deviceName: "جوال المبيعات",
      clientNonce: "pairing-attempt-0001",
      now: now + 2_000,
    });
    assert.equal(repeatedResponse?.deviceId, redeemed.deviceId);
    assert.equal(repeatedResponse?.token, redeemed.token);
    assert.equal(pairing.redeemGatewayPairingCode({
      code: issued.code,
      deviceName: "جهاز مكرر",
      clientNonce: "different-attempt-0002",
      now: now + 2_000,
    }), null);

    const storedDevice = db.prepare("SELECT token_hash FROM gateway_devices WHERE id = ?")
      .get(redeemed.deviceId) as { token_hash: string };
    assert.notEqual(storedDevice.token_hash, redeemed.token);
    assert.equal(pairing.verifyGatewayDeviceToken(ownerUid, redeemed.token, now + 3_000), true);
    assert.equal(pairing.verifyGatewayDeviceToken(ownerUid, `${redeemed.token}x`, now + 3_000), false);
    assert.equal(pairing.activeGatewayDeviceCount(ownerUid), 1);
    assert.equal(pairing.listGatewayDevices(ownerUid)[0].name, "جوال المبيعات");

    assert.equal(pairing.revokeGatewayDevice(ownerUid, redeemed.deviceId, now + 4_000), true);
    assert.equal(pairing.verifyGatewayDeviceToken(ownerUid, redeemed.token, now + 5_000), false);
    assert.equal(pairing.activeGatewayDeviceCount(ownerUid), 0);

    const expired = pairing.createGatewayPairingCode(ownerUid, "admin-1", {
      now,
      ttlMs: 1_000,
    });
    assert.equal(pairing.redeemGatewayPairingCode({
      code: expired.code,
      deviceName: "جهاز متأخر",
      clientNonce: "expired-attempt-0003",
      now: now + 1_001,
    }), null);
  } finally {
    openedDb?.close();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
  }
});
