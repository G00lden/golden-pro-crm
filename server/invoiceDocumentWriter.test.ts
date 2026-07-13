import assert from "node:assert/strict";
import test from "node:test";
import {
  createAtomicInvoiceDocumentWithDatabase,
  deterministicInvoiceDocumentId,
  type InvoiceDocumentDatabase,
} from "./invoiceDocumentWriter";

type Row = Record<string, unknown>;

class SerializedFirestore {
  readonly rows = new Map<string, Row>();
  private tail: Promise<unknown> = Promise.resolve();

  private path(collection: string, id: string) {
    return `${collection}/${id}`;
  }

  private snapshot(collection: string, id: string) {
    const row = this.rows.get(this.path(collection, id));
    return { id, exists: Boolean(row), data: () => ({ ...(row || {}) }) };
  }

  collection = (name: string) => {
    const database = this;
    return {
      doc(id: string) {
        return {
          id,
          get: async () => database.snapshot(name, id),
        };
      },
      where(field: string, _operator: string, value: unknown) {
        return {
          where: this.where,
          async get() {
            const docs = [...database.rows.entries()]
              .filter(([path, row]) => path.startsWith(`${name}/`) && row[field] === value)
              .map(([path]) => database.snapshot(name, path.slice(name.length + 1)));
            return { docs };
          },
        };
      },
      async get() { return { docs: [] }; },
    };
  };

  runTransaction<T>(callback: (transaction: any) => Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      const writes: Array<() => void> = [];
      const result = await callback({
        get: async (reference: { id: string }) => {
          const collection = reference.id.includes("__tax_documents") ? "invoice_sequences" : "invoices";
          return this.snapshot(collection, reference.id);
        },
        set: (reference: { id: string }, data: Row) => {
          writes.push(() => this.rows.set(this.path("invoice_sequences", reference.id), { ...data }));
        },
        create: (reference: { id: string }, data: Row) => {
          writes.push(() => {
            const path = this.path("invoices", reference.id);
            if (this.rows.has(path)) throw new Error("already exists");
            this.rows.set(path, { ...data });
          });
        },
      });
      for (const write of writes) write();
      return result;
    });
    this.tail = run.catch(() => undefined);
    return run;
  }
}

function options(key: string) {
  return {
    ownerUid: "owner-a",
    idempotencyKey: key,
    issued: true,
    minimumNext: 1,
    now: () => "2026-07-13T18:00:00.000Z",
    build: ({ sequence, issuedAt }: { sequence: number | null; issuedAt: string | null }) => ({
      invoice_number: `INV-20260713-${sequence}`,
      sequence_no: sequence,
      issued_at: issuedAt,
      status: "issued",
    }),
  };
}

test("deterministic invoice document id is stable per owner and idempotency key", () => {
  assert.equal(
    deterministicInvoiceDocumentId("owner-a", "invoice:retry-1"),
    deterministicInvoiceDocumentId("owner-a", "invoice:retry-1"),
  );
  assert.notEqual(
    deterministicInvoiceDocumentId("owner-a", "invoice:retry-1"),
    deterministicInvoiceDocumentId("owner-b", "invoice:retry-1"),
  );
});

test("concurrent Firestore retries create one invoice and consume one sequence", async () => {
  const database = new SerializedFirestore();
  const results = await Promise.all(Array.from({ length: 12 }, () =>
    createAtomicInvoiceDocumentWithDatabase(database as unknown as InvoiceDocumentDatabase, options("invoice:retry-1"))));

  assert.equal(new Set(results.map((result) => result.id)).size, 1);
  assert.equal(results.filter((result) => result.created).length, 1);
  assert.ok(results.every((result) => result.data.sequence_no === 1));
  assert.equal(database.rows.get("invoice_sequences/owner-a__tax_documents")?.last_value, 1);
});

test("Firestore first-use seed scans all legacy invoices once and continues above the maximum", async () => {
  const database = new SerializedFirestore();
  database.rows.set("invoices/legacy-high", {
    createdBy: "owner-a",
    invoice_number: "INV-20260712-077",
  });
  database.rows.set("invoices/legacy-reset", {
    createdBy: "owner-a",
    invoice_number: "INV-20260619-001",
  });
  const first = await createAtomicInvoiceDocumentWithDatabase(
    database as unknown as InvoiceDocumentDatabase,
    options("invoice:after-legacy"),
  );
  assert.equal(first.data.sequence_no, 78);

  const batch = await Promise.all(Array.from({ length: 5 }, (_, index) =>
    createAtomicInvoiceDocumentWithDatabase(
      database as unknown as InvoiceDocumentDatabase,
      options(`invoice:unique-${index}`),
    )));
  assert.deepEqual(batch.map((result) => result.data.sequence_no).sort((a, b) => Number(a) - Number(b)), [79, 80, 81, 82, 83]);
});

test("a legacy random document is replayed without allocating another number", async () => {
  const database = new SerializedFirestore();
  database.rows.set("invoices/legacy-random-id", {
    createdBy: "owner-a",
    idempotency_key: "quote:legacy-quote",
    quote_id: "legacy-quote",
    sequence_no: 42,
    invoice_number: "INV-20260712-042",
  });
  const result = await createAtomicInvoiceDocumentWithDatabase(
    database as unknown as InvoiceDocumentDatabase,
    {
      ...options("quote:legacy-quote"),
      legacyIdentity: { field: "quote_id", value: "legacy-quote" },
    },
  );
  assert.equal(result.created, false);
  assert.equal(result.id, "legacy-random-id");
  assert.equal(result.data.sequence_no, 42);
  assert.equal(database.rows.has("invoice_sequences/owner-a__tax_documents"), false);
});
