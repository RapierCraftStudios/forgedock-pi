#!/usr/bin/env bash
set -euo pipefail

SOURCE=
OUT=
BRANCH=staging
OFFLINE=0
usage() {
  cat <<'EOF'
Usage: prepare-integration-checkout.sh --source REPOSITORY --out DIRECTORY [--branch BRANCH] [--offline]

Creates a disposable clean checkout on the exact origin/BRANCH head without
switching, resetting, or modifying SOURCE. --offline uses an already-fetched
origin/BRANCH ref in SOURCE and is intended for local fixtures.
EOF
}
while (($#)); do
  case "$1" in
    --source|--repo) SOURCE=${2:?missing path}; shift 2 ;;
    --out) OUT=${2:?missing path}; shift 2 ;;
    --branch) BRANCH=${2:?missing branch}; shift 2 ;;
    --offline) OFFLINE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done
[[ -n "$SOURCE" && -n "$OUT" ]] || { usage >&2; exit 2; }
SOURCE=$(cd "$SOURCE" && pwd)
OUT=$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")
[[ ! -e "$OUT" ]] || { echo "Disposable integration checkout already exists: $OUT" >&2; exit 1; }
git -C "$SOURCE" diff --quiet HEAD --
git -C "$SOURCE" diff --cached --quiet
git -C "$SOURCE" status --porcelain=v1 --untracked-files=all | grep -q . && { echo "Source checkout must be clean; refusing to prepare from partial work." >&2; exit 1; } || true

git check-ref-format --branch "$BRANCH" >/dev/null
ORIGIN_URL=$(git -C "$SOURCE" remote get-url origin)
if [[ "$OFFLINE" -eq 0 ]]; then
  git -C "$SOURCE" fetch origin "$BRANCH" --quiet
fi
BASE_SHA=$(git -C "$SOURCE" rev-parse --verify "refs/remotes/origin/$BRANCH^{commit}")
mkdir -p "$(dirname "$OUT")"
git clone --quiet --no-local --no-hardlinks "$SOURCE" "$OUT"
git -C "$OUT" remote set-url origin "$ORIGIN_URL"
if [[ "$OFFLINE" -eq 0 ]]; then
  git -C "$OUT" fetch origin "$BRANCH" --quiet
  BASE_SHA=$(git -C "$OUT" rev-parse --verify "refs/remotes/origin/$BRANCH^{commit}")
else
  git -C "$OUT" update-ref "refs/remotes/origin/$BRANCH" "$BASE_SHA"
fi
git -C "$OUT" checkout --quiet -B "$BRANCH" "$BASE_SHA"
git -C "$OUT" status --porcelain=v1 --untracked-files=all | grep -q . && { echo "Prepared checkout is not clean" >&2; exit 1; } || true
printf '{"schema":"forgedock.candidate-integration-checkout/v1","path":%s,"branch":%s,"baseSha":%s,"origin":%s}\n' \
  "$(printf '%s' "$OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s)))')" \
  "$(printf '%s' "$BRANCH" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s)))')" \
  "$(printf '%s' "$BASE_SHA" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s)))')" \
  "$(printf '%s' "$ORIGIN_URL" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s)))')"
