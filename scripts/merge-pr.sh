#!/usr/bin/env bash
#
# merge-pr.sh — squash-merge a feature PR with a message we wrote, not GitHub's.
#
#   bun run merge <PR number>
#
# GitHub's default squash message (squash_merge_commit_message=COMMIT_MESSAGES)
# appends a `Co-authored-by:` trailer for every commit author whose email
# differs from the merger's (our branch commits appear to carry the plain noreply
# address, the merge the numbered one), so a511497, c11e030 and others landed
# on main with `Co-authored-by: Sriinnu`. The repo rule is no trailers, so this
# sends the subject and body explicitly:
#
#   subject  "<PR title> (#N)"
#   body     the PR description, minus any Co-authored-by lines
#            ("See #N." when nothing is left: an empty body may let GitHub
#            fall back to its default message, trailers included)
#
# --match-head-commit pins the merge to the head we read, so a push that lands
# between the read and the merge is refused rather than merged unread.
#
# No --delete-branch: gh also deletes the local branch, which fails when that
# branch is checked out in a worktree, and then exits non-zero after the merge
# has already landed. The remote branch is deleted here once the PR reads
# MERGED; failing to delete it is only a warning.
#
set -euo pipefail

n="${1:-}"
if [[ ! "$n" =~ ^[0-9]+$ ]]; then
  echo "usage: bun run merge <PR number>" >&2
  exit 2
fi
repo=()
if [[ -n "${TOKMETER_REPO:-}" ]]; then
  repo=(--repo "$TOKMETER_REPO")
  export GH_REPO="$TOKMETER_REPO" # resolves `gh api`'s {owner}/{repo}
fi
view() { gh pr view "$n" ${repo[@]+"${repo[@]}"} --json "$1" -q ".$1"; }

state="$(view state)"
if [[ "$state" != "OPEN" ]]; then
  echo "PR #$n is $state, not OPEN; nothing merged." >&2
  exit 1
fi
base="$(view baseRefName)"
if [[ "$base" != "main" ]]; then
  echo "PR #$n targets '$base', not main; nothing merged." >&2
  exit 1
fi
title="$(view title)"
head="$(view headRefOid)"
branch="$(view headRefName)"
cross="$(view isCrossRepository)"
body="$(view body)"

if [[ -z "$title" || -z "$head" ]]; then
  echo "PR #$n: could not read its title or head commit; nothing merged." >&2
  exit 1
fi

subject="$title"
[[ "$subject" == *"(#$n)" ]] || subject="$subject (#$n)"
# Drop trailer lines (any case, any indent); $(...) trims trailing newlines.
clean="$(printf '%s\n' "$body" | grep -viE '^[[:space:]]*co-authored-by:' || true)"
[[ "$clean" =~ [^[:space:]] ]] || clean="See #$n."

echo "Merging #$n at ${head:0:12}: $subject"
gh pr merge "$n" ${repo[@]+"${repo[@]}"} --squash \
  --match-head-commit "$head" --subject "$subject" --body "$clean"

after="$(view state)"
if [[ "$after" != "MERGED" ]]; then
  echo "PR #$n is $after after the merge call, not MERGED." >&2
  exit 1
fi
echo "Merged #$n."
if [[ "$cross" == "true" || -z "$branch" ]]; then
  echo "Head branch is in a fork or unknown; left it alone."
elif gh api -X DELETE "repos/{owner}/{repo}/git/refs/heads/$branch" > /dev/null 2>&1; then
  echo "Deleted remote branch $branch."
else
  echo "warning: merged, but could not delete remote branch $branch; delete it by hand." >&2
fi
