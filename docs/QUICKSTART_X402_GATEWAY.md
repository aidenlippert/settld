# Quickstart: x402 Gateway (Verify Before Release)

Goal: in ~10 minutes, run a local Settld API + a mock x402 upstream + the Settld x402 gateway, then complete a `402 -> hold -> verify -> release` flow and get a deterministic receipt trail.

## TL;DR (one command)

```bash
npm ci && npm run quickstart:x402
```

Success: prints `OK`, `gateId=...`, and `gateStateUrl=...`.

By default the script keeps services running until you press Ctrl+C. To run once and exit (CI-friendly):

```bash
npm ci && SETTLD_QUICKSTART_KEEP_ALIVE=0 npm run quickstart:x402
```

If you already ran `npm ci` in this repo, you can skip it:

```bash
npm run quickstart:x402
```

Ports can be overridden if you already have something running on `3000/8402/9402`:

- `SETTLD_QUICKSTART_API_PORT`
- `SETTLD_QUICKSTART_GATEWAY_PORT`
- `SETTLD_QUICKSTART_UPSTREAM_PORT`

## 0) Prereqs

- Node.js 20+
- Bash (for the copy/paste snippets below)
- `curl`

Optional:

- Docker Engine 20.10+ (only if you want to run the gateway via container)
  - Linux: this quickstart includes Linux-safe Docker networking options (do not assume `host.docker.internal` works without configuration).

## 1) Start a local Settld API (in-memory)

From repo root:

```bash
npm ci
```

Then:

```bash
PROXY_OPS_TOKEN=tok_ops PORT=3000 npm run dev:api
```

In another terminal, confirm:

```bash
curl -fsS http://127.0.0.1:3000/healthz
```

## 2) Mint an API key (no jq required)

This mints a tenant API key using the dev ops token (`PROXY_OPS_TOKEN`). The gateway uses `SETTLD_API_KEY` (not the ops token) to call Settld.

```bash
SETTLD_API_KEY="$(
  set -euo pipefail
  curl -fsS -X POST http://127.0.0.1:3000/ops/api-keys \
    -H "x-proxy-ops-token: tok_ops" \
    -H "authorization: Bearer tok_ops" \
    -H "x-proxy-tenant-id: tenant_default" \
    -H "content-type: application/json" \
    -d '{"scopes":["ops_read","ops_write","finance_read","finance_write","audit_read"],"description":"x402 gateway quickstart"}' \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);if(!j?.keyId||!j?.secret){console.error("unexpected response:",d);process.exit(1)}process.stdout.write(`${j.keyId}.${j.secret}`)})'
)"
export SETTLD_API_KEY
if [ -n "$SETTLD_API_KEY" ]; then
  echo "SETTLD_API_KEY minted"
else
  echo "FAILED: SETTLD_API_KEY empty" >&2
fi
```

## 3) Start a mock x402 upstream

The upstream will return `HTTP 402` with `x-payment-required` until you retry with `x-payment: paid`.

```bash
PORT=9402 node services/x402-gateway/examples/upstream-mock.js
```

In another terminal:

```bash
curl -fsS http://127.0.0.1:9402/healthz
```

## 3.5) Provider signature key (demo)

This quickstart uses provider-signed responses as a minimal correctness check:

- the upstream mock signs a response hash with Ed25519
- the gateway verifies the signature before releasing funds

Export the upstream mock's dev-only public key:

```bash
export X402_PROVIDER_PUBLIC_KEY_PEM="$(cat <<'EOF'
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA7zJ+oQLAO6F4Xewe7yJB1mv5TxsLo5bGZI7ZJPuFB6s=
-----END PUBLIC KEY-----
EOF
)"
```

## 4) Start the x402 gateway (thin proxy)

### Option A: run from source (fastest)

```bash
SETTLD_API_URL="http://127.0.0.1:3000" \
SETTLD_API_KEY="$SETTLD_API_KEY" \
UPSTREAM_URL="http://127.0.0.1:9402" \
HOLDBACK_BPS=0 \
DISPUTE_WINDOW_MS=3600000 \
X402_AUTOFUND=1 \
X402_PROVIDER_PUBLIC_KEY_PEM="$X402_PROVIDER_PUBLIC_KEY_PEM" \
PORT=8402 \
npm run dev:x402-gateway
```

Notes:

- `X402_AUTOFUND=1` is for local demo only. It simulates funding the payer so escrow holds can be created without a real payment rail.

### Option B: run via Docker (same config surface)

Important:

- On macOS/Windows (Docker Desktop), `host.docker.internal` works by default.
- On Linux, `host.docker.internal` is usually not defined. If you run the gateway in Docker while your Settld API + mock upstream are running on the host, use one of the Linux commands below:
  - Recommended: `--add-host=host.docker.internal:host-gateway` (Docker Engine 20.10+)
  - Alternative: `--network host` and use `127.0.0.1` URLs (not available on Docker Desktop; often not supported with rootless Docker)

Pull the image:

```bash
docker pull ghcr.io/aidenlippert/settld/x402-gateway:latest
```

If `docker pull` fails with `denied`, either:

- build locally from this repo (no dependencies; copies `src/core` + `services/x402-gateway`):

```bash
docker build -t settld/x402-gateway:local -f services/x402-gateway/Dockerfile .
```

and replace `ghcr.io/aidenlippert/settld/x402-gateway:latest` with `settld/x402-gateway:local` in the `docker run` commands below.

macOS/Windows (Docker Desktop):

```bash
docker run --rm -p 8402:8402 \
  -e SETTLD_API_URL="http://host.docker.internal:3000" \
  -e SETTLD_API_KEY="$SETTLD_API_KEY" \
  -e UPSTREAM_URL="http://host.docker.internal:9402" \
  -e HOLDBACK_BPS=0 \
  -e DISPUTE_WINDOW_MS=3600000 \
  -e X402_AUTOFUND=1 \
  -e X402_PROVIDER_PUBLIC_KEY_PEM="$X402_PROVIDER_PUBLIC_KEY_PEM" \
  -e PORT=8402 \
  ghcr.io/aidenlippert/settld/x402-gateway:latest
```

Linux (recommended, bridge networking):

```bash
docker run --rm -p 8402:8402 \
  --add-host=host.docker.internal:host-gateway \
  -e SETTLD_API_URL="http://host.docker.internal:3000" \
  -e SETTLD_API_KEY="$SETTLD_API_KEY" \
  -e UPSTREAM_URL="http://host.docker.internal:9402" \
  -e HOLDBACK_BPS=0 \
  -e DISPUTE_WINDOW_MS=3600000 \
  -e X402_AUTOFUND=1 \
  -e X402_PROVIDER_PUBLIC_KEY_PEM="$X402_PROVIDER_PUBLIC_KEY_PEM" \
  -e PORT=8402 \
  ghcr.io/aidenlippert/settld/x402-gateway:latest
```

Linux alternative (host networking):

```bash
docker run --rm --network host \
  -e SETTLD_API_URL="http://127.0.0.1:3000" \
  -e SETTLD_API_KEY="$SETTLD_API_KEY" \
  -e UPSTREAM_URL="http://127.0.0.1:9402" \
  -e HOLDBACK_BPS=0 \
  -e DISPUTE_WINDOW_MS=3600000 \
  -e X402_AUTOFUND=1 \
  -e X402_PROVIDER_PUBLIC_KEY_PEM="$X402_PROVIDER_PUBLIC_KEY_PEM" \
  -e PORT=8402 \
  ghcr.io/aidenlippert/settld/x402-gateway:latest
```

Confirm:

```bash
curl -fsS http://127.0.0.1:8402/healthz
```

## 5) Drive the 402 -> verify -> release flow

### 5.0 One-shot smoke test (copy/paste; fails fast)

This asserts the expected HTTP status codes and (with the default upstream + gateway config in this doc) checks that the released/refunded cents are consistent.

```bash
set -euo pipefail

h402="$(curl -sS -D - -o /dev/null http://127.0.0.1:8402/resource)"
echo "$h402" | grep -qE '^HTTP/.* 402 '
echo "$h402" | grep -qi '^x-payment-required:'
amount_cents="$(echo "$h402" | tr -d '\r' | grep -i '^x-payment-required:' | sed -n 's/.*amountCents=\([0-9][0-9]*\).*/\1/p' | head -n 1)"
test -n "$amount_cents"
GATE_ID="$(echo "$h402" | awk 'tolower($1) == "x-settld-gate-id:" {print $2}' | tr -d '\r' | head -n 1)"
test -n "$GATE_ID"
echo "gateId=$GATE_ID"

h200="$(curl -sS -D - -o /dev/null http://127.0.0.1:8402/resource -H "x-settld-gate-id: $GATE_ID" -H "x-payment: paid")"
echo "$h200" | grep -qE '^HTTP/.* 200 '

settlement_status="$(echo "$h200" | awk 'tolower($1) == "x-settld-settlement-status:" {print $2}' | tr -d '\r' | head -n 1)"
released_cents="$(echo "$h200" | awk 'tolower($1) == "x-settld-released-amount-cents:" {print $2}' | tr -d '\r' | head -n 1)"
refunded_cents="$(echo "$h200" | awk 'tolower($1) == "x-settld-refunded-amount-cents:" {print $2}' | tr -d '\r' | head -n 1)"
test "$settlement_status" = "released"
test "$released_cents" = "$amount_cents"
test "$refunded_cents" = "0"

echo "OK"
```

Notes:

- If you set `HOLDBACK_BPS>0`, the gateway may emit `x-settld-holdback-*` headers (a follow-on settlement).

### 5.1 First request (expect 402 + x-settld-gate-id)

```bash
curl -isS http://127.0.0.1:8402/resource | sed -n '1,40p'
```

Extract the gate id:

```bash
GATE_ID="$(
  curl -isS http://127.0.0.1:8402/resource \
    | awk 'tolower($1) == "x-settld-gate-id:" {print $2}' \
    | tr -d '\r' \
    | head -n 1
)"
echo "gateId=$GATE_ID"
```

### 5.2 Second request (retry with gate id + mock payment proof)

```bash
curl -isS http://127.0.0.1:8402/resource \
  -H "x-settld-gate-id: $GATE_ID" \
  -H "x-payment: paid" | sed -n '1,80p'
```

You should see:

- `HTTP 200`
- `x-settld-response-sha256: ...`
- `x-settld-verification-status: green|red`
- `x-settld-verification-codes: ...` (optional; reason codes when verification is forced red)
- `x-settld-settlement-status: released`
- `x-settld-released-amount-cents`, `x-settld-refunded-amount-cents`
- `x-settld-holdback-status`, `x-settld-holdback-amount-cents` (when `HOLDBACK_BPS>0`)

## 6) Inspect the gate state (optional)

```bash
curl -fsS "http://127.0.0.1:3000/x402/gate/$GATE_ID" \
  -H "x-proxy-tenant-id: tenant_default" \
  -H "authorization: Bearer $SETTLD_API_KEY" \
  -H "x-settld-protocol: 1.0"
```

## Troubleshooting

- If the gateway never returns `x-settld-gate-id`, your upstream likely isn’t returning `402` with `x-payment-required`.
- If `/x402/gate/verify` fails with insufficient funds, you forgot `X402_AUTOFUND=1` (local demo) or you need a real funding path wired in.
- Linux + Docker: if the gateway container can’t reach `http://host.docker.internal:3000` / `:9402`, use `--add-host=host.docker.internal:host-gateway` or `--network host` (and point `SETTLD_API_URL`/`UPSTREAM_URL` at `http://127.0.0.1:...`).
- If you see `EADDRINUSE` (port already in use), pick different ports (the one-command quickstart supports `SETTLD_QUICKSTART_API_PORT`, `SETTLD_QUICKSTART_UPSTREAM_PORT`, and `SETTLD_QUICKSTART_GATEWAY_PORT`).

If you tried and failed:

- Run `./scripts/collect-debug.sh` and attach the resulting `settld-debug-*.tar.gz` to a GitHub issue using the "Quickstart failure" template:
  - https://github.com/aidenlippert/settld/issues/new?template=quickstart-failure.yml
