# Pilot Onboarding Runbook (x402 Gateway)

Goal: install a design partner in one afternoon and prove a known-good `402 -> authorize -> verify -> settled` flow.

## 1. Prerequisites

- Runtime: Node 20+, Docker available for hosted acceptance checks.
- Access:
  - Settld API base URL (`SETTLD_BASE_URL`)
  - tenant id (`SETTLD_TENANT_ID`)
  - ops token (`PROXY_OPS_TOKEN`) to mint scoped API keys
- Pilot safety defaults:
  - `X402_PILOT_KILL_SWITCH=0`
  - `X402_PILOT_MAX_AMOUNT_CENTS=100`
  - `X402_PILOT_DAILY_LIMIT_CENTS=1000`

## 2. Environment Setup (15-20m)

```bash
export SETTLD_BASE_URL='https://api.settld.work'
export SETTLD_TENANT_ID='tenant_default'
export PROXY_OPS_TOKEN='tok_ops'
```

Mint a scoped API key:

```bash
curl -sS -X POST "$SETTLD_BASE_URL/ops/api-keys" \
  -H "x-proxy-tenant-id: $SETTLD_TENANT_ID" \
  -H "x-proxy-ops-token: $PROXY_OPS_TOKEN" \
  -H 'x-settld-protocol: 1.0' \
  -H 'content-type: application/json' \
  -d '{"scopes":["ops_read","ops_write","audit_read","finance_read","finance_write"]}' | jq .
```

## 3. Gateway Deploy (10-15m)

Use the local smoke stack as the deployment sanity baseline:

```bash
scripts/dev/smoke-x402-gateway.sh
```

For hosted deployment, configure gateway env:

- `SETTLD_API_URL=<api base>`
- `SETTLD_API_KEY=<keyId.secret>`
- `UPSTREAM_URL=<paid upstream base>`
- `X402_AUTOFUND=1` for pilot/demo rails only

## 4. Sandbox vs Production Mode

| Mode | Required vars | Notes |
|---|---|---|
| `sandbox` | `SETTLD_DEMO_CIRCLE_MODE=sandbox`, `X402_REQUIRE_EXTERNAL_RESERVE=1` | Safe pilot proving reserve path without live funds |
| `production` | `SETTLD_DEMO_CIRCLE_MODE=production`, live Circle vars (`CIRCLE_API_KEY`, wallet ids, token id) | Keep strict caps and provider allowlist on |

## 5. Known-Good Health Check Flow (10m)

1. Gateway health:

```bash
curl -sS http://127.0.0.1:8402/healthz | jq .
```

2. First request returns `402` + `x-settld-gate-id`:

```bash
FIRST_HEADERS=$(mktemp)
curl -sS -D "$FIRST_HEADERS" 'http://127.0.0.1:8402/exa/search?q=pilot+health' -o /tmp/pilot-first-body.json
GATE_ID=$(awk 'tolower($1)=="x-settld-gate-id:" {print $2}' "$FIRST_HEADERS" | tr -d '\r')
echo "$GATE_ID"
```

3. Retry with gate id returns `200` and settlement headers:

```bash
curl -sS -D /tmp/pilot-second-headers.txt \
  -H "x-settld-gate-id: $GATE_ID" \
  'http://127.0.0.1:8402/exa/search?q=pilot+health' -o /tmp/pilot-second-body.json
```

4. Confirm gate resolved in API:

```bash
curl -sS "$SETTLD_BASE_URL/x402/gate/$GATE_ID" \
  -H "x-proxy-tenant-id: $SETTLD_TENANT_ID" \
  -H "authorization: Bearer $SETTLD_API_KEY" \
  -H 'x-settld-protocol: 1.0' | jq '{gateId:.gate.gateId,status:.gate.status,settlement:.settlement.status}'
```

Expected: `status=resolved` and non-locked settlement.

## 6. Rollback Procedure (Fail-Closed)

1. Activate kill switch:

```bash
export X402_PILOT_KILL_SWITCH=1
```

2. Restart API/gateway with kill switch active.
3. Verify authorize rejects with `X402_PILOT_KILL_SWITCH_ACTIVE`.
4. Drain in-flight checks; stop new pilot traffic.
5. Revert risky config (prod reserve mode, provider allowlist overrides).
6. Run health checks again in sandbox mode before re-opening traffic.

## 7. Pilot Exit Criteria

- Health check flow passes end-to-end.
- Reliability report generated (`X402PilotReliabilityReport.v1`) and within thresholds.
- Rollback drill executed once and documented.
