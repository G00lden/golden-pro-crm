import assert from "node:assert/strict";
import test from "node:test";
import {
  createOwnedRepository,
  type CollectionLike,
  type DocSnapshotLike,
  type DocumentLike,
  type FirestoreLikeStore,
  type QueryLike,
  type QuerySnapshotLike,
} from "./ownedRepository";

type Row = Record<string, unknown>;

class MemoryDocument implements DocumentLike {
  constructor(
    private readonly rows: Map<string, Row>,
    public readonly id: string,
  ) {}

  async get(): Promise<DocSnapshotLike> {
    const row = this.rows.get(this.id);
    return {
      id: this.id,
      exists: Boolean(row),
      data: () => ({ ...(row || {}) }),
    };
  }

  async set(data: Row) {
    this.rows.set(this.id, { ...data });
  }

  async update(data: Row) {
    this.rows.set(this.id, { ...(this.rows.get(this.id) || {}), ...data });
  }

  async delete() {
    this.rows.delete(this.id);
  }
}

class MemoryQuery implements CollectionLike {
  constructor(
    private readonly rows: Map<string, Row>,
    private readonly filters: Array<[string, unknown]> = [],
    private readonly orderField?: string,
    private readonly maximum = Number.POSITIVE_INFINITY,
  ) {}

  where(field: string, operator: string, value: unknown): QueryLike {
    assert.equal(operator, "==");
    return new MemoryQuery(this.rows, [...this.filters, [field, value]], this.orderField, this.maximum);
  }

  orderBy(field: string): QueryLike {
    return new MemoryQuery(this.rows, this.filters, field, this.maximum);
  }

  limit(value: number): QueryLike {
    return new MemoryQuery(this.rows, this.filters, this.orderField, value);
  }

  async get(): Promise<QuerySnapshotLike> {
    let entries = [...this.rows.entries()].filter(([, row]) =>
      this.filters.every(([field, value]) => row[field] === value),
    );
    if (this.orderField) {
      entries = entries.sort(([, left], [, right]) =>
        String(left[this.orderField!]).localeCompare(String(right[this.orderField!])),
      );
    }
    const docs = entries.slice(0, this.maximum).map(([id, row]) => ({
      id,
      exists: true,
      data: () => ({ ...row }),
    }));
    return { docs, size: docs.length };
  }

  doc(id = `row-${this.rows.size + 1}`): DocumentLike {
    return new MemoryDocument(this.rows, id);
  }
}

class MemoryStore implements FirestoreLikeStore {
  private readonly collections = new Map<string, Map<string, Row>>();

  collection(name: string): CollectionLike {
    let rows = this.collections.get(name);
    if (!rows) {
      rows = new Map();
      this.collections.set(name, rows);
    }
    return new MemoryQuery(rows);
  }
}

test("owner repository isolates tenants and protects ownership fields", async () => {
  const repository = createOwnedRepository(new MemoryStore());
  const id = await repository.create("customers", "owner-a", { name: "First" });

  assert.equal((await repository.get("customers", id, "owner-a"))?.name, "First");
  assert.equal(await repository.get("customers", id, "owner-b"), null);
  assert.equal(await repository.update("customers", id, "owner-b", { name: "Stolen" }), false);

  assert.equal(await repository.update("customers", id, "owner-a", {
    name: "Updated",
    createdBy: "owner-b",
    owner_uid: "owner-b",
    id: "replacement",
  }), true);
  const updated = await repository.get("customers", id, "owner-a");
  assert.equal(updated?.name, "Updated");
  assert.equal(updated?.createdBy, "owner-a");
  assert.equal(updated?.id, id);
});

test("owner repository lists, checks references, and deletes within one tenant", async () => {
  const repository = createOwnedRepository(new MemoryStore());
  const customerId = await repository.create("customers", "owner-a", { name: "Customer" });
  await repository.create("installations", "owner-a", { customer_id: customerId });
  await repository.create("installations", "owner-b", { customer_id: customerId });

  assert.equal((await repository.list("installations", "owner-a")).length, 1);
  assert.equal(await repository.findBlockingReferences("owner-a", [{
    table: "installations",
    field: "customer_id",
    value: customerId,
    label: "تركيبات",
  }]), "تركيبات (1)");

  assert.equal(await repository.delete("customers", customerId, "owner-b"), false);
  assert.equal(await repository.delete("customers", customerId, "owner-a"), true);
});
