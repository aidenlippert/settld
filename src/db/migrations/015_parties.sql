-- v1.?: parties registry for Connect-style settlement

CREATE TABLE IF NOT EXISTS parties (
  tenant_id TEXT NOT NULL,
  party_id TEXT NOT NULL,
  party_role TEXT NOT NULL, -- 'platform' | 'operator' | 'customer' | 'subcontractor' | 'insurer'
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'suspended' | 'terminated'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, party_id)
);

CREATE INDEX IF NOT EXISTS idx_parties_role ON parties(tenant_id, party_role, status);

