-- v0.9: Postgres-backed event store + outbox + ledger.

CREATE TABLE IF NOT EXISTS proxy_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public_keys (
  key_id TEXT PRIMARY KEY,
  public_key_pem TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS server_signer (
  id INTEGER PRIMARY KEY,
  public_key_pem TEXT NOT NULL,
  private_key_pem TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  seq BIGINT NOT NULL,
  event_id TEXT NOT NULL,
  chain_hash TEXT NOT NULL,
  prev_chain_hash TEXT,
  payload_hash TEXT NOT NULL,
  type TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL,
  actor_json JSONB NOT NULL,
  payload_json JSONB,
  signature TEXT,
  signer_key_id TEXT,
  event_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (aggregate_type, aggregate_id, seq),
  UNIQUE (event_id),
  UNIQUE (aggregate_type, aggregate_id, chain_hash)
);

CREATE INDEX IF NOT EXISTS events_by_aggregate ON events (aggregate_type, aggregate_id, seq);
CREATE INDEX IF NOT EXISTS events_by_type ON events (type);

CREATE TABLE IF NOT EXISTS snapshots (
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  seq BIGINT NOT NULL,
  at_chain_hash TEXT,
  snapshot_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (aggregate_type, aggregate_id)
);

CREATE INDEX IF NOT EXISTS snapshots_by_type ON snapshots (aggregate_type, aggregate_id);

CREATE TABLE IF NOT EXISTS outbox (
  id BIGSERIAL PRIMARY KEY,
  topic TEXT NOT NULL,
  aggregate_type TEXT,
  aggregate_id TEXT,
  payload_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ,
  worker TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS outbox_unprocessed ON outbox (processed_at, topic, id);

CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  entry_id TEXT PRIMARY KEY,
  entry_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ledger_balances (
  account_id TEXT PRIMARY KEY,
  balance_cents BIGINT NOT NULL
);

