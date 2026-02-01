-- v1.2: contracts (tenant/customer/site scoped policies for SLA/credits/evidence retention).

CREATE TABLE IF NOT EXISTS contracts (
  tenant_id TEXT NOT NULL DEFAULT 'tenant_default',
  contract_id TEXT NOT NULL,
  name TEXT NOT NULL,
  customer_id TEXT,
  site_id TEXT,
  template_id TEXT,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  contract_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, contract_id)
);

CREATE INDEX IF NOT EXISTS contracts_by_scope ON contracts (tenant_id, customer_id, site_id, template_id, is_default, contract_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'contracts_one_default_per_tenant'
  ) THEN
    CREATE UNIQUE INDEX contracts_one_default_per_tenant ON contracts (tenant_id) WHERE is_default;
  END IF;
END $$;

