-- v1.5: tenant-scoped API auth keys (hashed secrets + scopes + lifecycle).

CREATE TABLE IF NOT EXISTS auth_keys (
  tenant_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  scopes TEXT[] NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','rotated','revoked')),
  description TEXT,
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, key_id)
);

CREATE INDEX IF NOT EXISTS auth_keys_by_tenant_status
  ON auth_keys (tenant_id, status, key_id);

