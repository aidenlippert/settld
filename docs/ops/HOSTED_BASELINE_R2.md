# Sprint R2: Hosted Baseline (Staging + Production)

This is the minimum hosted setup for a real product surface.

## 1) Environment topology

- `staging.app.settld.work` (frontend, Vercel)
- `staging.api.settld.work` (API, Railway)
- `app.settld.work` (frontend, Vercel)
- `api.settld.work` (API, Railway)
- Separate Postgres instances/schemas and separate secret sets for staging/prod.
- Separate signing keys per environment (never reuse signer keys across staging/prod).

## 2) Railway service split

Create two Railway services from this repo per environment:

- `settld-api`:
  - start command: `npm run start:prod`
- `settld-worker`:
  - start command: `npm run start:maintenance`

Both services must point at the same environment DB and secret set for that environment.

## 3) Required runtime controls

- Tenant rate limiting:
  - `PROXY_RATE_LIMIT_RPM`
  - `PROXY_RATE_LIMIT_BURST`
- API-key rate limiting:
  - `PROXY_RATE_LIMIT_PER_KEY_RPM`
  - `PROXY_RATE_LIMIT_PER_KEY_BURST`
- Tenant quotas:
  - `PROXY_QUOTA_*` and `PROXY_QUOTA_PLATFORM_*` envs from `docs/CONFIG.md`.

## 4) Observability + alerts

Scrape `/metrics` and enable rules from `deploy/observability/prometheus-rules.yml`.

R2-required alerts:

- replay mismatches: `replay_mismatch_gauge`
- stuck disputes: `disputes_over_sla_gauge`, `arbitration_over_sla_gauge`
- stuck holds: `settlement_holds_over_24h_gauge`
- worker lag: `worker_outbox_pending_total_gauge`, `worker_deliveries_pending_total_gauge`

Reference: `docs/ALERTS.md`.

## 5) Backups + restore drill

- Backup/restore scripts: `scripts/backup-pg.sh`, `scripts/restore-pg.sh`
- Full drill script: `scripts/backup-restore-test.sh`
- Run at least weekly for staging and monthly for production.
- Record evidence in incident/runbook logs (timestamp, operator, pass/fail, DB snapshot IDs).

## 6) Clerk onboarding handoff (app -> API)

The app should map Clerk identity/org to a tenant ID, then bootstrap that tenant on the API side.

Recommended server-side flow:

1. User signs up/signs in via Clerk at `*.app.settld.work`.
2. App backend chooses tenant ID (for example: `tenant_<clerk_org_id>`).
3. App backend calls:
   - `POST /ops/tenants/bootstrap` (with a privileged ops token, server-side only)
4. App stores/bootstrap-returns tenant API key and presents onboarding state + Explorer links.

## 7) New-tenant acceptance run

Use this command to prove onboarding is self-serve and conformance-ready:

```bash
npm run ops:tenant:bootstrap:conformance -- \
  --base-url https://staging.api.settld.work \
  --ops-token "$SETTLD_STAGING_OPS_TOKEN" \
  --tenant-id "tenant_demo_$(date +%s)"
```

This performs:

- tenant bootstrap
- API key issuance
- kernel conformance run with that new tenant/API key

## 8) Acceptance bar (R2)

- Brand-new tenant can be created from app onboarding flow.
- Tenant receives API key without manual DB edits.
- Tenant can run kernel conformance against staging/prod.
- Explorer, replay, and closepack flows are reachable for that tenant.

## 9) Hosted baseline evidence command

Use the ops command below to collect a deterministic hosted-baseline evidence artifact (health, ops status, metrics, alert metric presence, billing catalog/quotas, optional rate-limit probe, optional backup/restore drill evidence):

```bash
npm run ops:hosted-baseline:evidence -- \
  --base-url https://staging.api.settld.work \
  --tenant-id tenant_default \
  --ops-token "$SETTLD_STAGING_OPS_TOKEN" \
  --environment staging \
  --rate-limit-mode optional \
  --rate-limit-probe-requests 20 \
  --out ./artifacts/ops/hosted-baseline-evidence-staging.json
```

If you want the command to execute the backup/restore drill inline:

```bash
npm run ops:hosted-baseline:evidence -- \
  --base-url https://staging.api.settld.work \
  --tenant-id tenant_default \
  --ops-token "$SETTLD_STAGING_OPS_TOKEN" \
  --environment staging \
  --run-backup-restore true \
  --database-url "$DATABASE_URL" \
  --restore-database-url "$RESTORE_DATABASE_URL" \
  --require-backup-restore true \
  --out ./artifacts/ops/hosted-baseline-evidence-staging.json
```

Important:

- `DATABASE_URL` and `RESTORE_DATABASE_URL` must be real connection strings (not redacted placeholders like `postgres://...`).
- Quick preflight:

```bash
node -e 'for (const n of ["DATABASE_URL","RESTORE_DATABASE_URL"]) { const v=(process.env[n]||"").trim(); if (!v) { console.error(`${n}=missing`); process.exitCode=1; continue; } const u=new URL(v); console.log(`${n} host=${u.hostname} protocol=${u.protocol}`); }'
```
