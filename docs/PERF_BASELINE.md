# Performance Baseline (Local)

This doc is the repeatable “truth under load” baseline for Settld. Update it when hot-path behavior changes (indexes, worker concurrency, timeouts).

## Prereqs

- Postgres running (recommended: `docker compose up -d postgres`)
- API running in PG mode with workers enabled:

  ```sh
  export STORE=pg
  export DATABASE_URL=postgres://proxy:proxy@localhost:5432/proxy
  export PROXY_AUTOTICK=1
  export PROXY_OPS_TOKENS="dev:ops_read,ops_write,finance_read,finance_write,audit_read"
  npm run dev:api
  ```

- `k6` installed on your PATH.

Optional (high-signal):

- `PROXY_PG_LOG_SLOW_MS=100` to log `pg.query.slow` events.
- `PROXY_PG_WORKER_STATEMENT_TIMEOUT_MS=5000` to prevent worker “hung query” pileups.
- `PROXY_WORKER_CONCURRENCY_ARTIFACTS` / `PROXY_WORKER_CONCURRENCY_DELIVERIES` to tune throughput.

## Scenario A: Ingest burst + ops reads

Runs job lifecycles at a constant arrival rate, while also hammering ops read endpoints.

```sh
OPS_TOKEN=dev BASE_URL=http://localhost:3000 \
  TENANTS=10 ROBOTS_PER_TENANT=3 JOBS_PER_MIN_PER_TENANT=50 DURATION=2m \
  k6 run scripts/load/ingest-burst.k6.js
```

Record:

- k6 summary p50/p95/p99 for `http_req_duration`
- `/healthz` over time: `outboxPending`, `deliveriesPending`, `deliveriesFailed`

## Scenario B: Delivery stress (webhook failures + timeouts)

1) Start the webhook receiver:

```sh
PORT=4010 TIMEOUT_RATE_PCT=5 ERROR_RATE_PCT=5 TIMEOUT_DELAY_MS=10000 \
  node scripts/load/webhook-receiver.js
```

2) Run the API with an export destination pointing at the receiver:

```sh
export PROXY_EXPORT_DESTINATIONS='{
  "tenant_default": [
    { "destinationId": "dst", "kind": "webhook", "url": "http://127.0.0.1:4010/hook", "secret": "devsecret" }
  ]
}'
export PROXY_DELIVERY_HTTP_TIMEOUT_MS=1000
```

3) Run load:

```sh
OPS_TOKEN=dev BASE_URL=http://localhost:3000 \
  TENANTS=3 ROBOTS_PER_TENANT=3 JOBS_PER_MIN_PER_TENANT=100 DURATION=2m \
  k6 run scripts/load/delivery-stress.k6.js
```

Record:

- `/healthz` backlog signals (steady state vs unbounded growth)
- `/ops/deliveries?state=failed` size and retry behavior

## Current baseline (fill in)

- Date:
- Machine:
- Scenario A:
  - p95 ingest/job endpoints:
  - outboxPending steady state:
- Scenario B:
  - deliveriesPending steady state:
  - deliveriesFailed steady state:
  - notes:

