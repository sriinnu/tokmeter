#!/usr/bin/env bash
#
# update-brew-cask.sh <X.Y.Z>
#
# Point the Homebrew cask (sriinnu/homebrew-tap → Casks/tokmeterbar.rb) at a new
# release: bumps `version` and recomputes `sha256` from the released zip, then
# commits + pushes the tap. Run AFTER the GitHub release exists (i.e. after
# `bar:ship`), since the sha256 comes from the published artifact.
#
# Needs: gh auth with push access to the tap repo.
#
set -euo pipefail

VERSION="${1:-}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "usage: update-brew-cask.sh X.Y.Z" >&2; exit 1; }

REPO="${REPO:-sriinnu/tokmeter}"
TAP="${TAP:-sriinnu/homebrew-tap}"
APP="TokmeterBar"
TAG="v${VERSION}"
ZIPNAME="${APP}-${VERSION}.zip"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# sha256 from the local build if present, else download the released asset so
# the cask always matches exactly what users will fetch.
local_zip="${ROOT}/packages/macos-bar/${ZIPNAME}"
if [[ -f "$local_zip" ]]; then
  SHA="$(shasum -a 256 "$local_zip" | awk '{print $1}')"
  echo "==> sha256 from local artifact: $SHA"
else
  echo "==> Downloading ${ZIPNAME} from release ${TAG} to compute sha256"
  tmp="$(mktemp -d)"
  gh release download "$TAG" --repo "$REPO" --pattern "$ZIPNAME" --dir "$tmp"
  SHA="$(shasum -a 256 "$tmp/$ZIPNAME" | awk '{print $1}')"
  rm -rf "$tmp"
  echo "    sha256: $SHA"
fi

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

git -C "$work/tap" add Casks/tokmeterbar.rb
git -C "$work/tap" commit -m "tokmeterbar ${VERSION}"
git -C "$work/tap" push
echo "==> Pushed cask update: brew install --cask ${TAP%/*}/${TAP#*/}/tokmeterbar now serves ${VERSION}"
