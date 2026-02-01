# Settld Finance Sink (reference)

A tiny reference consumer that accepts Settld webhook deliveries and writes **finance-friendly** objects to S3/MinIO:

- `JournalCsv.v1` → `finance/tenants/<tenantId>/periods/<YYYY-MM>/journal.csv`
- `FinancePackBundle.v1` (pointer artifact) → fetches the referenced `.zip` and writes `finance/tenants/<tenantId>/periods/<YYYY-MM>/finance_pack_bundle.<bundleHash>.zip`
- Writes `_READY_*.json` markers with hashes and verification status.

It also ACKs deliveries back to Settld (retry-safe), and dedupes by `x-proxy-dedupe-key`.

## Run

```bash
node services/finance-sink/src/server.js
```

## Env

- `FINANCE_SINK_PORT` (default `4100`)
- `FINANCE_SINK_TENANT_ID` (default `tenant_default`)
- `FINANCE_SINK_DESTINATION_ID` (required; must match the Settld destination id that sends webhooks here)
- `FINANCE_SINK_ACK_URL` (required; Settld `/exports/ack`)

Secrets:
- `FINANCE_SINK_HMAC_SECRET` or `FINANCE_SINK_HMAC_SECRET_REF` (`env:NAME` or `file:/path`)

S3/MinIO (write destination):
- `FINANCE_SINK_S3_ENDPOINT`
- `FINANCE_SINK_S3_REGION` (default `us-east-1`)
- `FINANCE_SINK_S3_BUCKET`
- `FINANCE_SINK_S3_PREFIX` (default `finance/`)
- `FINANCE_SINK_S3_FORCE_PATH_STYLE` (`1`/`0`, default `1`)
- `FINANCE_SINK_S3_ACCESS_KEY_ID` / `_REF`
- `FINANCE_SINK_S3_SECRET_ACCESS_KEY` / `_REF`

Dedupe DB:
- `FINANCE_SINK_DEDUPE_DB_PATH` (default `./finance-sink-dedupe.jsonl`)
