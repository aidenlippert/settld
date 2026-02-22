#!/usr/bin/env bash
set -euo pipefail

# Vercel "ignoreCommand" contract:
# - exit 0 => skip deployment
# - exit 1 => continue with deployment

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

if ! git rev-parse --verify HEAD^ >/dev/null 2>&1; then
  # No parent commit context available; build to stay safe.
  exit 1
fi

if git diff --quiet HEAD^ HEAD -- \
  dashboard/ \
  scripts/vercel/ignore-dashboard.sh \
  .github/workflows/release.yml \
  .github/workflows/tests.yml; then
  # No website changes; skip dashboard deployment.
  exit 0
fi

# Relevant website/deploy files changed; run deployment.
exit 1
