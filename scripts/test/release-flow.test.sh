#!/usr/bin/env bash
#
# release-flow.test.sh — drive scripts/release.sh end to end in a sandbox and
# kill it at each stage, to prove a rerun resumes instead of redoing or
# refusing work.
#
# Real: git, a bare "origin", SSH signing with a throwaway key, bump-version.sh.
# Faked: gh (state in files, squash-merges into the bare origin), npm (with a
# sandbox global root), launchctl and plutil (never the real daemon), curl,
# bun, and the secret gate (it packs the real packages; here it only records
# that it ran). The signer can be told to miss taps.
#
#   bash scripts/test/release-flow.test.sh
#
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
V=1.1.0
pass=0; fail=0
ok()  { echo "  ✓ $*"; pass=$((pass + 1)); }
bad() { echo "  ✗ $*"; fail=$((fail + 1)); }
check() { local what="$1"; shift; if "$@"; then ok "$what"; else bad "$what"; fi; }

# ── fakes ────────────────────────────────────────────────────────────────────
BIN="$TMP/bin"; mkdir -p "$BIN"
cat > "$BIN/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
S="$GH_STATE"; mkdir -p "$S/pr" "$S/release"
echo "gh $*" >> "$S/log"
sub="$1 $2"; shift 2
key() { echo "${1//\//_}"; }
opt() { local want="$1"; shift; while [[ $# -gt 0 ]]; do [[ "$1" == "$want" ]] && { echo "$2"; return; }; shift; done; }
has_flag() { local want="$1"; shift; for a in "$@"; do [[ "$a" == "$want" ]] && return 0; done; return 1; }
case "$sub" in
  "pr view")
    f="$S/pr/$(key "$1")"; [[ -f "$f" ]] || exit 1
    read -r num state < "$f"
    case "$(opt --json "$@")" in
      number) echo "$num" ;;
      state) echo "$state" ;;
      # The appcast vetting query. A scenario overrides it with "$f.meta".
      *files*)
        if [[ -f "$f.meta" ]]; then cat "$f.meta"; else
          printf '{"author":{"is_bot":true,"login":"app/github-actions"},"baseRefName":"main","files":[{"path":"packages/macos-bar/appcast.xml"}],"headRefName":"%s","headRefOid":"%s","headRepository":{"nameWithOwner":"sriinnu/tokmeter"},"isCrossRepository":false}\n' "$1" "$APPCAST_HEAD"
        fi ;;
    esac ;;
  "pr create")
    n=$(( $(find "$S/pr" -type f | wc -l) + 100 ))
    echo "$n OPEN" > "$S/pr/$(key "$(opt --head "$@")")"; echo "https://example.test/pull/$n" ;;
  "pr checks")
    [[ -f "$S/pr/$(key "$1")" ]] || { echo "no pull requests found"; exit 1; }
    if [[ -f "$S/checks_fail" ]]; then printf 'build\tfail\t1s\tu\n'; exit 1; fi
    # An optional external check (a Cloudflare Pages preview) failing: gh shows
    # it, and exits 1, unless the caller asked for --required checks only.
    if [[ -f "$S/optional_fail" ]] && ! has_flag --required "$@"; then
      printf 'Cloudflare Pages\tfail\t0\tu\nbuild\tpass\t1s\tu\n'; exit 1
    fi
    printf 'build\tpass\t1s\tu\n' ;;
  "pr diff") printf 'diff --git a/packages/macos-bar/appcast.xml b/packages/macos-bar/appcast.xml\n' ;;
  "pr merge")
    br="$1"
    if [[ "$br" == release/appcast-* ]]; then  # opened by CI, not in the sandbox origin
      read -r num _ < "$S/pr/$(key "$br")"; echo "$num MERGED" > "$S/pr/$(key "$br")"; exit 0
    fi
    w="$(mktemp -d)"
    git clone -q "$ORIGIN" "$w"
    git -C "$w" merge -q --squash "origin/$br" >/dev/null
    git -C "$w" -c commit.gpgsign=false commit -q -m "$(opt --subject "$@")"
    git -C "$w" push -q origin main; rm -rf "$w"
    read -r num _ < "$S/pr/$(key "$br")"; echo "$num MERGED" > "$S/pr/$(key "$br")" ;;
  "pr close"|"pr reopen") ;;
  "release view")
    [[ -f "$S/release/$1" ]] || exit 1
    [[ "$*" == *assets* ]] && cat "$S/release/$1"; true ;;
  "release create") echo "TokmeterBar-${1#v}.zip" > "$S/release/$1" ;;
  *) echo "fake gh: unhandled: $sub $*" >&2; exit 2 ;;
esac
EOF
# npm: the registry serves every version; the global root is a sandbox dir.
cat > "$BIN/npm" <<'EOF'
#!/usr/bin/env bash
echo "npm $*" >> "$GH_STATE/log"
case "$1" in
  view) echo "${2##*@}" ;;
  root) echo "$NPM_ROOT" ;;
  i|install)
    [[ -f "$GH_STATE/npm_install_fail" ]] && { echo "npm ERR! code E500" >&2; exit 1; }
    shift; for spec in "$@"; do
      [[ "$spec" == -* ]] && continue
      mkdir -p "$NPM_ROOT/${spec%@*}"
      echo "{ \"name\": \"${spec%@*}\", \"version\": \"${spec##*@}\" }" > "$NPM_ROOT/${spec%@*}/package.json"
    done ;;
esac
EOF
# launchctl: never the real one. The daemon job is loaded when a file says so.
cat > "$BIN/launchctl" <<'EOF'
#!/usr/bin/env bash
echo "launchctl $*" >> "$GH_STATE/log"
case "$1" in
  print) [[ -f "$GH_STATE/daemon_loaded" ]] || { echo "Could not find service" >&2; exit 113; } ;;
  kickstart) [[ -f "$GH_STATE/daemon_loaded" ]] || exit 113 ;;
esac
EOF
# plutil: the LaunchAgent's script path, from a file (CI's Linux has no plutil).
cat > "$BIN/plutil" <<'EOF'
#!/usr/bin/env bash
cat "$GH_STATE/daemon_program"
EOF
cat > "$BIN/curl" <<'EOF'
#!/usr/bin/env bash
url="${*: -1}"
if [[ "$url" == *appcast.xml && -f "$GH_STATE/appcast_pending" ]]; then
  echo "<sparkle:shortVersionString>0.0.0</sparkle:shortVersionString>"  # not merged yet
elif [[ "$url" == *registry* ]]; then
  echo "{\"servers\":[{\"server\":{\"name\":\"io.github.sriinnu/tokmeter\",\"version\":\"$FAKE_VERSION\"}}]}"
else
  echo "<sparkle:shortVersionString>$FAKE_VERSION</sparkle:shortVersionString>"
fi
EOF
cat > "$BIN/bun" <<'EOF'
#!/usr/bin/env bash
echo "bun $*" >> "$GH_STATE/log"
EOF
# Signer: misses $SIGN_FAILS taps (counted down in a file), then signs.
cat > "$BIN/signer" <<'EOF'
#!/usr/bin/env bash
c="$(cat "$SIGN_FAILS_FILE" 2>/dev/null || echo 0)"
if (( c > 0 )); then
  echo $((c - 1)) > "$SIGN_FAILS_FILE"
  echo "Couldn't sign message: incorrect passphrase supplied to decrypt private key?" >&2
  exit 255
fi
exec ssh-keygen "$@"
EOF
chmod +x "$BIN"/*

ssh-keygen -q -t ed25519 -N "" -C test -f "$TMP/key"
echo "test@example.test $(cat "$TMP/key.pub")" > "$TMP/allowed_signers"
cat > "$TMP/gitconfig" <<EOF
[user]
	name = Test
	email = test@example.test
	signingkey = $TMP/key.pub
[gpg]
	format = ssh
[gpg "ssh"]
	program = $BIN/signer
	allowedSignersFile = $TMP/allowed_signers
[init]
	defaultBranch = main
EOF

# ── a fresh sandbox repo per scenario ────────────────────────────────────────
sandbox() {
  local d="$TMP/$1"; rm -rf "$d"; mkdir -p "$d"
  export GH_STATE="$d/gh" ORIGIN="$d/origin.git" SIGN_FAILS_FILE="$d/sign_fails" FAKE_VERSION="$V"
  export APPCAST_HEAD=0123456789abcdef0123456789abcdef01234567
  export HOME="$d" GIT_CONFIG_GLOBAL="$TMP/gitconfig" GIT_CONFIG_NOSYSTEM=1 PATH="$BIN:$PATH"
  export NPM_ROOT="$d/npm-global/lib/node_modules"
  mkdir -p "$GH_STATE" "$NPM_ROOT"
  git init -q --bare "$ORIGIN"
  R="$d/repo"; mkdir -p "$R"/scripts/lib "$R"/packages/{tokmeter,mcp,macos-bar}
  cp "$SRC/scripts/release.sh" "$SRC/scripts/bump-version.sh" "$R/scripts/"
  cp "$SRC/scripts/lib/signing.sh" "$R/scripts/lib/"
  # shellcheck disable=SC2016  # the $ belongs in the written files, unexpanded
  printf '#!/usr/bin/env bash\necho gate >> "$GH_STATE/log"\n' > "$R/scripts/check-no-secrets.sh"
  echo '{ "name": "@sriinnu/tokmeter", "version": "1.0.0" }' > "$R/packages/tokmeter/package.json"
  echo '{ "name": "@sriinnu/tokmeter-mcp", "version": "1.0.0" }' > "$R/packages/mcp/package.json"
  echo '{ "version": "1.0.0", "packages": [{ "version": "1.0.0" }] }' > "$R/packages/mcp/server.json"
  # shellcheck disable=SC2016
  printf 'SHORT_VERSION="${CFBundleShortVersionString:-1.0.0}"\nBUILD_VERSION="${CFBundleVersion:-7}"\n' > "$R/packages/macos-bar/bundle.sh"
  echo '![release](https://img.shields.io/badge/release-v1.0.0-blue)' > "$R/README.md"
  printf '# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- A fix.\n\n## [1.0.0] - 2026-01-01\n\n- First.\n' > "$R/CHANGELOG.md"
  # Older history well past the 64 KB pipe buffer, so stage 8's notes
  # extraction runs against a CHANGELOG as large as the real one (88 KB at
  # 1.19.4, when an early awk exit made git show die of SIGPIPE).
  for i in $(seq 1 1500); do printf '\n## [0.0.%d] - 2025-01-01\n\n- Older entry %d with enough text to fill the pipe buffer.\n' "$i" "$i"; done >> "$R/CHANGELOG.md"
  git -C "$R" init -q
  git -C "$R" add -A && git -C "$R" -c commit.gpgsign=false commit -q -m init
  git -C "$R" remote add origin "$ORIGIN" && git -C "$R" push -q -u origin main
  git -C "$R" switch -q -c "release/v$V"
}
release() { (cd "$R" && bash scripts/release.sh "$V" --yes --skip-brew "$@" </dev/null) > "$GH_STATE/out" 2>&1; }
main_subject() { git -C "$R" fetch -q origin && git -C "$R" log -1 --format=%s origin/main; }
count() { grep -c -- "$1" "$GH_STATE/log" || true; }
released() { [[ -f "$GH_STATE/release/v$V" ]]; }
tag_ok() {
  git -C "$R" fetch -q --tags origin
  [[ "$(git -C "$R" rev-parse "v$V^{commit}")" == "$(git -C "$R" rev-parse origin/main)" ]] \
    && git -C "$R" verify-tag "v$V" >/dev/null 2>&1
}
show_out() { sed 's/^/      | /' "$GH_STATE/out"; }

echo "release-flow tests"

echo "• every helper is defined at top level"
# A function defined inside a stage's block exists only when that stage runs,
# so a resumed run that skips the stage calls "command not found" (1.18.0: the
# appcast wait timed out three times on checks_started).
check "no function is defined inside a block" \
  test -z "$(grep -nE '^[[:space:]]+[A-Za-z_][A-Za-z0-9_]*\(\)[[:space:]]*\{' "$SRC/scripts/release.sh")"

echo "• clean run"
sandbox clean
if release; then ok "exits 0"; else bad "exits 0"; show_out; fi
check "squash subject is 'chore(release): v$V (#100)'" test "$(main_subject)" = "chore(release): v$V (#100)"
check "signed tag on the release commit" tag_ok
check "GitHub release created" released
check "secret gate ran" test "$(count gate)" = 1
check "bundle build advanced once (7 → 8)" grep -q 'CFBundleVersion:-8' "$R/packages/macos-bar/bundle.sh"

echo "• rerun of a finished release changes nothing"
before="$(count 'gh pr create')$(count 'gh pr merge')$(count 'gh release create')"
if release; then ok "exits 0"; else bad "exits 0"; show_out; fi
check "no new PR, merge or release" test "$(count 'gh pr create')$(count 'gh pr merge')$(count 'gh release create')" = "$before"
check "reports the stages as done" grep -q 'already done: release v' "$GH_STATE/out"

echo "• missed tap on the release commit is retried"
sandbox missed_tap
echo 1 > "$SIGN_FAILS_FILE"
if release; then ok "exits 0"; else bad "exits 0"; show_out; fi
check "says attempt 1/3 failed" grep -q 'attempt 1/3' "$GH_STATE/out"
check "release commit landed" test "$(main_subject)" = "chore(release): v$V (#100)"

echo "• another repo's signature is pending: wait for it, then sign"
sandbox other_signer
# Stands in for a commit elsewhere waiting on the key; gone after 4s.
(exec -a "ssh-keygen -Y sign -n git other-repo" sleep 4) &
sleep 0.5
if release; then ok "exits 0"; else bad "exits 0"; show_out; fi
check "names the waiting signature" grep -q 'another signature is waiting' "$GH_STATE/out"
check "signed tag on the release commit" tag_ok
wait

echo "• three missed taps stop the run; the rerun resumes"
sandbox no_tap
echo 3 > "$SIGN_FAILS_FILE"
if release; then bad "stops"; else ok "stops"; fi
check "nothing pushed" test "$(count 'gh pr create')" = 0
if release; then ok "rerun exits 0"; else bad "rerun exits 0"; show_out; fi
check "rerun reuses the applied bump" grep -q 'already done: bump applied' "$GH_STATE/out"
check "bundle build advanced once, not twice" grep -q 'CFBundleVersion:-8' "$R/packages/macos-bar/bundle.sh"
check "signed tag on the release commit" tag_ok

echo "• died after the commit (not pushed)"
sandbox committed
(cd "$R" && bash scripts/bump-version.sh "$V" >/dev/null && git add -u && git commit -q -S -m "chore(release): v$V")
if release; then ok "exits 0"; else bad "exits 0"; show_out; fi
check "skips the commit" grep -q "already done: .* chore(release): v$V" "$GH_STATE/out"
check "release commit landed" test "$(main_subject)" = "chore(release): v$V (#100)"

echo "• CI fails; the rerun reuses the open PR"
sandbox ci_fail
touch "$GH_STATE/checks_fail"
if release; then bad "stops on red CI"; else ok "stops on red CI"; fi
rm "$GH_STATE/checks_fail"
if release; then ok "rerun exits 0"; else bad "rerun exits 0"; show_out; fi
check "one PR, not two" test "$(count 'gh pr create')" = 1
check "rerun reports the open PR" grep -q 'already done: PR #100 is open' "$GH_STATE/out"
check "GitHub release created" released

echo "• an optional check fails (not required by main): the release still merges"
sandbox optional_fail
touch "$GH_STATE/optional_fail"
if release; then ok "exits 0"; else bad "exits 0"; show_out; fi
rm "$GH_STATE/optional_fail"
check "release commit landed" test "$(main_subject)" = "chore(release): v$V (#100)"
check "GitHub release created" released

echo "• --no-publish, then publish later from main"
sandbox later
if release --no-publish; then ok "first run exits 0"; else bad "first run exits 0"; show_out; fi
check "tagged, not released" bash -c "! test -f '$GH_STATE/release/v$V'"
git -C "$R" switch -q main 2>/dev/null || true
if release; then ok "second run exits 0"; else bad "second run exits 0"; show_out; fi
check "release created" released
check "no second merge" test "$(count 'gh pr merge')" = 1

# The workflow opened release/appcast-vX; the feed on main doesn't list X yet.
appcast_pending() {  # appcast_pending [meta-json] — seed the CI-opened PR
  touch "$GH_STATE/appcast_pending"; mkdir -p "$GH_STATE/pr"
  echo "200 OPEN" > "$GH_STATE/pr/release_appcast-v$V"
  [[ -z "${1:-}" ]] || echo "$1" > "$GH_STATE/pr/release_appcast-v$V.meta"
}
appcast_merged() { grep -q "gh pr merge release/appcast-v$V" "$GH_STATE/log"; }
pr_meta() {  # pr_meta <author login> <files JSON> <head repo> <isCrossRepository>
  printf '{"author":{"login":"%s"},"baseRefName":"main","files":%s,"headRefName":"release/appcast-v%s","headRefOid":"%s","headRepository":{"nameWithOwner":"%s"},"isCrossRepository":%s}' \
    "$1" "$2" "$V" "$APPCAST_HEAD" "$3" "$4"
}
APPCAST_ONLY='[{"path":"packages/macos-bar/appcast.xml"}]'

echo "• the workflow's appcast PR is vetted, shown, and merged pinned to its head"
sandbox appcast_ok
appcast_pending
if release; then ok "exits 0"; else bad "exits 0"; show_out; fi
check "shows the diff before merging" grep -q "gh pr diff release/appcast-v$V" "$GH_STATE/log"
check "merge is pinned to the vetted head" \
  grep -q "gh pr merge release/appcast-v$V .*--match-head-commit $APPCAST_HEAD" "$GH_STATE/log"

echo "• a fork's same-named appcast PR is refused"
sandbox appcast_fork
appcast_pending "$(pr_meta app/github-actions "$APPCAST_ONLY" mallory/tokmeter true)"
if release; then bad "refuses"; else ok "refuses"; fi
if appcast_merged; then bad "does not merge it"; else ok "does not merge it"; fi
check "names the head repo" grep -q 'head repo is mallory/tokmeter' "$GH_STATE/out"

echo "• an appcast PR by someone other than the Actions bot is refused"
sandbox appcast_author
appcast_pending "$(pr_meta mallory "$APPCAST_ONLY" sriinnu/tokmeter false)"
if release; then bad "refuses"; else ok "refuses"; fi
if appcast_merged; then bad "does not merge it"; else ok "does not merge it"; fi
check "names the author" grep -q 'author is mallory' "$GH_STATE/out"

echo "• an appcast PR that touches anything besides appcast.xml is refused"
sandbox appcast_files
appcast_pending "$(pr_meta app/github-actions '[{"path":"packages/macos-bar/appcast.xml"},{"path":"scripts/release.sh"}]' sriinnu/tokmeter false)"
if release; then bad "refuses"; else ok "refuses"; fi
if appcast_merged; then bad "does not merge it"; else ok "does not merge it"; fi
check "names the extra file" grep -q 'scripts/release.sh, not only' "$GH_STATE/out"
rm "$GH_STATE/pr/release_appcast-v$V.meta"
if release; then ok "rerun once the PR is clean exits 0"; else bad "rerun once the PR is clean exits 0"; show_out; fi
check "…and merges it pinned to the vetted head" \
  grep -q "gh pr merge release/appcast-v$V .*--match-head-commit $APPCAST_HEAD" "$GH_STATE/log"

# Stage 12: this machine's own global install and launchd daemon.
global_install() {  # global_install <version> — seed both packages in the sandbox root
  local p; for p in tokmeter tokmeter-mcp; do
    mkdir -p "$NPM_ROOT/@sriinnu/$p"
    echo "{ \"name\": \"@sriinnu/$p\", \"version\": \"$1\" }" > "$NPM_ROOT/@sriinnu/$p/package.json"
  done
}
global_is() {  # global_is <version> — both packages installed at it
  grep -q "\"version\": \"$1\"" "$NPM_ROOT/@sriinnu/tokmeter/package.json" \
    && grep -q "\"version\": \"$1\"" "$NPM_ROOT/@sriinnu/tokmeter-mcp/package.json"
}
KICK="launchctl kickstart -k gui/$(id -u)/com.tokmeter.daemon"

echo "• this machine is already on the version: no install, no restart"
sandbox local_current
global_install "$V"; touch "$GH_STATE/daemon_loaded"
if release; then ok "exits 0"; else bad "exits 0"; show_out; fi
check "reports the install as done" grep -q "already done: global install is at $V" "$GH_STATE/out"
check "no npm install" test "$(count 'npm i ')" = 0
check "no daemon restart" test "$(count 'launchctl kickstart')" = 0

echo "• this machine is behind and the daemon is loaded: upgrade, then kickstart"
sandbox local_upgrade
global_install 1.0.0; touch "$GH_STATE/daemon_loaded"
if release; then ok "exits 0"; else bad "exits 0"; show_out; fi
check "installs both packages at the exact version" \
  grep -qx "npm i -g @sriinnu/tokmeter@$V @sriinnu/tokmeter-mcp@$V" "$GH_STATE/log"
check "global install is now $V" global_is "$V"
check "kickstarts the daemon once" test "$(count "$KICK")" = 1
check "kickstart comes after the install" \
  test "$(grep -n 'npm i -g' "$GH_STATE/log" | cut -d: -f1)" -lt "$(grep -n 'launchctl kickstart' "$GH_STATE/log" | cut -d: -f1)"
if release; then ok "rerun exits 0"; else bad "rerun exits 0"; show_out; fi
check "rerun neither reinstalls nor restarts" test "$(count 'npm i ')$(count 'launchctl kickstart')" = 11

echo "• this machine is behind and the daemon isn't loaded: says how to restart it"
sandbox local_unloaded
global_install 1.0.0
if release; then ok "exits 0"; else bad "exits 0"; show_out; fi
check "global install is now $V" global_is "$V"
check "no kickstart" test "$(count 'launchctl kickstart')" = 0
check "prints the manual restart" grep -q 'tokmeter-mcp daemon restart' "$GH_STATE/out"
check "names the unloaded job" grep -q 'com.tokmeter.daemon is not loaded' "$GH_STATE/out"

echo "• the install fails: the release still succeeds, with a loud manual step"
sandbox local_install_fail
global_install 1.0.0; touch "$GH_STATE/daemon_loaded" "$GH_STATE/npm_install_fail"
if release; then ok "exits 0"; else bad "exits 0"; show_out; fi
check "warns that this machine is behind" grep -q "THIS MACHINE IS NOT ON $V" "$GH_STATE/out"
check "prints the npm command" grep -q "npm i -g @sriinnu/tokmeter@$V @sriinnu/tokmeter-mcp@$V" "$GH_STATE/out"
check "no kickstart onto the old version" test "$(count 'launchctl kickstart')" = 0
check "still reports the release complete" grep -q "Release v$V complete" "$GH_STATE/out"

echo "• the daemon runs from a different install than this npm: warns, no kickstart"
sandbox local_other_prefix
global_install 1.0.0; touch "$GH_STATE/daemon_loaded"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/other/bin"
touch "$HOME/Library/LaunchAgents/com.tokmeter.daemon.plist" "$HOME/other/bin/tokmeter-mcp"
echo "$HOME/other/bin/tokmeter-mcp" > "$GH_STATE/daemon_program"
if release; then ok "exits 0"; else bad "exits 0"; show_out; fi
check "names the daemon's install" grep -q "the daemon runs .*other/bin/tokmeter-mcp" "$GH_STATE/out"
check "no kickstart" test "$(count 'launchctl kickstart')" = 0

echo "• --skip-local-upgrade leaves this machine alone"
sandbox local_skip
global_install 1.0.0; touch "$GH_STATE/daemon_loaded"
if release --skip-local-upgrade; then ok "exits 0"; else bad "exits 0"; show_out; fi
check "no npm install" test "$(count 'npm i ')" = 0
check "no daemon restart" test "$(count 'launchctl kickstart')" = 0
check "says it skipped" grep -q 'skipped (--skip-local-upgrade)' "$GH_STATE/out"

echo "• a non-bump change in the tree is refused"
sandbox dirty
echo "stray" >> "$R/README.md"; echo "x" > "$R/stray.txt"
if release; then bad "refuses"; else ok "refuses"; fi
check "says why" grep -q 'working tree not clean' "$GH_STATE/out"

echo
echo "release-flow: ${pass} passed, ${fail} failed"
(( fail == 0 ))
