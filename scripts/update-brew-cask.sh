#!/usr/bin/env bash
#
# update-brew-cask.sh <X.Y.Z>
#
# Point the Homebrew cask (sriinnu/homebrew-tap → Casks/tokmeterbar.rb) at a new
# release: bumps `version` and recomputes `sha256` from the released zip, then
# opens a PR on the tap and squash-merges it. Run AFTER CI has attached the zip
# to the GitHub release, since the sha256 comes from the published artifact.
#
# Needs: gh auth with push access to the tap repo. The tap's main requires
# signed commits via PR, like this repo's; GitHub signs the squash merge.
#
set -euo pipefail

VERSION="${1:-}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "usage: update-brew-cask.sh X.Y.Z" >&2; exit 1; }

REPO="${REPO:-sriinnu/tokmeter}"
TAP="${TAP:-sriinnu/homebrew-tap}"
APP="TokmeterBar"
TAG="v${VERSION}"
ZIPNAME="${APP}-${VERSION}.zip"

# Always hash the released asset — exactly what users fetch. CI builds and
# signs the zip, so a local build of the same version is a different file and
# its sha256 would make every `brew install` fail verification.
echo "==> Downloading ${ZIPNAME} from release ${TAG} to compute sha256"
tmp="$(mktemp -d)"
gh release download "$TAG" --repo "$REPO" --pattern "$ZIPNAME" --dir "$tmp"
SHA="$(shasum -a 256 "$tmp/$ZIPNAME" | awk '{print $1}')"
rm -rf "$tmp"
echo "    sha256: $SHA"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
echo "==> Cloning tap ${TAP}"
gh repo clone "$TAP" "$work/tap" -- --depth 1 >/dev/null 2>&1

cask="$work/tap/Casks/tokmeterbar.rb"
[[ -f "$cask" ]] || { echo "ERROR: $cask not found in tap" >&2; exit 1; }

perl -i -pe 's/(version ")[^"]+(")/${1}'"$VERSION"'${2}/' "$cask"
perl -i -pe 's/(sha256 ")[^"]+(")/${1}'"$SHA"'${2}/' "$cask"

echo "==> Cask now:"
grep -E 'version |sha256 ' "$cask" | sed 's/^/    /'

if git -C "$work/tap" diff --quiet; then
  echo "==> Cask already at ${VERSION} with this sha256 — nothing to push."
  exit 0
fi

branch="chore/tokmeterbar-${VERSION}"
git -C "$work/tap" switch -q -c "$branch"
git -C "$work/tap" add Casks/tokmeterbar.rb
git -C "$work/tap" commit -q -m "tokmeterbar ${VERSION}"
git -C "$work/tap" push -q -u origin "$branch"
gh pr create --repo "$TAP" --base main --head "$branch" \
  --title "tokmeterbar ${VERSION}" \
  --body "Points the cask at ${TAG}. sha256 computed from the zip attached to the release."
gh pr merge "$branch" --repo "$TAP" --squash --delete-branch
echo "==> Merged cask update: brew install --cask ${TAP%/*}/${TAP#*/}/tokmeterbar now serves ${VERSION}"
