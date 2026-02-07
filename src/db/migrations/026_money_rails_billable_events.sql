-- v1.19: durable money rail operations/provider events and immutable billable usage event ledger.

CREATE TABLE IF NOT EXISTS money_rail_operations (
  tenant_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  amount_cents BIGINT NOT NULL,
  currency TEXT NOT NULL,
  counterparty_ref TEXT NOT NULL,
  state TEXT NOT NULL,
  provider_ref TEXT NULL,
  reason_code TEXT NULL,
  initiated_at TIMESTAMPTZ NOT NULL,
  submitted_at TIMESTAMPTZ NULL,
  confirmed_at TIMESTAMPTZ NULL,
  failed_at TIMESTAMPTZ NULL,
  cancelled_at TIMESTAMPTZ NULL,
  reversed_at TIMESTAMPTZ NULL,
  request_hash TEXT NULL,
  metadata_json JSONB NULL,
  operation_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider_id, operation_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS money_rail_operations_tenant_provider_direction_idem_key
  ON money_rail_operations (tenant_id, provider_id, direction, idempotency_key);

CREATE INDEX IF NOT EXISTS money_rail_operations_by_tenant_provider_updated
  ON money_rail_operations (tenant_id, provider_id, updated_at DESC, operation_id ASC);

CREATE TABLE IF NOT EXISTS money_rail_provider_events (
  tenant_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_dedupe_key TEXT NOT NULL,
  event_id TEXT NULL,
  at TIMESTAMPTZ NOT NULL,
  payload_json JSONB NULL,
  event_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider_id, operation_id, event_type, event_dedupe_key),
  FOREIGN KEY (tenant_id, provider_id, operation_id)
    REFERENCES money_rail_operations (tenant_id, provider_id, operation_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS money_rail_provider_events_by_tenant_provider_operation_at
  ON money_rail_provider_events (tenant_id, provider_id, operation_id, at DESC, event_type ASC);

CREATE TABLE IF NOT EXISTS billable_usage_events (
  tenant_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  period TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  quantity BIGINT NOT NULL,
  amount_cents BIGINT NULL,
  currency TEXT NULL,
  run_id TEXT NULL,
  settlement_id TEXT NULL,
  dispute_id TEXT NULL,
  arbitration_case_id TEXT NULL,
  source_type TEXT NULL,
  source_id TEXT NULL,
  source_event_id TEXT NULL,
  event_hash TEXT NULL,
  audit_json JSONB NULL,
  event_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, event_key)
);

CREATE INDEX IF NOT EXISTS billable_usage_events_by_tenant_period_type
  ON billable_usage_events (tenant_id, period, event_type, occurred_at ASC, event_key ASC);

CREATE INDEX IF NOT EXISTS billable_usage_events_by_tenant_occurred
  ON billable_usage_events (tenant_id, occurred_at ASC, event_key ASC);
