-- v1.??: enforce one artifact per (job + type + source_event_id) when source_event_id is present.
-- This prevents duplicate settlement-backed WorkCertificates and similar finance-final artifacts.

CREATE UNIQUE INDEX IF NOT EXISTS artifacts_unique_by_job_type_source_event
  ON artifacts (tenant_id, job_id, artifact_type, source_event_id)
  WHERE source_event_id <> '';

CREATE INDEX IF NOT EXISTS artifacts_by_job_type_source_event
  ON artifacts (tenant_id, job_id, artifact_type, source_event_id);

