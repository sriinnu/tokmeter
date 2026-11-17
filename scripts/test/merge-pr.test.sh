#!/usr/bin/env bash
#
# merge-pr.test.sh — drive scripts/merge-pr.sh against a fake gh and check the
# merge it asks for: explicit subject, trailer-free non-empty body, pinned
# head, main only, remote branch deleted only after a confirmed merge.
#
#   bash scripts/test/merge-pr.test.sh                    # the real script
#   MERGE_PR=<path> bash scripts/test/merge-pr.test.sh    # another (to see it fail)
#
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="${MERGE_PR:-$SRC/scripts/merge-pr.sh}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
ok()  { echo "  ✓ $*"; pass=$((pass + 1)); }
bad() { echo "  ✗ $*"; fail=$((fail + 1)); }
check() { local what="$1"; shift; if "$@"; then ok "$what"; else bad "$what"; fi; }

# ── fake gh: `pr view` from files, `pr merge` records argv and flips the state
# to MERGED (unless merge_noop), `api` records its call (fails if api_fail) ──
BIN="$TMP/bin"; mkdir -p "$BIN"
cat > "$BIN/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
S="$GH_STATE"
if [[ "$1 $2" == "pr view" ]]; then
  field=""; while [[ $# -gt 0 ]]; do [[ "$1" == "--json" ]] && field="$2"; shift; done
  cat "$S/$field"; exit 0
fi
if [[ "$1 $2" == "pr merge" ]]; then
  : > "$S/merge.args"; for a in "$@"; do printf '%s\0' "$a" >> "$S/merge.args"; done
  [[ -f "$S/merge_noop" ]] || printf MERGED > "$S/state"
  exit 0
fi
if [[ "$1" == "api" ]]; then
  echo "$*" >> "$S/api.log"
  [[ -f "$S/api_fail" ]] && exit 1
  exit 0
fi
echo "fake gh: unexpected: $*" >&2; exit 1
EOF
chmod +x "$BIN/gh"

# Value of option $1 in the recorded merge argv.
arg() {
  local want="$1" prev="" a
  while IFS= read -r -d '' a; do
    [[ "$prev" == "$want" ]] && { printf '%s' "$a"; return 0; }
    prev="$a"
  done < "$GH_STATE/merge.args"
  return 1
}
has() { tr '\0' '\n' < "$GH_STATE/merge.args" | grep -qx -- "$1"; }
run() { PATH="$BIN:$PATH" bash "$SCRIPT" "$@" > "$GH_STATE/out" 2>&1; }

setup() {
  export GH_STATE="$TMP/state-$1"; mkdir -p "$GH_STATE"
  printf '%s' "${2:-OPEN}" > "$GH_STATE/state"
  printf '%s' "${3:-main}" > "$GH_STATE/baseRefName"
  printf '%s' "fix(codex): count fork work once" > "$GH_STATE/title"
  printf '%s' "0123456789abcdef0123456789abcdef01234567" > "$GH_STATE/headRefOid"
  printf '%s' "fix/codex-fork" > "$GH_STATE/headRefName"
  printf '%s' "false" > "$GH_STATE/isCrossRepository"
  printf '%s' "Why: the fork's own turns were dropped.

Evidence: oracle f1.

Co-authored-by: Sriinnu <sriinnu@users.noreply.github.com>
  co-authored-BY: Someone <x@example.test>
" > "$GH_STATE/body"
}

echo "merge an open PR"
setup open
run 42 || bad "script exited non-zero: $(cat "$GH_STATE/out")"
if [[ -f "$GH_STATE/merge.args" ]]; then
  check "squash" has --squash
  check "no --delete-branch (it fails on a branch held by a worktree)" bash -c '! tr "\0" "\n" < "$1" | grep -qx -- --delete-branch' _ "$GH_STATE/merge.args"
  check "subject is title + (#42)" [ "$(arg --subject)" = "fix(codex): count fork work once (#42)" ]
  check "head pinned" [ "$(arg --match-head-commit)" = "0123456789abcdef0123456789abcdef01234567" ]
  body="$(arg --body || true)"
  check "body keeps the description" grep -q "Evidence: oracle f1." <<< "$body"
  check "no Co-authored-by line, any case" bash -c '! grep -qi "co-authored-by" <<< "$1"' _ "$body"
  check "remote branch deleted after the merge" grep -q "api -X DELETE repos/{owner}/{repo}/git/refs/heads/fix/codex-fork" "$GH_STATE/api.log"
else
  bad "no merge was requested"
fi

echo "a body that is only trailers"
setup trailers
printf '%s' "Co-authored-by: Sriinnu <sriinnu@users.noreply.github.com>" > "$GH_STATE/body"
run 5 || true
check "body is never empty" [ "$(arg --body 2>/dev/null)" = "See #5." ]

echo "an empty body"
setup empty
printf '' > "$GH_STATE/body"
run 6 || true
check "body is never empty" [ "$(arg --body 2>/dev/null)" = "See #6." ]

echo "subject already carries the number"
setup numbered
printf '%s' "fix: thing (#7)" > "$GH_STATE/title"
run 7 || true
check "number not doubled" [ "$(arg --subject 2>/dev/null)" = "fix: thing (#7)" ]

echo "branch delete fails after a real merge"
setup apifail
touch "$GH_STATE/api_fail"
if run 8; then ok "still exits 0: the merge landed"; else bad "exited non-zero after the merge landed"; fi
check "says so" grep -q "could not delete remote branch" "$GH_STATE/out"

echo "merge call returns but the PR isn't merged"
setup noop
touch "$GH_STATE/merge_noop"
if run 10; then bad "reported success on an unmerged PR"; else ok "exits non-zero"; fi
check "no branch deleted" [ ! -f "$GH_STATE/api.log" ]

echo "refuses a PR that isn't open"
setup closed MERGED
if run 9; then bad "exited 0 on a merged PR"; else ok "exits non-zero"; fi
check "no merge requested" [ ! -f "$GH_STATE/merge.args" ]

echo "refuses a PR into another base"
setup base OPEN release/next
if run 11; then bad "merged into release/next"; else ok "exits non-zero"; fi
check "no merge requested" [ ! -f "$GH_STATE/merge.args" ]

echo "refuses a bad argument"
setup badarg
if run "12; rm -rf x"; then bad "accepted a non-number"; else ok "rejects a non-number"; fi
check "no merge requested" [ ! -f "$GH_STATE/merge.args" ]

echo
echo "merge-pr: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
