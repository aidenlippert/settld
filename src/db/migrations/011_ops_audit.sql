-- v1.8: append-only ops audit log for privileged actions.

CREATE TABLE IF NOT EXISTS ops_audit (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  actor_key_id TEXT,
  actor_principal_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  request_id TEXT,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  details_hash TEXT NOT NULL,
  details_json JSONB
);

CREATE INDEX IF NOT EXISTS ops_audit_by_tenant_at
  ON ops_audit (tenant_id, at DESC, id DESC);

CREATE OR REPLACE FUNCTION ops_audit_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ops_audit is immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ops_audit_no_update ON ops_audit;
CREATE TRIGGER ops_audit_no_update BEFORE UPDATE ON ops_audit
FOR EACH ROW EXECUTE FUNCTION ops_audit_immutable();

DROP TRIGGER IF EXISTS ops_audit_no_delete ON ops_audit;
CREATE TRIGGER ops_audit_no_delete BEFORE DELETE ON ops_audit
FOR EACH ROW EXECUTE FUNCTION ops_audit_immutable();

