-- v2.0: contracts-as-code (hash-addressed contract documents + signatures).

CREATE TABLE IF NOT EXISTS contracts_v2 (
  tenant_id TEXT NOT NULL DEFAULT 'tenant_default',
  contract_id TEXT NOT NULL,
  contract_version INTEGER NOT NULL,

  status TEXT NOT NULL DEFAULT 'DRAFT', -- DRAFT|PUBLISHED|ACTIVE|SUPERSEDED|TERMINATED
  effective_from TIMESTAMPTZ,
  effective_to TIMESTAMPTZ,

  contract_hash TEXT, -- sha256 hex of canonical ContractDocument bytes; set on publish
  policy_hash TEXT,   -- hash of compiled contract policy template; set on activate (semantics v2)
  compiler_id TEXT,   -- compiler identifier recorded on activate

  scope_customer_id TEXT,
  scope_site_id TEXT,
  scope_zone_id TEXT,
  scope_template_id TEXT,
  scope_skill_id TEXT,

  doc_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, contract_id, contract_version)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'contracts_v2_contract_hash_unique'
  ) THEN
    CREATE UNIQUE INDEX contracts_v2_contract_hash_unique ON contracts_v2 (tenant_id, contract_hash) WHERE contract_hash IS NOT NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS contracts_v2_by_status ON contracts_v2 (tenant_id, status, effective_from DESC NULLS LAST, contract_id, contract_version);
CREATE INDEX IF NOT EXISTS contracts_v2_by_scope ON contracts_v2 (
  tenant_id,
  scope_customer_id,
  scope_site_id,
  scope_zone_id,
  scope_template_id,
  scope_skill_id,
  status
);

CREATE TABLE IF NOT EXISTS contract_signatures_v2 (
  tenant_id TEXT NOT NULL DEFAULT 'tenant_default',
  contract_hash TEXT NOT NULL,
  party_role TEXT NOT NULL, -- platform|operator|customer
  signer_key_id TEXT NOT NULL,
  signature TEXT NOT NULL, -- base64 signature over contract_hash (hex bytes)
  signed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, contract_hash, party_role)
);

CREATE TABLE IF NOT EXISTS contract_compilations_v2 (
  tenant_id TEXT NOT NULL DEFAULT 'tenant_default',
  contract_hash TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  compiler_id TEXT NOT NULL,
  diagnostics_json JSONB,
  compiled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, contract_hash, policy_hash, compiler_id)
);

