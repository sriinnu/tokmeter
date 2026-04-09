#!/usr/bin/env bash
# bundle.sh — build, sign, notarize, and package TokmeterBar.app
#
# Three modes:
#
#   ./bundle.sh                  # dev:     ad-hoc signed (no Apple ID needed)
#   ./bundle.sh --signed         # signed:  Developer ID signed (no notarization)
#   ./bundle.sh --release        # release: signed + notarized + stapled + zipped
#                                #          + appcast.xml entry generated
#
# Required environment variables for --signed and --release:
#   DEV_ID                       # "Developer ID Application: Your Name (TEAMID)"
#
# Additionally required for --release:
#   APPLE_ID                     # your Apple ID email
#   APPLE_TEAM_ID                # 10-char Team ID from developer.apple.com
#   APPLE_APP_PASSWORD           # app-specific password (NOT your Apple password)
#                                # generate at appleid.apple.com
#   SPARKLE_PRIVATE_KEY_PATH     # path to ed25519 private key (default: ./sparkle_ed25519_priv)
#   RELEASE_DOWNLOAD_URL         # public URL where the .zip will be hosted
#                                # e.g. https://github.com/owner/repo/releases/download/vX.Y.Z/TokmeterBar.zip
#
# Optional:
#   CFBundleShortVersionString   # semver, default 0.1.0
#   CFBundleVersion              # build number (integer), default 1
#   APP_NAME                     # default "TokmeterBar"
#
# Outputs:
#   TokmeterBar.app              # the .app bundle (always)
#   TokmeterBar-X.Y.Z.zip        # ditto-zipped, ready for upload (--release)
#   appcast.xml                  # updated with new release item (--release)

set -euo pipefail

cd "$(dirname "$0")"

# ─── Mode selection ─────────────────────────────────────────────────────
# Default: dev mode, ALWAYS install to /Applications. If you want to keep
# the .app local without installing, pass --no-install.
MODE="dev"
INSTALL=1
for arg in "$@"; do
    case "${arg}" in
        --release)    MODE="release"; INSTALL=0 ;;
        --signed)     MODE="signed";  INSTALL=0 ;;
        --install)    INSTALL=1 ;;          # explicit, but it's the default
        --no-install) INSTALL=0 ;;
        "")           ;;
        *)            echo "Unknown flag: ${arg}"; exit 2 ;;
    esac
done

# ─── Config ─────────────────────────────────────────────────────────────
APP_NAME="${APP_NAME:-TokmeterBar}"
APP_DIR="${APP_NAME}.app"
CONTENTS="${APP_DIR}/Contents"
MACOS_DIR="${CONTENTS}/MacOS"
RESOURCES_DIR="${CONTENTS}/Resources"
FRAMEWORKS_DIR="${CONTENTS}/Frameworks"
ENTITLEMENTS="entitlements.plist"
SHORT_VERSION="${CFBundleShortVersionString:-0.1.0}"
BUILD_VERSION="${CFBundleVersion:-1}"
SUFEED_URL="${SUFEED_URL:-https://raw.githubusercontent.com/sriinnu/tokmeter/main/packages/macos-bar/appcast.xml}"
SUPUBLIC_KEY="${SUPUBLIC_KEY:-}"  # populated below if private key is present

# ─── 1. Build the binary ────────────────────────────────────────────────
echo "==> [${MODE}] Building release binary"
swift build -c release

BINARY_PATH=".build/release/${APP_NAME}"
if [[ ! -f "${BINARY_PATH}" ]]; then
    echo "Build failed: ${BINARY_PATH} not found"
    exit 1
fi

# ─── 2. Wipe + skeleton ─────────────────────────────────────────────────
rm -rf "${APP_DIR}"
mkdir -p "${MACOS_DIR}" "${RESOURCES_DIR}" "${FRAMEWORKS_DIR}"

# ─── 3. Copy the binary + fix rpath so it finds Sparkle.framework ────────
cp "${BINARY_PATH}" "${MACOS_DIR}/${APP_NAME}"
chmod +x "${MACOS_DIR}/${APP_NAME}"

# The binary was linked with @rpath/Sparkle.framework/... but SPM didn't add
# an rpath pointing at @executable_path/../Frameworks. Add it now so dyld
# can locate Sparkle.framework relative to the binary's location in the .app.
# This mutates the binary after the linker is done with it, which invalidates
# any existing code signature — that's fine because we re-sign in step 7.
# I don't swallow errors here; a silent failure puts us right back where we
# started (dyld can't find Sparkle, app refuses to launch).
if otool -l "${MACOS_DIR}/${APP_NAME}" | grep -q "@executable_path/../Frameworks"; then
    echo "==> rpath already present"
else
    echo "==> Adding LC_RPATH @executable_path/../Frameworks"
    install_name_tool -add_rpath "@executable_path/../Frameworks" "${MACOS_DIR}/${APP_NAME}"
fi

# ─── 4. Copy Sparkle.framework if it was built ──────────────────────────
# SPM resolves Sparkle into .build/checkouts/Sparkle/. We need the
# Sparkle.framework artifact which Sparkle ships as an XCFramework.
SPARKLE_XC=".build/artifacts/sparkle/Sparkle/Sparkle.xcframework"
if [[ -d "${SPARKLE_XC}" ]]; then
    # Pick the macOS (universal) slice
    SPARKLE_SLICE="${SPARKLE_XC}/macos-arm64_x86_64"
    if [[ -d "${SPARKLE_SLICE}/Sparkle.framework" ]]; then
        cp -R "${SPARKLE_SLICE}/Sparkle.framework" "${FRAMEWORKS_DIR}/"
        echo "==> Bundled Sparkle.framework"
    fi
fi

# ─── 4b. Copy the app icon so Finder/Dock don't show a grey placeholder ──
# AppIcon.icns is produced by ./generate-icon.sh and committed to the repo.
# If it's missing, fall back to generating it on the fly.
if [[ ! -f "AppIcon.icns" ]]; then
    if [[ -x "./generate-icon.sh" ]]; then
        echo "==> AppIcon.icns missing; running generate-icon.sh"
        ./generate-icon.sh
    else
        echo "WARNING: AppIcon.icns missing and generate-icon.sh not executable"
    fi
fi
if [[ -f "AppIcon.icns" ]]; then
    cp "AppIcon.icns" "${RESOURCES_DIR}/AppIcon.icns"
    echo "==> Bundled AppIcon.icns"
fi

# ─── 5. Resolve public Sparkle key from private key (if available) ──────
PRIV_KEY_PATH="${SPARKLE_PRIVATE_KEY_PATH:-./sparkle_ed25519_priv}"
if [[ -z "${SUPUBLIC_KEY}" && -f "${PRIV_KEY_PATH}.pub" ]]; then
    SUPUBLIC_KEY=$(cat "${PRIV_KEY_PATH}.pub")
fi

# ─── 6. Write Info.plist ────────────────────────────────────────────────
cat > "${CONTENTS}/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>en</string>
    <key>CFBundleExecutable</key>
    <string>${APP_NAME}</string>
    <key>CFBundleIdentifier</key>
    <string>com.sriinnu.tokmeterbar</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>${APP_NAME}</string>
    <key>CFBundleDisplayName</key>
    <string>Tokmeter</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>CFBundleIconName</key>
    <string>AppIcon</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>${SHORT_VERSION}</string>
    <key>CFBundleVersion</key>
    <string>${BUILD_VERSION}</string>
    <key>LSMinimumSystemVersion</key>
    <string>14.0</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSPrincipalClass</key>
    <string>NSApplication</string>
    <!-- Sparkle: where to fetch the appcast and how to verify updates -->
    <key>SUFeedURL</key>
    <string>${SUFEED_URL}</string>
    <key>SUEnableInstallerLauncherService</key>
    <true/>
    <key>SUEnableAutomaticChecks</key>
    <true/>
    <key>SUScheduledCheckInterval</key>
    <integer>86400</integer>
PLIST

if [[ -n "${SUPUBLIC_KEY}" ]]; then
    cat >> "${CONTENTS}/Info.plist" <<PLIST
    <key>SUPublicEDKey</key>
    <string>${SUPUBLIC_KEY}</string>
PLIST
fi

cat >> "${CONTENTS}/Info.plist" <<'PLIST'
</dict>
</plist>
PLIST

# ─── 7. Sign ────────────────────────────────────────────────────────────
# Sparkle.framework has nested XPC services (Installer.xpc, Downloader.xpc)
# that MUST be signed before the framework itself, which must be signed before
# the parent .app. We use Versions/Current (a symlink) instead of hardcoding
# Versions/B because Sparkle bumps the version letter periodically.

sign_sparkle_nested() {
    local sign_id="$1"
    local extra_args="$2"  # e.g. "--options runtime --timestamp" for Developer ID
    [[ -d "${FRAMEWORKS_DIR}/Sparkle.framework" ]] || return 0

    local sparkle_current="${FRAMEWORKS_DIR}/Sparkle.framework/Versions/Current"
    [[ -d "${sparkle_current}" ]] || sparkle_current="${FRAMEWORKS_DIR}/Sparkle.framework/Versions/B"

    # 1. Sign every XPC service inside the framework first (deepest first)
    if [[ -d "${sparkle_current}/XPCServices" ]]; then
        for xpc in "${sparkle_current}/XPCServices/"*.xpc; do
            [[ -d "${xpc}" ]] || continue
            # shellcheck disable=SC2086
            codesign --force ${extra_args} --sign "${sign_id}" "${xpc}"
        done
    fi
    # 2. Sign the Updater.app and Autoupdate helpers
    for helper in "${sparkle_current}/Updater.app" \
                  "${sparkle_current}/Autoupdate"; do
        [[ -e "${helper}" ]] || continue
        # shellcheck disable=SC2086
        codesign --force ${extra_args} --sign "${sign_id}" "${helper}"
    done
    # 3. Sign the framework itself
    # shellcheck disable=SC2086
    codesign --force ${extra_args} --sign "${sign_id}" "${FRAMEWORKS_DIR}/Sparkle.framework"
}

case "${MODE}" in
    dev)
        echo "==> Signing (ad-hoc, dev mode)"
        # Sign Sparkle's nested components first — even ad-hoc requires this
        # because dyld refuses to load an unsigned framework on macOS 13+.
        sign_sparkle_nested "-" ""
        # Then the main app
        codesign --force --sign - "${APP_DIR}"
        ;;
    signed|release)
        if [[ -z "${DEV_ID:-}" ]]; then
            echo "ERROR: --${MODE} requires DEV_ID env var"
            echo "       Example: DEV_ID='Developer ID Application: Your Name (TEAMID)'"
            exit 3
        fi
        echo "==> Signing with Developer ID: ${DEV_ID}"

        sign_sparkle_nested "${DEV_ID}" "--options runtime --timestamp"

        # Sign the main app with hardened runtime + entitlements
        codesign --force --options runtime --timestamp \
            --entitlements "${ENTITLEMENTS}" \
            --sign "${DEV_ID}" "${APP_DIR}"

        # Verify (--deep is deprecated but still informative for diagnostics)
        codesign --verify --deep --strict --verbose=2 "${APP_DIR}"
        ;;
esac

echo "==> Built ${APP_DIR} ($(du -sh "${APP_DIR}" | cut -f1))"

# ─── 8. Notarize + staple (release only) ────────────────────────────────
if [[ "${MODE}" == "release" ]]; then
    # ALL required env vars are now FATAL on missing — no silent failures
    # in a release pipeline. If you forgot a credential, find out now, not
    # after you've shipped a broken appcast.
    if [[ -z "${APPLE_ID:-}" || -z "${APPLE_TEAM_ID:-}" || -z "${APPLE_APP_PASSWORD:-}" ]]; then
        echo "ERROR: --release requires APPLE_ID, APPLE_TEAM_ID, APPLE_APP_PASSWORD env vars"
        echo "       Generate an app-specific password at appleid.apple.com"
        exit 4
    fi
    if [[ -z "${RELEASE_DOWNLOAD_URL:-}" ]]; then
        echo "ERROR: --release requires RELEASE_DOWNLOAD_URL env var"
        echo "       This is the public URL where the .zip will be hosted."
        echo "       Example: https://github.com/owner/repo/releases/download/vX.Y.Z/${APP_NAME}-${SHORT_VERSION}.zip"
        exit 4
    fi
    if [[ ! -f "${PRIV_KEY_PATH}" ]]; then
        echo "ERROR: --release requires a Sparkle private key at ${PRIV_KEY_PATH}"
        echo "       Generate one: ./generate-sparkle-keys.sh"
        echo "       Without it, your appcast can't be signed and existing"
        echo "       users will refuse the update."
        exit 4
    fi

    ZIP_PATH="${APP_NAME}-${SHORT_VERSION}.zip"
    echo "==> Creating notarization zip: ${ZIP_PATH}"
    rm -f "${ZIP_PATH}"
    /usr/bin/ditto -c -k --keepParent "${APP_DIR}" "${ZIP_PATH}"

    echo "==> Submitting to Apple notary service (this can take 5-30 minutes)"
    # Capture the submission UUID so we can fetch the log on failure.
    NOTARY_OUT=$(mktemp)
    if ! xcrun notarytool submit "${ZIP_PATH}" \
        --apple-id "${APPLE_ID}" \
        --team-id "${APPLE_TEAM_ID}" \
        --password "${APPLE_APP_PASSWORD}" \
        --wait \
        --output-format plist > "${NOTARY_OUT}" 2>&1; then
        echo "ERROR: notarytool submit failed:"
        cat "${NOTARY_OUT}"
        # Try to extract a UUID and fetch the detailed log
        UUID=$(grep -Eo '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' "${NOTARY_OUT}" | head -1 || true)
        if [[ -n "${UUID}" ]]; then
            echo "==> Fetching detailed notarization log for ${UUID}"
            xcrun notarytool log "${UUID}" \
                --apple-id "${APPLE_ID}" \
                --team-id "${APPLE_TEAM_ID}" \
                --password "${APPLE_APP_PASSWORD}" || true
        fi
        rm -f "${NOTARY_OUT}"
        exit 5
    fi
    cat "${NOTARY_OUT}"
    rm -f "${NOTARY_OUT}"

    echo "==> Stapling notarization ticket to ${APP_DIR}"
    xcrun stapler staple "${APP_DIR}"
    xcrun stapler validate "${APP_DIR}"

    # Re-zip the stapled .app for distribution
    rm -f "${ZIP_PATH}"
    /usr/bin/ditto -c -k --keepParent "${APP_DIR}" "${ZIP_PATH}"
    ZIP_SIZE=$(stat -f%z "${ZIP_PATH}")

    echo "==> Stapled & zipped: ${ZIP_PATH} (${ZIP_SIZE} bytes)"

    # ─── 9. Sign the update with Sparkle's sign_update ──────────────
    # Find the sign_update tool — search both locations Sparkle has used.
    SIGN_TOOL=""
    for candidate in \
        ".build/artifacts/sparkle/Sparkle/bin/sign_update" \
        ".build/checkouts/Sparkle/bin/sign_update"; do
        if [[ -x "${candidate}" ]]; then
            SIGN_TOOL="${candidate}"
            break
        fi
    done
    if [[ -z "${SIGN_TOOL}" ]]; then
        SIGN_TOOL=$(find .build -name "sign_update" -type f -perm +111 2>/dev/null | head -1)
    fi
    if [[ -z "${SIGN_TOOL}" || ! -x "${SIGN_TOOL}" ]]; then
        echo "ERROR: Sparkle sign_update tool not found in .build/"
        echo "       Run 'swift build' first to fetch the SPM artifact."
        exit 6
    fi

    ED_SIG=$("${SIGN_TOOL}" -f "${PRIV_KEY_PATH}" "${ZIP_PATH}")
    echo "==> Sparkle signature: ${ED_SIG}"

    # Append a new <item> to appcast.xml.
    # Pass values via environment variables — NOT shell interpolation into a
    # heredoc — so quotes, backslashes, and Python triple-quote sequences in
    # any variable can never break the Python parser. The Python script reads
    # everything from os.environ and uses xml.etree to mutate the appcast,
    # which is whitespace-tolerant (the regex approach was fragile).
    PUB_DATE=$(date -u +"%a, %d %b %Y %H:%M:%S +0000")
    export DRISHTI_APP_NAME="${APP_NAME}"
    export DRISHTI_SHORT_VERSION="${SHORT_VERSION}"
    export DRISHTI_BUILD_VERSION="${BUILD_VERSION}"
    export DRISHTI_PUB_DATE="${PUB_DATE}"
    export DRISHTI_DOWNLOAD_URL="${RELEASE_DOWNLOAD_URL}"
    export DRISHTI_ZIP_SIZE="${ZIP_SIZE}"
    export DRISHTI_ED_SIG="${ED_SIG}"

    python3 - <<'PY'
import os
import sys
import xml.etree.ElementTree as ET

# Sparkle uses an XML namespace; register it so the writer keeps the prefix.
SPARKLE_NS = "http://www.andymatuschak.org/xml-namespaces/sparkle"
ET.register_namespace("sparkle", SPARKLE_NS)
ET.register_namespace("dc", "http://purl.org/dc/elements/1.1/")

appcast_path = "appcast.xml"
tree = ET.parse(appcast_path)
root = tree.getroot()
channel = root.find("channel")
if channel is None:
    print("ERROR: appcast.xml has no <channel> element", file=sys.stderr)
    sys.exit(1)

# Build the new <item>
item = ET.Element("item")
ET.SubElement(item, "title").text = (
    f"{os.environ['DRISHTI_APP_NAME']} {os.environ['DRISHTI_SHORT_VERSION']}"
)
ET.SubElement(item, "pubDate").text = os.environ["DRISHTI_PUB_DATE"]
ET.SubElement(item, f"{{{SPARKLE_NS}}}version").text = os.environ["DRISHTI_BUILD_VERSION"]
ET.SubElement(item, f"{{{SPARKLE_NS}}}shortVersionString").text = os.environ[
    "DRISHTI_SHORT_VERSION"
]
ET.SubElement(item, f"{{{SPARKLE_NS}}}minimumSystemVersion").text = "14.0"
desc = ET.SubElement(item, "description")
desc.text = "<p>See release notes on GitHub.</p>"

# Parse the sign_update output: "sparkle:edSignature=\"...\" length=\"...\""
# Sparkle's tool prints the attribute pair already formatted; we extract the
# signature value and reuse the length we computed locally.
import re

ed_sig = os.environ["DRISHTI_ED_SIG"]
match = re.search(r'sparkle:edSignature="([^"]+)"', ed_sig)
sig_value = match.group(1) if match else ""

enclosure = ET.SubElement(item, "enclosure")
enclosure.set("url", os.environ["DRISHTI_DOWNLOAD_URL"])
enclosure.set("length", os.environ["DRISHTI_ZIP_SIZE"])
enclosure.set("type", "application/octet-stream")
enclosure.set(f"{{{SPARKLE_NS}}}edSignature", sig_value)

# Insert as the first <item> child of <channel> so newest is on top.
existing_items = list(channel.findall("item"))
insert_at = list(channel).index(existing_items[0]) if existing_items else len(list(channel))
channel.insert(insert_at, item)

# Pretty-print and write back. ET.indent is Python 3.9+.
ET.indent(tree, space="    ")
tree.write(appcast_path, encoding="utf-8", xml_declaration=True)
print("==> appcast.xml updated with new <item>")
PY
fi

# ─── 10. Install to /Applications + relaunch ────────────────────────────
if [[ "${INSTALL}" == "1" ]]; then
    echo "==> Installing to /Applications"

    # Stop any running instance so we can replace the .app cleanly.
    if pgrep -x "${APP_NAME}" > /dev/null; then
        echo "    Stopping running ${APP_NAME}"
        osascript -e "tell application \"${APP_NAME}\" to quit" 2>/dev/null || \
            killall "${APP_NAME}" 2>/dev/null || true
        # Give it a moment to clean up
        sleep 0.5
    fi

    rm -rf "/Applications/${APP_DIR}"
    cp -R "${APP_DIR}" /Applications/

    # Launch it. Use `open` so it's a fresh launch via LaunchServices,
    # which Sparkle's installer logic relies on.
    echo "    Launching /Applications/${APP_DIR}"
    open "/Applications/${APP_DIR}"
fi

echo ""
echo "Done."
case "${MODE}" in
    dev)     echo "Status: installed to /Applications/${APP_DIR} and launched." ;;
    signed)  echo "Status: signed .app at ./${APP_DIR} (Gatekeeper-friendly for AirDrop). Pass --install to install." ;;
    release) echo "Status: notarized + stapled. Upload ${APP_NAME}-${SHORT_VERSION}.zip + appcast.xml." ;;
esac
