#!/usr/bin/env bash
# Codified staging→main promotion for ForgeDock (self-service, no operator
# improvisation): reconcile main into an unprotected promote branch, open the
# PR, let CI run on the branch head, then squash-merge.
set -euo pipefail

BRANCH="promote/staging-$(date -u +%Y%m%dT%H%M%S)"
PR_BODY="Promotion of staging to protected main. CI runs on this branch head; reviews/approvals per branch protection."

git fetch origin staging main --quiet
git checkout -q -b "$BRANCH" origin/staging
if ! git merge origin/main -m 'merge: reconcile protected main history for promotion'; then
  echo "Merge conflicts reconciling main into staging — resolve them before re-running this script." >&2
  exit 1
fi
git push -q -u origin "$BRANCH"
PR_URL=$(gh pr create --base main --head "$BRANCH" --title "promote: staging to main" --body "$PR_BODY")
echo "PR: $PR_URL"
echo "Required: check (22), check (24) green on this branch head + 1 approval (ForgeDock App policy), then: gh pr merge --squash"
