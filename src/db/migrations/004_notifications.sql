-- v1.0: notifications sink (outbox-driven).

CREATE TABLE IF NOT EXISTS notifications (
  id BIGSERIAL PRIMARY KEY,
  outbox_id BIGINT UNIQUE,
  topic TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_by_topic ON notifications (topic, id);

