-- vNext: ledger allocations include account_id for finance exports and statement classification.

ALTER TABLE ledger_allocations
  ADD COLUMN IF NOT EXISTS account_id TEXT;

CREATE INDEX IF NOT EXISTS idx_ledger_allocations_account ON ledger_allocations(tenant_id, account_id);

