-- v1.20: durable tenant billing config persistence (plan/subscription/provider dedupe keys).

CREATE TABLE IF NOT EXISTS tenant_billing_config (
  tenant_id TEXT PRIMARY KEY,
  billing_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tenant_billing_config_updated_at
  ON tenant_billing_config (updated_at DESC, tenant_id ASC);
