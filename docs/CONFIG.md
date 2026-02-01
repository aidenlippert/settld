# Settld Configuration (Runtime)

This repo is intentionally “ops-first”: **safe defaults**, explicit hardening toggles, and predictable failure modes.

## Store / durability

- `STORE` (`memory` | `pg`, default: `memory`)
- `DATABASE_URL` (required when `STORE=pg`)
- `PROXY_PG_SCHEMA` (default: `public`)
- `PROXY_PG_LOG_SLOW_MS` (default: `0` = disabled)  
  When nonzero, logs slow queries as `pg.query.slow` with duration + a best-effort query label (never logs query args).
- `PROXY_MIGRATE_ON_STARTUP` (`1` | `0`, default: `1`)  
  When `1`, Settld runs SQL migrations on startup (PG advisory-lock protected so concurrent instances are safe). Set `0` if you run migrations out-of-band.
- `PROXY_DATA_DIR` (memory mode durability via file tx-log; default: unset = purely in-memory)

## HTTP limits

- `PROXY_MAX_BODY_BYTES` (default: `1000000`)
- `PROXY_INGEST_MAX_EVENTS` (default: `200`)

## Protocol / versioning

Settld exposes a protocol version contract via `x-settld-protocol` and enforces compatibility windows.

- `PROXY_PROTOCOL_MIN` (default: current, e.g. `1.0`)  
  Requests below this return `426` with `code: PROTOCOL_TOO_OLD`.

- `PROXY_PROTOCOL_MAX` (default: current, e.g. `1.0`)  
  Requests above this return `400` with `code: PROTOCOL_TOO_NEW`.

- `PROXY_PROTOCOL_DEPRECATIONS` (optional file path)  
  JSON map of protocol version -> cutoff date; requests past cutoff return `426` with `code: PROTOCOL_DEPRECATED`.
  Example:

  ```json
  { "1.0": { "cutoff": "2026-12-31T00:00:00.000Z" } }
  ```

Production enforcement:

- When `NODE_ENV=production`, `/ingest/proxy` and `POST /{jobs|robots|operators}/:id/events` require the request header `x-settld-protocol` (else `400` with `code: PROTOCOL_VERSION_REQUIRED`).

## Rate limiting

- `PROXY_RATE_LIMIT_RPM` (default: `0` = disabled)
- `PROXY_RATE_LIMIT_BURST` (default: `PROXY_RATE_LIMIT_RPM`)

## Outbox reclaim / worker loop

- `PROXY_RECLAIM_AFTER_SECONDS` (default: `60`)  
  Reclaim “claimed but not processed” outbox rows after this window.

- `PROXY_PG_WORKER_STATEMENT_TIMEOUT_MS` (default: `0` = disabled; PG only)  
  Sets `statement_timeout` for worker-transaction queries (outbox claims + delivery claims + outbox processors) to prevent “hung query” pileups.

- `PROXY_AUTOTICK` (`1` enables a default loop)
- `PROXY_AUTOTICK_INTERVAL_MS` (default: `0`, or `250` when `PROXY_AUTOTICK=1`)
- `PROXY_AUTOTICK_MAX_MESSAGES` (default: `100`)

Delivery/worker tuning:

- `PROXY_WORKER_CONCURRENCY_ARTIFACTS` (default: `1`)  
  Max concurrent artifact build groups (grouped by `tenantId + jobId`).

- `PROXY_WORKER_CONCURRENCY_DELIVERIES` (default: `1`)  
  Max concurrent delivery scope groups (grouped by `scopeKey`; preserves ordering within each scope).

- `PROXY_DELIVERY_HTTP_TIMEOUT_MS` (default: `0` = disabled)  
  Abort outbound delivery HTTP requests after this timeout and retry with backoff.

## Ops / API auth

- `PROXY_OPS_TOKENS`  
  Format: `token:scope1,scope2;token2:scopeA` (scopes include `ops_read`, `ops_write`, `audit_read`, `finance_write`, …)

- `PROXY_OPS_TOKEN` (legacy)  
  If `PROXY_OPS_TOKENS` is empty, this single token grants full ops access.

- `PROXY_AUTH_KEY_TOUCH_MIN_SECONDS` (default: `60`)  
  Throttle how often `last_used_at` is updated for API keys (reduces DB write amplification).

## Ingest auth

- `PROXY_INGEST_TOKEN` (optional)  
  When set, `/ingest/proxy` requires header `x-proxy-ingest-token` to match.

## Export destinations (deliveries)

- `PROXY_EXPORT_DESTINATIONS` (JSON)  
  Maps `tenantId -> destinations[]`.

Webhook destination (preferred, secrets via ref):

```json
{
  "tenant_default": [
    { "destinationId": "dst_webhook", "kind": "webhook", "url": "https://example.com/hook", "secretRef": "file:/var/run/secrets/webhook_secret" }
  ]
}
```

S3 destination (preferred, credentials via ref):

```json
{
  "tenant_default": [
    {
      "destinationId": "dst_s3",
      "kind": "s3",
      "endpoint": "https://s3.amazonaws.com",
      "bucket": "my-bucket",
      "region": "us-east-1",
      "accessKeyIdRef": "file:/var/run/secrets/aws_access_key_id",
      "secretAccessKeyRef": "file:/var/run/secrets/aws_secret_access_key"
    }
  ]
}
```

Hardening note:

- Inline secrets (`secret`, `accessKeyId`, `secretAccessKey`) are rejected when `NODE_ENV=production` unless `PROXY_ALLOW_INLINE_SECRETS=1`.

## Evidence store

- `PROXY_EVIDENCE_STORE` (`fs` | `memory` | `s3` | `minio`, default: `fs`)
- `PROXY_EVIDENCE_DIR` (fs store root; default: tmp dir when not using `PROXY_DATA_DIR`)

S3/minio evidence store config:

- `PROXY_EVIDENCE_S3_ENDPOINT`
- `PROXY_EVIDENCE_S3_REGION` (default: `us-east-1`)
- `PROXY_EVIDENCE_S3_BUCKET`
- `PROXY_EVIDENCE_S3_ACCESS_KEY_ID` (or `AWS_ACCESS_KEY_ID`)
- `PROXY_EVIDENCE_S3_SECRET_ACCESS_KEY` (or `AWS_SECRET_ACCESS_KEY`)
- `PROXY_EVIDENCE_S3_FORCE_PATH_STYLE` (default: `1`)

Evidence download security:

- `PROXY_EVIDENCE_SIGNING_SECRET` (optional; default derived from server signer)
- `PROXY_EVIDENCE_PRESIGN_MAX_SECONDS` (default: `300`, max: `3600`)
- `PROXY_EVIDENCE_RETENTION_MAX_DAYS` (default: `365`)  
  Tenant cap for `contract.policies.evidencePolicy.retentionDays`.
- `PROXY_EVIDENCE_RETENTION_MAX_DAYS_BY_TENANT` (JSON map, optional)  
  Per-tenant override for `PROXY_EVIDENCE_RETENTION_MAX_DAYS`.

## Secrets provider

- `PROXY_ENABLE_ENV_SECRETS` (`1` enables `env:NAME` refs; default: disabled unless `NODE_ENV=development`)
- `PROXY_SECRETS_CACHE_TTL_SECONDS` (default: `30`)

Supported refs:

- `env:NAME` (dev-only unless explicitly enabled)
- `file:/absolute/path` (k8s secret mounts)

## URL safety overrides (dev only)

These exist to make local development possible (e.g. MinIO on `localhost`). Do not enable in production.

- `PROXY_ALLOW_HTTP_URLS` (`1` allows `http://` where URL safety checks apply)
- `PROXY_ALLOW_PRIVATE_URLS` (`1` allows private IP ranges)
- `PROXY_ALLOW_LOOPBACK_URLS` (`1` allows `localhost` / loopback)

## Retention / cleanup

Retention is tenant-configurable via in-memory config and capped by these runtime env vars.

- `PROXY_RETENTION_INGEST_RECORDS_DAYS` (default: `0` = no expiry)  
  Sets `expires_at` for `ingest_records`.

- `PROXY_RETENTION_INGEST_RECORDS_MAX_DAYS` (default: `0` = no platform cap)  
  When set, tenant `0` means “use the cap”.

- `PROXY_RETENTION_DELIVERIES_DAYS` (default: `0` = no expiry)  
  Expiration for delivered deliveries.

- `PROXY_RETENTION_DELIVERIES_MAX_DAYS` (default: `0` = no platform cap)

- `PROXY_RETENTION_DELIVERY_DLQ_DAYS` (default: `PROXY_RETENTION_DELIVERIES_DAYS`)  
  Expiration for failed (DLQ) deliveries.

- `PROXY_RETENTION_DELIVERY_DLQ_MAX_DAYS` (default: `PROXY_RETENTION_DELIVERIES_MAX_DAYS`)

Cleanup execution (PG mode):

- `PROXY_RETENTION_CLEANUP_BATCH_SIZE` (default: `500`)  
  Max rows per table per cleanup run.

- `PROXY_RETENTION_CLEANUP_MAX_MILLIS` (default: `1500`)  
  Wall-clock budget for a single cleanup run (enforced via PG `statement_timeout`).

- `PROXY_RETENTION_CLEANUP_DRY_RUN` (`1` prints would-delete counts; no deletes)

Maintenance runner (recommended in prod):

- `PROXY_MAINTENANCE_INTERVAL_SECONDS` (default: `300`)  
  Sleep between cleanup runs in `src/api/maintenance.js`.

## Quotas / backpressure

On quota breach, requests return `429` with `code: TENANT_QUOTA_EXCEEDED`.

- `PROXY_QUOTA_MAX_OPEN_JOBS` (default: `0` = unlimited)
- `PROXY_QUOTA_PLATFORM_MAX_OPEN_JOBS` (default: `0` = no platform cap)

- `PROXY_QUOTA_MAX_PENDING_DELIVERIES` (default: `0` = unlimited)
- `PROXY_QUOTA_PLATFORM_MAX_PENDING_DELIVERIES` (default: `0` = no platform cap)

- `PROXY_QUOTA_MAX_INGEST_DLQ_DEPTH` (default: `0` = unlimited)
- `PROXY_QUOTA_PLATFORM_MAX_INGEST_DLQ_DEPTH` (default: `0` = no platform cap)

- `PROXY_QUOTA_MAX_EVIDENCE_REFS_PER_JOB` (default: `0` = unlimited)
- `PROXY_QUOTA_PLATFORM_MAX_EVIDENCE_REFS_PER_JOB` (default: `0` = no platform cap)

- `PROXY_QUOTA_MAX_ARTIFACTS_PER_JOB_TYPE` (default: `0` = unlimited)
- `PROXY_QUOTA_PLATFORM_MAX_ARTIFACTS_PER_JOB_TYPE` (default: `0` = no platform cap)

## Outbox poison-pill

- `PROXY_OUTBOX_MAX_ATTEMPTS` (default: `25`)  
  After this many attempts, outbox work is marked done with a DLQ error marker.

## Evidence ingest constraints (optional hardening)

- `PROXY_EVIDENCE_CONTENT_TYPE_ALLOWLIST` (comma-separated)  
  If set, `EVIDENCE_CAPTURED.payload.contentType` must be in the allowlist.

- `PROXY_EVIDENCE_REQUIRE_SIZE_BYTES` (`1` requires `EVIDENCE_CAPTURED.payload.sizeBytes`)
- `PROXY_EVIDENCE_MAX_SIZE_BYTES` (default: `0` = unlimited)

## Backups / restore (Postgres)

These helper scripts assume you have Postgres client tools installed (`pg_dump`, `pg_restore`, `psql`).

- Backup:

  ```sh
  DATABASE_URL=postgres://... PROXY_PG_SCHEMA=public OUT_DIR=./backups bash scripts/backup-pg.sh
  ```

- Restore (to a fresh DB is recommended):

  ```sh
  DATABASE_URL=postgres://... PROXY_PG_SCHEMA=public bash scripts/restore-pg.sh ./backups/backup_*/db.dump
  ```

- Verify a restored DB:

  ```sh
  DATABASE_URL=postgres://... PROXY_PG_SCHEMA=public node scripts/verify-pg.js
  ```

Verification knobs:

- `VERIFY_MAX_STREAMS` (default: `100`)
- `VERIFY_MAX_ARTIFACTS` (default: `100`)
- `VERIFY_MAX_LEDGER_ENTRIES` (default: `0` = all)

RPO/RTO (practical):

- RPO is the time between successful backups.
- RTO is `restore time + verification time` and scales with DB size.
