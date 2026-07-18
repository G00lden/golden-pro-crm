import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { allocateInvoiceSequenceWithDatabase, historicalInvoiceSequence } from "./invoiceSequence";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const adapterUrl = pathToFileURL(path.join(root, "server", "sqliteFirestoreAdapter.ts")).href;
const dbUrl = pathToFileURL(path.join(root, "server", "db.ts")).href;

function childEnvironment(dbPath: string) {
  return {
    ...process.env,
    NODE_ENV: "test",
    DATA_PROVIDER: "sqlite",
    DB_PATH: dbPath,
  };
}

function workerSource(count: number, minimumNext: number) {
  return `
    (async () => {
      const { createSqliteFirestoreAdapter } = await import(${JSON.stringify(adapterUrl)});
      const adapter = createSqliteFirestoreAdapter();
      const values = [];
      for (let index = 0; index < ${count}; index += 1) {
        values.push(await adapter.allocateCounter("owner-concurrent", "tax_documents", ${minimumNext}));
      }
      process.stdout.write(JSON.stringify(values));
    })().catch((error) => {
      process.stderr.write(String(error && error.stack || error));
      process.exitCode = 1;
    });
  `;
}

function runWorker(dbPath: string, count: number, minimumNext = 1) {
  return new Promise<number[]>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--eval", workerSource(count, minimumNext)],
      { cwd: root, env: childEnvironment(dbPath), shell: false, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("SQLite counter worker timed out."));
    }, 30_000);
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(stderr || `SQLite counter worker exited with ${code}.`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as number[]);
      } catch (error) {
        reject(new Error(`Invalid SQLite counter worker output: ${stdout}`, { cause: error }));
      }
    });
  });
}

test("invoice sequence selects the provider-native allocator and fixed tax-document series", async () => {
  let input: unknown[] | undefined;
  const allocation = await allocateInvoiceSequenceWithDatabase({
    allocateCounter(...args) {
      input = args;
      return 17;
    },
  }, "owner-a", 12);

  assert.equal(allocation, 17);
  assert.deepEqual(input, ["owner-a", "tax_documents", 12]);
});

test("legacy Firestore invoice numbers seed a non-resetting sequence without sequence_no", () => {
  assert.equal(historicalInvoiceSequence({ invoice_number: "INV-20260619-001" }), 1);
  assert.equal(historicalInvoiceSequence({ invoice_number: "CN-20260705-042" }), 42);
  assert.equal(historicalInvoiceSequence({ sequence_no: 77, invoice_number: "INV-20260712-001" }), 77);
  assert.equal(historicalInvoiceSequence({ invoice_number: "INV-LEGACY" }), null);
});

test("invoice sequence falls back to a Firestore transaction", async () => {
  let stored: Record<string, unknown> | undefined;
  let collectionName = "";
  let documentId = "";
  const database = {
    collection(name: string) {
      collectionName = name;
      return { doc(id: string) { documentId = id; return { id }; } };
    },
    async runTransaction<T>(callback: (transaction: {
      get: (_reference: unknown) => Promise<{ exists: boolean; data: () => Record<string, unknown> }>;
      set: (_reference: unknown, data: Record<string, unknown>, options?: { merge?: boolean }) => void;
    }) => Promise<T>) {
      return callback({
        async get(_reference) {
          return { exists: Boolean(stored), data: () => stored || {} };
        },
        set(_reference, data, _options) { stored = data; },
      });
    },
  };

  assert.equal(await allocateInvoiceSequenceWithDatabase(database, "owner-a", 5), 5);
  assert.equal(await allocateInvoiceSequenceWithDatabase(database, "owner-a", 1), 6);
  assert.equal(collectionName, "invoice_sequences");
  assert.equal(documentId, "owner-a__tax_documents");
  assert.equal(stored?.owner_uid, "owner-a");
  assert.equal(stored?.series, "tax_documents");
  assert.equal(stored?.last_value, 6);
});

test("SQLite counter is durable and unique across concurrent database connections", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "crm-invoice-sequence-"));
  const dbPath = path.join(directory, "crm.db");
  try {
    const bootstrap = spawnSync(
      process.execPath,
      ["--import", "tsx", "--eval", `import(${JSON.stringify(dbUrl)})`],
      { cwd: root, env: childEnvironment(dbPath), encoding: "utf8", shell: false },
    );
    assert.equal(bootstrap.status, 0, bootstrap.stderr || bootstrap.stdout);

    const batches = await Promise.all([
      runWorker(dbPath, 10),
      runWorker(dbPath, 10),
      runWorker(dbPath, 10),
    ]);
    const concurrent = batches.flat().sort((left, right) => left - right);
    assert.deepEqual(concurrent, Array.from({ length: 30 }, (_, index) => index + 1));

    assert.deepEqual(await runWorker(dbPath, 1), [31]);
    assert.deepEqual(await runWorker(dbPath, 1, 100), [100]);
    assert.deepEqual(await runWorker(dbPath, 1), [101]);

    const inspection = new Database(dbPath, { readonly: true });
    try {
      const state = inspection.prepare(`
        SELECT last_value
        FROM invoice_sequences
        WHERE owner_uid = 'owner-concurrent' AND series = 'tax_documents'
      `).get() as { last_value?: number } | undefined;
      assert.equal(state?.last_value, 101);
      assert.equal(Number(inspection.pragma("user_version", { simple: true })), 10501);
    } finally {
      inspection.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Supabase migration mirrors counter RPC and credit-note lifecycle constraints", () => {
  const migration = readFileSync(
    path.join(root, "supabase", "migrations", "20260713180000_invoice_document_sequence.sql"),
    "utf8",
  );
  for (const required of [
    "document_kind",
    "sequence_no",
    "issued_at",
    "source_invoice_id",
    "adjustment_kind",
    "adjustment_scope",
    "adjustment_reason",
    "idempotency_key",
    "invoice_sequences",
    "tax_documents",
    "idx_invoices_owner_sequence",
    "idx_invoices_owner_idempotency",
    "idx_invoices_one_full_credit_per_source",
    "allocate_invoice_sequence",
  ]) {
    assert.match(migration, new RegExp(required));
  }
  assert.match(migration, /greatest\(public\.invoice_sequences\.last_value \+ 1, excluded\.last_value\)/i);
  assert.match(migration, /security definer/i);
  assert.match(migration, /revoke all on function[\s\S]*from public, anon, authenticated/i);
  assert.match(migration, /substring\(btrim\(invoice_number\)[\s\S]*collision_rank[\s\S]*collision_assignments/i);
  assert.match(migration, /maximum_candidate \+ row_number\(\) over/i);
  assert.match(migration, /order by sort_time nulls first, invoice_number, id/i);
  assert.match(migration, /status <> 'draft'/i);
  assert.equal(
    (migration.match(/pg_catalog\.pg_advisory_xact_lock/gi) || []).length,
    2,
    "credit insertion and source status transitions must share a transaction lock",
  );
  assert.match(
    migration,
    /hashtextextended\([\s\S]*new\.owner_uid[\s\S]*new\.source_invoice_id[\s\S]*hashtextextended\([\s\S]*old\.owner_uid[\s\S]*old\.id/i,
  );
  assert.match(migration, /new\.status is distinct from old\.status/i);
  assert.match(migration, /drop policy if exists invoices_owner_access on public\.invoices/i);
  assert.match(migration, /create policy invoices_owner_select on public\.invoices[\s\S]*for select/i);
  assert.match(migration, /revoke all on table public\.invoices from anon, authenticated/i);
  assert.match(migration, /grant select on table public\.invoices to authenticated/i);
  assert.match(
    migration,
    /grant select, insert, update, delete on table public\.invoices to service_role/i,
  );

  const verifier = readFileSync(path.join(root, "scripts", "supabase-verify.mjs"), "utf8");
  assert.match(verifier, /name: "invoices"[\s\S]*document_kind[\s\S]*sequence_no[\s\S]*idempotency_key/i);
  assert.match(verifier, /name: "invoice_sequences"[\s\S]*last_value/i);
  assert.match(verifier, /\/rpc\/allocate_invoice_sequence/i);
});
