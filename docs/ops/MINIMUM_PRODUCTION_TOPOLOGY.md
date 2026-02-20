# Minimum Production Topology

This is the smallest topology that supports real paid agent tool calls with audit evidence.

## 1) Required runtime components

| Component | Purpose | Start command |
|---|---|---|
| `settld-api` | control plane + kernel APIs + receipts + ops endpoints | `npm run start:prod` |
| `settld-maintenance` | reconciliation/cleanup/maintenance ticks | `npm run start:maintenance` |
| `postgres` | system of record for tenants, gates, receipts, ops state | managed Postgres |
| `x402-gateway` | payment challenge/authorize/verify wrapper for paid tool calls | `npm run start:x402-gateway` |
| paid upstream tool API(s) | actual provider tools (`/exa`, `/weather`, etc.) | provider-specific |

Without all five, the end-to-end paid tool path is incomplete.

## 2) Recommended production shape

- `app.settld.work` -> frontend (Vercel or equivalent)
- `api.settld.work` -> `settld-api`
- `gateway.settld.work` -> `x402-gateway` (or internal service DNS)
- Separate staging/prod stacks with separate DBs (or schemas + strict separation), separate secret sets, and separate signing keys.

Reference baseline: `docs/ops/HOSTED_BASELINE_R2.md`.

## 3) Minimum environment contract

### `settld-api`

- `NODE_ENV=production`
- `STORE=pg`
- `DATABASE_URL`
- `PROXY_PG_SCHEMA`
- `PROXY_MIGRATE_ON_STARTUP=1` (or run migrations out-of-band)
- `PROXY_OPS_TOKENS` (scoped ops tokens)
- `PROXY_FINANCE_RECONCILE_ENABLED=1`
- `PROXY_MONEY_RAIL_RECONCILE_ENABLED=1`

Primary config source: `docs/CONFIG.md`.

### `settld-maintenance`

- Same DB/env set as `settld-api`
- `PROXY_MAINTENANCE_INTERVAL_SECONDS` tuned for your traffic profile

### `x402-gateway`

- `SETTLD_API_URL` (usually `https://api.settld.work`)
- `SETTLD_API_KEY` (`keyId.secret`)
- `UPSTREAM_URL` (provider tool base URL)
- `HOLDBACK_BPS`
- `DISPUTE_WINDOW_MS`
- optional signature controls for provider verification

Reference flow: `docs/QUICKSTART_X402_GATEWAY.md`.

## 4) Non-negotiable controls

1. Rate limits enabled (`PROXY_RATE_LIMIT_*`, per-tenant and per-key).
2. Quotas configured (`PROXY_QUOTA_*` + `PROXY_QUOTA_PLATFORM_*`).
3. Ops auth scoped via `PROXY_OPS_TOKENS` (no broad shared token in prod).
4. Backups + restore drills on schedule (`scripts/backup-restore-test.sh`).
5. `/metrics` scraped and alert rules enabled (`docs/ALERTS.md`).

## 5) What must be hosted vs optional

Must host for real customer traffic:

1. `settld-api`
2. `settld-maintenance`
3. Postgres
4. `x402-gateway`
5. At least one paid upstream provider API

Optional at first:

1. Receiver service (`npm run start:receiver`)
2. Finance sink (`npm run start:finance-sink`)
3. Magic-link UI service

## 6) Definition of "usable in production"

A deployment is considered usable when all are true:

1. `GET /healthz` is green on API and gateway.
2. Hosted baseline evidence command passes for the environment.
3. One paid MCP tool call succeeds end-to-end with artifact output.
4. Receipt verification succeeds and is replay-auditable.
5. Rollback path is documented and tested.
