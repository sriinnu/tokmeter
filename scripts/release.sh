#!/usr/bin/env bash
#
# release.sh <X.Y.Z> [flags]
#
# One-command release. Run from an interactive shell on a release branch so the
# Titan-signed commit/tag, npm auth, Apple notarization creds (.env), and gh all
# work. Every stage is guarded; the secret gate is mandatory and runs before the
# commit AND before any publish.
#
# Stages:
#   1. preflight        — semver, branch != main, required tools present
#   2. bump             — scripts/bump-version.sh (package.json + bundle.sh + CHANGELOG)
#   3. secret gate      — scripts/check-no-secrets.sh   (NON-skippable)
#   4. quality gate     — bun run build && test && lint
#   5. commit + tag     — git commit -S, git tag -s vX.Y.Z   (Titan)
#   6. push + PR + merge — push branch, gh pr create, gh pr merge --admin
#   7. tag main + push  — tag the merged commit, push the tag
#   8. npm publish      — every non-private package        (--skip-npm)
#   9. bar ship         — bun run bar:ship (notarize+release+appcast)  (--skip-bar)
#  10. brew cask        — scripts/update-brew-cask.sh       (--skip-brew)
#
# Flags:
#   --no-publish   stop after stage 7 (code + tag landed; skip npm/bar/brew)
#   --skip-npm --skip-bar --skip-brew
#   --dry-run      print the plan, change nothing
#   --yes          don't prompt before the irreversible publish stages
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION=""; DRY=0; ASSUME_YES=0; NO_PUBLISH=0
SKIP_NPM=0; SKIP_BAR=0; SKIP_BREW=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    --no-publish) NO_PUBLISH=1 ;;
    --skip-npm) SKIP_NPM=1 ;;
    --skip-bar) SKIP_BAR=1 ;;
    --skip-brew) SKIP_BREW=1 ;;
    -* ) echo "unknown flag: $arg" >&2; exit 1 ;;
    * ) VERSION="$arg" ;;
  esac
done
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "usage: release.sh X.Y.Z [--no-publish|--skip-npm|--skip-bar|--skip-brew|--dry-run|--yes]" >&2; exit 1; }

TAG="v${VERSION}"
say()  { echo; echo "════ $* ════"; }
run()  { if [[ $DRY -eq 1 ]]; then echo "DRY: $*"; else eval "$*"; fi; }
confirm() {
  [[ $ASSUME_YES -eq 1 || $DRY -eq 1 ]] && return 0
  read -r -p "  $1 [y/N] " a; [[ "$a" == "y" || "$a" == "Y" ]]
}

# ── 1. preflight ─────────────────────────────────────────────────────────────
say "1/10 preflight ${TAG}"
branch="$(git branch --show-current)"
[[ "$branch" == "main" ]] && { echo "Refusing to release from main — work on a release branch." >&2; exit 1; }
echo "  branch: $branch"
for t in git gh node bun npm shasum; do command -v "$t" >/dev/null || { echo "missing tool: $t" >&2; exit 1; }; done
gh release view "$TAG" --repo sriinnu/tokmeter >/dev/null 2>&1 && { echo "Release $TAG already exists — bump the version." >&2; exit 1; }

# ── 2. bump ──────────────────────────────────────────────────────────────────
say "2/10 bump → ${VERSION}"
run "bash scripts/bump-version.sh ${VERSION}"

# ── 3. secret gate (mandatory) ───────────────────────────────────────────────
say "3/10 secret gate"
run "bash scripts/check-no-secrets.sh"

# ── 4. quality gate ──────────────────────────────────────────────────────────
say "4/10 build + test + lint"
run "bun run build"
run "bun run test"
run "bun run lint"

# ── 5. commit + tag (Titan-signed) ───────────────────────────────────────────
say "5/10 commit + tag (signed)"
run "git add -A packages/*/package.json packages/macos-bar/bundle.sh CHANGELOG.md"
run "git commit -S -m 'chore(release): ${TAG}'"
run "git tag -s '${TAG}' -m '${TAG}'"

# ── 6. push + PR + merge ─────────────────────────────────────────────────────
say "6/10 push + PR + merge to main"
run "git push -u origin '${branch}'"
run "gh pr create --base main --head '${branch}' --title 'Release ${TAG}' --body 'Automated release ${TAG}. CI checks may show red on Actions billing, not code.' || true"
if confirm "Admin-merge the PR to main?"; then
  run "gh pr merge '${branch}' --merge --admin"
else
  echo "  merge skipped — tag stays on the branch commit."
fi

# ── 7. push tag (re-point to merged main if merged) ──────────────────────────
say "7/10 publish tag ${TAG}"
run "git push origin '${TAG}'"

if [[ $NO_PUBLISH -eq 1 ]]; then
  say "done (--no-publish): ${TAG} committed, tagged, pushed. Skipped npm/bar/brew."
  exit 0
fi

# ── 8. npm publish (every non-private package) ───────────────────────────────
if [[ $SKIP_NPM -eq 0 ]]; then
  say "8/10 npm publish"
  if confirm "Publish public packages to npm?"; then
    for pj in packages/*/package.json; do
      node -e 'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1])).private?0:1)' "$pj" && continue
      name="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).name)' "$pj")"
      echo "  → $name"
      run "(cd '$(dirname "$pj")' && npm publish --access public)"
    done
  else echo "  npm publish skipped."; fi
else say "8/10 npm publish — skipped (--skip-npm)"; fi

# ── 9. macOS bar ship (notarize + GH release + appcast) ──────────────────────
if [[ $SKIP_BAR -eq 0 ]]; then
  say "9/10 macOS bar ship"
  if confirm "Build + notarize + release the macOS bar (needs .env)?"; then
    run "bun run bar:ship"
    run "bash scripts/check-no-secrets.sh"   # re-gate: the built zip must be clean
  else echo "  bar ship skipped."; fi
else say "9/10 macOS bar — skipped (--skip-bar)"; fi

# ── 10. Homebrew cask ────────────────────────────────────────────────────────
if [[ $SKIP_BREW -eq 0 ]]; then
  say "10/10 Homebrew cask"
  if confirm "Update + push the Homebrew cask to ${VERSION}?"; then
    run "bash scripts/update-brew-cask.sh ${VERSION}"
  else echo "  brew cask skipped."; fi
else say "10/10 Homebrew cask — skipped (--skip-brew)"; fi

say "Release ${TAG} complete."
echo "  Remember: commit packages/macos-bar/appcast.xml (updated by bar:ship) on a branch + PR to main."
