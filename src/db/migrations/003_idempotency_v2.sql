-- v1.0: structured idempotency keys (principal, endpoint, key).

ALTER TABLE idempotency RENAME TO idempotency_v0;

CREATE TABLE idempotency (
  principal_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_id, endpoint, idem_key)
);

-- Best-effort migration from v0 keys of the form METHOD:/path:idempotencyKey.
INSERT INTO idempotency (principal_id, endpoint, idem_key, request_hash, status_code, response_json, created_at, updated_at)
SELECT
  'anon' AS principal_id,
  split_part(key, ':', 1) || ' ' || split_part(key, ':', 2) AS endpoint,
  split_part(key, ':', 3) AS idem_key,
  request_hash,
  status_code,
  response_json,
  created_at,
  updated_at
FROM idempotency_v0
WHERE key LIKE '%:%:%';

DROP TABLE idempotency_v0;

