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

if ! command -v psql >/dev/null 2>&1; then
  echo "psql is required on PATH" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="${TMPDIR:-/tmp}"
RUN_ID="settld_backup_restore_$(date +%s)"
SQL_DUMP="${TMP}/${RUN_ID}.sql"
EXPECTED_JSON="${TMP}/${RUN_ID}.expected.json"
STEP_TIMEOUT_SECONDS="${STEP_TIMEOUT_SECONDS:-600}"
VERIFY_FINANCE_PACK_RAW="${BACKUP_RESTORE_VERIFY_FINANCE_PACK:-0}"
VERIFY_FINANCE_PACK=0
case "$(printf '%s' "${VERIFY_FINANCE_PACK_RAW}" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes) VERIFY_FINANCE_PACK=1 ;;
  *) VERIFY_FINANCE_PACK=0 ;;
esac

export STORE=pg
export NODE_ENV=production
export PROXY_MIGRATE_ON_STARTUP=1

# Make the seed workload isolated by schema (so repeated runs don't collide).
# If the ambient env uses "public", force an isolated drill schema.
REQUESTED_SCHEMA="${PROXY_PG_SCHEMA:-}"
if [[ -z "${REQUESTED_SCHEMA}" || "${REQUESTED_SCHEMA}" == "public" ]]; then
  export PROXY_PG_SCHEMA="backup_${RUN_ID}"
else
  export PROXY_PG_SCHEMA="${REQUESTED_SCHEMA}"
fi
export TENANT_ID="${TENANT_ID:-tenant_default}"
export MONTH="${MONTH:-2026-01}"
export JOBS="${JOBS:-10}"
if [[ "${VERIFY_FINANCE_PACK}" -ne 1 ]]; then
  export BACKUP_RESTORE_REQUIRE_MONTH_CLOSE=0
  export BACKUP_RESTORE_REQUEST_MONTH_CLOSE=0
fi

SAME_DATABASE_URLS=0
if [[ "${DATABASE_URL}" == "${RESTORE_DATABASE_URL}" ]]; then
  SAME_DATABASE_URLS=1
fi
RESTORE_SCHEMA="${PROXY_PG_RESTORE_SCHEMA:-${PROXY_PG_SCHEMA}_restore}"
if [[ "${#RESTORE_SCHEMA}" -gt 63 ]]; then
  RESTORE_SCHEMA="${RESTORE_SCHEMA:0:63}"
fi
if [[ "${SAME_DATABASE_URLS}" -eq 1 && "${RESTORE_SCHEMA}" == "${PROXY_PG_SCHEMA}" ]]; then
  RESTORE_SCHEMA="${PROXY_PG_SCHEMA}_r"
fi

step() {
  local label="$1"
  shift
  local started
  started="$(date +%s)"
  echo "${label}"
  if timeout "${STEP_TIMEOUT_SECONDS}" "$@"; then
    local elapsed
    elapsed="$(( $(date +%s) - started ))"
    echo "    -> ok (${elapsed}s)"
    return 0
  else
    local code="$?"
    local elapsed
    elapsed="$(( $(date +%s) - started ))"
    echo "    -> failed (${elapsed}s, exit=${code})" >&2
    return "${code}"
  fi
}

dump_schema_to_file() {
  local out_file="$1"
  local err_file
  err_file="$(mktemp "${TMP}/settld_pg_dump_err_${RUN_ID}_XXXX.txt")"

  if command -v pg_dump >/dev/null 2>&1; then
    if pg_dump --schema="${PROXY_PG_SCHEMA}" --no-owner --no-privileges "${DATABASE_URL}" > "${out_file}" 2>"${err_file}"; then
      rm -f "${err_file}"
      return 0
    fi
    if ! grep -qi "server version mismatch" "${err_file}"; then
      cat "${err_file}" >&2
      rm -f "${err_file}"
      return 1
    fi
  fi

  if ! command -v docker >/dev/null 2>&1; then
    cat "${err_file}" >&2
    rm -f "${err_file}"
    return 1
  fi

  if ! docker run --rm postgres:17 pg_dump --schema="${PROXY_PG_SCHEMA}" --no-owner --no-privileges "${DATABASE_URL}" > "${out_file}" 2>"${err_file}"; then
    cat "${err_file}" >&2
    rm -f "${err_file}"
    return 1
  fi

  rm -f "${err_file}"
  return 0
}

clone_schema_in_place() {
  local src_schema="$1"
  local dst_schema="$2"
  psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 <<SQL >/dev/null
DROP SCHEMA IF EXISTS "${dst_schema}" CASCADE;
CREATE SCHEMA "${dst_schema}";
DO \$\$
DECLARE
  t RECORD;
BEGIN
  FOR t IN
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = '${src_schema}'
    ORDER BY tablename
  LOOP
    EXECUTE format(
      'CREATE TABLE %I.%I (LIKE %I.%I INCLUDING DEFAULTS INCLUDING GENERATED INCLUDING IDENTITY)',
      '${dst_schema}',
      t.tablename,
      '${src_schema}',
      t.tablename
    );
    EXECUTE format('INSERT INTO %I.%I SELECT * FROM %I.%I', '${dst_schema}', t.tablename, '${src_schema}', t.tablename);
  END LOOP;
END
\$\$;
SQL
}

step "[1/8] Seed workload into source DB (schema=${PROXY_PG_SCHEMA})" \
  node "${ROOT}/scripts/backup-restore/seed-workload.mjs"

step "[2/8] Capture expected state" \
  bash -lc "node \"${ROOT}/scripts/backup-restore/capture-state.mjs\" > \"${EXPECTED_JSON}\""

FP_ZIP=""
FP_SHA=""
if [[ "${VERIFY_FINANCE_PACK}" -eq 1 ]]; then
  echo "[3/8] Build FinancePackBundle and strict-verify (source DB)"
  FINANCE_OUT="${TMP}/${RUN_ID}.finance_pack"
  FP_ZIP="$(timeout "${STEP_TIMEOUT_SECONDS}" env DATABASE_URL="${DATABASE_URL}" TENANT_ID="${TENANT_ID}" PROXY_PG_SCHEMA="${PROXY_PG_SCHEMA}" node "${ROOT}/scripts/finance-pack/bundle.mjs" --period "${MONTH}" --out "${FINANCE_OUT}" --zip)"
  step "    strict verify source finance pack" \
    node "${ROOT}/packages/artifact-verify/bin/settld-verify.js" --strict --finance-pack "${FP_ZIP}" >/dev/null
  FP_SHA="$(node -e "import fs from 'node:fs'; import crypto from 'node:crypto'; const b=fs.readFileSync(process.argv[1]); console.log(crypto.createHash('sha256').update(b).digest('hex'))" "${FP_ZIP}")"
  echo "    -> ok ($(basename "${FP_ZIP}"))"
else
  echo "[3/8] Skip FinancePackBundle strict verification (set BACKUP_RESTORE_VERIFY_FINANCE_PACK=1 to enable)"
fi

if [[ "${SAME_DATABASE_URLS}" -eq 1 ]]; then
  echo "[4/8] Clone source schema (${PROXY_PG_SCHEMA}) -> (${RESTORE_SCHEMA})"
  clone_started="$(date +%s)"
  if clone_schema_in_place "${PROXY_PG_SCHEMA}" "${RESTORE_SCHEMA}"; then
    echo "    -> ok ($(( $(date +%s) - clone_started ))s)"
  else
    echo "    -> failed ($(( $(date +%s) - clone_started ))s, exit=1)" >&2
    exit 1
  fi
  echo "[5/8] Restore into restore DB (same DB URL; schema clone used)"
else
  echo "[4/8] pg_dump source DB schema (${PROXY_PG_SCHEMA})"
  dump_started="$(date +%s)"
  if dump_schema_to_file "${SQL_DUMP}"; then
    echo "    -> ok ($(( $(date +%s) - dump_started ))s)"
  else
    echo "    -> failed ($(( $(date +%s) - dump_started ))s, exit=1)" >&2
    exit 1
  fi

  echo "[5/8] Restore into restore DB"
  # Restore DB is assumed to exist and be empty-ish; caller can create it via CI setup.
  step "    probe restore DB connectivity" \
    psql "${RESTORE_DATABASE_URL}" -v ON_ERROR_STOP=1 -c "SELECT 1" >/dev/null
  step "    restore SQL dump" \
    psql "${RESTORE_DATABASE_URL}" -v ON_ERROR_STOP=1 -f "${SQL_DUMP}" >/dev/null
fi

step "[6/8] Verify restored state" \
  env DATABASE_URL="${RESTORE_DATABASE_URL}" PROXY_PG_SCHEMA="${RESTORE_SCHEMA}" node "${ROOT}/scripts/backup-restore/verify-state.mjs" "${EXPECTED_JSON}"

if [[ "${VERIFY_FINANCE_PACK}" -eq 1 ]]; then
  echo "[7/8] Build FinancePackBundle and strict-verify (restored DB) + compare zip hash"
  RESTORED_OUT="${TMP}/${RUN_ID}.finance_pack_restored"
  FP_ZIP_RESTORED="$(timeout "${STEP_TIMEOUT_SECONDS}" env DATABASE_URL="${RESTORE_DATABASE_URL}" TENANT_ID="${TENANT_ID}" PROXY_PG_SCHEMA="${RESTORE_SCHEMA}" node "${ROOT}/scripts/finance-pack/bundle.mjs" --period "${MONTH}" --out "${RESTORED_OUT}" --zip)"
  step "    strict verify restored finance pack" \
    node "${ROOT}/packages/artifact-verify/bin/settld-verify.js" --strict --finance-pack "${FP_ZIP_RESTORED}" >/dev/null
  FP_SHA_RESTORED="$(node -e "import fs from 'node:fs'; import crypto from 'node:crypto'; const b=fs.readFileSync(process.argv[1]); console.log(crypto.createHash('sha256').update(b).digest('hex'))" "${FP_ZIP_RESTORED}")"
  if [[ "${FP_SHA}" != "${FP_SHA_RESTORED}" ]]; then
    echo "FinancePack zip hash mismatch after restore:" >&2
    echo "  source:   ${FP_SHA} (${FP_ZIP})" >&2
    echo "  restored: ${FP_SHA_RESTORED} (${FP_ZIP_RESTORED})" >&2
    exit 1
  fi
else
  echo "[7/8] Skip FinancePackBundle restore hash comparison (set BACKUP_RESTORE_VERIFY_FINANCE_PACK=1 to enable)"
fi

echo "[8/8] Done"
echo "=== Backup/Restore Verification PASSED ==="
