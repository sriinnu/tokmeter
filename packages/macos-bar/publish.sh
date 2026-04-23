#!/usr/bin/env bash
# Upload the notarized TokmeterBar-<version>.zip produced by `bundle.sh --release`
# to a GitHub release. Run after `bun run bar:release`, or let `bar:ship` chain them.
# Keeps Sparkle's appcast URL (which points at this zip) in sync with reality.
set -euo pipefail

REPO="${REPO:-sriinnu/tokmeter}"
APP_NAME="${APP_NAME:-TokmeterBar}"

# Exactly one TokmeterBar-*.zip must be present. Zero means nothing built; more
# than one means stale artifacts — either case I want to bail rather than guess.
shopt -s nullglob
zips=("${APP_NAME}"-*.zip)
shopt -u nullglob

if [[ ${#zips[@]} -eq 0 ]]; then
    echo "ERROR: No ${APP_NAME}-*.zip found here. Run 'bun run bar:release' first." >&2
    exit 1
fi
if [[ ${#zips[@]} -gt 1 ]]; then
    echo "ERROR: Multiple zips found:" >&2
    printf '  %s\n' "${zips[@]}" >&2
    echo "Run 'bun run clean' then 'bun run bar:release' to produce exactly one." >&2
    exit 1
fi

ZIP="${zips[0]}"
VERSION="${ZIP#${APP_NAME}-}"
VERSION="${VERSION%.zip}"
TAG="v${VERSION}"

# Don't clobber an existing release — force would hide a version-bump mistake.
if gh release view "${TAG}" --repo "${REPO}" >/dev/null 2>&1; then
    echo "ERROR: Release ${TAG} already exists on ${REPO}." >&2
    echo "       Bump CFBundleShortVersionString and rebuild, or delete the existing release." >&2
    exit 1
fi

echo "==> Creating GitHub release ${TAG} on ${REPO}"
gh release create "${TAG}" "${ZIP}" \
    --repo "${REPO}" \
    --title "TokmeterBar ${VERSION}" \
    --notes "Notarized + stapled release build.

Auto-update feed: https://raw.githubusercontent.com/${REPO}/main/packages/macos-bar/appcast.xml"

echo ""
echo "==> Published ${TAG}"
echo "    https://github.com/${REPO}/releases/tag/${TAG}"
echo ""
echo "Next: commit packages/macos-bar/appcast.xml on your branch and PR to main"
echo "      so Sparkle clients pick up the new <item>."
