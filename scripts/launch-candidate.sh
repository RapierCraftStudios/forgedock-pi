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

if [[ -z "$MODEL" ]]; then
  MODEL=$(node "$BIN" config --cwd "$REPO" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);process.stdout.write(v.ownerModel);})')
fi
[[ "$MODEL" =~ ^[^[:space:]/]+/[^[:space:]]+$ ]] || { echo "Target forge.yaml did not provide a full provider/model ID" >&2; exit 1; }

ARGS=(--offline --no-approve --session-dir "$INSTALL_ROOT/sessions" --model "$MODEL")
if [[ -n "$THINKING" ]]; then ARGS+=(--thinking "$THINKING"); fi
if [[ -n "$NAME" ]]; then ARGS+=(--name "$NAME"); else ARGS+=(--name "ForgeDock candidate: $(basename "$REPO")"); fi

cd "$REPO"
exec env \
  PI_CODING_AGENT_DIR="$PI_ROOT" \
  PI_CODING_AGENT_SESSION_DIR="$INSTALL_ROOT/sessions" \
  PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 \
  FORGEDOCK_CANDIDATE_INSTALL_ROOT="$INSTALL_ROOT" \
  FORGEDOCK_CANDIDATE_BIN="$BIN" \
  pi "${ARGS[@]}" "${EXTRA[@]}"
