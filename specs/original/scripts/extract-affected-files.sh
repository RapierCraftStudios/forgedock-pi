#!/usr/bin/env bash
# Extract declared mutation paths for orchestrate DAG construction.
# Output: PROVENANCE=<contract-deliverables|affected-files-section|body-fallback|none|error>
# followed by one repository-relative path per line.
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

NUM=""
REPO=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -R)
      shift
      [[ $# -gt 0 ]] || { echo "Missing value for -R" >&2; exit 2; }
      REPO="$1"
      shift
      ;;
    -R\ *) REPO="${1#-R }"; shift ;;
    -*) echo "Unknown flag: $1" >&2; exit 2 ;;
    *) NUM="$1"; shift ;;
  esac
done

[[ "$NUM" =~ ^[1-9][0-9]*$ ]] || {
  echo "Usage: extract-affected-files.sh <issue_number> -R <owner/repo>" >&2
  exit 2
}
[[ "$REPO" =~ ^[^/]+/[^/]+$ ]] || {
  echo "A valid -R owner/repo is required" >&2
  exit 2
}

if ! ISSUE_JSON=$(gh issue view "$NUM" -R "$REPO" --json body,comments 2>/dev/null); then
  echo "PROVENANCE=error"
  exit 0
fi

section() {
  local headings="$1"
  awk -v headings="$headings" '
    $0 ~ headings { capture=1; next }
    /^#/ { capture=0 }
    capture { print }
  '
}

paths() {
  grep -oE '(([[:alnum:]_.-]+/)*[[:alnum:]_.-]+)(:[0-9]+(-[0-9]+)?)?' 2>/dev/null \
    | sed -E 's/:[0-9]+(-[0-9]+)?$//' \
    | sort -u \
    || true
}

valid_paths() {
  local root path parent
  root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
  while IFS= read -r path; do
    [[ -n "$path" && "$path" != /* && "$path" != *".."* ]] || continue
    [[ "$path" =~ ^[[:alnum:]_.-]+(/[[:alnum:]_.-]+)*$ ]] || continue
    parent=$(dirname "$path")
    # Existing tracked/root files are authoritative. A syntactically valid nested
    # path with a known parent or filename extension may be a declared new file.
    if git -C "$root" ls-files --error-unmatch -- "$path" >/dev/null 2>&1 \
      || [[ -e "$root/$path" ]] \
      || [[ "$path" == */* && ( -d "$root/$parent" || "$(basename "$path")" == *.* ) ]]; then
      printf '%s\n' "$path"
    fi
  done
}

extract_from() {
  local text="$1" headings="$2"
  printf '%s\n' "$text" | section "$headings" | paths | valid_paths
}

CONTRACT=$(printf '%s' "$ISSUE_JSON" | jq -r '[.comments[] | select(.body | contains("FORGE:CONTRACT"))] | last | .body // ""')
INVESTIGATION=$(printf '%s' "$ISSUE_JSON" | jq -r '[.comments[] | select(.body | contains("FORGE:INVESTIGATOR"))] | last | .body // ""')
BODY=$(printf '%s' "$ISSUE_JSON" | jq -r '.body // ""')

FILES=$(extract_from "$CONTRACT" '^### Deliverables([[:space:]]|$)')
if [[ -n "$FILES" ]]; then
  echo "PROVENANCE=contract-deliverables"
  printf '%s\n' "$FILES"
  exit 0
fi

FILES=$(extract_from "$INVESTIGATION" '^### (Mutation Scope|Affected Files)([[:space:]]|$)')
if [[ -n "$FILES" ]]; then
  echo "PROVENANCE=affected-files-section"
  printf '%s\n' "$FILES"
  exit 0
fi

FILES=$(extract_from "$BODY" '^## (Affected Files|Deliverables)([[:space:]]|$)|^### (Files to change|Mutation Scope)([[:space:]]|$)')
if [[ -n "$FILES" ]]; then
  echo "PROVENANCE=body-fallback"
  printf '%s\n' "$FILES"
  exit 0
fi

echo "PROVENANCE=none"
