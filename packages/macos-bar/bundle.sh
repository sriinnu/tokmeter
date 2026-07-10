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
#   CFBundleShortVersionString   # semver, default 0.4.0
#   CFBundleVersion              # build number (integer), default 4
#   APP_NAME                     # default "TokmeterBar"
#
# Outputs:
#   TokmeterBar.app              # the .app bundle (always)
#   TokmeterBar-X.Y.Z.zip        # ditto-zipped, ready for upload (--release)
#   appcast.xml                  # updated with new release item (--release)

set -euo pipefail

cd "$(dirname "$0")"

# ─── Mode selection ─────────────────────────────────────────────────────
# Default: ALWAYS install to /Applications, in every mode. A build must never
# be left sitting only in the repo dir (or /tmp) — the canonical home is
# /Applications. If you explicitly want to keep the .app local without
# installing (e.g. CI producing an upload artifact), pass --no-install.
MODE="dev"
INSTALL=1
for arg in "$@"; do
    case "${arg}" in
        --release)    MODE="release" ;;
        --signed)     MODE="signed" ;;
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
SHORT_VERSION="${CFBundleShortVersionString:-1.9.0}"
BUILD_VERSION="${CFBundleVersion:-40}"
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
# Strip all surrounding whitespace/newlines: a .pub file that is just a
# trailing newline would otherwise pass the non-empty guard below and emit a
# blank <string> for SUPublicEDKey — a key that can never validate an update.
SUPUBLIC_KEY="$(printf '%s' "${SUPUBLIC_KEY}" | tr -d '[:space:]')"

# For any distributable build, refuse to proceed without the public key.
# A bundle missing SUPublicEDKey can never validate a Sparkle update — it
# ships un-updateable and strands every user on that build (this exact hole
# shipped build 21). Dev builds may skip it; signed/release must not.
if [[ "${MODE}" == "signed" || "${MODE}" == "release" ]] && [[ -z "${SUPUBLIC_KEY}" ]]; then
    echo "ERROR: SUPUBLIC_KEY is empty in ${MODE} mode — refusing to build an"
    echo "       un-updateable app with no SUPublicEDKey in Info.plist."
    echo "       Fix: source packages/macos-bar/.env (or export SUPUBLIC_KEY),"
    echo "       or place the public key at ${PRIV_KEY_PATH}.pub."
    exit 4
fi

# A Sparkle EdDSA public key is 44 base64 chars (32 bytes) ending in '='.
# A value that survives the emptiness check but is malformed (truncated env,
# partial paste) would also ship un-updateable — fail loud in signed/release.
if [[ "${MODE}" == "signed" || "${MODE}" == "release" ]] && \
   [[ ! "${SUPUBLIC_KEY}" =~ ^[A-Za-z0-9+/]{43}=$ ]]; then
    echo "ERROR: SUPUBLIC_KEY does not look like a 44-char base64 Ed25519 key:"
    echo "       '${SUPUBLIC_KEY}'"
    echo "       Refusing to embed a malformed SUPublicEDKey. Check .env."
    exit 4
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
    <key>NSHumanReadableCopyright</key>
    <string>© 2026 sriinnu. All rights reserved.</string>
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
    # Supports two auth methods:
    #   a) API Key file: TOKMETER_API_KEY_FILE (or auto-detected) + KEY_ID + ISSUER_ID (preferred)
    #   b) Apple ID: APPLE_ID + APPLE_APP_PASSWORD + APPLE_TEAM_ID (legacy)
    # Notarization defaults come from the environment only — no account key IDs,
    # issuer UUIDs, or personal key paths are baked into this tracked file.
    # Set these (or the APP_STORE_CONNECT_* vars, or the APPLE_ID trio) in
    # packages/macos-bar/.env. See .env.example.
    TOKMETER_DEFAULT_KEY="${TOKMETER_DEFAULT_KEY:-}"
    TOKMETER_DEFAULT_KEY_ID="${TOKMETER_DEFAULT_KEY_ID:-}"
    TOKMETER_DEFAULT_ISSUER="${TOKMETER_DEFAULT_ISSUER:-}"

    USE_API_KEY=0
    USE_KEY_FILE=0
    if [[ -n "${APP_STORE_CONNECT_API_KEY_P8:-}" && -n "${APP_STORE_CONNECT_KEY_ID:-}" && -n "${APP_STORE_CONNECT_ISSUER_ID:-}" ]]; then
        USE_API_KEY=1
    elif [[ -f "${TOKMETER_API_KEY_FILE:-${TOKMETER_DEFAULT_KEY}}" ]]; then
        # Auto-detect the tokmeter key file — no env vars needed for local release builds
        TOKMETER_API_KEY_FILE="${TOKMETER_API_KEY_FILE:-${TOKMETER_DEFAULT_KEY}}"
        APP_STORE_CONNECT_KEY_ID="${APP_STORE_CONNECT_KEY_ID:-${TOKMETER_DEFAULT_KEY_ID}}"
        APP_STORE_CONNECT_ISSUER_ID="${APP_STORE_CONNECT_ISSUER_ID:-${TOKMETER_DEFAULT_ISSUER}}"
        USE_KEY_FILE=1
    elif [[ -z "${APPLE_ID:-}" || -z "${APPLE_TEAM_ID:-}" || -z "${APPLE_APP_PASSWORD:-}" ]]; then
        echo "ERROR: --release requires notarization credentials."
        echo "       Option A (preferred): APP_STORE_CONNECT_API_KEY_P8 + KEY_ID + ISSUER_ID"
        echo "       Option A2 (local): set TOKMETER_DEFAULT_KEY[_ID]/_ISSUER (or TOKMETER_API_KEY_FILE)"
        echo "       Option B: APPLE_ID + APPLE_TEAM_ID + APPLE_APP_PASSWORD"
        exit 4
    fi
    if [[ -z "${RELEASE_DOWNLOAD_URL:-}" ]]; then
        echo "ERROR: --release requires RELEASE_DOWNLOAD_URL env var"
        echo "       This is the public URL where the .zip will be hosted."
        echo "       Use {VERSION} as a placeholder for the semver — it gets"
        echo "       substituted with \$SHORT_VERSION so the URL never drifts."
        echo "       Example: https://github.com/owner/repo/releases/download/v{VERSION}/${APP_NAME}-{VERSION}.zip"
        exit 4
    fi
    # Substitute {VERSION} → $SHORT_VERSION so the URL tracks the build automatically.
    # Without this, .env hardcodes a version literal and quietly drifts every release.
    RELEASE_DOWNLOAD_URL="${RELEASE_DOWNLOAD_URL//\{VERSION\}/${SHORT_VERSION}}"
    # Sanity check: URL must contain $SHORT_VERSION literally now. If user hardcoded
    # an old version and forgot to use the placeholder, fail loudly BEFORE notarizing.
    if [[ "${RELEASE_DOWNLOAD_URL}" != *"${SHORT_VERSION}"* ]]; then
        echo "ERROR: RELEASE_DOWNLOAD_URL does not contain SHORT_VERSION=${SHORT_VERSION}"
        echo "       URL: ${RELEASE_DOWNLOAD_URL}"
        echo "       Either use {VERSION} placeholder in .env or update the URL."
        echo "       Bailing now — submitting to Apple notary with a wrong-version"
        echo "       URL would publish an appcast item that points nowhere."
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
    /usr/bin/ditto --norsrc -c -k --keepParent "${APP_DIR}" "${ZIP_PATH}"

    # Strip extended attributes that would create AppleDouble files
    xattr -cr "${APP_DIR}" 2>/dev/null || true
    find "${APP_DIR}" -name '._*' -delete 2>/dev/null || true

    echo "==> Submitting to Apple notary service (this can take 5-30 minutes)"
    NOTARY_FAILED=0

    if [[ "${USE_KEY_FILE}" == "1" ]]; then
        # API Key auth using key file path directly (local release build)
        echo "==> Notarizing with key file: ${TOKMETER_API_KEY_FILE} (id: ${APP_STORE_CONNECT_KEY_ID})"
        xcrun notarytool submit "${ZIP_PATH}" \
            --key "${TOKMETER_API_KEY_FILE}" \
            --key-id "${APP_STORE_CONNECT_KEY_ID}" \
            --issuer "${APP_STORE_CONNECT_ISSUER_ID}" \
            --wait || NOTARY_FAILED=1
    elif [[ "${USE_API_KEY}" == "1" ]]; then
        # API Key auth via env var (CI)
        API_KEY_FILE=$(mktemp)
        echo "${APP_STORE_CONNECT_API_KEY_P8}" | sed 's/\\n/\n/g' > "${API_KEY_FILE}"
        trap "rm -f '${API_KEY_FILE}'" EXIT

        xcrun notarytool submit "${ZIP_PATH}" \
            --key "${API_KEY_FILE}" \
            --key-id "${APP_STORE_CONNECT_KEY_ID}" \
            --issuer "${APP_STORE_CONNECT_ISSUER_ID}" \
            --wait || NOTARY_FAILED=1
    else
        # Apple ID + app-specific password auth (legacy)
        xcrun notarytool submit "${ZIP_PATH}" \
            --apple-id "${APPLE_ID}" \
            --team-id "${APPLE_TEAM_ID}" \
            --password "${APPLE_APP_PASSWORD}" \
            --wait || NOTARY_FAILED=1
    fi

    if [[ "${NOTARY_FAILED}" == "1" ]]; then
        echo "ERROR: notarytool submit failed"
        exit 5
    fi

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

    # Remove the build-dir copy once it's installed — otherwise Spotlight and
    # Launchpad index BOTH it and the /Applications copy, so the user sees two
    # "TokmeterBar" apps. The distributable .zip (release mode) is kept; only
    # the loose .app is redundant after install. Skipped for --no-install so CI
    # still has the artifact to upload.
    rm -rf "${APP_DIR}"

    # Launch it. Use `open` so it's a fresh launch via LaunchServices,
    # which Sparkle's installer logic relies on.
    echo "    Launching /Applications/${APP_DIR}"
    open "/Applications/${APP_DIR}"
fi

echo ""
echo "Done."
case "${MODE}" in
    dev)
        if [[ "${INSTALL}" == "1" ]]; then
            echo "Status: installed to /Applications/${APP_DIR} and launched."
        else
            echo "Status: built ./${APP_DIR} (ad-hoc signed). Pass --install to deposit to /Applications."
        fi
        ;;
    signed)
        if [[ "${INSTALL}" == "1" ]]; then
            echo "Status: signed + installed to /Applications/${APP_DIR} (also Gatekeeper-friendly for AirDrop)."
        else
            echo "Status: signed .app at ./${APP_DIR} (Gatekeeper-friendly for AirDrop). Pass --install to install."
        fi
        ;;
    release)
        if [[ "${INSTALL}" == "1" ]]; then
            echo "Status: notarized + stapled + installed to /Applications/${APP_DIR}. Upload ${APP_NAME}-${SHORT_VERSION}.zip + appcast.xml."
        else
            echo "Status: notarized + stapled. Upload ${APP_NAME}-${SHORT_VERSION}.zip + appcast.xml."
        fi
        ;;
esac
