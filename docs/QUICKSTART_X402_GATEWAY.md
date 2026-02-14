# Quickstart: x402 Gateway (Receipt In 5 Minutes)

Goal: run an x402-style payment flow and get a deterministic Settld settlement outcome ("receipt") instead of a blind payment.

## Prereqs

- Node.js 20+
- `curl`, `jq`

## 1) Start Settld API

```bash
PROXY_OPS_TOKEN=tok_ops npm run dev:api
```

## 2) Mint an API key for the gateway

```bash
SETTLD_API_KEY="$(bash scripts/dev/new-sdk-key.sh --ops-token tok_ops --print-only)"
```

## 3) Start a mock x402 upstream (returns 402 until "paid")

```bash
PORT=9402 node services/x402-gateway/examples/upstream-mock.js
```

## 4) Start the x402 gateway (thin proxy)

Recommended: run the gateway directly with Node (fastest local dev loop).

```bash
SETTLD_API_URL=http://127.0.0.1:3000 \
SETTLD_API_KEY="$SETTLD_API_KEY" \
UPSTREAM_URL=http://127.0.0.1:9402 \
X402_AUTOFUND=1 \
HOLDBACK_BPS=1000 \
DISPUTE_WINDOW_MS=86400000 \
PORT=8402 \
node services/x402-gateway/src/server.js
```

Optional: run the gateway via Docker (closest to production packaging).

Linux note: `host.docker.internal` is not always available; this uses `--add-host` to wire it up.

```bash
# Preferred (after this repo is merged to main): pull the published image from GHCR.
docker pull ghcr.io/aidenlippert/settld/x402-gateway:latest

# If you're developing locally (before merge), build it:
# docker build -f services/x402-gateway/Dockerfile -t settld/x402-gateway:dev .

docker run --rm -p 8402:8402 \
  --add-host=host.docker.internal:host-gateway \
  -e SETTLD_API_URL="http://host.docker.internal:3000" \
  -e SETTLD_API_KEY="$SETTLD_API_KEY" \
  -e UPSTREAM_URL="http://host.docker.internal:9402" \
  -e X402_AUTOFUND=1 \
  -e HOLDBACK_BPS=1000 \
  -e DISPUTE_WINDOW_MS=86400000 \
  -e PORT=8402 \
  ghcr.io/aidenlippert/settld/x402-gateway:latest
```

## 5) Drive the flow

Note: this demo does not process a real payment. `X402_AUTOFUND=1` is enabled so the Settld hold can be created without integrating a payment rail.

Initial request triggers 402 and creates a Settld gate:

```bash
curl -isS http://127.0.0.1:8402/resource | tee /tmp/x402_first.txt
GATE_ID="$(rg -i '^x-settld-gate-id:' /tmp/x402_first.txt | head -n 1 | awk '{print $2}' | tr -d '\r')"
echo "gateId=$GATE_ID"
```

Retry as "paid" (mock) and include `x-settld-gate-id` so the gateway can verify and settle:

```bash
curl -isS http://127.0.0.1:8402/resource \
  -H "x-settld-gate-id: $GATE_ID" \
  -H "x-payment: paid"
```

Fetch the receipt state from Settld:

```bash
curl -sS "http://127.0.0.1:3000/x402/gate/$GATE_ID" \
  -H "x-proxy-tenant-id: tenant_default" \
  -H "authorization: Bearer $SETTLD_API_KEY" \
  -H "x-settld-protocol: 1.0" | jq
```

What you should see:

- `gate.status = "resolved"`
- `settlement.status != "locked"`
- If `HOLDBACK_BPS > 0`, `gate.holdback.status = "held"` and a `holdbackSettlement` exists.
