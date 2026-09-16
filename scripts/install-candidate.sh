#!/usr/bin/env bash
set -euo pipefail

SOURCE_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SUBAGENTS_SOURCE=${PI_SUBAGENTS_SOURCE:-$HOME/.pi/agent/git/github.com/RapierCraftStudios/pi-subagents}
INSTALL_ROOT=${FORGEDOCK_CANDIDATE_INSTALL_ROOT:-}
REUSE_AUTH=0
AUTH_SOURCE=${PI_AUTH_SOURCE:-$HOME/.pi/agent/auth.json}

usage() {
  cat <<'EOF'
Usage: install-candidate.sh [--subagents-source DIR] [--install-root DIR]

Creates an immutable candidate snapshot and installs it with pi-subagents into an
isolated PI_CODING_AGENT_DIR. It never changes the operator's default Pi settings.

Optional: --reuse-auth creates a symlink to an existing operator auth.json in
the disposable config; it does not copy credentials.
EOF
}
while (($#)); do
  case "$1" in
    --subagents-source) SUBAGENTS_SOURCE=${2:?missing path}; shift 2 ;;
    --install-root) INSTALL_ROOT=${2:?missing path}; shift 2 ;;
    --reuse-auth) REUSE_AUTH=1; shift ;;
    --auth-source) AUTH_SOURCE=${2:?missing path}; REUSE_AUTH=1; shift 2 ;;
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

if [[ -f "$INSTALL_ROOT/manifest.json" ]]; then
  read -r INSTALLED_CANDIDATE_SHA INSTALLED_SUBAGENTS_SHA < <(node --input-type=module - "$INSTALL_ROOT/manifest.json" <<'NODE'
import { readFileSync } from "node:fs";
const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
process.stdout.write(`${manifest.candidateCommit ?? ""} ${manifest.piSubagentsCommit ?? ""}`);
NODE
  )
  if [[ "$INSTALLED_CANDIDATE_SHA" != "$CANDIDATE_SHA" || "$INSTALLED_SUBAGENTS_SHA" != "$SUBAGENTS_SHA" ]]; then
    echo "Install root already contains a different candidate snapshot; choose a new --install-root." >&2
    exit 1
  fi
elif [[ -e "$PACKAGE_ROOT/package.json" || -e "$SUBAGENTS_ROOT/package.json" ]]; then
  echo "Install root is incomplete and has no identity manifest; choose a new --install-root." >&2
  exit 1
fi

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
import { dirname, relative, resolve } from "node:path";
const [file, subagentsRoot, packageRoot] = process.argv.slice(2);
const settings = JSON.parse(readFileSync(file, "utf8"));
const sourceOf = (entry) => typeof entry === "string" ? entry : entry && typeof entry.source === "string" ? entry.source : undefined;
const absoluteSource = (source) => source && (source.startsWith("/") ? source : resolve(dirname(file), source));
const entries = Array.isArray(settings.packages) ? settings.packages : [];
const subagentsEntry = entries.find((entry) => absoluteSource(sourceOf(entry)) === subagentsRoot);
const packageEntry = entries.find((entry) => absoluteSource(sourceOf(entry)) === packageRoot);
const relativeSource = (root) => {
  const value = relative(dirname(file), root);
  return value.startsWith(".") ? value : `./${value}`;
};
settings.packages = [
  { source: sourceOf(subagentsEntry) ?? relativeSource(subagentsRoot), extensions: ["./index.ts"], skills: [], prompts: [] },
  sourceOf(packageEntry) ? sourceOf(packageEntry) : relativeSource(packageRoot),
];
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
  "authPolicy": "$([ "$REUSE_AUTH" -eq 1 ] && echo symlinked-existing-auth || echo no-auth-copied)",
  "sourceWorktree": "$SOURCE_ROOT"
}
EOF
chmod 600 "$INSTALL_ROOT/manifest.json"
if [[ "$REUSE_AUTH" -eq 1 ]]; then
  [[ -f "$AUTH_SOURCE" && ! -L "$AUTH_SOURCE" ]] || { echo "--reuse-auth requires a regular existing auth file: $AUTH_SOURCE" >&2; exit 1; }
  ln -sfn "$AUTH_SOURCE" "$PI_ROOT/auth.json"
fi
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
