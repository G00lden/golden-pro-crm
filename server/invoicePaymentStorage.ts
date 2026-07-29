export const INVOICE_PAYMENT_LEDGER_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS invoice_payment_entries (
    id TEXT PRIMARY KEY,
    owner_uid TEXT NOT NULL,
    invoice_id TEXT NOT NULL,
    entry_type TEXT NOT NULL CHECK(entry_type IN ('collection', 'reversal')),
    method TEXT NOT NULL CHECK(method IN ('cash', 'card', 'bank_transfer', 'tap', 'other')),
    amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
    currency TEXT NOT NULL DEFAULT 'SAR',
    reference TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    source_payment_id TEXT,
    reverses_entry_id TEXT,
    idempotency_key TEXT NOT NULL,
    recorded_by TEXT NOT NULL DEFAULT '',
    occurred_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK(
      (entry_type = 'collection' AND reverses_entry_id IS NULL)
      OR (entry_type = 'reversal' AND reverses_entry_id IS NOT NULL)
    ),
    FOREIGN KEY(invoice_id) REFERENCES invoices(id) ON DELETE RESTRICT,
    FOREIGN KEY(reverses_entry_id) REFERENCES invoice_payment_entries(id) ON DELETE RESTRICT
  );

  CREATE INDEX IF NOT EXISTS idx_invoice_payment_entries_owner_time
    ON invoice_payment_entries(owner_uid, occurred_at DESC, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_invoice_payment_entries_invoice
    ON invoice_payment_entries(owner_uid, invoice_id, occurred_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_payment_entries_idempotency
    ON invoice_payment_entries(owner_uid, idempotency_key);
  DROP INDEX IF EXISTS idx_invoice_payment_entries_source_payment;
  CREATE UNIQUE INDEX idx_invoice_payment_entries_source_payment
    ON invoice_payment_entries(owner_uid, source_payment_id)
    WHERE source_payment_id IS NOT NULL AND entry_type = 'collection';
  CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_payment_entries_one_reversal
    ON invoice_payment_entries(reverses_entry_id)
    WHERE reverses_entry_id IS NOT NULL;

  INSERT OR IGNORE INTO invoice_payment_entries (
    id, owner_uid, invoice_id, entry_type, method, amount_minor, currency,
    reference, note, source_payment_id, reverses_entry_id, idempotency_key,
    recorded_by, occurred_at, created_at
  )
  SELECT
    'ip_tap_' || payment.id,
    payment.owner_uid,
    payment.invoice_id,
    'collection',
    'tap',
    CAST(ROUND(CAST(payment.amount AS REAL) * 100) AS INTEGER),
    UPPER(COALESCE(NULLIF(payment.currency, ''), 'SAR')),
    COALESCE(payment.tap_charge_id, ''),
    'ترحيل دفعة Tap مؤكدة',
    payment.id,
    NULL,
    'tap:' || payment.id,
    'tap',
    COALESCE(NULLIF(payment.updated_at, ''), NULLIF(payment.created_at, ''), datetime('now')),
    COALESCE(NULLIF(payment.created_at, ''), datetime('now'))
  FROM payments payment
  JOIN invoices invoice
    ON invoice.id = payment.invoice_id
   AND invoice.owner_uid = payment.owner_uid
  WHERE payment.status = 'completed'
    AND payment.invoice_id IS NOT NULL
    AND CAST(payment.amount AS REAL) > 0;
`;
