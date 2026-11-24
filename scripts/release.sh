#!/usr/bin/env bash
#
# release.sh <X.Y.Z> [flags]
#
# One-command release. Run from an interactive shell on a release branch cut
# from main, so the hardware-key-signed commit and tag and gh all work.
#
# Publishing is CI's job. Publishing the GitHub release is the trigger:
#   publish.yml        npm (Trusted Publishing) + MCP registry
#   release-macos.yml  build, notarize, upload the bar zip, open the appcast PR
# This script never publishes npm or the bar itself — a second publisher would
# upload a zip that differs byte-for-byte from CI's signed one and break every
# user's auto-update. Homebrew is still local, and must wait for CI's zip.
#
# Stages:
#   1. preflight        — semver, release branch, and where a previous run got to
#   2. bump             — scripts/bump-version.sh
#   3. quality gate     — bun run build && test && lint
#   4. secret gate      — scripts/check-no-secrets.sh   (NON-skippable)
#   5. commit           — signed release commit
#   6. PR + squash      — push, open PR, wait for CI, squash-merge
#   7. tag              — signed tag on the squashed commit ON MAIN, push
#   8. GitHub release   — publishes; CI takes npm, MCP registry and the bar
#   9. wait for CI      — npm versions visible, bar zip attached, MCP registry
#  10. Homebrew cask    — scripts/update-brew-cask.sh    (--skip-brew)
#  11. appcast PR       — trigger its checks, merge it: Sparkle users get the update
#  12. this machine     — upgrade the global npm install to X.Y.Z and restart
#                         its launchd daemon                 (--skip-local-upgrade)
#
# Rerunnable. Every stage first checks whether it already happened — bump
# applied, release commit made, PR open or merged, tag pushed, release
# published, cask current, appcast merged, global install current — and skips
# it if so. When a run dies (a missed key tap, a CI flake, a closed terminal),
# run the same command again from the same branch and it carries on from where
# it stopped. Once the release commit is on main, any branch works.
#
# Flags:
#   --no-publish   stop after stage 7 (merged and tagged; no release, no brew)
#   --skip-brew
#   --skip-local-upgrade
#                  leave this machine's global npm install and daemon alone
#   --dry-run      print where the release is and what would run, change nothing
#   --yes          don't prompt before the irreversible stages
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck source=SCRIPTDIR/lib/signing.sh
source "$ROOT/scripts/lib/signing.sh"

REPO="sriinnu/tokmeter"
notes=""
cleanup() {
  if [[ -n "${notes:-}" ]]; then
    rm -f "$notes"
  fi
}
trap cleanup EXIT
VERSION=""; DRY=0; ASSUME_YES=0; NO_PUBLISH=0; SKIP_BREW=0; SKIP_LOCAL=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    --no-publish) NO_PUBLISH=1 ;;
    --skip-brew) SKIP_BREW=1 ;;
    --skip-local-upgrade) SKIP_LOCAL=1 ;;
    -* ) echo "unknown flag: $arg" >&2; exit 1 ;;
    * ) VERSION="$arg" ;;
  esac
done
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "usage: release.sh X.Y.Z [--no-publish|--skip-brew|--skip-local-upgrade|--dry-run|--yes]" >&2; exit 1; }

TAG="v${VERSION}"
SUBJECT="chore(release): ${TAG}"
say()  { echo; echo "════ $* ════"; }
skip() { echo "  ✓ already done: $*"; }
run()  { if [[ $DRY -eq 1 ]]; then echo "DRY: $*"; else eval "$*"; fi; }
run_signed() {  # run_signed <what> <command string>
  if [[ $DRY -eq 1 ]]; then echo "DRY: (signed) $2"; else signed "$1" eval "$2"; fi
}
die()  { echo "ERROR: $*" >&2; exit 1; }
confirm() {
  [[ $ASSUME_YES -eq 1 || $DRY -eq 1 ]] && return 0
  read -r -p "  $1 [y/N] " a; [[ "$a" == "y" || "$a" == "Y" ]]
}
# Poll until a command succeeds; return 1 after $2 seconds without success.
poll() {
  local desc="$1" limit="$2"; shift 2
  [[ $DRY -eq 1 ]] && { echo "DRY: wait for ${desc}"; return 0; }
  local waited=0
  until "$@" >/dev/null 2>&1; do
    (( waited >= limit )) && return 1
    # Limits count in 15 s steps; the test suite sleeps 0 to run them fast.
    sleep "${RELEASE_POLL_SLEEP:-15}"; waited=$((waited + 15))
  done
  echo "  ✓ ${desc}"
}
# poll, but a timeout ends the release.
wait_for() { poll "$@" || die "timed out after $2s waiting for $1"; }

# ── where a previous run got to ──────────────────────────────────────────────
# The squash commit on main is "chore(release): vX (#N)"; older releases used
# the PR title. Match the subject, never the tip of main: other PRs may have
# merged after the release one.
release_commit_on_main() {
  local v="${VERSION//./\\.}"
  # "|| true": no match is the normal not-yet-released case, and under
  # pipefail grep's exit 1 would end the script silently.
  { git log origin/main -n 200 --format='%H %s' \
    | grep -E "^[0-9a-f]+ (chore\(release\): v${v}|Release v${v})( \(#[0-9]+\))?$" || true; } \
    | head -1 | cut -d' ' -f1
}
version_at() {  # version_at <ref> — the meta-package version in that tree
  git show "$1:packages/tokmeter/package.json" | node -e \
    'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))'
}
# The commit a remote tag points at (peeled), or nothing.
remote_tag_commit() {
  # An annotated tag lists twice: the tag object, and "^{}" for its commit.
  local refs; refs="$(git ls-remote --tags origin "refs/tags/${TAG}*" 2>/dev/null || true)"
  awk -v t="refs/tags/${TAG}" '$2 == t "^{}" { print $1; found = 1; exit }
    $2 == t { plain = $1 } END { if (!found && plain) print plain }' <<<"$refs"
}
pr_field() {  # pr_field <branch> <json field> — empty when there is no PR
  gh pr view "$1" --repo "$REPO" --json "$2" -q ".$2" 2>/dev/null || true
}
pr_open() { [[ "$(pr_field "$1" state)" == "OPEN" ]]; }
# Right after a PR opens CI hasn't registered yet, and `gh pr checks` reports
# "no checks" as a failure, so callers wait for rows to appear before watching.
# Every wait is on the checks main's branch protection REQUIRES (--required):
# an optional external check must not block a release. 1.19.5 died at stage 6
# on a retired Cloudflare Pages project still building from a removed site/.
# Capture the output first: under pipefail, `! gh … | grep -q` inverts gh's own
# non-zero exit and reports "started" before any check exists (1.13.0).
# Top level, not inside stage 6: a resumed run that skips stage 6 still needs
# it for the appcast PR (1.18.0 timed out three times on "command not found").
checks_started() {
  # Started means gh listed at least one check row ("name<TAB>state<TAB>...").
  # Anything else — no checks yet, no PR yet, or a gh auth/network error — is
  # "not started", so wait_for keeps polling and times out loudly instead of
  # printing a false ✓.
  local out
  out="$(gh pr checks "$1" --repo "$REPO" --required 2>&1)" || true
  printf '%s\n' "$out" | grep -qE $'^[^\t]+\t(pass|fail|pending|skipping|cancel)'
}
# The files bump-version.sh writes. A dirty tree made of only these, already
# at VERSION, is a bump an earlier run applied before it died.
BUMP_FILES_RE='^(CHANGELOG\.md|README\.md|bun\.lock|packages/[^/]+/package\.json|packages/macos-bar/bundle\.sh|packages/mcp/server\.json)$'

# ── this machine's own install (stage 12) ────────────────────────────────────
# The release machine runs tokmeter too: a launchd daemon on the global npm
# install. Publishing doesn't touch it, so it stays on the old version until
# someone notices. 1.19.5 shipped and a day later the daemon was still on
# 1.19.4, whose Copilot parser failure held the midnight seal and froze the
# bar's "today" on yesterday.
DAEMON_LABEL="com.tokmeter.daemon"
LOCAL_PKGS=("@sriinnu/tokmeter@${VERSION}" "@sriinnu/tokmeter-mcp@${VERSION}")
global_version() {  # global_version <package> — its version in npm's global root, or nothing
  local root pj
  root="$(npm root -g 2>/dev/null)" || return 0
  pj="${root}/$1/package.json"
  [[ -f "$pj" ]] || return 0
  node -e 'try { console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version ?? "") } catch {}' "$pj" 2>/dev/null || true
}
global_at_version() {
  [[ "$(global_version @sriinnu/tokmeter)" == "$VERSION" && "$(global_version @sriinnu/tokmeter-mcp)" == "$VERSION" ]]
}
daemon_target() { echo "gui/$(id -u)/${DAEMON_LABEL}"; }
daemon_loaded() {
  command -v launchctl >/dev/null 2>&1 && launchctl print "$(daemon_target)" >/dev/null 2>&1
}
# The script the LaunchAgent runs (ProgramArguments[1], after node), fully
# resolved, or nothing when it can't be told. Lets stage 12 notice a daemon
# that runs from a different install than the npm on PATH (an nvm node, say).
daemon_program() {
  local plist="${HOME}/Library/LaunchAgents/${DAEMON_LABEL}.plist" prog
  [[ -f "$plist" ]] && command -v plutil >/dev/null 2>&1 || return 0
  prog="$(plutil -extract ProgramArguments.1 raw -o - "$plist" 2>/dev/null)" || return 0
  [[ -e "$prog" ]] || return 0
  node -e 'console.log(require("fs").realpathSync(process.argv[1]))' "$prog" 2>/dev/null || true
}
local_upgrade_warn() {  # local_upgrade_warn <what went wrong>
  {
    echo
    echo "  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
    echo "  !! THIS MACHINE IS NOT ON ${VERSION}: $1"
    echo "  !! ${TAG} itself is published; only the local install is behind. By hand:"
    echo "  !!   npm i -g ${LOCAL_PKGS[*]}"
    echo "  !!   launchctl kickstart -k gui/\$(id -u)/${DAEMON_LABEL}"
    echo "  !! or rerun: bash scripts/release.sh ${VERSION}"
    echo "  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  } >&2
}
# Never fails: the release is out by now, and a stale local install is worth a
# loud warning, not a red release. Every step checks its own result, since
# set -e doesn't apply inside a function called with ||.
upgrade_local_install() {
  local root prog real_root
  root="$(npm root -g 2>/dev/null || true)"
  echo "  global npm root: ${root:-unknown}"
  echo "  installed: tokmeter $(global_version @sriinnu/tokmeter | grep . || echo none)," \
    "tokmeter-mcp $(global_version @sriinnu/tokmeter-mcp | grep . || echo none)"
  if global_at_version; then
    skip "global install is at ${VERSION}"
    return 0
  fi
  # Stage 9 already saw both on npm, but `npm i` can briefly miss a version
  # `npm view` already serves, so wait again, without dying on a timeout.
  if ! poll "@sriinnu/tokmeter@${VERSION} on npm" 900 npm view "@sriinnu/tokmeter@${VERSION}" version \
    || ! poll "@sriinnu/tokmeter-mcp@${VERSION} on npm" 900 npm view "@sriinnu/tokmeter-mcp@${VERSION}" version; then
    local_upgrade_warn "npm still isn't serving ${VERSION} after 15 minutes."
    return 0
  fi
  if [[ $DRY -eq 1 ]]; then
    echo "DRY: npm i -g ${LOCAL_PKGS[*]}"
    echo "DRY: launchctl kickstart -k $(daemon_target), if it is loaded"
    return 0
  fi
  if ! npm i -g "${LOCAL_PKGS[@]}"; then
    local_upgrade_warn "npm i -g failed."
    return 0
  fi
  if ! global_at_version; then
    local_upgrade_warn "npm i -g ran, but ${root:-the global root} still isn't at ${VERSION}."
    return 0
  fi
  echo "  ✓ global install upgraded to ${VERSION}"

  if ! daemon_loaded; then
    echo "  ${DAEMON_LABEL} is not loaded in launchd, so nothing was restarted."
    echo "  If a tokmeter daemon runs outside launchd, restart it on ${VERSION}:"
    echo "    tokmeter-mcp daemon restart"
    echo "  To run it under launchd from now on: tokmeter-mcp daemon install-agent"
    return 0
  fi
  prog="$(daemon_program)"
  real_root="$(node -e 'console.log(require("fs").realpathSync(process.argv[1]))' "$root" 2>/dev/null || true)"
  if [[ -n "$prog" && -n "$real_root" && "$prog" != "${real_root}/"* ]]; then
    local_upgrade_warn "the daemon runs ${prog}, which is not under this npm's global root ${real_root}. Upgrade the install it runs from, then kickstart it."
    return 0
  fi
  if launchctl kickstart -k "$(daemon_target)"; then
    echo "  ✓ restarted ${DAEMON_LABEL} on ${VERSION}"
  else
    local_upgrade_warn "launchctl kickstart failed; the daemon may still be running the old version."
  fi
}

# The menubar app on this machine. Sparkle checks once a day, so after a
# release the bar here sat a version behind (1.21.0 while 1.22.1 was out)
# until someone noticed. Stage 12 installs CI's signed zip itself, and only
# after the checks Gatekeeper makes plus one it doesn't: the new app must be
# signed by the same team as the installed one, under the bar's bundle id.
BAR_APP="${TOKMETER_BAR_APP:-/Applications/TokmeterBar.app}"
BAR_ID="com.sriinnu.tokmeterbar"
BAR_PROC="TokmeterBar"
bar_version() {  # bar_version <app> — CFBundleShortVersionString, or nothing
  node -e '
    try {
      const m = require("fs").readFileSync(process.argv[1], "utf8")
        .match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/);
      console.log(m ? m[1] : "");
    } catch {}' "$1/Contents/Info.plist" 2>/dev/null || true
}
version_at_least() {  # version_at_least <a> <b> — a >= b, numeric per dotted part
  node -e '
    const p = (v) => v.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : NaN));
    const [a, b] = [p(process.argv[1]), p(process.argv[2])];
    if ([...a, ...b].some(Number.isNaN)) process.exit(1);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if ((a[i] ?? 0) !== (b[i] ?? 0)) process.exit((a[i] ?? 0) > (b[i] ?? 0) ? 0 : 1);
    }' "$1" "$2" 2>/dev/null
}
bar_running() { pgrep -x "$BAR_PROC" >/dev/null 2>&1; }
# Sparkle's installer runs outside the app bundle; after a quit it may be
# rewriting the same bundle, so the swap waits for it.
sparkle_installing() { pgrep -f 'Sparkle.*(Autoupdate|Installer)' >/dev/null 2>&1; }
team_of() {  # team_of <app> — the signing team, or nothing (ad-hoc, unsigned)
  codesign -dv "$1" 2>&1 | sed -n 's/^TeamIdentifier=//p' | grep -v '^not set$' || true
}
bar_upgrade_warn() {  # bar_upgrade_warn <what went wrong>
  {
    echo
    echo "  !! THE BAR ON THIS MACHINE IS NOT ON ${VERSION}: $1"
    echo "  !! Sparkle offers ${VERSION} on its next daily check,"
    echo "  !! or rerun: bash scripts/release.sh ${VERSION}"
  } >&2
}
# When the swap fails and the old app can't be put back, there is no bar at
# BAR_APP: Sparkle has nothing to update and a rerun says "no TokmeterBar",
# so the only way out is putting the old bundle back by hand.
bar_stranded_warn() {  # bar_stranded_warn <what went wrong>
  {
    echo
    echo "  !! THE BAR ON THIS MACHINE IS NOT ON ${VERSION}: $1"
    echo "  !! The previous bar could not be put back. It is at ${BAR_APP}.old"
    if [[ -e "${BAR_APP}.new" ]]; then echo "  !! (the verified ${VERSION} bar is at ${BAR_APP}.new)."; fi
    if [[ -e "$BAR_APP" ]]; then
      echo "  !! Something else is at ${BAR_APP}; move it out of the way, then restore with:"
    else
      echo "  !! No bar is at ${BAR_APP}, so a rerun finds nothing to upgrade. Restore it with:"
    fi
    echo "  !!   mv \"${BAR_APP}.old\" \"${BAR_APP}\" && open \"${BAR_APP}\""
  } >&2
}
bar_relaunch() {  # bar_relaunch — start the bar at BAR_APP again, or say how to
  open "$BAR_APP" >/dev/null 2>&1 \
    || echo "  !! could not relaunch the bar; start it with: open \"${BAR_APP}\"" >&2
}
# Undo the swap: the old app goes back to BAR_APP and runs again if it ran.
# Whatever sits at BAR_APP moves to .new rather than being deleted, since it
# may not be ours.
bar_roll_back() {  # bar_roll_back <what failed> <was_running 0|1>
  if [[ -e "$BAR_APP" ]]; then
    rm -rf "${BAR_APP}.new"
    if ! mv "$BAR_APP" "${BAR_APP}.new"; then
      bar_stranded_warn "$1."; return 0
    fi
  fi
  if ! mv "${BAR_APP}.old" "$BAR_APP"; then
    bar_stranded_warn "$1."; return 0
  fi
  rm -rf "${BAR_APP}.new"
  bar_upgrade_warn "$1; the old bar is back in place$( (( $2 )) && echo ' and relaunched')."
  if (( $2 )); then bar_relaunch; fi
  return 0
}
# Never fails the release, like the npm upgrade above.
upgrade_local_bar() {
  local cur tmp rc=0
  # The path gets moved and deleted below; refuse anything that isn't a bundle.
  if [[ "$BAR_APP" != /*.app ]]; then
    bar_upgrade_warn "TOKMETER_BAR_APP must be an absolute path to a .app, not '${BAR_APP}'."
    return 0
  fi
  if [[ ! -d "$BAR_APP" ]]; then
    echo "  no TokmeterBar at ${BAR_APP}, so no bar to upgrade."
    return 0
  fi
  cur="$(bar_version "$BAR_APP")"
  # A dev or pre-release build (1.23.0-dev) has no order against a release,
  # and replacing it would throw away whatever is being tried on it.
  if [[ -n "$cur" && ! "$cur" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "  !! TokmeterBar at ${BAR_APP} is '${cur}', not a plain X.Y.Z release; leaving it alone." >&2
    return 0
  fi
  if [[ -n "$cur" ]] && version_at_least "$cur" "$VERSION"; then
    skip "TokmeterBar is at ${cur} (release ${VERSION})"
    return 0
  fi
  echo "  installed bar: ${cur:-unknown}"
  if [[ $DRY -eq 1 ]]; then
    echo "DRY: download TokmeterBar-${VERSION}.zip, verify it, replace ${BAR_APP}"
    return 0
  fi
  tmp="$(mktemp -d)" || { bar_upgrade_warn "could not make a scratch directory. Nothing was replaced."; return 0; }
  install_bar_from "$tmp" || rc=$?
  rm -rf "$tmp"
  return $rc
}
install_bar_from() {  # install_bar_from <scratch dir>
  local tmp="$1" zip="TokmeterBar-${VERSION}.zip" new team assess was_running=0 waited=0 qpid now
  local keep="Nothing was replaced."
  # The installed bar is the trust anchor: its team gets pinned on the new
  # one below. A TeamIdentifier read off a bundle whose signature doesn't
  # hold proves nothing, so the signature is checked first.
  if ! codesign --verify --strict "$BAR_APP" >/dev/null 2>&1; then
    bar_upgrade_warn "the installed bar's own signature doesn't verify, so it can't vouch for the release's team. ${keep}"
    return 0
  fi
  team="$(team_of "$BAR_APP")"
  if [[ -z "$team" ]]; then
    bar_upgrade_warn "the installed bar isn't Developer ID signed (a dev build?), so there's no team to check the release against. ${keep}"
    return 0
  fi
  # It goes inside a codesign requirement string, where a quote or an extra
  # clause would change what the requirement means.
  if [[ ! "$team" =~ ^[A-Z0-9]{10}$ ]]; then
    bar_upgrade_warn "the installed bar's team identifier isn't in Apple's 10-character form. ${keep}"
    return 0
  fi
  if ! gh release download "$TAG" --repo "$REPO" -p "$zip" -D "$tmp" >/dev/null; then
    bar_upgrade_warn "could not download ${zip} from ${TAG}. ${keep}"; return 0
  fi
  if ! ditto -x -k "$tmp/$zip" "$tmp/x"; then
    bar_upgrade_warn "could not unpack ${zip}. ${keep}"; return 0
  fi
  new="$tmp/x/TokmeterBar.app"
  # ditto keeps a top-level symlink, and copying it later would install
  # whatever it points at.
  if [[ -L "$new" || ! -d "$new" ]]; then
    bar_upgrade_warn "${zip} has no TokmeterBar.app directory at its top. ${keep}"; return 0
  fi
  if [[ "$(bar_version "$new")" != "$VERSION" ]]; then
    bar_upgrade_warn "${zip} holds version '$(bar_version "$new")', not ${VERSION}. ${keep}"; return 0
  fi
  if ! codesign --verify --deep --strict \
    -R="anchor apple generic and identifier \"${BAR_ID}\" and certificate leaf[subject.OU] = \"${team}\"" \
    "$new"; then
    bar_upgrade_warn "${zip} isn't validly signed as ${BAR_ID} by the installed bar's team. ${keep}"; return 0
  fi
  if ! assess="$(spctl -a -t exec -vv "$new" 2>&1)" || ! grep -q '^source=Notarized Developer ID$' <<<"$assess"; then
    bar_upgrade_warn "Gatekeeper doesn't accept ${zip} as notarized Developer ID. ${keep}"; return 0
  fi
  if ! xcrun stapler validate "$new" >/dev/null; then
    bar_upgrade_warn "${zip} has no valid stapled notarization ticket. ${keep}"; return 0
  fi
  echo "  ✓ ${zip} verified: team signature, notarized Developer ID, stapled, ${VERSION}"

  # Copy beside the old app first, so a failed copy never leaves no bar.
  rm -rf "${BAR_APP}.new" "${BAR_APP}.old"
  if ! ditto "$new" "${BAR_APP}.new"; then
    rm -rf "${BAR_APP}.new"
    bar_upgrade_warn "could not copy the new bar next to ${BAR_APP}. ${keep}"; return 0
  fi

  # Sparkle swaps this same bundle when it installs, and two swaps at once
  # can leave neither app. Checked whether or not the bar runs: a bar that
  # isn't running is exactly when Sparkle's install-on-quit is at work.
  if sparkle_installing; then
    rm -rf "${BAR_APP}.new"
    bar_upgrade_warn "a Sparkle install is running right now, and this won't race its swap. ${keep}"
    return 0
  fi

  # Quit by bundle id, in the background: osascript can wait on an Automation
  # prompt, and a --yes run must not hang on it. TERM after 10 s. Quitting
  # can start Sparkle's install-on-quit, so the wait covers that too.
  if bar_running; then
    was_running=1
    osascript -e "tell application id \"${BAR_ID}\" to quit" >/dev/null 2>&1 &
    qpid=$!
    while bar_running || sparkle_installing; do
      if (( waited == 10 )) && bar_running; then
        echo "  the bar didn't quit within 10 s; sending it TERM"
        pkill -TERM -x "$BAR_PROC" 2>/dev/null || true
      fi
      if (( waited >= 20 )); then
        kill "$qpid" 2>/dev/null || true
        rm -rf "${BAR_APP}.new"
        if bar_running; then
          bar_upgrade_warn "the bar didn't quit within 20 seconds, even after a TERM; it is still running the old version. ${keep}"
        else
          # Opening a bundle Sparkle is rewriting could start a half-written
          # app, so the bar stays down and Sparkle finishes on its own.
          bar_upgrade_warn "the bar quit, but a Sparkle install was still running after 20 seconds, so the bar was NOT relaunched (Sparkle may relaunch it when it's done). This script replaced nothing. If the bar isn't back once Sparkle is done: open \"${BAR_APP}\""
        fi
        return 0
      fi
      # The test suite sleeps 0 to run the timeout fast.
      sleep "${RELEASE_BAR_SLEEP:-1}"; waited=$((waited + 1))
    done
    kill "$qpid" 2>/dev/null || true
  fi
  # Sparkle may have installed the update while the bar quit.
  now="$(bar_version "$BAR_APP")"
  if [[ -n "$now" ]] && version_at_least "$now" "$VERSION"; then
    rm -rf "${BAR_APP}.new"
    skip "TokmeterBar is at ${now} (installed while it quit)"
    if (( was_running )); then bar_relaunch; fi
    return 0
  fi

  # Swap by rename. The old app stays at .old until the new one is in place,
  # reads as ${VERSION} and, if the bar was running, has launched; a failure
  # before that puts the old one back.
  if ! mv "$BAR_APP" "${BAR_APP}.old"; then
    rm -rf "${BAR_APP}.new"
    bar_upgrade_warn "could not move the old bar aside. ${keep}"
    if (( was_running )); then bar_relaunch; fi
    return 0
  fi
  if [[ -e "$BAR_APP" ]] || ! mv "${BAR_APP}.new" "$BAR_APP" \
    || [[ "$(bar_version "$BAR_APP")" != "$VERSION" ]]; then
    bar_roll_back "installing the new bar failed" "$was_running"; return 0
  fi
  if (( was_running )) && ! open "$BAR_APP" >/dev/null 2>&1; then
    bar_roll_back "the new bar wouldn't launch" 1; return 0
  fi
  rm -rf "${BAR_APP}.old"
  echo "  ✓ TokmeterBar upgraded to ${VERSION}$( (( was_running )) && echo ' and relaunched')"
}

# ── 1. preflight ─────────────────────────────────────────────────────────────
say "1/12 preflight ${TAG}"
branch="$(git branch --show-current)"
echo "  branch: ${branch:-detached}"
# run() evals its command string, and the branch name is interpolated into
# some of them. Git allows quotes, `$` and `;` in ref names, so refuse anything
# outside a plain charset rather than trust the quoting.
[[ -z "$branch" || "$branch" =~ ^[A-Za-z0-9._/-]+$ ]] || die "branch name has characters release.sh won't pass through eval: ${branch}"
for t in git gh node bun npm shasum curl; do command -v "$t" >/dev/null || die "missing tool: $t"; done
git fetch -q origin main || die "could not fetch origin/main."

merged="$(release_commit_on_main)"
tag_commit="$(remote_tag_commit)"
released=0; gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1 && released=1
bumped=0; committed=0

if [[ -n "$merged" ]]; then
  [[ "$(version_at "$merged")" == "$VERSION" ]] \
    || die "main has '${SUBJECT}' (${merged:0:7}) but its version isn't ${VERSION} — sort that out by hand."
  echo "  release commit on main: ${merged:0:7}"
else
  [[ "$branch" == "main" || -z "$branch" ]] && die "refusing to release from main — cut a release branch."
  [[ -n "$tag_commit" || $released -eq 1 ]] \
    && die "${TAG} is tagged or released, but no release commit is on main — sort that out by hand."
  git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null && die "tag ${TAG} exists locally but not on main's release — delete it by hand."
  [[ "$(git merge-base HEAD origin/main)" == "$(git rev-parse origin/main)" ]] \
    || die "branch is behind origin/main — rebase first."

  dirty="$(git status --porcelain)"
  if [[ "$(git log -1 --format=%s)" == "$SUBJECT" ]]; then
    [[ -z "$dirty" ]] || die "the release commit exists but the tree has changes on top — commit or stash them."
    [[ "$(git rev-list --count origin/main..HEAD)" == "1" ]] \
      || die "the branch has commits besides the release commit — the release PR must hold only the bump."
    committed=1; bumped=1
  elif [[ -n "$dirty" ]]; then
    # Only tracked, modified bump files (staged or not: a failed commit leaves
    # them staged), and already at the target version.
    if ! printf '%s\n' "$dirty" | grep -qvE '^[ M][ M] ' \
      && ! printf '%s\n' "$dirty" | cut -c4- | grep -qvE "$BUMP_FILES_RE" \
      && [[ "$(node -p 'require("./packages/tokmeter/package.json").version')" == "$VERSION" ]]; then
      bumped=1
    else
      die "working tree not clean — the release commit must hold only the bump."
    fi
  fi
fi

state() { [[ "$1" == 1 || ( "$1" != 0 && -n "$1" ) ]] && echo "✓" || echo "·"; }
echo "  progress: bump $(state $bumped)  commit $(state $committed)  merged $(state "$merged")  tag $(state "$tag_commit")  release $(state $released)"

if [[ -z "$merged" ]]; then
  # ── 2. bump ────────────────────────────────────────────────────────────────
  say "2/12 bump → ${VERSION}"
  if [[ $bumped -eq 1 ]]; then skip "bump applied"; else run "bash scripts/bump-version.sh ${VERSION}"; fi
  # The release notes are this version's CHANGELOG section. Check them now,
  # before anything is committed, merged or tagged — not after.
  if [[ $DRY -eq 1 && $bumped -eq 0 ]]; then
    echo "DRY: check CHANGELOG section for ${VERSION}"
  else
    section="$(awk -v v="$VERSION" '
      $0 ~ "^## \\[" v "\\]" { on = 1; next }
      on && /^## \[/ { exit }
      on { print }
    ' CHANGELOG.md)"
    [[ -n "$section" ]] || die "no CHANGELOG section for ${VERSION}."
    grep -q "_TODO_" <<<"$section" && die "CHANGELOG section for ${VERSION} still has _TODO_ placeholders — fill it in, commit, rerun."
  fi

  # ── 3. quality gate ────────────────────────────────────────────────────────
  say "3/12 build + test + lint"
  run "bun run build"
  run "bun run test"
  run "bun run lint"

  # ── 4. secret gate (mandatory) ─────────────────────────────────────────────
  # Runs after build (so dist/ exists for npm pack --dry-run) and after staging
  # the bump changes on every pass — a release commit made by hand never went
  # through it.
  say "4/12 secret gate"
  if [[ $committed -eq 0 ]]; then
    # Preflight allowed only bump files to be dirty, so every tracked change is the bump.
    run "git add -u"
  fi
  run "bash scripts/check-no-secrets.sh"

  # ── 5. commit (signed) ─────────────────────────────────────────────────────
  say "5/12 release commit (signed)"
  if [[ $committed -eq 1 ]]; then
    skip "$(git log -1 --format='%h %s')"
  else
    run "git add -u"
    run_signed "release commit" "git commit -S -m '${SUBJECT}'"
  fi

  # ── 6. push + PR + squash-merge ────────────────────────────────────────────
  say "6/12 PR + squash-merge"
  run "git push -u origin '${branch}'"
  case "$(pr_field "$branch" state)" in
    OPEN) skip "PR #$(pr_field "$branch" number) is open" ;;
    "") run "gh pr create --repo '${REPO}' --base main --head '${branch}' --title 'Release ${TAG}' --body 'Release ${TAG}. See CHANGELOG.md.'" ;;
    *) die "the PR for ${branch} is $(pr_field "$branch" state) — reopen it or cut a fresh branch." ;;
  esac
  # Right after PR creation CI hasn't registered yet, and `gh pr checks` reports
  # "no checks" as a failure; wait for them to appear before watching.
  wait_for "CI checks to start" 300 checks_started "$branch"
  run "gh pr checks '${branch}' --repo '${REPO}' --required --watch --fail-fast"
  confirm "Squash-merge the release PR to main?" || die "merge declined — nothing tagged or published. Rerun to resume."
  if [[ $DRY -eq 0 ]]; then
    pr="$(pr_field "$branch" number)"
    # Set the subject: with more than one commit GitHub would use the PR title,
    # and stage 7 looks the release commit up by this subject.
    gh pr merge "$branch" --repo "$REPO" --squash --delete-branch --subject "${SUBJECT} (#${pr})" --body ""
    git fetch -q origin main
    merged="$(release_commit_on_main)"
    [[ -n "$merged" ]] || die "merged, but '${SUBJECT}' isn't on origin/main — check the squash and tag it by hand."
    # The squash must carry exactly the tree that passed the gates.
    [[ "$(git rev-parse "${merged}^{tree}")" == "$(git rev-parse "HEAD^{tree}")" ]] \
      || die "merged tree differs from the tested release commit — refusing to tag."
  else
    echo "DRY: gh pr merge '${branch}' --squash --delete-branch --subject '${SUBJECT} (#N)'"
  fi
else
  say "2–6/12 bump, gates, commit, PR"
  skip "${SUBJECT} is on main (${merged:0:7})"
fi
merged="${merged:-origin/main}"   # dry run: the commit the squash would make

# ── 7. tag the squashed commit on main ───────────────────────────────────────
# Squash creates a new commit, so the tag goes on main's commit, never the
# branch's — a tag off main is invisible to anyone reading main's history.
say "7/12 tag ${TAG} on main"
if [[ -n "$tag_commit" ]]; then
  [[ "$tag_commit" == "$(git rev-parse "$merged")" ]] \
    || die "${TAG} on origin points at ${tag_commit:0:7}, not the release commit ${merged:0:7}."
  skip "${TAG} is on origin"
else
  if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
    [[ "$(git rev-parse "${TAG}^{commit}")" == "$(git rev-parse "$merged")" ]] \
      || die "local tag ${TAG} points elsewhere — delete it by hand and rerun."
    skip "${TAG} is tagged locally"
  else
    run_signed "tag ${TAG}" "git tag -s '${TAG}' -m '${TAG}' '${merged}'"
  fi
  run "git push origin '${TAG}'"
fi
if [[ "$branch" == "main" || -z "$(git status --porcelain)" ]]; then
  run "git switch -q main && git merge -q --ff-only origin/main" || echo "  (couldn't fast-forward local main; not needed for the release)"
fi

if [[ $NO_PUBLISH -eq 1 ]]; then
  say "done (--no-publish): ${TAG} merged and tagged. Rerun without --no-publish to publish."
  exit 0
fi

# ── 8. GitHub release → CI publishes ─────────────────────────────────────────
say "8/12 GitHub release (starts CI publishing)"
if [[ $released -eq 1 ]]; then
  skip "release ${TAG} is published"
else
  # Notes from the merged commit's CHANGELOG, not the working tree: on a
  # resumed run the checkout may be anywhere.
  notes="$(mktemp)"
  # awk reads to EOF instead of exiting at the next heading: an early exit
  # closes the pipe while git show is still writing, git show dies of
  # SIGPIPE, and pipefail + set -e turn that into exit 141 once CHANGELOG.md
  # outgrows the pipe buffer (it did at 88 KB, releasing 1.19.4).
  git show "${merged}:CHANGELOG.md" | awk -v v="$VERSION" '
    done { next }
    $0 ~ "^## \\[" v "\\]" { on = 1; next }
    on && /^## \[/ { on = 0; done = 1; next }
    on { print }
  ' > "$notes"
  [[ $DRY -eq 1 || -s "$notes" ]] || die "no CHANGELOG section for ${VERSION} on main."
  confirm "Publish GitHub release ${TAG}? CI then publishes npm, the MCP registry and the bar." \
    || die "release not published. Rerun to resume."
  run "gh release create '${TAG}' --repo '${REPO}' --verify-tag --title '${TAG}' --notes-file '${notes}'"
  rm -f "$notes"
  notes=""
fi

# ── 9. wait for CI ───────────────────────────────────────────────────────────
say "9/12 waiting for CI"
npm_live() { npm view "$1@${VERSION}" version >/dev/null 2>&1; }
# publish.yml stages both packages; neither is installable until approved with
# the security key. CI can't approve its own release, so say how, once.
if ! npm_live @sriinnu/tokmeter || ! npm_live @sriinnu/tokmeter-mcp; then
  echo "  CI stages both packages on npm. Approve each with the security key once staged:"
  echo "    npm stage list @sriinnu/tokmeter      then  npm stage approve <id>"
  echo "    npm stage list @sriinnu/tokmeter-mcp  then  npm stage approve <id>"
fi
wait_for "@sriinnu/tokmeter@${VERSION} on npm (approved)" 3600 npm_live @sriinnu/tokmeter
wait_for "@sriinnu/tokmeter-mcp@${VERSION} on npm (approved)" 3600 npm_live @sriinnu/tokmeter-mcp
zip_attached() {
  gh release view "$TAG" --repo "$REPO" --json assets --jq '.assets[].name' | grep -qx "TokmeterBar-${VERSION}.zip"
}
wait_for "TokmeterBar-${VERSION}.zip on the release" 3600 zip_attached
# The official MCP registry is the one listing that changes per release;
# publish.yml registers it after npm. Cline, Glama and the rest read the repo
# (README, llms-install.md, glama.json) and npm, so they track on their own.
registry_listed() {
  # The response is data: node only JSON.parses it from the environment.
  # Nothing fetched from the network is ever piped into an interpreter.
  local body
  # Ask for this exact version: an unfiltered search returns one page of 30,
  # and from 1.23.1 tokmeter has more versions than that, so the newest one
  # landed on page 2 and this wait never saw it.
  body="$(curl -fsS "https://registry.modelcontextprotocol.io/v0/servers?search=tokmeter&version=${VERSION}")" || return 1
  REGISTRY_BODY="$body" node -e '
    const hit = JSON.parse(process.env.REGISTRY_BODY).servers?.some(s =>
      s.server?.name === "io.github.sriinnu/tokmeter" && s.server?.version === process.argv[1]);
    process.exit(hit ? 0 : 1);' "$VERSION"
}
# publish.yml's MCP job waits 30 minutes for the approved version. Approved
# later than that, the job has given up, so run it alone, once.
if ! poll "io.github.sriinnu/tokmeter ${VERSION} in the MCP registry" 1200 registry_listed; then
  echo "  The MCP-registry job likely gave up before npm was live; re-running it alone."
  run "gh workflow run publish.yml --repo '${REPO}' --ref main -f tag='${TAG}' -f publish_npm=false"
  wait_for "io.github.sriinnu/tokmeter ${VERSION} in the MCP registry" 1800 registry_listed
fi

# ── 10. Homebrew cask ────────────────────────────────────────────────────────
# update-brew-cask.sh is itself rerunnable: it does nothing when the cask is
# already at this version and sha256.
if [[ $SKIP_BREW -eq 0 ]]; then
  say "10/12 Homebrew cask"
  if confirm "Update the Homebrew cask to ${VERSION}?"; then
    run "bash scripts/update-brew-cask.sh ${VERSION}"
  else echo "  brew skipped. Later: bash scripts/update-brew-cask.sh ${VERSION}"; fi
else say "10/12 Homebrew cask — skipped (--skip-brew)"; fi

# ── 11. appcast PR ───────────────────────────────────────────────────────────
# release-macos.yml opens it with the workflow token, and GitHub doesn't run
# workflows for PRs that token opens, so its required checks never start and
# Sparkle users never see the release. Closing and reopening it as a person
# starts them.
say "11/12 appcast PR (Sparkle)"
appcast="release/appcast-${TAG}"
appcast_on_main() {
  # Read the whole feed before matching: `curl | grep -q` would SIGPIPE curl
  # once the feed outgrows the pipe buffer, and under pipefail this wait loop
  # would then read "not merged yet" until it timed out.
  local feed
  feed="$(curl -fsS "https://raw.githubusercontent.com/${REPO}/main/packages/macos-bar/appcast.xml")" || return 1
  grep -q "<sparkle:shortVersionString>${VERSION}</sparkle:shortVersionString>" <<<"$feed"
}
# The PR is found by branch name, and `gh pr view <branch>` also matches a
# fork's PR from a same-named branch. Merging it is what ships the feed to
# every Sparkle user, so first prove it is the workflow's own PR: opened by
# the Actions bot (gh reports github-actions[bot] as "app/github-actions"),
# from this repo, into main, changing appcast.xml and nothing else. Prints the
# head commit it vetted; the merge is pinned to it, so a push after the check
# fails the merge instead of shipping bytes nobody looked at.
appcast_pr_vetted_head() {  # appcast_pr_vetted_head <branch>
  local meta
  meta="$(gh pr view "$1" --repo "$REPO" \
    --json author,headRepository,isCrossRepository,baseRefName,headRefName,headRefOid,files)" || return 1
  # shellcheck disable=SC2016  # JavaScript template literals, not shell
  node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      const [repo, branch] = process.argv.slice(1);
      const pr = JSON.parse(s);
      const files = (pr.files ?? []).map(f => f.path);
      const problems = [];
      if (pr.headRepository?.nameWithOwner !== repo || pr.isCrossRepository !== false)
        problems.push(`head repo is ${pr.headRepository?.nameWithOwner ?? "unknown"}, not ${repo}`);
      if (pr.author?.login !== "app/github-actions")
        problems.push(`author is ${pr.author?.login ?? "unknown"}, not github-actions[bot]`);
      if (pr.baseRefName !== "main") problems.push(`base is ${pr.baseRefName}, not main`);
      if (pr.headRefName !== branch) problems.push(`head branch is ${pr.headRefName}, not ${branch}`);
      if (files.length === 0 || files.some(f => f !== "packages/macos-bar/appcast.xml"))
        problems.push(`changes ${files.join(", ") || "no files"}, not only packages/macos-bar/appcast.xml`);
      if (!/^[0-9a-f]{40}$/.test(pr.headRefOid ?? "")) problems.push("no head commit");
      if (problems.length) { for (const p of problems) console.error(`  ✗ ${p}`); process.exit(1); }
      console.log(pr.headRefOid);
    });' "$REPO" "$1" <<<"$meta"
}
if [[ $DRY -eq 1 ]]; then
  echo "DRY: wait for ${appcast}, start its checks, merge it"
elif appcast_on_main; then
  skip "appcast on main lists ${VERSION}"
else
  wait_for "the appcast PR (${appcast})" 600 pr_open "$appcast"
  if ! checks_started "$appcast"; then
    gh pr close "$appcast" --repo "$REPO" >/dev/null
    gh pr reopen "$appcast" --repo "$REPO" >/dev/null
  fi
  wait_for "appcast PR checks to start" 300 checks_started "$appcast"
  gh pr checks "$appcast" --repo "$REPO" --required --watch --fail-fast
  head="$(appcast_pr_vetted_head "$appcast")" \
    || die "the ${appcast} PR is not the workflow's appcast-only PR — not merging. Inspect it by hand."
  echo "  ✓ ${appcast}: github-actions[bot], ${REPO} → main, appcast.xml only (head ${head:0:12})"
  gh pr diff "$appcast" --repo "$REPO" --color never
  if confirm "Merge the appcast PR above? Sparkle users get ${VERSION} on their next check."; then
    pr="$(pr_field "$appcast" number)"
    gh pr merge "$appcast" --repo "$REPO" --squash --delete-branch --match-head-commit "$head" \
      --subject "chore(appcast): add ${TAG} (#${pr})" --body ""
    echo "  ✓ appcast merged"
  else
    echo "  appcast not merged. Rerun to finish, or merge ${appcast} by hand."
  fi
fi

# ── 12. this machine's install ───────────────────────────────────────────────
if [[ $SKIP_LOCAL -eq 0 ]]; then
  say "12/12 this machine's install"
  upgrade_local_install || local_upgrade_warn "the local upgrade stage stopped unexpectedly."
  upgrade_local_bar || bar_upgrade_warn "the bar upgrade stopped unexpectedly."
else say "12/12 this machine's install — skipped (--skip-local-upgrade)"; fi

say "Release ${TAG} complete."
