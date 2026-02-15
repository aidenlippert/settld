#!/usr/bin/env bash
set -euo pipefail

SCRIPT_VERSION="1"
WORKDIR=""

usage() {
  cat <<'EOH' >&2
Collect a Settld debug bundle for quickstart / Docker issues.

This script captures basic host + repo + Docker/Compose info and (optionally) compose logs,
then packages everything into a single archive you can attach to a GitHub issue.

Usage:
  scripts/collect-debug.sh [--out <path>] [--project-dir <dir>] [--tail <N>] [--no-logs] [--zip] [--dry-run]

Options:
  --out <path>         Output archive path. Default: ./settld-debug-<ts>.tar.gz
  --project-dir <dir>  Directory to run docker compose from. Default: repo root.
  --tail <N>           Number of log lines to collect per service. Default: 2000
  --no-logs            Skip collecting compose logs.
  --zip                Create a .zip (requires `zip`). Default is .tar.gz
  --dry-run            Print what would be collected and exit.
  -h, --help           Show this help.

Notes:
  - Review the bundle before sharing. Logs can contain secrets.
  - The script will still produce a bundle even if Docker is not installed/running.
EOH
}

die() {
  echo "error: $*" >&2
  exit 2
}

quote_cmd() {
  local out=""
  local arg
  for arg in "$@"; do
    out+="$(printf '%q ' "$arg")"
  done
  printf '%s' "${out% }"
}

run_cmd() {
  local out_file="$1"
  shift
  mkdir -p "$(dirname "$out_file")"
  local cmd
  cmd="$(quote_cmd "$@")"
  {
    echo "\$ ${cmd}"
    set +e
    "$@"
    local rc=$?
    set -e
    echo
    echo "exit_code=${rc}"
  } >"$out_file" 2>&1
  return 0
}

write_kv_file() {
  local out_file="$1"
  shift
  mkdir -p "$(dirname "$out_file")"
  {
    for kv in "$@"; do
      echo "$kv"
    done
  } >"$out_file"
}

sha256_file() {
  local p="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$p" | awk '{print $1}'
    return 0
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$p" | awk '{print $1}'
    return 0
  fi
  echo "unknown"
}

main() {
  local root
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

  local out_path=""
  local project_dir="$root"
  local tail_lines="2000"
  local no_logs="0"
  local want_zip="0"
  local dry_run="0"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --out)
        [[ $# -ge 2 ]] || die "--out requires a value"
        out_path="$2"
        shift 2
        ;;
      --project-dir)
        [[ $# -ge 2 ]] || die "--project-dir requires a value"
        project_dir="$2"
        shift 2
        ;;
      --tail)
        [[ $# -ge 2 ]] || die "--tail requires a value"
        tail_lines="$2"
        shift 2
        ;;
      --no-logs)
        no_logs="1"
        shift
        ;;
      --zip)
        want_zip="1"
        shift
        ;;
      --dry-run)
        dry_run="1"
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        die "unknown argument: $1"
        ;;
    esac
  done

  if [[ ! -d "$project_dir" ]]; then
    die "project dir not found: $project_dir"
  fi

  local ts bundle_name
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  bundle_name="settld-debug-${ts}"

  if [[ -z "$out_path" ]]; then
    if [[ "$want_zip" == "1" ]]; then
      out_path="./${bundle_name}.zip"
    else
      out_path="./${bundle_name}.tar.gz"
    fi
  fi

  if [[ "$dry_run" == "1" ]]; then
    local logs_msg="enabled"
    if [[ "$no_logs" == "1" ]]; then
      logs_msg="skipped (--no-logs)"
    fi
    cat <<EOF
Would create:
  bundle: ${bundle_name}/
  archive: ${out_path}

Would collect:
  - Host: uname, os-release (if present), sw_vers (if present)
  - Runtime: bash/node/npm versions (if present)
  - Repo: git head + git status (if present)
  - Docker: version + info (if present)
  - Compose: version + ps + config
  - Compose logs: ${logs_msg} (tail=${tail_lines})
EOF
    exit 0
  fi

  WORKDIR="$(mktemp -d)"
  local bundle_dir
  bundle_dir="${WORKDIR}/${bundle_name}"
  mkdir -p "$bundle_dir"
  trap 'if [ -n "${WORKDIR:-}" ] && [ -d "${WORKDIR:-}" ]; then rm -rf "$WORKDIR"; fi' EXIT

  write_kv_file "${bundle_dir}/meta.txt" \
    "script=collect-debug.sh" \
    "script_version=${SCRIPT_VERSION}" \
    "collected_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "project_dir=${project_dir}"

  run_cmd "${bundle_dir}/host/uname.txt" uname -a
  if [[ -f /etc/os-release ]]; then
    run_cmd "${bundle_dir}/host/os-release.txt" cat /etc/os-release
  fi
  if command -v sw_vers >/dev/null 2>&1; then
    run_cmd "${bundle_dir}/host/sw_vers.txt" sw_vers
  fi

  run_cmd "${bundle_dir}/runtime/bash-version.txt" bash --version
  if command -v node >/dev/null 2>&1; then
    run_cmd "${bundle_dir}/runtime/node-version.txt" node --version
  fi
  if command -v npm >/dev/null 2>&1; then
    run_cmd "${bundle_dir}/runtime/npm-version.txt" npm --version
  fi

  if command -v git >/dev/null 2>&1; then
    run_cmd "${bundle_dir}/repo/git-head.txt" git -C "$root" rev-parse HEAD
    run_cmd "${bundle_dir}/repo/git-status.txt" git -C "$root" status -sb
  fi

  write_kv_file "${bundle_dir}/env/selected.txt" \
    "PATH=$([[ -n "${PATH:-}" ]] && echo '<set>' || echo '<unset>')" \
    "DOCKER_HOST=$([[ -n "${DOCKER_HOST:-}" ]] && echo '<set>' || echo '<unset>')" \
    "DOCKER_CONTEXT=$([[ -n "${DOCKER_CONTEXT:-}" ]] && echo '<set>' || echo '<unset>')" \
    "COMPOSE_FILE=$([[ -n "${COMPOSE_FILE:-}" ]] && echo '<set>' || echo '<unset>')" \
    "COMPOSE_PROJECT_NAME=$([[ -n "${COMPOSE_PROJECT_NAME:-}" ]] && echo '<set>' || echo '<unset>')" \
    "HTTP_PROXY=$([[ -n "${HTTP_PROXY:-}" ]] && echo '<set>' || echo '<unset>')" \
    "HTTPS_PROXY=$([[ -n "${HTTPS_PROXY:-}" ]] && echo '<set>' || echo '<unset>')" \
    "NO_PROXY=$([[ -n "${NO_PROXY:-}" ]] && echo '<set>' || echo '<unset>')"

  if command -v docker >/dev/null 2>&1; then
    run_cmd "${bundle_dir}/docker/docker-version.txt" docker --version
    run_cmd "${bundle_dir}/docker/docker-info.txt" docker info
  else
    write_kv_file "${bundle_dir}/docker/docker-missing.txt" "docker=<missing>"
  fi

  # Compose info (prefer `docker compose`, fall back to `docker-compose`).
  local compose_kind="none"
  local -a compose_cmd=()
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    compose_kind="docker-compose-plugin"
    compose_cmd=(docker compose)
  elif command -v docker-compose >/dev/null 2>&1; then
    compose_kind="docker-compose-standalone"
    compose_cmd=(docker-compose)
  fi

  write_kv_file "${bundle_dir}/compose/compose-kind.txt" "compose_kind=${compose_kind}"
  if [[ "$compose_kind" != "none" ]]; then
    run_cmd "${bundle_dir}/compose/compose-version.txt" "${compose_cmd[@]}" version
    run_cmd "${bundle_dir}/compose/compose-ps.txt" "${compose_cmd[@]}" -f "${project_dir}/docker-compose.yml" ps
    run_cmd "${bundle_dir}/compose/compose-config.txt" "${compose_cmd[@]}" -f "${project_dir}/docker-compose.yml" config

    if [[ "$no_logs" != "1" ]]; then
      run_cmd "${bundle_dir}/compose/compose-logs.txt" "${compose_cmd[@]}" -f "${project_dir}/docker-compose.yml" logs --no-color --tail "$tail_lines"
    fi
  fi

  # Pack archive.
  mkdir -p "$(dirname "$out_path")" || true
  if [[ "$want_zip" == "1" ]]; then
    command -v zip >/dev/null 2>&1 || die "--zip requested but `zip` is not installed"
    (cd "$WORKDIR" && zip -r -q "$out_path" "$bundle_name")
  else
    (cd "$WORKDIR" && tar -czf "$out_path" "$bundle_name")
  fi

  local sum
  sum="$(sha256_file "$out_path")"
  printf '%s  %s\n' "$sum" "$(basename "$out_path")" > "${out_path}.sha256" 2>/dev/null || true
  echo "wrote: ${out_path}"
  echo "sha256: ${sum}"
}

main "$@"
