#!/usr/bin/env bash
set -euo pipefail

INSTALL_ROOT=${1:?Usage: native-smoke.sh INSTALL_ROOT [TARGET_REPOSITORY]}
TARGET=${2:-$(pwd)}
INSTALL_ROOT=$(cd "$INSTALL_ROOT" && pwd)
exec node "$INSTALL_ROOT/package/bin/forgedock-candidate.mjs" doctor \
  --config-dir "$INSTALL_ROOT/pi-agent" --cwd "$TARGET"
