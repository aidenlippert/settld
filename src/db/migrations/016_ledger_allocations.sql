-- v1.?: per-party attribution for each ledger posting (Connect v1)

CREATE TABLE IF NOT EXISTS ledger_allocations (
  tenant_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  posting_id TEXT NOT NULL, -- stable posting index within entry.postings (e.g. 'p0', 'p1')
  party_id TEXT NOT NULL,
  party_role TEXT NOT NULL, -- 'platform' | 'operator' | 'customer' | 'subcontractor' | 'insurer'
  currency TEXT NOT NULL,
  amount_cents BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, entry_id, posting_id, party_id)
);

CREATE INDEX IF NOT EXISTS idx_ledger_allocations_party ON ledger_allocations(tenant_id, party_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ledger_allocations_entry ON ledger_allocations(tenant_id, entry_id);

