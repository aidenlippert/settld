#!/usr/bin/env bash
set -euo pipefail

echo "=== Settld Backup/Restore Verification ==="

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required" >&2
  exit 2
fi
if [[ -z "${RESTORE_DATABASE_URL:-}" ]]; then
  echo "RESTORE_DATABASE_URL is required" >&2
  exit 2
fi

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "pg_dump is required on PATH" >&2
  exit 2
fi
if ! command -v psql >/dev/null 2>&1; then
  echo "psql is required on PATH" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="${TMPDIR:-/tmp}"
RUN_ID="settld_backup_restore_$(date +%s)"
SQL_DUMP="${TMP}/${RUN_ID}.sql"
EXPECTED_JSON="${TMP}/${RUN_ID}.expected.json"

export STORE=pg
export NODE_ENV=production
export PROXY_MIGRATE_ON_STARTUP=1

# Make the seed workload isolated by schema (so repeated runs don't collide).
export PROXY_PG_SCHEMA="${PROXY_PG_SCHEMA:-backup_${RUN_ID}}"
export TENANT_ID="${TENANT_ID:-tenant_default}"
export MONTH="${MONTH:-2026-01}"
export JOBS="${JOBS:-10}"

echo "[1/6] Seed workload into source DB (schema=${PROXY_PG_SCHEMA})"
node "${ROOT}/scripts/backup-restore/seed-workload.mjs" >/dev/null

echo "[2/6] Capture expected state"
node "${ROOT}/scripts/backup-restore/capture-state.mjs" > "${EXPECTED_JSON}"

echo "[3/8] Build FinancePackBundle and strict-verify (source DB)"
FINANCE_OUT="${TMP}/${RUN_ID}.finance_pack"
FP_ZIP="$(DATABASE_URL="${DATABASE_URL}" TENANT_ID="${TENANT_ID}" PROXY_PG_SCHEMA="${PROXY_PG_SCHEMA}" node "${ROOT}/scripts/finance-pack/bundle.mjs" --period "${MONTH}" --out "${FINANCE_OUT}" --zip)"
node "${ROOT}/packages/artifact-verify/bin/settld-verify.js" --strict --finance-pack "${FP_ZIP}" >/dev/null
FP_SHA="$(node -e "import fs from 'node:fs'; import crypto from 'node:crypto'; const b=fs.readFileSync(process.argv[1]); console.log(crypto.createHash('sha256').update(b).digest('hex'))" "${FP_ZIP}")"

echo "[4/8] pg_dump source DB"
pg_dump "${DATABASE_URL}" > "${SQL_DUMP}"

echo "[5/8] Restore into restore DB"
# Restore DB is assumed to exist and be empty-ish; caller can create it via CI setup.
psql "${RESTORE_DATABASE_URL}" -v ON_ERROR_STOP=1 -c "SELECT 1" >/dev/null
psql "${RESTORE_DATABASE_URL}" -v ON_ERROR_STOP=1 -f "${SQL_DUMP}" >/dev/null

echo "[6/8] Verify restored state"
DATABASE_URL="${RESTORE_DATABASE_URL}" node "${ROOT}/scripts/backup-restore/verify-state.mjs" "${EXPECTED_JSON}"

echo "[7/8] Build FinancePackBundle and strict-verify (restored DB) + compare zip hash"
RESTORED_OUT="${TMP}/${RUN_ID}.finance_pack_restored"
FP_ZIP_RESTORED="$(DATABASE_URL="${RESTORE_DATABASE_URL}" TENANT_ID="${TENANT_ID}" PROXY_PG_SCHEMA="${PROXY_PG_SCHEMA}" node "${ROOT}/scripts/finance-pack/bundle.mjs" --period "${MONTH}" --out "${RESTORED_OUT}" --zip)"
node "${ROOT}/packages/artifact-verify/bin/settld-verify.js" --strict --finance-pack "${FP_ZIP_RESTORED}" >/dev/null
FP_SHA_RESTORED="$(node -e "import fs from 'node:fs'; import crypto from 'node:crypto'; const b=fs.readFileSync(process.argv[1]); console.log(crypto.createHash('sha256').update(b).digest('hex'))" "${FP_ZIP_RESTORED}")"
if [[ "${FP_SHA}" != "${FP_SHA_RESTORED}" ]]; then
  echo "FinancePack zip hash mismatch after restore:" >&2
  echo "  source:   ${FP_SHA} (${FP_ZIP})" >&2
  echo "  restored: ${FP_SHA_RESTORED} (${FP_ZIP_RESTORED})" >&2
  exit 1
fi

echo "[8/8] Done"
echo "=== Backup/Restore Verification PASSED ==="
