#!/usr/bin/env bash
# bundle.sh — wrap the swift-built binary into a proper .app bundle
# so it can be launched, dragged into /Applications, or distributed.
#
# Usage:
#   ./bundle.sh             # build + bundle
#   ./bundle.sh --install   # also copy to /Applications

set -euo pipefail

cd "$(dirname "$0")"

APP_NAME="TokmeterBar"
APP_DIR="${APP_NAME}.app"
CONTENTS="${APP_DIR}/Contents"
MACOS_DIR="${CONTENTS}/MacOS"
RESOURCES_DIR="${CONTENTS}/Resources"

# 1. Build the binary
echo "==> Building release binary"
swift build -c release

# 2. Wipe previous bundle
rm -rf "${APP_DIR}"

# 3. Create the bundle skeleton
mkdir -p "${MACOS_DIR}" "${RESOURCES_DIR}"

# 4. Copy the binary
cp .build/release/TokmeterBar "${MACOS_DIR}/${APP_NAME}"
chmod +x "${MACOS_DIR}/${APP_NAME}"

# 5. Write Info.plist — LSUIElement=true makes it a true menubar app
#    (no Dock icon, no app switcher entry).
cat > "${CONTENTS}/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>en</string>
    <key>CFBundleExecutable</key>
    <string>TokmeterBar</string>
    <key>CFBundleIdentifier</key>
    <string>com.sriinnu.tokmeterbar</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>TokmeterBar</string>
    <key>CFBundleDisplayName</key>
    <string>Tokmeter</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>0.1.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSMinimumSystemVersion</key>
    <string>14.0</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSPrincipalClass</key>
    <string>NSApplication</string>
</dict>
</plist>
PLIST

# 6. Ad-hoc sign so macOS Gatekeeper allows the app to run locally
echo "==> Signing (ad-hoc)"
codesign --force --deep --sign - "${APP_DIR}"

echo "==> Built ${APP_DIR}"
echo "    Size: $(du -sh "${APP_DIR}" | cut -f1)"
echo ""
echo "Run:    open ${APP_DIR}"
echo "Install: cp -R ${APP_DIR} /Applications/"

if [[ "${1:-}" == "--install" ]]; then
    echo ""
    echo "==> Installing to /Applications"
    rm -rf "/Applications/${APP_DIR}"
    cp -R "${APP_DIR}" /Applications/
    echo "    Installed. Open it with: open /Applications/${APP_DIR}"
fi
