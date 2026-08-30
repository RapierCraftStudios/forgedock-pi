#!/usr/bin/env bash
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/../.." && pwd)/specs/original/scripts/classify-lane.sh"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
mkdir -p "$ROOT/bin" "$ROOT/seed"
git init --bare "$ROOT/origin.git" >/dev/null
git init -b main "$ROOT/seed" >/dev/null
git -C "$ROOT/seed" config user.name Test
git -C "$ROOT/seed" config user.email test@example.invalid
printf 'base\n' >"$ROOT/seed/file"
git -C "$ROOT/seed" add file
git -C "$ROOT/seed" commit -m base >/dev/null
BASE=$(git -C "$ROOT/seed" rev-parse HEAD)
git -C "$ROOT/seed" remote add origin "$ROOT/origin.git"
git -C "$ROOT/seed" push origin main >/dev/null
git clone -q "$ROOT/origin.git" "$ROOT/clone"
git -C "$ROOT/clone" fetch origin main:refs/remotes/origin/main >/dev/null
BRANCH="work-order/wo-demo-demo"
git -C "$ROOT/clone" push origin "$BASE:refs/heads/$BRANCH" >/dev/null
cat >"$ROOT/binding.json" <<JSON
{"kind":"work-order","stableId":"wo-demo","slug":"demo","branch":"$BRANCH","repository":"owner/repo","frozenBase":{"branch":"main","sha":"$BASE"}}
JSON
cat >"$ROOT/bin/gh" <<'GH'
#!/usr/bin/env bash
printf '%s\n' '{"milestone":null,"labels":[]}'
GH
chmod +x "$ROOT/bin/gh"
OUTPUT=$(cd "$ROOT/clone" && PATH="$ROOT/bin:$PATH" "$SCRIPT" 1 -R owner/repo --work-order demo --work-order-binding "$ROOT/binding.json" --json)
printf '%s' "$OUTPUT" | jq -e '.source == "work-order" and .branch == "work-order/wo-demo-demo"' >/dev/null
if (cd "$ROOT/clone" && PATH="$ROOT/bin:$PATH" "$SCRIPT" 1 -R owner/repo --work-order demo --json >/dev/null 2>&1); then
  echo "expected missing binding to fail" >&2
  exit 1
fi
printf 'classify-lane work-order tests passed\n'
