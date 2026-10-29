#!/usr/bin/env bash
# sign-app.sh — code-sign an assembled TokmeterBar.app, and nothing else.
#
#   ./sign-app.sh --adhoc TokmeterBar.app   # local dev only: ad-hoc ("-"); never ships
#   ./sign-app.sh TokmeterBar.app           # Developer ID + hardened runtime + timestamp
#
# Split out of bundle.sh so the release workflow can assemble the app in a job
# that holds no secrets (bun install, vite and its plugins, swift build all run
# third-party code) and sign it in a separate job that runs none of that.
# bundle.sh calls this for its own dev/--signed/--release modes, so local and
# CI builds are signed by the same code.
#
# Developer ID mode:
#   DEV_ID        required. "Developer ID Application: Name (TEAMID)".
#   SUPUBLIC_KEY  optional. When set, written into Info.plist as SUPublicEDKey
#                 before signing (the CI build job never sees it). Either way
#                 the app must end up with a well-formed key and the Sparkle
#                 hardening keys, or this refuses to sign: a Developer-ID app
#                 without them is un-updateable or accepts unsigned feeds.
#   SUFEED_URL    optional. The feed URL the app must carry (default: main's
#                 appcast.xml).
#   ENTITLEMENTS  optional. Default: entitlements.plist next to this script.
#
# Never prints the signing identity or team ID; CI logs are not a vault.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ADHOC=0
APP_DIR=""
for arg in "$@"; do
    case "${arg}" in
        --adhoc) ADHOC=1 ;;
        -*)      echo "Unknown flag: ${arg}" >&2; exit 2 ;;
        *)       APP_DIR="${arg}" ;;
    esac
done
[[ -n "${APP_DIR}" ]] || { echo "usage: sign-app.sh [--adhoc] <App.app>" >&2; exit 2; }
[[ -d "${APP_DIR}/Contents" ]] || { echo "ERROR: ${APP_DIR} is not an app bundle" >&2; exit 2; }

PLIST="${APP_DIR}/Contents/Info.plist"
FRAMEWORKS_DIR="${APP_DIR}/Contents/Frameworks"
ENTITLEMENTS="${ENTITLEMENTS:-${SCRIPT_DIR}/entitlements.plist}"
EXPECTED_FEED_URL="${SUFEED_URL:-https://raw.githubusercontent.com/sriinnu/tokmeter/main/packages/macos-bar/appcast.xml}"

plist_get() { /usr/libexec/PlistBuddy -c "Print :$1" "${PLIST}" 2>/dev/null || true; }

# Packaging metadata (resource forks, Finder info, quarantine) must be gone
# before signing: the distributed bundle has to be byte-for-byte what we sign.
xattr -cr "${APP_DIR}" 2>/dev/null || true
find "${APP_DIR}" -name '._*' -delete 2>/dev/null || true

# Sparkle.framework has nested XPC services (Installer.xpc, Downloader.xpc)
# that MUST be signed before the framework itself, which must be signed before
# the parent .app. Versions/Current (a symlink) rather than a hardcoded
# Versions/B, because Sparkle bumps the version letter periodically.
sign_sparkle_nested() {
    local sign_id="$1"
    shift
    local extra_args=("$@")  # e.g. --options runtime --timestamp
    [[ -d "${FRAMEWORKS_DIR}/Sparkle.framework" ]] || return 0

    local sparkle_current="${FRAMEWORKS_DIR}/Sparkle.framework/Versions/Current"
    [[ -d "${sparkle_current}" ]] || sparkle_current="${FRAMEWORKS_DIR}/Sparkle.framework/Versions/B"

    if [[ -d "${sparkle_current}/XPCServices" ]]; then
        for xpc in "${sparkle_current}/XPCServices/"*.xpc; do
            [[ -d "${xpc}" ]] || continue
            codesign --force "${extra_args[@]}" --sign "${sign_id}" "${xpc}"
        done
    fi
    for helper in "${sparkle_current}/Updater.app" "${sparkle_current}/Autoupdate"; do
        [[ -e "${helper}" ]] || continue
        codesign --force "${extra_args[@]}" --sign "${sign_id}" "${helper}"
    done
    codesign --force "${extra_args[@]}" --sign "${sign_id}" "${FRAMEWORKS_DIR}/Sparkle.framework"
}

if [[ "${ADHOC}" == "1" ]]; then
    echo "==> Signing (ad-hoc, local dev only — never distributed)"
    # Even ad-hoc, dyld refuses an unsigned framework on macOS 13+.
    # --timestamp=none is what ad-hoc does anyway; passing it keeps the
    # extra-args array non-empty, which macOS's bash 3.2 needs under set -u.
    sign_sparkle_nested "-" --timestamp=none
    codesign --force --sign - "${APP_DIR}"
    exit 0
fi

# ─── Developer ID ────────────────────────────────────────────────────────
if [[ -z "${DEV_ID:-}" ]]; then
    echo "ERROR: Developer ID signing requires the DEV_ID env var" >&2
    echo "       Example: DEV_ID='Developer ID Application: Your Name (TEAMID)'" >&2
    exit 3
fi
[[ -f "${ENTITLEMENTS}" ]] || { echo "ERROR: entitlements not found at ${ENTITLEMENTS}" >&2; exit 3; }

# Embed the update key when the caller supplies it. A Sparkle EdDSA public key
# is 44 base64 chars (32 bytes) ending in '='.
if [[ -n "${SUPUBLIC_KEY:-}" ]]; then
    key="$(printf '%s' "${SUPUBLIC_KEY}" | tr -d '[:space:]')"
    if [[ ! "${key}" =~ ^[A-Za-z0-9+/]{43}=$ ]]; then
        echo "ERROR: SUPUBLIC_KEY is not a 44-char base64 Ed25519 key; refusing to embed it" >&2
        exit 4
    fi
    /usr/libexec/PlistBuddy -c "Set :SUPublicEDKey ${key}" "${PLIST}" 2>/dev/null \
        || /usr/libexec/PlistBuddy -c "Add :SUPublicEDKey string ${key}" "${PLIST}"
fi

# Whatever the source, refuse to Developer-ID-sign an app whose updater is not
# fully configured. Missing SUPublicEDKey strands users on that build (this
# exact hole shipped build 21); missing hardening keys accept unsigned feeds.
fail_plist() { echo "ERROR: Info.plist $1 — refusing to sign a distributable build" >&2; exit 4; }
[[ "$(plist_get SUPublicEDKey)" =~ ^[A-Za-z0-9+/]{43}=$ ]] || fail_plist "has no well-formed SUPublicEDKey"
[[ "$(plist_get SUFeedURL)" == "${EXPECTED_FEED_URL}" ]] || fail_plist "SUFeedURL is not ${EXPECTED_FEED_URL}"
[[ "$(plist_get SUVerifyUpdateBeforeExtraction)" == "true" ]] || fail_plist "lacks SUVerifyUpdateBeforeExtraction=true"
[[ "$(plist_get SURequireSignedFeed)" == "true" ]] || fail_plist "lacks SURequireSignedFeed=true"

echo "==> Signing with the configured Developer ID (hardened runtime, secure timestamp)"
sign_sparkle_nested "${DEV_ID}" --options runtime --timestamp
codesign --force --options runtime --timestamp \
    --entitlements "${ENTITLEMENTS}" \
    --sign "${DEV_ID}" "${APP_DIR}"

# --deep is deprecated for signing but still the strictest verification.
codesign --verify --deep --strict --verbose=2 "${APP_DIR}"

# Assert the properties notarization and Gatekeeper depend on, quietly: the
# detailed output names the team, which stays out of logs.
details="$(codesign -d --verbose=4 "${APP_DIR}" 2>&1)"
grep -qE '^CodeDirectory .*flags=0x[0-9a-f]*\([^)]*runtime' <<<"${details}" \
    || { echo "ERROR: ${APP_DIR} is not signed with the hardened runtime" >&2; exit 5; }
grep -q '^Timestamp=' <<<"${details}" \
    || { echo "ERROR: ${APP_DIR} has no secure timestamp" >&2; exit 5; }
grep -q '^Authority=Developer ID Application: ' <<<"${details}" \
    || { echo "ERROR: ${APP_DIR} is not signed by a Developer ID Application certificate" >&2; exit 5; }
unset details

echo "==> Signed ${APP_DIR} (Developer ID, hardened runtime, timestamped)"
