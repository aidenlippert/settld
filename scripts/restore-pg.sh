#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required" >&2
  exit 2
fi

if [[ $# -lt 1 ]]; then
  echo "Usage: DATABASE_URL=... $0 /path/to/db.dump" >&2
  exit 2
fi

DUMP_PATH="$1"
if [[ ! -f "$DUMP_PATH" ]]; then
  echo "Dump file not found: $DUMP_PATH" >&2
  exit 2
fi

echo "Restoring from $DUMP_PATH" >&2

# Ensure required extensions exist (safe even if already present).
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;" >/dev/null

# Restore (best for fresh DB; --clean drops existing objects if present).
pg_restore --no-owner --no-privileges --clean --if-exists --dbname "$DATABASE_URL" "$DUMP_PATH"

echo "Restore complete" >&2

if [[ "${VERIFY_AFTER_RESTORE:-1}" == "1" ]]; then
  echo "Running verification..." >&2
  node scripts/verify-pg.js
fi

