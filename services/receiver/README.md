# Settld Reference Receiver (verify-on-receipt)

This service is a reference downstream consumer for Settld webhook deliveries:
- verifies webhook HMAC
- verifies artifact integrity (`packages/artifact-verify`)
- stores the artifact immutably to S3/MinIO keyed by `artifactHash`
- ACKs the delivery back to Settld (`POST /exports/ack`)
- dedupes by `x-proxy-dedupe-key` and is restart-safe via an append-only local log

## Run (local)

```sh
node services/receiver/src/server.js
```

## Endpoints

- `POST /deliveries/settld`
- `GET /health`
- `GET /ready`
- `GET /metrics`

## Required env

- `RECEIVER_PORT` (default `4000`)
- `RECEIVER_TENANT_ID` (default `tenant_default`)
- `RECEIVER_DESTINATION_ID` (must match Settld export destination id)
- `RECEIVER_ACK_URL` (Settld `POST /exports/ack` URL)

Secrets (use `*_REF` in production):
- `RECEIVER_HMAC_SECRET_REF` (`env:NAME` or `file:/path`)
- `RECEIVER_S3_ACCESS_KEY_ID_REF`
- `RECEIVER_S3_SECRET_ACCESS_KEY_REF`

S3/MinIO:
- `RECEIVER_S3_ENDPOINT`
- `RECEIVER_S3_REGION` (default `us-east-1`)
- `RECEIVER_S3_BUCKET`
- `RECEIVER_S3_PREFIX` (default `settld/`)
- `RECEIVER_S3_FORCE_PATH_STYLE` (`1`/`0`, default `1`)

Persistence:
- `RECEIVER_DEDUPE_DB_PATH` (default `./receiver-dedupe.jsonl`)

ACK tuning:
- `RECEIVER_ACK_MAX_INFLIGHT` (default `10`)
- `RECEIVER_ACK_RETRY_MAX` (default `50`)
- `RECEIVER_ACK_TIMEOUT_MS` (default `5000`)

