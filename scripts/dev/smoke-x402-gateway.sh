#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

API_PID=""
UPSTREAM_PID=""
GATEWAY_PID=""
FIRST_HEADERS=""
RUNTIME_ENV_FILE=""

cleanup() {
  set +e
  if [[ -n "${FIRST_HEADERS:-}" && -f "${FIRST_HEADERS:-}" ]]; then rm -f "${FIRST_HEADERS:-}"; fi
  if [[ -n "${RUNTIME_ENV_FILE:-}" && -f "${RUNTIME_ENV_FILE:-}" ]]; then rm -f "${RUNTIME_ENV_FILE:-}"; fi
  if [[ -n "${GATEWAY_PID:-}" ]]; then kill "${GATEWAY_PID}" >/dev/null 2>&1 || true; fi
  if [[ -n "${UPSTREAM_PID:-}" ]]; then kill "${UPSTREAM_PID}" >/dev/null 2>&1 || true; fi
  if [[ -n "${API_PID:-}" ]]; then kill "${API_PID}" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

# Ensure scripts/dev/env.sh + scripts/dev/new-sdk-key.sh target the local API and do not clobber repo env files.
RUNTIME_ENV_FILE="$(mktemp)"
export SETTLD_BASE_URL="http://127.0.0.1:3000"
export SETTLD_TENANT_ID="tenant_default"
export SETTLD_RUNTIME_ENV_FILE="${RUNTIME_ENV_FILE}"
export SETTLD_ENV_FILE="/dev/null"

echo "[smoke] starting Settld API on :3000"
PROXY_OPS_TOKEN=tok_ops PORT=3000 node src/api/server.js >/tmp/settld_api_smoke.log 2>&1 &
API_PID="$!"

echo "[smoke] waiting for API readiness"
for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:3000/healthz" >/dev/null; then break; fi
  sleep 1
  if [[ "$i" == "60" ]]; then
    echo "[smoke] API did not become ready; tailing logs" >&2
    tail -n 200 /tmp/settld_api_smoke.log >&2 || true
    exit 1
  fi
done

echo "[smoke] minting an API key"
bash scripts/dev/new-sdk-key.sh --ops-token tok_ops >/dev/null
# shellcheck source=/dev/null
source "${RUNTIME_ENV_FILE}"
if [[ -z "${SETTLD_API_KEY:-}" ]]; then
  echo "[smoke] SETTLD_API_KEY not set after new-sdk-key.sh" >&2
  exit 1
fi

echo "[smoke] starting mock upstream on :9402"
PORT=9402 node services/x402-gateway/examples/upstream-mock.js >/tmp/settld_x402_upstream_smoke.log 2>&1 &
UPSTREAM_PID="$!"

echo "[smoke] waiting for upstream readiness"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:9402/healthz" >/dev/null; then break; fi
  sleep 0.2
  if [[ "$i" == "30" ]]; then
    echo "[smoke] upstream did not become ready; tailing logs" >&2
    tail -n 200 /tmp/settld_x402_upstream_smoke.log >&2 || true
    exit 1
  fi
done

echo "[smoke] starting gateway on :8402"
SETTLD_API_URL="http://127.0.0.1:3000" \
SETTLD_API_KEY="${SETTLD_API_KEY}" \
UPSTREAM_URL="http://127.0.0.1:9402" \
X402_AUTOFUND=1 \
HOLDBACK_BPS=1000 \
DISPUTE_WINDOW_MS=86400000 \
PORT=8402 \
node services/x402-gateway/src/server.js >/tmp/settld_x402_gateway_smoke.log 2>&1 &
GATEWAY_PID="$!"

echo "[smoke] waiting for gateway readiness"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:8402/healthz" >/dev/null; then break; fi
  sleep 0.2
  if [[ "$i" == "30" ]]; then
    echo "[smoke] gateway did not become ready; tailing logs" >&2
    tail -n 200 /tmp/settld_x402_gateway_smoke.log >&2 || true
    exit 1
  fi
done

echo "[smoke] driving 402 -> gate/create"
FIRST_HEADERS="$(mktemp)"
curl -isS "http://127.0.0.1:8402/resource" | tee "${FIRST_HEADERS}" >/dev/null
GATE_ID="$(
  awk 'BEGIN{IGNORECASE=1} $1 ~ /^x-settld-gate-id:$/ {print $2}' "${FIRST_HEADERS}" | tr -d '\r' | head -n 1
)"
if [[ -z "${GATE_ID:-}" ]]; then
  echo "[smoke] missing x-settld-gate-id header" >&2
  cat "${FIRST_HEADERS}" >&2 || true
  exit 1
fi
echo "[smoke] gateId=${GATE_ID}"

echo "[smoke] driving verify-before-release"
curl -isS "http://127.0.0.1:8402/resource" \
  -H "x-settld-gate-id: ${GATE_ID}" \
  -H "x-payment: paid" >/dev/null

echo "[smoke] fetching gate state from API"
curl -fsS "http://127.0.0.1:3000/x402/gate/${GATE_ID}" \
  -H "x-proxy-tenant-id: tenant_default" \
  -H "authorization: Bearer ${SETTLD_API_KEY}" \
  -H "x-settld-protocol: 1.0" | jq '{gateStatus:.gate.status, settlementStatus:.settlement.status, holdback:.gate.holdback}'

echo "[smoke] ok"
