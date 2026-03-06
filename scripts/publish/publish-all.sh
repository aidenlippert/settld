#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

node scripts/publish/prepublish-check.mjs

if [[ "${NOOTERRA_PUBLISH_DRY_RUN:-1}" == "1" ]]; then
  echo "NOOTERRA_PUBLISH_DRY_RUN=1 -> running npm publish --dry-run"
  npm publish --dry-run "$@"
else
  npm publish "$@"
fi
