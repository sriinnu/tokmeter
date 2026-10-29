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
#   3. secret gate      — scripts/check-no-secrets.sh   (NON-skippable)
#   4. quality gate     — bun run build && test && lint
#   5. commit           — signed release commit
#   6. PR + squash      — push, open PR, wait for CI, squash-merge
#   7. tag              — signed tag on the squashed commit ON MAIN, push
#   8. GitHub release   — publishes; CI takes npm, MCP registry and the bar
#   9. wait for CI      — npm versions visible, bar zip attached, MCP registry
#  10. Homebrew cask    — scripts/update-brew-cask.sh    (--skip-brew)
#  11. appcast PR       — trigger its checks, merge it: Sparkle users get the update
#
# Rerunnable. Every stage first checks whether it already happened — bump
# applied, release commit made, PR open or merged, tag pushed, release
# published, cask current, appcast merged — and skips it if so. When a run
# dies (a missed key tap, a CI flake, a closed terminal), run the same command
# again from the same branch and it carries on from where it stopped. Once the
# release commit is on main, any branch works.
#
# Flags:
#   --no-publish   stop after stage 7 (merged and tagged; no release, no brew)
#   --skip-brew
#   --dry-run      print where the release is and what would run, change nothing
#   --yes          don't prompt before the irreversible stages
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck source=SCRIPTDIR/lib/signing.sh
source "$ROOT/scripts/lib/signing.sh"

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
  out="$(gh pr checks "$1" --repo "$REPO" 2>&1)" || true
  printf '%s\n' "$out" | grep -qE $'^[^\t]+\t(pass|fail|pending|skipping|cancel)'
}
# The files bump-version.sh writes. A dirty tree made of only these, already
# at VERSION, is a bump an earlier run applied before it died.
BUMP_FILES_RE='^(CHANGELOG\.md|README\.md|bun\.lock|packages/[^/]+/package\.json|packages/macos-bar/bundle\.sh|packages/mcp/server\.json)$'

# ── 1. preflight ─────────────────────────────────────────────────────────────
say "1/11 preflight ${TAG}"
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
  say "2/11 bump → ${VERSION}"
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

  # ── 3. secret gate (mandatory) ─────────────────────────────────────────────
  # Runs on every pass, resumed or not: a release commit made by hand never
  # went through it.
  say "3/11 secret gate"
  run "bash scripts/check-no-secrets.sh"

  # ── 4. quality gate ────────────────────────────────────────────────────────
  say "4/11 build + test + lint"
  run "bun run build"
  run "bun run test"
  run "bun run lint"

  # ── 5. commit (signed) ─────────────────────────────────────────────────────
  say "5/11 release commit (signed)"
  if [[ $committed -eq 1 ]]; then
    skip "$(git log -1 --format='%h %s')"
  else
    # Preflight allowed only bump files to be dirty, so every tracked change is the bump.
    run "git add -u"
    run_signed "release commit" "git commit -S -m '${SUBJECT}'"
  fi

  # ── 6. push + PR + squash-merge ────────────────────────────────────────────
  say "6/11 PR + squash-merge"
  run "git push -u origin '${branch}'"
  case "$(pr_field "$branch" state)" in
    OPEN) skip "PR #$(pr_field "$branch" number) is open" ;;
    "") run "gh pr create --repo '${REPO}' --base main --head '${branch}' --title 'Release ${TAG}' --body 'Release ${TAG}. See CHANGELOG.md.'" ;;
    *) die "the PR for ${branch} is $(pr_field "$branch" state) — reopen it or cut a fresh branch." ;;
  esac
  # Right after PR creation CI hasn't registered yet, and `gh pr checks` reports
  # "no checks" as a failure; wait for them to appear before watching.
  wait_for "CI checks to start" 300 checks_started "$branch"
  run "gh pr checks '${branch}' --repo '${REPO}' --watch --fail-fast"
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
  say "2–6/11 bump, gates, commit, PR"
  skip "${SUBJECT} is on main (${merged:0:7})"
fi
merged="${merged:-origin/main}"   # dry run: the commit the squash would make

# ── 7. tag the squashed commit on main ───────────────────────────────────────
# Squash creates a new commit, so the tag goes on main's commit, never the
# branch's — a tag off main is invisible to anyone reading main's history.
say "7/11 tag ${TAG} on main"
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
say "8/11 GitHub release (starts CI publishing)"
if [[ $released -eq 1 ]]; then
  skip "release ${TAG} is published"
else
  # Notes from the merged commit's CHANGELOG, not the working tree: on a
  # resumed run the checkout may be anywhere.
  notes="$(mktemp)"
  git show "${merged}:CHANGELOG.md" | awk -v v="$VERSION" '
    $0 ~ "^## \\[" v "\\]" { on = 1; next }
    on && /^## \[/ { exit }
    on { print }
  ' > "$notes"
  [[ $DRY -eq 1 || -s "$notes" ]] || die "no CHANGELOG section for ${VERSION} on main."
  confirm "Publish GitHub release ${TAG}? CI then publishes npm, the MCP registry and the bar." \
    || die "release not published. Rerun to resume."
  run "gh release create '${TAG}' --repo '${REPO}' --verify-tag --title '${TAG}' --notes-file '${notes}'"
fi

# ── 9. wait for CI ───────────────────────────────────────────────────────────
say "9/11 waiting for CI"
wait_for "@sriinnu/tokmeter@${VERSION} on npm" 1800 npm view "@sriinnu/tokmeter@${VERSION}" version
wait_for "@sriinnu/tokmeter-mcp@${VERSION} on npm" 1800 npm view "@sriinnu/tokmeter-mcp@${VERSION}" version
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
  body="$(curl -fsS "https://registry.modelcontextprotocol.io/v0/servers?search=tokmeter")" || return 1
  REGISTRY_BODY="$body" node -e '
    const hit = JSON.parse(process.env.REGISTRY_BODY).servers?.some(s =>
      s.server?.name === "io.github.sriinnu/tokmeter" && s.server?.version === process.argv[1]);
    process.exit(hit ? 0 : 1);' "$VERSION"
}
wait_for "io.github.sriinnu/tokmeter ${VERSION} in the MCP registry" 1800 registry_listed

# ── 10. Homebrew cask ────────────────────────────────────────────────────────
# update-brew-cask.sh is itself rerunnable: it does nothing when the cask is
# already at this version and sha256.
if [[ $SKIP_BREW -eq 0 ]]; then
  say "10/11 Homebrew cask"
  if confirm "Update the Homebrew cask to ${VERSION}?"; then
    run "bash scripts/update-brew-cask.sh ${VERSION}"
  else echo "  brew skipped. Later: bash scripts/update-brew-cask.sh ${VERSION}"; fi
else say "10/11 Homebrew cask — skipped (--skip-brew)"; fi

# ── 11. appcast PR ───────────────────────────────────────────────────────────
# release-macos.yml opens it with the workflow token, and GitHub doesn't run
# workflows for PRs that token opens, so its required checks never start and
# Sparkle users never see the release. Closing and reopening it as a person
# starts them.
say "11/11 appcast PR (Sparkle)"
appcast="release/appcast-${TAG}"
appcast_on_main() {
  curl -fsS "https://raw.githubusercontent.com/${REPO}/main/packages/macos-bar/appcast.xml" \
    | grep -q "<sparkle:shortVersionString>${VERSION}</sparkle:shortVersionString>"
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
  gh pr checks "$appcast" --repo "$REPO" --watch --fail-fast
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

say "Release ${TAG} complete."
