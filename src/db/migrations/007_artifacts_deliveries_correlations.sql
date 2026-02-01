-- v1.4: artifacts (immutable snapshots), deliveries (export retries), correlations (external key -> job).

CREATE TABLE IF NOT EXISTS artifacts (
  tenant_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  job_id TEXT NOT NULL,
  at_chain_hash TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  artifact_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, artifact_id)
);

CREATE INDEX IF NOT EXISTS artifacts_by_job ON artifacts (tenant_id, job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS artifacts_by_type ON artifacts (tenant_id, artifact_type, created_at DESC);

CREATE TABLE IF NOT EXISTS deliveries (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending', -- pending|delivered|failed
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at TIMESTAMPTZ,
  worker TEXT,
  last_status INTEGER,
  last_error TEXT,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries (tenant_id, state, next_attempt_at, id);

CREATE TABLE IF NOT EXISTS correlations (
  tenant_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  correlation_key TEXT NOT NULL,
  job_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, site_id, correlation_key)
);

CREATE INDEX IF NOT EXISTS correlations_by_job ON correlations (tenant_id, job_id);

