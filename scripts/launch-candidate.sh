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
    --) shift; EXTRA+=("$@"); break ;;
    *) EXTRA+=("$1"); shift ;;
  esac
done

if [[ -z "$INSTALL_ROOT" || -z "$REPO" ]]; then usage >&2; exit 2; fi
INSTALL_ROOT=$(cd "$INSTALL_ROOT" && pwd)
REPO=$(cd "$REPO" && pwd)
PI_ROOT="$INSTALL_ROOT/pi-agent"
PACKAGE_ROOT="$INSTALL_ROOT/package"
BIN="$PACKAGE_ROOT/bin/forgedock-candidate.mjs"
[[ -f "$PI_ROOT/settings.json" && -f "$BIN" ]] || { echo "Invalid candidate install: $INSTALL_ROOT" >&2; exit 1; }

# A stopped/foreign parent may leave PI_SUBAGENT_* controls in its environment.
# The candidate must start from its own settings; the native runtime repopulates
# its child-scoped variables after launch.
for variable in $(compgen -v | grep -E '^PI_SUBAGENTS?_' || true); do unset "$variable"; done

CONFIG_JSON=$(node "$BIN" config --cwd "$REPO")
if [[ -z "$MODEL" ]]; then
  MODEL=$(printf '%s' "$CONFIG_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);process.stdout.write(v.ownerModel);})')
fi
if [[ -z "$THINKING" ]]; then
  THINKING=$(printf '%s' "$CONFIG_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);process.stdout.write(v.ownerThinking);})')
fi
[[ "$MODEL" =~ ^[^[:space:]/]+/[^[:space:]]+$ ]] || { echo "Target forge.yaml did not provide a full provider/model ID" >&2; exit 1; }
if [[ "$MODEL" =~ :([[:alpha:]]+)$ ]]; then
  MODEL_SUFFIX=${BASH_REMATCH[1],,}
  case "$MODEL_SUFFIX" in
    off|minimal|low|medium|high|xhigh|max) MODEL="${MODEL%:*}:$MODEL_SUFFIX" ;;
    *) echo "Model has an unsupported thinking suffix" >&2; exit 1 ;;
  esac
fi
[[ "$THINKING" =~ ^(off|minimal|low|medium|high|xhigh|max)$ ]] || { echo "Target forge.yaml did not provide a supported thinking level" >&2; exit 1; }

ARGS=(--offline --no-approve --session-dir "$INSTALL_ROOT/sessions" --model "$MODEL" --thinking "$THINKING")
if [[ -n "$NAME" ]]; then ARGS+=(--name "$NAME"); else ARGS+=(--name "ForgeDock candidate: $(basename "$REPO")"); fi

cd "$REPO"
exec env \
  -u PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT \
  -u PI_SUBAGENT_PI_BINARY \
  PI_CODING_AGENT_DIR="$PI_ROOT" \
  PI_CODING_AGENT_SESSION_DIR="$INSTALL_ROOT/sessions" \
  PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 \
  FORGEDOCK_CANDIDATE_INSTALL_ROOT="$INSTALL_ROOT" \
  FORGEDOCK_CANDIDATE_BIN="$BIN" \
  pi "${ARGS[@]}" "${EXTRA[@]}"
