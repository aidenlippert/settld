# Settld x402 Gateway (S24)

Thin proxy that sits between your client and an upstream x402-style API, and converts `HTTP 402` into a Settld `hold -> verify -> release/refund` settlement.

## Config

Required:

- `SETTLD_API_URL`
- `SETTLD_API_KEY` (format: `keyId.secret`)
- `UPSTREAM_URL`

Optional:

- `HOLDBACK_BPS` (default `0`)
- `DISPUTE_WINDOW_MS` (default `3600000`)
- `X402_AUTOFUND` (default `false`) (local demo only; do not use in production)
- `X402_PROVIDER_PUBLIC_KEY_PEM` (optional; if set, the gateway requires a provider signature on responses and will not release funds without it)
- `PORT` (default `8402`)

Notes:

- The gateway forwards `x-proxy-tenant-id` to Settld if present on the incoming request; otherwise it uses `tenant_default`.
- For Settld writes it sends `x-settld-protocol=1.0`.

## Run (Docker)

From repo root:

```bash
# Preferred: pull the published image from GHCR.
docker pull ghcr.io/aidenlippert/settld/x402-gateway:latest

# Or build from source:
# docker build -f services/x402-gateway/Dockerfile -t settld/x402-gateway:dev .

docker run --rm -p 8402:8402 \
  -e X402_AUTOFUND=0 \
  -e SETTLD_API_URL="http://host.docker.internal:3000" \
  -e SETTLD_API_KEY="YOUR_KEY_ID.YOUR_SECRET" \
  -e UPSTREAM_URL="https://example.com" \
  ghcr.io/aidenlippert/settld/x402-gateway:latest
```

## Usage

1. Send your normal request through the gateway: `http://127.0.0.1:8402/...`
2. If upstream returns `402` with `x-payment-required`, the gateway responds `402` and includes `x-settld-gate-id`.
3. Retry the upstream request through the gateway, but include `x-settld-gate-id: <value>`.
4. When the upstream returns `200`, the gateway calls Settld `/x402/gate/verify` and returns `x-settld-*` result headers.
