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
#   1. preflight        — semver, release branch, clean tree, tag/release unused
#   2. bump             — scripts/bump-version.sh
#   3. secret gate      — scripts/check-no-secrets.sh   (NON-skippable)
#   4. quality gate     — bun run build && test && lint
#   5. commit           — signed release commit
#   6. PR + squash      — push, open PR, wait for CI, squash-merge
#   7. tag              — signed tag on the squashed commit ON MAIN, push
#   8. GitHub release   — publishes; CI takes npm, MCP registry and the bar
#   9. wait for CI      — npm versions visible, bar zip attached
#  10. Homebrew cask    — scripts/update-brew-cask.sh    (--skip-brew)
#
# Flags:
#   --no-publish   stop after stage 7 (merged and tagged; no release, no brew)
#   --skip-brew
#   --dry-run      print the plan, change nothing
#   --yes          don't prompt before the irreversible stages
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

REPO="sriinnu/tokmeter"
VERSION=""; DRY=0; ASSUME_YES=0; NO_PUBLISH=0; SKIP_BREW=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    --no-publish) NO_PUBLISH=1 ;;
    --skip-brew) SKIP_BREW=1 ;;
    -* ) echo "unknown flag: $arg" >&2; exit 1 ;;
    * ) VERSION="$arg" ;;
  esac
done
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "usage: release.sh X.Y.Z [--no-publish|--skip-brew|--dry-run|--yes]" >&2; exit 1; }

TAG="v${VERSION}"
say()  { echo; echo "════ $* ════"; }
run()  { if [[ $DRY -eq 1 ]]; then echo "DRY: $*"; else eval "$*"; fi; }
die()  { echo "ERROR: $*" >&2; exit 1; }
confirm() {
  [[ $ASSUME_YES -eq 1 || $DRY -eq 1 ]] && return 0
  read -r -p "  $1 [y/N] " a; [[ "$a" == "y" || "$a" == "Y" ]]
}
# Poll until a command succeeds, or give up after $2 seconds.
wait_for() {
  local desc="$1" limit="$2"; shift 2
  [[ $DRY -eq 1 ]] && { echo "DRY: wait for ${desc}"; return 0; }
  local waited=0
  until "$@" >/dev/null 2>&1; do
    (( waited >= limit )) && die "timed out after ${limit}s waiting for ${desc}"
    sleep 15; waited=$((waited + 15))
  done
  echo "  ✓ ${desc}"
}

# ── 1. preflight ─────────────────────────────────────────────────────────────
say "1/10 preflight ${TAG}"
branch="$(git branch --show-current)"
[[ "$branch" == "main" ]] && die "refusing to release from main — cut a release branch."
echo "  branch: $branch"
for t in git gh node bun npm shasum; do command -v "$t" >/dev/null || die "missing tool: $t"; done
[[ -z "$(git status --porcelain)" ]] || die "working tree not clean — the release commit must hold only the bump."
git fetch -q origin main || die "could not fetch origin/main."
[[ "$(git merge-base HEAD origin/main)" == "$(git rev-parse origin/main)" ]] \
  || die "branch is behind origin/main — rebase first."
# A tag can exist without a release (a half-finished run), so check both.
git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null && die "tag ${TAG} exists locally."
git ls-remote --exit-code --tags origin "refs/tags/${TAG}" >/dev/null 2>&1 && die "tag ${TAG} exists on origin."
gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1 && die "release ${TAG} already exists."

# ── 2. bump ──────────────────────────────────────────────────────────────────
say "2/10 bump → ${VERSION}"
run "bash scripts/bump-version.sh ${VERSION}"
# The release notes are this version's CHANGELOG section. Check them now,
# before anything is committed, merged or tagged — not after.
notes="$(mktemp)"
if [[ $DRY -eq 1 ]]; then
  echo "DRY: check CHANGELOG section for ${VERSION}"
else
  awk -v v="$VERSION" '
    $0 ~ "^## \\[" v "\\]" { on = 1; next }
    on && /^## \[/ { exit }
    on { print }
  ' CHANGELOG.md > "$notes"
  [[ -s "$notes" ]] || die "no CHANGELOG section for ${VERSION}."
  grep -q "_TODO_" "$notes" && die "CHANGELOG section for ${VERSION} still has _TODO_ placeholders — fill it in, commit, rerun."
fi

# ── 3. secret gate (mandatory) ───────────────────────────────────────────────
say "3/10 secret gate"
run "bash scripts/check-no-secrets.sh"

# ── 4. quality gate ──────────────────────────────────────────────────────────
say "4/10 build + test + lint"
run "bun run build"
run "bun run test"
run "bun run lint"

# ── 5. commit (signed) ───────────────────────────────────────────────────────
say "5/10 release commit (signed)"
# The tree was clean in preflight, so every tracked change is the bump.
run "git add -u"
run "git commit -S -m 'chore(release): ${TAG}'"

# ── 6. push + PR + squash-merge ──────────────────────────────────────────────
say "6/10 PR + squash-merge"
run "git push -u origin '${branch}'"
run "gh pr create --repo '${REPO}' --base main --head '${branch}' --title 'Release ${TAG}' --body 'Release ${TAG}. See CHANGELOG.md.'"
# Right after PR creation CI hasn't registered yet, and `gh pr checks` reports
# "no checks" as a failure; wait for them to appear before watching.
checks_started() { ! gh pr checks "$branch" --repo "$REPO" 2>&1 | grep -q "no checks reported"; }
wait_for "CI checks to start" 300 checks_started
run "gh pr checks '${branch}' --repo '${REPO}' --watch --fail-fast"
confirm "Squash-merge the release PR to main?" || die "merge declined — nothing tagged or published."
run "gh pr merge '${branch}' --repo '${REPO}' --squash --delete-branch"

# ── 7. tag the squashed commit on main ───────────────────────────────────────
# Squash creates a new commit, so the tag goes on main's commit, never the
# branch's — a tag off main is invisible to anyone reading main's history.
say "7/10 tag ${TAG} on main"
run "git fetch -q origin main"
if [[ $DRY -eq 0 ]]; then
  merged="$(git rev-parse origin/main)"
  git log -1 --format=%s "$merged" | grep -q "chore(release): ${TAG}" \
    || die "origin/main is not the release commit ($(git log -1 --format=%s "$merged")) — tag it by hand."
  # The squash must carry exactly the tree that passed the gates.
  [[ "$(git rev-parse "${merged}^{tree}")" == "$(git rev-parse "HEAD^{tree}")" ]] \
    || die "merged tree differs from the tested release commit — refusing to tag."
fi
run "git tag -s '${TAG}' -m '${TAG}' origin/main"
run "git push origin '${TAG}'"
run "git switch -q main && git merge -q --ff-only origin/main"

if [[ $NO_PUBLISH -eq 1 ]]; then
  say "done (--no-publish): ${TAG} merged and tagged. Publish with: gh release create ${TAG} --verify-tag"
  exit 0
fi

# ── 8. GitHub release → CI publishes ─────────────────────────────────────────
say "8/10 GitHub release (starts CI publishing)"
confirm "Publish GitHub release ${TAG}? CI then publishes npm, the MCP registry and the bar." \
  || die "release not published. Resume with: gh release create ${TAG} --verify-tag --notes-file <notes>"
run "gh release create '${TAG}' --repo '${REPO}' --verify-tag --title '${TAG}' --notes-file '${notes}'"

# ── 9. wait for CI ───────────────────────────────────────────────────────────
say "9/10 waiting for CI"
wait_for "@sriinnu/tokmeter@${VERSION} on npm" 1800 npm view "@sriinnu/tokmeter@${VERSION}" version
wait_for "@sriinnu/tokmeter-mcp@${VERSION} on npm" 1800 npm view "@sriinnu/tokmeter-mcp@${VERSION}" version
zip_attached() {
  gh release view "$TAG" --repo "$REPO" --json assets --jq '.assets[].name' | grep -qx "TokmeterBar-${VERSION}.zip"
}
wait_for "TokmeterBar-${VERSION}.zip on the release" 3600 zip_attached

# ── 10. Homebrew cask ────────────────────────────────────────────────────────
if [[ $SKIP_BREW -eq 0 ]]; then
  say "10/10 Homebrew cask"
  if confirm "Open the Homebrew cask PR for ${VERSION}?"; then
    run "bash scripts/update-brew-cask.sh ${VERSION}"
  else echo "  brew skipped. Later: bash scripts/update-brew-cask.sh ${VERSION}"; fi
else say "10/10 Homebrew cask — skipped (--skip-brew)"; fi

say "Release ${TAG} complete."
echo "  Still to land: the appcast PR release-macos.yml opened (release/appcast-${TAG})."
