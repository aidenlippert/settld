#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required" >&2
  exit 2
fi

OUT_DIR="${OUT_DIR:-./backups}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="${OUT_DIR%/}/backup_${TS}"

mkdir -p "$DEST"

sanitize_url() {
  # Best-effort: redact password in postgres://user:pass@host/db
  local url="$1"
  if [[ "$url" =~ ^([^:]+://[^:@]+):[^@]+@(.*)$ ]]; then
    echo "${BASH_REMATCH[1]}:[REDACTED]@${BASH_REMATCH[2]}"
  else
    echo "[REDACTED]"
  fi
}

echo "Backing up to $DEST" >&2

pg_dump --format=custom --no-owner --no-privileges --file "$DEST/db.dump" "$DATABASE_URL"

if command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$DEST/db.dump" >"$DEST/db.dump.sha256"
elif command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$DEST/db.dump" >"$DEST/db.dump.sha256"
fi

cat >"$DEST/meta.json" <<EOF
{
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "databaseUrl": "$(sanitize_url "$DATABASE_URL")",
  "pgSchema": "${PROXY_PG_SCHEMA:-public}",
  "notes": "pg_dump custom format; restore with scripts/restore-pg.sh"
}
EOF

echo "Done: $DEST" >&2

