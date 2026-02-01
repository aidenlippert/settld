# Settld Operations Runbook

## Quick reference

| Symptom | Likely cause | Action |
|---|---|---|
| `outbox_pending_gauge` growing | downstream down or worker stuck | check `/ops/status`, check delivery logs, restart worker |
| `delivery_dlq_pending_total_gauge` > 0 | repeated delivery failures | inspect DLQ; fix destination; requeue (audited) |
| `ingest_rejected_total` spike | integration bug or hostile input | check `/ops/status` top reject codes; identify client from logs |
| `/healthz` dbOk=false | Postgres down/unreachable | fix DB connectivity; do not restart-loop workers |
| `ARTIFACT_HASH_MISMATCH` | non-determinism or duplicate IDs | **stop ingestion**, preserve state, investigate |

## Standard endpoints

- `GET /health` liveness
- `GET /healthz` health with signals
- `GET /metrics` metrics
- `GET /ops/status` backlog + DLQ + top reject codes

## Common scenarios

### Outbox backlog growing

1. `GET /ops/status` (confirm which backlog is growing).
2. Check logs for `outbox.claim`, `ledger.apply.*`, `delivery.*`.
3. If deliveries: verify destination health/auth; allow retries or move to DLQ.
4. If ledger apply: investigate DB errors; do **not** manually mutate ledger tables.

### Delivery DLQ non-zero

1. Inspect failure reason codes in DB/ops tooling (destination down, non-2xx, auth, timeout).
2. Fix destination.
3. Requeue (audited) and watch `delivery_dlq_pending_total_gauge` return to 0.

### Ingest rejects spike

1. `GET /ops/status` → identify top reject reason codes.
2. Correlate to request logs by `requestId` and tenant.
3. If attack suspected: enable/raise rate limiting; rotate/revoke keys as needed.

### Settlement / artifact drift (critical)

Stop. This is a “system-of-record” incident.

Immediate actions:
1. Stop accepting new writes (ingest + event appends).
2. Preserve DB snapshot and logs.
3. Identify the job/artifact with drift.
4. Compare event stream bytes + pinned hashes; look for nondeterminism (timestamps, randomness, floats).

Do not resume ingestion until:
- root cause is fixed, and
- a regression test is added, and
- a replay produces identical hashes.

## DR: backup/restore drill

Use `scripts/backup-restore-test.sh` (PG mode) to prove restore correctness.

