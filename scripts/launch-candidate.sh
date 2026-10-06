#!/usr/bin/env bash
set -euo pipefail

INSTALL_ROOT=${FORGEDOCK_CANDIDATE_INSTALL_ROOT:-}
REPO=
MODEL=
THINKING=
NAME=
EXTRA=()

usage() {
  cat <<'EOF'
Usage: launch-candidate.sh --install-root DIR --repo DIR [--model provider/id[:thinking]] [--thinking level] [--name name] [pi args...]

Starts an interactive Pi session using only the isolated candidate and pinned
pi-subagents settings. Target-local project settings are ignored; AGENTS.md
coding instructions remain available.
EOF
}
while (($#)); do
  case "$1" in
    --install-root) INSTALL_ROOT=${2:?missing path}; shift 2 ;;
    --repo|--cwd) REPO=${2:?missing path}; shift 2 ;;
    --model) MODEL=${2:?missing model}; shift 2 ;;
    --thinking) THINKING=${2:?missing level}; shift 2 ;;
    --name) NAME=${2:?missing name}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    --)
      shift
      for argument in "$@"; do
        [[ "$argument" != -* ]] || { echo "Unsafe Pi option after --: $argument" >&2; exit 2; }
        EXTRA+=("$argument")
      done
      break
      ;;
    *)
      [[ "$1" != -* ]] || { echo "Unsupported launcher option: $1" >&2; exit 2; }
      EXTRA+=("$1")
      shift
      ;;
  esac
done

if [[ -z "$INSTALL_ROOT" || -z "$REPO" ]]; then usage >&2; exit 2; fi
INSTALL_ROOT=$(cd "$INSTALL_ROOT" && pwd)
REPO=$(cd "$REPO" && pwd)
PI_ROOT="$INSTALL_ROOT/pi-agent"
PACKAGE_ROOT="$INSTALL_ROOT/package"
BIN="$PACKAGE_ROOT/bin/forgedock-candidate.mjs"
[[ -f "$PI_ROOT/settings.json" && -f "$BIN" && -f "$INSTALL_ROOT/manifest.json" ]] || { echo "Invalid candidate install: $INSTALL_ROOT" >&2; exit 1; }
PI_PINNED_BINARY=$(node --input-type=module - "$INSTALL_ROOT/manifest.json" <<'NODE'
import { readFileSync } from "node:fs";
const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
process.stdout.write(typeof manifest.piBinary === "string" ? manifest.piBinary : "");
NODE
)
[[ -n "$PI_PINNED_BINARY" && "$PI_PINNED_BINARY" == /* ]] || { echo "Candidate install has no absolute Pi executable pin; reinstall with the explicit runtime selector" >&2; exit 1; }
if [[ -n "${PI_SUBAGENT_PI_BINARY:-}" && "$PI_SUBAGENT_PI_BINARY" != "$PI_PINNED_BINARY" ]]; then
  echo "PI_SUBAGENT_PI_BINARY differs from the candidate install's Pi executable pin" >&2
  exit 1
fi
PI_BINARY="$PI_PINNED_BINARY"
[[ -x "$PI_BINARY" ]] || { echo "Pinned Pi executable is unavailable: $PI_BINARY" >&2; exit 1; }
PI_VERSION=$("$PI_BINARY" --version)
PI_PINNED_VERSION=$(node --input-type=module - "$INSTALL_ROOT/manifest.json" <<'NODE'
import { readFileSync } from "node:fs";
const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
process.stdout.write(typeof manifest.piVersion === "string" ? manifest.piVersion : "");
NODE
)
[[ -n "$PI_PINNED_VERSION" && "$PI_VERSION" == "$PI_PINNED_VERSION" ]] || { echo "Pinned Pi runtime is $PI_VERSION, expected installed version $PI_PINNED_VERSION" >&2; exit 1; }
PI_SUBAGENT_PI_BINARY="$PI_BINARY" node "$BIN" verify-install --install-root "$INSTALL_ROOT" >/dev/null

# A stopped/foreign parent may leave PI_SUBAGENT_* controls in its environment.
# Clear them, then explicitly restore the install's Pi binary pin for both the
# parent and native child launches.
for variable in $(compgen -v | grep -E '^PI_SUBAGENTS?_' || true); do unset "$variable"; done

CONFIG_JSON=$(node "$BIN" config --cwd "$REPO")
if [[ -z "$MODEL" ]]; then
  MODEL=$(printf '%s' "$CONFIG_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);process.stdout.write(v.ownerModel);})')
fi
if [[ -z "$THINKING" ]]; then
  THINKING=$(printf '%s' "$CONFIG_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);process.stdout.write(v.ownerThinking);})')
fi
[[ "$MODEL" =~ ^[^[:space:]/]+/[^[:space:]]+$ && "$MODEL" != *: && "$MODEL" != *::* ]] || { echo "Target forge.yaml did not provide a full provider/model ID" >&2; exit 1; }
if [[ "$MODEL" =~ :([[:alpha:]]+)$ ]]; then
  MODEL_SUFFIX=${BASH_REMATCH[1],,}
  case "$MODEL_SUFFIX" in
    off|minimal|low|medium|high|xhigh|max) MODEL="${MODEL%:*}:$MODEL_SUFFIX" ;;
    *) echo "Model has an unsupported thinking suffix" >&2; exit 1 ;;
  esac
fi
[[ "$THINKING" =~ ^(off|minimal|low|medium|high|xhigh|max)$ ]] || { echo "Target forge.yaml did not provide a supported thinking level" >&2; exit 1; }

# The owner and reviewer share the configured provider/model in this candidate.
# Resolve it once against the pinned runtime's native registry before starting
# an interactive parent that could dispatch product work. Only the lookup uses
# the registry's base ID; MODEL (including any :max suffix) remains unchanged.
MODEL_BASE="$MODEL"
if [[ "$MODEL_BASE" =~ :([[:alpha:]]+)$ ]]; then
  MODEL_BASE="${MODEL_BASE%:*}"
fi
MODEL_PROVIDER=${MODEL_BASE%%/*}
MODEL_ID=${MODEL_BASE#*/}
MODEL_LIST=$(PI_CODING_AGENT_DIR="$PI_ROOT" PI_SUBAGENT_PI_BINARY="$PI_BINARY" PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 NO_COLOR=1 TERM=dumb \
  "$PI_BINARY" --model "$MODEL" --thinking "$THINKING" --list-models "$MODEL_BASE" 2>&1) || {
  echo "Pi $PI_VERSION model-registry preflight failed for owner/reviewer model $MODEL:$THINKING" >&2
  exit 1
}
if ! printf '%s\n' "$MODEL_LIST" | awk -v provider="$MODEL_PROVIDER" -v model="$MODEL_ID" -v thinking="$THINKING" '$1 == provider && $2 == model && (thinking == "off" || $5 == "yes") { found = 1 } END { exit !found }'; then
  echo "Pi $PI_VERSION model registry does not resolve owner/reviewer model $MODEL:$THINKING" >&2
  exit 1
fi
printf 'Pi runtime preflight passed: %s (%s), owner/reviewer model %s:%s\n' "$PI_BINARY" "$PI_VERSION" "$MODEL" "$THINKING"

ARGS=(--offline --no-approve --session-dir "$INSTALL_ROOT/sessions" --model "$MODEL" --thinking "$THINKING")
if [[ -n "$NAME" ]]; then ARGS+=(--name "$NAME"); else ARGS+=(--name "ForgeDock candidate: $(basename "$REPO")"); fi

cd "$REPO"
exec env \
  -u PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT \
  PI_SUBAGENT_PI_BINARY="$PI_BINARY" \
  PI_CODING_AGENT_DIR="$PI_ROOT" \
  PI_CODING_AGENT_SESSION_DIR="$INSTALL_ROOT/sessions" \
  PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 \
  FORGEDOCK_CANDIDATE_INSTALL_ROOT="$INSTALL_ROOT" \
  FORGEDOCK_CANDIDATE_BIN="$BIN" \
  FORGEDOCK_CANDIDATE_OWNER_MODEL="$MODEL" \
  FORGEDOCK_CANDIDATE_OWNER_THINKING="$THINKING" \
  FORGEDOCK_CANDIDATE_REVIEWER_THINKING="$THINKING" \
  "$PI_BINARY" "${ARGS[@]}" "${EXTRA[@]}"
