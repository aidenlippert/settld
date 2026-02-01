-- v1.6: tenant-scoped signer key registry (purpose + lifecycle).

CREATE TABLE IF NOT EXISTS signer_keys (
  tenant_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  public_key_pem TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('robot','operator','server')),
  status TEXT NOT NULL CHECK (status IN ('active','rotated','revoked')),
  description TEXT,
  valid_from TIMESTAMPTZ,
  valid_to TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, key_id)
);

CREATE INDEX IF NOT EXISTS signer_keys_by_tenant_status
  ON signer_keys (tenant_id, status, key_id);

CREATE INDEX IF NOT EXISTS signer_keys_by_tenant_purpose
  ON signer_keys (tenant_id, purpose, key_id);

