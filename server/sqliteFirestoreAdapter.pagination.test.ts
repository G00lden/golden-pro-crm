import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("SQLite adapter applies the primary-key tie-breaker to offset zero", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "crm-sqlite-offset-zero-"));
  const dbPath = path.join(directory, "crm.db");
  const source = `
    const { createSqliteFirestoreAdapter } = await import("./server/sqliteFirestoreAdapter.ts");
    const adapter = createSqliteFirestoreAdapter();
    await adapter.collection("customers").doc("customer-z").set({ createdBy: "owner-a", name: "Same" });
    await adapter.collection("customers").doc("customer-a").set({ createdBy: "owner-a", name: "Same" });
    const snapshot = await adapter.collection("customers")
      .orderBy("name", "asc")
      .offset(0)
      .limit(2)
      .get();
    process.stdout.write(JSON.stringify(snapshot.docs.map((doc) => doc.id)));
  `;

  try {
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", source],
      {
        cwd: process.cwd(),
        env: { ...process.env, DB_PATH: dbPath, NODE_ENV: "test" },
        encoding: "utf8",
      },
    );
    assert.deepEqual(JSON.parse(output), ["customer-a", "customer-z"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
