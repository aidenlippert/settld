#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=/dev/null
source "$ROOT_DIR/scripts/dev/env.sh"

for bin in curl jq; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "Missing required tool: $bin"
    exit 1
  fi
done

if ! curl -fsS "$SETTLD_BASE_URL/healthz" >/dev/null 2>&1; then
  cat <<EOF
API is not reachable at $SETTLD_BASE_URL.
Start it in another shell:
  npm run dev:start
EOF
  exit 1
fi

if [[ -z "${SETTLD_API_KEY:-}" ]]; then
  SETTLD_API_KEY="$(bash "$ROOT_DIR/scripts/dev/new-sdk-key.sh" --print-only)"
  export SETTLD_API_KEY
fi

API_AUTH_HEADER="authorization: Bearer $SETTLD_API_KEY"
PERIOD="$(date -u +%Y-%m)"

api_post_json() {
  local path="$1"
  local payload="$2"
  local response
  local body
  local status

  response="$(curl -sS -X POST "$SETTLD_BASE_URL$path" \
    -H "$API_AUTH_HEADER" \
    -H "x-proxy-tenant-id: $SETTLD_TENANT_ID" \
    -H "content-type: application/json" \
    -d "$payload" \
    -w $'\n%{http_code}')"
  body="$(printf "%s" "$response" | sed '$d')"
  status="$(printf "%s" "$response" | tail -n1)"
  if [[ ! "$status" =~ ^2 ]]; then
    echo "Request failed: POST $path (HTTP $status)"
    echo "$body" | jq . 2>/dev/null || echo "$body"
    exit 1
  fi
  printf "%s" "$body"
}

echo "[1/5] Running first verified settlement..."
RUN_JSON="$(cd "$ROOT_DIR" && SETTLD_SDK_DISPUTE_WINDOW_DAYS=3 npm run -s sdk:first-run)"
echo "$RUN_JSON" | jq .

RUN_ID="$(echo "$RUN_JSON" | jq -r '.runId')"
PAYER_AGENT_ID="$(echo "$RUN_JSON" | jq -r '.payerAgentId')"
if [[ -z "$RUN_ID" || "$RUN_ID" == "null" ]]; then
  echo "Could not parse runId from sdk:first-run output."
  exit 1
fi
if [[ -z "$PAYER_AGENT_ID" || "$PAYER_AGENT_ID" == "null" ]]; then
  echo "Could not parse payerAgentId from sdk:first-run output."
  exit 1
fi

SUFFIX="$(date +%s%N | cut -c1-16)"
DISPUTE_ID="dispute_doctor_${SUFFIX}"
CASE_ID="arb_case_doctor_${SUFFIX}"

echo "[2/5] Opening dispute..."
DISPUTE_JSON="$(api_post_json "/runs/$RUN_ID/dispute/open" "{\"disputeId\":\"$DISPUTE_ID\",\"reason\":\"billing doctor validation\",\"openedByAgentId\":\"$PAYER_AGENT_ID\"}")"
echo "$DISPUTE_JSON" | jq .

echo "[3/5] Opening arbitration case..."
ARBITRATION_JSON="$(api_post_json "/runs/$RUN_ID/arbitration/open" "{\"caseId\":\"$CASE_ID\",\"disputeId\":\"$DISPUTE_ID\",\"arbiterAgentId\":\"$PAYER_AGENT_ID\"}")"
echo "$ARBITRATION_JSON" | jq .

echo "[4/5] Reading billable events..."
EVENTS_JSON="$(curl -sS "$SETTLD_BASE_URL/ops/finance/billable-events?period=$PERIOD" \
  -H "authorization: Bearer $PROXY_OPS_TOKEN" \
  -H "x-proxy-tenant-id: $SETTLD_TENANT_ID")"
echo "$EVENTS_JSON" | jq .

ARBITRATION_EVENTS_FOR_CASE="$(echo "$EVENTS_JSON" | jq --arg caseId "$CASE_ID" '[.events[] | select(.eventType=="arbitration_usage" and .arbitrationCaseId==$caseId)] | length')"
if [[ "$ARBITRATION_EVENTS_FOR_CASE" -lt 1 ]]; then
  echo "Expected at least one arbitration_usage event for case $CASE_ID, found $ARBITRATION_EVENTS_FOR_CASE."
  exit 1
fi

echo "[5/5] Reading billing summary..."
SUMMARY_JSON="$(curl -sS "$SETTLD_BASE_URL/ops/finance/billing/summary?period=$PERIOD" \
  -H "authorization: Bearer $PROXY_OPS_TOKEN" \
  -H "x-proxy-tenant-id: $SETTLD_TENANT_ID")"
echo "$SUMMARY_JSON" | jq .

ARBITRATION_CASES="$(echo "$SUMMARY_JSON" | jq -r '.usage.arbitrationCases // 0')"
if [[ "$ARBITRATION_CASES" -lt 1 ]]; then
  echo "Expected arbitrationCases >= 1 in billing summary, got $ARBITRATION_CASES."
  exit 1
fi

echo
echo "Billing doctor passed."
echo "Run: $RUN_ID"
echo "Dispute: $DISPUTE_ID"
echo "Arbitration case: $CASE_ID"
