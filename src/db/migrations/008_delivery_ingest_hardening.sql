-- v1.4.1: delivery ordering + receipts + ingest external event id dedupe/DLQ.

-- Deliveries: ordering + ACK status.
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS scope_key TEXT NOT NULL DEFAULT '';
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS order_seq BIGINT NOT NULL DEFAULT 0;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS order_key TEXT;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS acked_at TIMESTAMPTZ;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS ack_received_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS deliveries_order
  ON deliveries (tenant_id, state, next_attempt_at, scope_key, order_seq, priority, id);

-- Receiver ACK receipts (idempotent per delivery).
CREATE TABLE IF NOT EXISTS delivery_receipts (
  tenant_id TEXT NOT NULL,
  delivery_id BIGINT NOT NULL,
  destination_id TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  received_at TIMESTAMPTZ,
  acked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, delivery_id)
);

CREATE INDEX IF NOT EXISTS delivery_receipts_by_destination
  ON delivery_receipts (tenant_id, destination_id, acked_at DESC);

-- Ingest dedupe + rejection tracking (DLQ).
CREATE TABLE IF NOT EXISTS ingest_records (
  tenant_id TEXT NOT NULL,
  source TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  status TEXT NOT NULL, -- accepted|rejected
  reason TEXT,
  job_id TEXT,
  site_id TEXT,
  correlation_key TEXT,
  event_type TEXT,
  event_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  accepted_event_id TEXT,
  record_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, source, external_event_id)
);

CREATE INDEX IF NOT EXISTS ingest_records_by_status
  ON ingest_records (tenant_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS ingest_records_by_job
  ON ingest_records (tenant_id, job_id, created_at DESC);

