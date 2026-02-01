-- v1.9: retention support (expires_at) for high-volume tables.

ALTER TABLE ingest_records
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS ingest_records_by_expires
  ON ingest_records (tenant_id, expires_at)
  WHERE expires_at IS NOT NULL;

ALTER TABLE deliveries
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS deliveries_by_expires
  ON deliveries (tenant_id, expires_at)
  WHERE expires_at IS NOT NULL;

