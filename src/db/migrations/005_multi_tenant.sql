-- v1.2: multi-tenant scoping (tenant_id) across core tables.

-- EVENTS: add tenant_id and include it in aggregate uniqueness/ordering.
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'tenant_default';

UPDATE events SET tenant_id = 'tenant_default' WHERE tenant_id IS NULL;

ALTER TABLE events DROP CONSTRAINT IF EXISTS events_pkey;
ALTER TABLE events
  ADD CONSTRAINT events_pkey PRIMARY KEY (tenant_id, aggregate_type, aggregate_id, seq);

ALTER TABLE events DROP CONSTRAINT IF EXISTS events_aggregate_type_aggregate_id_chain_hash_key;
ALTER TABLE events
  ADD CONSTRAINT events_tenant_aggregate_chain_hash_key UNIQUE (tenant_id, aggregate_type, aggregate_id, chain_hash);

DROP INDEX IF EXISTS events_by_aggregate;
CREATE INDEX IF NOT EXISTS events_by_aggregate ON events (tenant_id, aggregate_type, aggregate_id, seq);

-- SNAPSHOTS: tenant-scoped primary key.
ALTER TABLE snapshots
  ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'tenant_default';

UPDATE snapshots SET tenant_id = 'tenant_default' WHERE tenant_id IS NULL;

ALTER TABLE snapshots DROP CONSTRAINT IF EXISTS snapshots_pkey;
ALTER TABLE snapshots
  ADD CONSTRAINT snapshots_pkey PRIMARY KEY (tenant_id, aggregate_type, aggregate_id);

-- OUTBOX: include tenant_id for filtering/debugging.
ALTER TABLE outbox
  ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'tenant_default';

UPDATE outbox SET tenant_id = 'tenant_default' WHERE tenant_id IS NULL;

DROP INDEX IF EXISTS outbox_unprocessed;
CREATE INDEX IF NOT EXISTS outbox_unprocessed ON outbox (processed_at, topic, tenant_id, id);

-- IDEMPOTENCY: tenant-scoped key uniqueness.
ALTER TABLE idempotency
  ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'tenant_default';

UPDATE idempotency SET tenant_id = 'tenant_default' WHERE tenant_id IS NULL;

-- Drop whatever primary key exists (name can vary because v1.0 migration temporarily
-- renames the table, which can cause the auto-generated PK constraint name to get
-- a numeric suffix).
DO $$
DECLARE pk_name TEXT;
BEGIN
  SELECT c.conname
    INTO pk_name
  FROM pg_constraint c
  WHERE c.conrelid = 'idempotency'::regclass
    AND c.contype = 'p'
  LIMIT 1;

  IF pk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE idempotency DROP CONSTRAINT %I', pk_name);
  END IF;
END $$;

ALTER TABLE idempotency
  ADD CONSTRAINT idempotency_pkey PRIMARY KEY (tenant_id, principal_id, endpoint, idem_key);

-- LEDGER: tenant-scoped entries and balances.
ALTER TABLE ledger_entries
  ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'tenant_default';

UPDATE ledger_entries SET tenant_id = 'tenant_default' WHERE tenant_id IS NULL;

ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS ledger_entries_pkey;
ALTER TABLE ledger_entries
  ADD CONSTRAINT ledger_entries_pkey PRIMARY KEY (tenant_id, entry_id);

ALTER TABLE ledger_balances
  ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'tenant_default';

UPDATE ledger_balances SET tenant_id = 'tenant_default' WHERE tenant_id IS NULL;

ALTER TABLE ledger_balances DROP CONSTRAINT IF EXISTS ledger_balances_pkey;
ALTER TABLE ledger_balances
  ADD CONSTRAINT ledger_balances_pkey PRIMARY KEY (tenant_id, account_id);

-- ROBOT RESERVATIONS: tenant-aware overlap prevention.
ALTER TABLE robot_reservations
  ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'tenant_default';

UPDATE robot_reservations SET tenant_id = 'tenant_default' WHERE tenant_id IS NULL;

ALTER TABLE robot_reservations DROP CONSTRAINT IF EXISTS robot_reservations_pkey;
ALTER TABLE robot_reservations
  ADD CONSTRAINT robot_reservations_pkey PRIMARY KEY (tenant_id, job_id);

ALTER TABLE robot_reservations DROP CONSTRAINT IF EXISTS robot_reservations_no_overlap;
ALTER TABLE robot_reservations
  ADD CONSTRAINT robot_reservations_no_overlap
  EXCLUDE USING gist (tenant_id WITH =, robot_id WITH =, "window" WITH &&);

-- NOTIFICATIONS: tenant-aware sink.
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'tenant_default';

UPDATE notifications SET tenant_id = 'tenant_default' WHERE tenant_id IS NULL;

CREATE INDEX IF NOT EXISTS notifications_by_tenant_topic ON notifications (tenant_id, topic, id);
