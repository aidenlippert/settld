#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=/dev/null
source "$ROOT_DIR/scripts/dev/env.sh"

if [[ "${1:-}" == "--help" ]]; then
  cat <<'EOF'
Usage:
  bash scripts/dev/new-sdk-key.sh
  bash scripts/dev/new-sdk-key.sh --print-only

Behavior:
  - mints a new API key via /ops/api-keys
  - writes SETTLD_API_KEY into .env.dev.runtime
  - prints export command for current shell
EOF
  exit 0
fi

# Prefer x-proxy-ops-token for hosted deployments that may not forward Authorization.
RESPONSE="$(
  curl -sS -X POST "$SETTLD_BASE_URL/ops/api-keys" \
    -H "x-proxy-ops-token: $PROXY_OPS_TOKEN" \
    -H "authorization: Bearer $PROXY_OPS_TOKEN" \
    -H "x-proxy-tenant-id: $SETTLD_TENANT_ID" \
    -H "content-type: application/json" \
    -d '{"scopes":["ops_read","ops_write","finance_read","finance_write","audit_read"],"description":"sdk quickstart"}'
)"

KEY_ID="$(echo "$RESPONSE" | jq -r '.keyId // empty')"
SECRET="$(echo "$RESPONSE" | jq -r '.secret // empty')"

if [[ -z "$KEY_ID" || -z "$SECRET" ]]; then
  echo "Failed to mint SDK key."
  echo "$RESPONSE" | jq .
  exit 1
fi

SETTLD_API_KEY_VALUE="${KEY_ID}.${SECRET}"

if [[ "${1:-}" == "--print-only" ]]; then
  echo "$SETTLD_API_KEY_VALUE"
  exit 0
fi

printf "SETTLD_API_KEY=%s\n" "$SETTLD_API_KEY_VALUE" >"$SETTLD_RUNTIME_ENV_FILE"
chmod 600 "$SETTLD_RUNTIME_ENV_FILE" || true

echo "Wrote $SETTLD_RUNTIME_ENV_FILE"
echo "export SETTLD_API_KEY='$SETTLD_API_KEY_VALUE'"
