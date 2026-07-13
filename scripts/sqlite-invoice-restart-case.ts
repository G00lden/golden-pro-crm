import assert from "node:assert/strict";

const phase = process.argv[2];
if (phase !== "seed" && phase !== "verify") throw new Error("Expected seed or verify phase.");

const { default: db } = await import("../server/db");
const id = "post-migration-restart-sentinel";

if (phase === "seed") {
  db.prepare(`
    INSERT INTO invoices (
      id, owner_uid, invoice_number, customer_name, issue_date, subtotal,
      discount, discount_mode, discount_value, vat, vat_percent, vat_amount,
      additional_fee, total_without_vat, total_with_vat, items, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    "owner",
    "INV-RESTART-SENTINEL",
    "Restart sentinel",
    "2026-07-10",
    999,
    0,
    "fixed",
    0,
    999,
    15,
    999,
    0,
    999,
    999,
    JSON.stringify([{ description: "Line", quantity: 1, unit_price: 100, vat_excluded: true }]),
    "2026-07-10T08:30:00Z",
  );
} else {
  const row = db.prepare("SELECT total_with_vat, updated_at FROM invoices WHERE id = ?").get(id) as {
    total_with_vat: number;
    updated_at: string;
  };
  assert.equal(Number(row.total_with_vat), 999, "financial backfill unexpectedly ran again after the schema was current");
  assert.equal(row.updated_at, "2026-07-10T08:30:00Z");
}

db.close();
