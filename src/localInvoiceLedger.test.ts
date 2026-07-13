import assert from "node:assert/strict";
import test from "node:test";
import {
  mutateLocalInvoiceLedger,
  type LocalInvoiceLedgerLockManager,
  type LocalInvoiceLedgerRecord,
} from "./localInvoiceLedger";

type TestInvoice = LocalInvoiceLedgerRecord & {
  id: string;
  invoice_number: string;
  status: "draft" | "issued" | "sent" | "paid";
  total_with_vat: number;
};

type TestDb = {
  invoices: TestInvoice[];
  taxDocumentSequence: number;
};

class SharedTabLocks implements LocalInvoiceLedgerLockManager {
  private tails = new Map<string, Promise<unknown>>();

  request<T>(name: string, callback: () => T | Promise<T>): Promise<T> {
    const previous = this.tails.get(name) || Promise.resolve();
    const current = previous.then(callback, callback);
    this.tails.set(name, current.catch(() => undefined));
    return current;
  }
}

function issuedInvoice(id: string, sequence: number): TestInvoice {
  return {
    id,
    invoice_number: `INV-20260713-${String(sequence).padStart(3, "0")}`,
    document_kind: "invoice",
    sequence_no: sequence,
    issued_at: `2026-07-13T12:00:${String(sequence).padStart(2, "0")}.000Z`,
    idempotency_key: `invoice:${id}`,
    status: "issued",
    total_with_vat: sequence * 100,
  };
}

function mutationOptions<T>(
  locks: LocalInvoiceLedgerLockManager,
  read: () => TestDb,
  write: (data: TestDb) => void,
  mutate: (data: TestDb, allocateSequence: () => number) => T | Promise<T>,
) {
  return {
    locks,
    lockName: "invoice-ledger:owner-a",
    load: read,
    save: write,
    invoices: (data: TestDb) => data.invoices,
    getSequence: (data: TestDb) => data.taxDocumentSequence,
    setSequence: (data: TestDb, value: number) => { data.taxDocumentSequence = value; },
    mutate,
  };
}

test("two tabs allocate and persist distinct invoice sequences under one shared lock", async () => {
  const locks = new SharedTabLocks();
  let stored = JSON.stringify({ invoices: [], taxDocumentSequence: 0 } satisfies TestDb);
  const read = () => JSON.parse(stored) as TestDb;
  const write = (data: TestDb) => { stored = JSON.stringify(data); };

  const createFromTab = (id: string) => mutateLocalInvoiceLedger(mutationOptions(
    locks,
    read,
    write,
    async (data, allocateSequence) => {
      await Promise.resolve();
      const sequence = allocateSequence();
      data.invoices.push(issuedInvoice(id, sequence));
      return sequence;
    },
  ));

  const allocations = await Promise.all([
    createFromTab("tab-a"),
    createFromTab("tab-b"),
  ]);
  const finalState = read();
  assert.deepEqual(allocations.sort((left, right) => left - right), [1, 2]);
  assert.equal(finalState.taxDocumentSequence, 2);
  assert.deepEqual(
    finalState.invoices.map((invoice) => invoice.sequence_no).sort(),
    [1, 2],
  );
});

test("a stale tab cannot lower the counter, remove, or financially modify an issued document", async () => {
  const locks = new SharedTabLocks();
  const original = { invoices: [issuedInvoice("original", 5)], taxDocumentSequence: 5 } satisfies TestDb;
  const staleSnapshot = JSON.parse(JSON.stringify(original)) as TestDb;
  let stored = JSON.stringify(original);
  const read = () => JSON.parse(stored) as TestDb;
  const write = (data: TestDb) => { stored = JSON.stringify(data); };

  await mutateLocalInvoiceLedger(mutationOptions(locks, read, write, (data, allocateSequence) => {
    const sequence = allocateSequence();
    data.invoices.push(issuedInvoice("newer", sequence));
  }));

  await mutateLocalInvoiceLedger(mutationOptions(locks, read, write, (data) => {
    data.taxDocumentSequence = 1;
  }));
  assert.equal(read().taxDocumentSequence, 6, "a stale counter value must be clamped to the durable floor");

  await assert.rejects(
    mutateLocalInvoiceLedger(mutationOptions(locks, read, write, (data) => {
      data.invoices = staleSnapshot.invoices;
      data.taxDocumentSequence = 1;
    })),
    /لا يمكن حذف فاتورة مصدرة/,
  );

  await assert.rejects(
    mutateLocalInvoiceLedger(mutationOptions(locks, read, write, (data) => {
      data.invoices[0].total_with_vat = 1;
      data.taxDocumentSequence = 1;
    })),
    /لا يمكن تعديل البيانات المالية/,
  );

  const finalState = read();
  assert.equal(finalState.taxDocumentSequence, 6);
  assert.deepEqual(finalState.invoices.map((invoice) => invoice.id), ["original", "newer"]);
  assert.equal(finalState.invoices[0].total_with_vat, 500);
});

test("an operational status cannot cross a full local credit note", async () => {
  const locks = new SharedTabLocks();
  const source = issuedInvoice("credited-source", 10);
  const credit: TestInvoice = {
    ...issuedInvoice("full-credit", 11),
    document_kind: "credit_note",
    source_invoice_id: source.id,
    adjustment_scope: "full",
    idempotency_key: `credit:${source.id}:cancellation`,
  };
  let stored = JSON.stringify({ invoices: [source, credit], taxDocumentSequence: 11 } satisfies TestDb);
  const read = () => JSON.parse(stored) as TestDb;
  const write = (data: TestDb) => { stored = JSON.stringify(data); };

  await assert.rejects(
    mutateLocalInvoiceLedger(mutationOptions(locks, read, write, (data) => {
      data.invoices[0].status = "paid";
      data.invoices[0].paid_at = "2026-07-13T20:00:00.000Z";
    })),
    /مرتبطة بإشعار دائن كامل/,
  );
  assert.equal(read().invoices[0].status, "issued");
});
