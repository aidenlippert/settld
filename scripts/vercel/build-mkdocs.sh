#!/usr/bin/env bash
set -euo pipefail

if ! python3 -m mkdocs --version >/dev/null 2>&1; then
  echo "MkDocs not found; running install step first..."
  bash scripts/vercel/install-mkdocs.sh
fi

python3 -m mkdocs build --strict --config-file mkdocs.yml
