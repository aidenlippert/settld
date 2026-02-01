#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

ACCEPTANCE_CLEAN="${ACCEPTANCE_CLEAN:-1}"
ACCEPTANCE_PROFILE="${ACCEPTANCE_PROFILE:-app}"

if ! docker info >/dev/null 2>&1; then
  echo "acceptance: docker is not available (is the daemon running, and do you have socket access?)" >&2
  exit 2
fi

RUN_ID="${ACCEPTANCE_RUN_ID:-$(date +%s)_$RANDOM}"
PROJECT="${ACCEPTANCE_PROJECT_NAME:-settld_acc_${RUN_ID}}"
SCHEMA="${ACCEPTANCE_PG_SCHEMA:-acc_${RUN_ID}}"
ART_DIR="${ACCEPTANCE_ARTIFACT_DIR:-$(mktemp -d)}"

pick_port() {
  node --input-type=module -e "import net from 'node:net'; const s=net.createServer(); s.listen(0,'127.0.0.1',()=>{console.log(s.address().port); s.close();});"
}

API_PORT="${ACCEPTANCE_API_PORT:-$(pick_port)}"
RECEIVER_PORT="${ACCEPTANCE_RECEIVER_PORT:-$(pick_port)}"
MINIO_PORT="${ACCEPTANCE_MINIO_PORT:-$(pick_port)}"
MINIO_CONSOLE_PORT="${ACCEPTANCE_MINIO_CONSOLE_PORT:-$(pick_port)}"

export COMPOSE_PROJECT_NAME="${PROJECT}"
export PROXY_PG_SCHEMA="${SCHEMA}"
export PROXY_API_PORT="${API_PORT}"
export PROXY_RECEIVER_PORT="${RECEIVER_PORT}"
export PROXY_MINIO_PORT="${MINIO_PORT}"
export PROXY_MINIO_CONSOLE_PORT="${MINIO_CONSOLE_PORT}"
export ACCEPTANCE_ARTIFACT_DIR="${ART_DIR}"
export ACCEPTANCE_API_BASE_URL="${ACCEPTANCE_API_BASE_URL:-http://127.0.0.1:${API_PORT}}"
export ACCEPTANCE_RECEIVER_BASE_URL="${ACCEPTANCE_RECEIVER_BASE_URL:-http://127.0.0.1:${RECEIVER_PORT}}"
export ACCEPTANCE_MINIO_ENDPOINT="${ACCEPTANCE_MINIO_ENDPOINT:-http://127.0.0.1:${MINIO_PORT}}"

mkdir -p "${ART_DIR}"
echo "acceptance: artifacts dir: ${ART_DIR}"
echo "acceptance: COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME}"
echo "acceptance: PROXY_PG_SCHEMA=${PROXY_PG_SCHEMA}"
echo "acceptance: PROXY_API_PORT=${PROXY_API_PORT}"
echo "acceptance: PROXY_RECEIVER_PORT=${PROXY_RECEIVER_PORT}"
echo "acceptance: PROXY_MINIO_PORT=${PROXY_MINIO_PORT}"
echo "acceptance: PROXY_MINIO_CONSOLE_PORT=${PROXY_MINIO_CONSOLE_PORT}"
echo "acceptance: ACCEPTANCE_API_BASE_URL=${ACCEPTANCE_API_BASE_URL}"
echo "acceptance: ACCEPTANCE_RECEIVER_BASE_URL=${ACCEPTANCE_RECEIVER_BASE_URL}"
echo "acceptance: ACCEPTANCE_MINIO_ENDPOINT=${ACCEPTANCE_MINIO_ENDPOINT}"

compose_down() {
  local profile_args=(--profile "${ACCEPTANCE_PROFILE}")
  local exit_code="${1:-0}"
  if [[ "${exit_code}" != "0" ]]; then
    echo "acceptance: failure diagnostics"
    docker compose "${profile_args[@]}" ps || true
    docker compose "${profile_args[@]}" logs --no-color --tail=400 >"${ART_DIR}/compose.logs.tail.txt" 2>&1 || true
    cat "${ART_DIR}/compose.logs.tail.txt" || true

    # Best-effort: if context exists, snapshot key ops endpoints for debugging.
    if [[ -f "${ART_DIR}/context.json" ]]; then
      node --input-type=module -e "import fs from 'node:fs'; const c=JSON.parse(fs.readFileSync(process.env.ACCEPTANCE_ARTIFACT_DIR + '/context.json','utf8')); console.log(c?.bearer ?? '');" \
        >"${ART_DIR}/bearer.txt" 2>/dev/null || true
      BEARER="$(cat "${ART_DIR}/bearer.txt" 2>/dev/null || true)"
      if [[ -n "${BEARER}" ]]; then
        BEARER="${BEARER}" TENANT="${ACCEPTANCE_TENANT_ID:-tenant_default}" PROTO="${ACCEPTANCE_PROTOCOL:-1.0}" API="${ACCEPTANCE_API_BASE_URL:-http://127.0.0.1:3000}" \
        node --input-type=module -e "const b=process.env.BEARER; const t=process.env.TENANT; const p=process.env.PROTO; const base=process.env.API; async function get(path){const r=await fetch(base+path,{headers:{authorization:b,'x-proxy-tenant-id':t,'x-settld-protocol':p}}).catch(()=>null); if(!r){console.log(path, 'fetch_failed'); return;} const txt=await r.text(); console.log(path, r.status); console.log(txt.slice(0, 4000));} await get('/ops/status'); await get('/ops/deliveries?limit=50'); await get('/ops/dlq?type=delivery&limit=50');" \
          >"${ART_DIR}/ops.snapshots.txt" 2>&1 || true
        cat "${ART_DIR}/ops.snapshots.txt" || true
      fi
    fi
  fi

  if [[ "${ACCEPTANCE_CLEAN}" == "1" ]]; then
    docker compose --profile "${ACCEPTANCE_PROFILE}" down -v --remove-orphans >/dev/null 2>&1 || true
  else
    docker compose --profile "${ACCEPTANCE_PROFILE}" down --remove-orphans >/dev/null 2>&1 || true
  fi
}

cleanup() {
  local code="$?"
  compose_down "${code}"
}
trap cleanup EXIT

compose_down 0

echo "acceptance: starting docker compose (profile=${ACCEPTANCE_PROFILE})"
docker compose --profile "${ACCEPTANCE_PROFILE}" up -d --build

echo "acceptance: running full-stack checks"
node scripts/acceptance/full-stack.mjs

echo "acceptance: OK"
