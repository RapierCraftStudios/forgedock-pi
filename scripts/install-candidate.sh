#!/usr/bin/env bash
set -euo pipefail

SOURCE_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SUBAGENTS_SOURCE=${PI_SUBAGENTS_SOURCE:-$HOME/.pi/agent/git/github.com/RapierCraftStudios/pi-subagents}
INSTALL_ROOT=${FORGEDOCK_CANDIDATE_INSTALL_ROOT:-}

usage() {
  cat <<'EOF'
Usage: install-candidate.sh [--subagents-source DIR] [--install-root DIR]

Creates an immutable candidate snapshot and installs it with pi-subagents into an
isolated PI_CODING_AGENT_DIR. It never changes the operator's default Pi settings.
EOF
}
while (($#)); do
  case "$1" in
    --subagents-source) SUBAGENTS_SOURCE=${2:?missing path}; shift 2 ;;
    --install-root) INSTALL_ROOT=${2:?missing path}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -n "$(git -C "$SOURCE_ROOT" status --porcelain=v1 --untracked-files=all)" ]]; then
  echo "Candidate source is not clean; commit or remove candidate-local files before snapshotting." >&2
  exit 1
fi
if [[ ! -d "$SUBAGENTS_SOURCE/.git" ]]; then
  echo "Pinned pi-subagents source is not a Git checkout: $SUBAGENTS_SOURCE" >&2
  exit 1
fi

CANDIDATE_SHA=$(git -C "$SOURCE_ROOT" rev-parse HEAD)
SUBAGENTS_SHA=$(git -C "$SUBAGENTS_SOURCE" rev-parse HEAD)
INSTALL_ROOT=${INSTALL_ROOT:-$HOME/.cache/forgedock-pi-candidate/$CANDIDATE_SHA}
INSTALL_ROOT=$(mkdir -p "$INSTALL_ROOT" && cd "$INSTALL_ROOT" && pwd)
PACKAGE_ROOT="$INSTALL_ROOT/package"
SUBAGENTS_ROOT="$INSTALL_ROOT/pi-subagents"
PI_ROOT="$INSTALL_ROOT/pi-agent"

if [[ ! -f "$PACKAGE_ROOT/package.json" ]]; then
  mkdir -p "$PACKAGE_ROOT"
  git -C "$SOURCE_ROOT" archive --format=tar "$CANDIDATE_SHA" | tar -x -C "$PACKAGE_ROOT"
fi
if [[ ! -f "$SUBAGENTS_ROOT/package.json" ]]; then
  mkdir -p "$SUBAGENTS_ROOT"
  git -C "$SUBAGENTS_SOURCE" archive --format=tar "$SUBAGENTS_SHA" | tar -x -C "$SUBAGENTS_ROOT"
fi
mkdir -p "$PI_ROOT" "$INSTALL_ROOT/sessions"

# Local-path package installs are intentionally immutable snapshots, so install
# their production dependencies explicitly rather than borrowing a worktree's
# node_modules directory.
( cd "$SUBAGENTS_ROOT" && npm install --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null )
( cd "$PACKAGE_ROOT" && npm install --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null )

export PI_CODING_AGENT_DIR="$PI_ROOT"
export PI_OFFLINE=1
export PI_SKIP_VERSION_CHECK=1
export PI_TELEMETRY=0

# Install the exact two snapshots into the isolated settings scope. Pi owns the
# package registration and dependency setup; no global settings are consulted.
pi install "$SUBAGENTS_ROOT" --approve >/dev/null
pi install "$PACKAGE_ROOT" --approve >/dev/null

# Keep project settings disabled for this trial while retaining normal AGENTS.md
# coding guidance. Do not copy or rewrite auth/settings files from the operator scope.
node --input-type=module - "$PI_ROOT/settings.json" "$SUBAGENTS_ROOT" "$PACKAGE_ROOT" <<'NODE'
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
const [file, subagentsRoot, packageRoot] = process.argv.slice(2);
const settings = JSON.parse(readFileSync(file, "utf8"));
const sourceOf = (entry) => typeof entry === "string" ? entry : entry && typeof entry.source === "string" ? entry.source : undefined;
const absoluteSource = (source) => source && (source.startsWith("/") ? source : resolve(dirname(file), source));
settings.packages = (Array.isArray(settings.packages) ? settings.packages : []).map((entry) => {
  const source = sourceOf(entry);
  const absolute = absoluteSource(source);
  if (absolute === subagentsRoot) return { source, extensions: ["./index.ts"], skills: [], prompts: [] };
  // Leave the candidate package as a manifest-driven source. Its manifest
  // contains only candidate resource roots, so no broad package filter is needed.
  if (absolute === packageRoot) return entry;
  return entry;
});
settings.defaultProjectTrust = "never";
settings.enableInstallTelemetry = false;
writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
chmodSync(file, 0o600);
NODE

PI_VERSION=$(pi --version)
cat > "$INSTALL_ROOT/manifest.json" <<EOF
{
  "schema": "forgedock.candidate-install/v1",
  "candidateCommit": "$CANDIDATE_SHA",
  "piSubagentsCommit": "$SUBAGENTS_SHA",
  "piVersion": "$PI_VERSION",
  "installRoot": "$INSTALL_ROOT",
  "packageRoot": "$PACKAGE_ROOT",
  "piSubagentsRoot": "$SUBAGENTS_ROOT",
  "piConfigRoot": "$PI_ROOT",
  "sessionRoot": "$INSTALL_ROOT/sessions",
  "targetSettingsPolicy": "--no-approve; target-local project settings are ignored",
  "sourceWorktree": "$SOURCE_ROOT"
}
EOF
chmod 600 "$INSTALL_ROOT/manifest.json"
cat > "$INSTALL_ROOT/launch.sh" <<EOF
#!/usr/bin/env bash
exec "$PACKAGE_ROOT/scripts/launch-candidate.sh" --install-root "$INSTALL_ROOT" "\$@"
EOF
cat > "$INSTALL_ROOT/doctor.sh" <<EOF
#!/usr/bin/env bash
exec node "$PACKAGE_ROOT/bin/forgedock-candidate.mjs" doctor --config-dir "$PI_ROOT" "\$@"
EOF
chmod 700 "$INSTALL_ROOT/launch.sh" "$INSTALL_ROOT/doctor.sh"

printf '%s\n' "Candidate installed without changing the default Pi installation."
printf '%s\n' "Install manifest: $INSTALL_ROOT/manifest.json"
printf '%s\n' "Launch: $INSTALL_ROOT/launch.sh --repo /absolute/target/repository"
printf '%s\n' "Doctor: $INSTALL_ROOT/doctor.sh --cwd /absolute/target/repository"
