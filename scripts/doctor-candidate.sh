#!/usr/bin/env bash
set -euo pipefail

INSTALL_ROOT=${FORGEDOCK_CANDIDATE_INSTALL_ROOT:-}
REPO=${FORGEDOCK_TARGET_REPOSITORY:-}
CONFIG_DIR=
while (($#)); do
  case "$1" in
    --install-root) INSTALL_ROOT=${2:?missing path}; shift 2 ;;
    --config-dir) CONFIG_DIR=${2:?missing path}; shift 2 ;;
    --cwd|--repo) REPO=${2:?missing path}; shift 2 ;;
    -h|--help) exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/bin/forgedock-candidate.mjs" --help ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
if [[ -z "$INSTALL_ROOT" ]]; then echo "Use --install-root DIR or FORGEDOCK_CANDIDATE_INSTALL_ROOT" >&2; exit 2; fi
INSTALL_ROOT=$(cd "$INSTALL_ROOT" && pwd)
CONFIG_DIR=${CONFIG_DIR:-$INSTALL_ROOT/pi-agent}
ARGS=(doctor --config-dir "$CONFIG_DIR")
if [[ -n "$REPO" ]]; then ARGS+=(--cwd "$REPO"); fi
exec node "$INSTALL_ROOT/package/bin/forgedock-candidate.mjs" "${ARGS[@]}"
