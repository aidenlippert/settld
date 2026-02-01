-- vNext: tenant-scoped finance account mapping (GL export mapping).

CREATE TABLE IF NOT EXISTS finance_account_maps (
  tenant_id TEXT PRIMARY KEY,
  mapping_hash TEXT NOT NULL,
  mapping_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS finance_account_maps_updated_at ON finance_account_maps (updated_at DESC);

