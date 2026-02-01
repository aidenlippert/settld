-- v2.0: performance indexes for hot ops/worker queries.

-- Outbox: claim scans benefit from a partial index on pending rows.
CREATE INDEX IF NOT EXISTS outbox_pending_by_topic_claimed
  ON outbox (topic, claimed_at, attempts, id)
  WHERE processed_at IS NULL;

-- Deliveries: ops listing is ordered by id DESC and filtered by tenant/state.
CREATE INDEX IF NOT EXISTS deliveries_by_tenant_id_desc
  ON deliveries (tenant_id, id DESC);

CREATE INDEX IF NOT EXISTS deliveries_by_tenant_state_id_desc
  ON deliveries (tenant_id, state, id DESC);

-- Ingest records: DLQ listing is ordered by received_at/created_at.
CREATE INDEX IF NOT EXISTS ingest_records_by_tenant_status_received
  ON ingest_records (tenant_id, status, received_at DESC, created_at DESC);

