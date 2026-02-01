-- v1.7: Party statements (Connect v1 rollups) + allocation metadata.

-- Ledger allocations: carry account_id to support statement breakdown/payout derivation without re-parsing ledger entry JSON.
ALTER TABLE ledger_allocations
  ADD COLUMN IF NOT EXISTS account_id TEXT;

CREATE INDEX IF NOT EXISTS idx_ledger_allocations_entry_posting
  ON ledger_allocations(tenant_id, entry_id, posting_id);

-- Per-party monthly statements (closeable, immutable once closed).
CREATE TABLE IF NOT EXISTS party_statements (
  tenant_id TEXT NOT NULL,
  party_id TEXT NOT NULL,
  period TEXT NOT NULL, -- YYYY-MM
  basis TEXT NOT NULL DEFAULT 'settledAt',
  status TEXT NOT NULL DEFAULT 'OPEN', -- OPEN|CLOSED
  statement_hash TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, party_id, period)
);

CREATE INDEX IF NOT EXISTS party_statements_by_period_status
  ON party_statements(tenant_id, period, status);

CREATE INDEX IF NOT EXISTS party_statements_by_party_period
  ON party_statements(tenant_id, party_id, period);

