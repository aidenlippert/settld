-- v1.??: support stable pagination and deterministic ordering for per-job artifact listing.
-- Order contract: created_at DESC, artifact_id DESC.

CREATE INDEX IF NOT EXISTS artifacts_by_job_created_at_id
  ON artifacts (tenant_id, job_id, created_at DESC, artifact_id DESC);

