#!/usr/bin/env bash
# generate-icon.sh — create AppIcon.icns: the sealed-ledger mark (logo.svg).
#
# Draws the icon programmatically via Core Graphics (embedded Swift script)
# so there's no dependency on rsvg-convert / Inkscape / ImageMagick. Every
# Mac with Swift can run this; that's what we ship the rest of the app with
# anyway, so it's a safe bet.
#
# Run once. Commit AppIcon.icns. bundle.sh copies it into Resources/ on
# every build.

set -euo pipefail
cd "$(dirname "$0")"

ICONSET="AppIcon.iconset"
OUT="AppIcon.icns"

rm -rf "${ICONSET}"
mkdir -p "${ICONSET}"

# Core Graphics renderer. Writes a single 1024×1024 PNG; sips downscales
# from there. Drawing once keeps the glyph consistent across sizes.
SWIFT_SRC=$(mktemp -t tokmeter-icon-render-XXXXXX.swift)
BASE_PNG=$(mktemp -t tokmeter-icon-XXXXXX).png

cat > "${SWIFT_SRC}" <<'SWIFT'
import AppKit
import CoreGraphics

// Same 64-unit geometry as logo.svg and site/public/icon.svg, so every
// surface shows one mark. `small` draws the 16–32 px master: a brighter ramp
// and a solid live cell, because an outline blurs away at those sizes.
let size: CGFloat = 1024
let outPath = CommandLine.arguments[1]
let small = CommandLine.arguments.count > 2 && CommandLine.arguments[2] == "small"

guard let ctx = CGContext(
    data: nil,
    width: Int(size),
    height: Int(size),
    bitsPerComponent: 8,
    bytesPerRow: 0,
    space: CGColorSpace(name: CGColorSpace.sRGB)!,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else {
    fputs("failed to create CGContext\n", stderr)
    exit(1)
}

func hex(_ v: UInt32) -> CGColor {
    CGColor(
        srgbRed: CGFloat((v >> 16) & 0xff) / 255,
        green: CGFloat((v >> 8) & 0xff) / 255,
        blue: CGFloat(v & 0xff) / 255,
        alpha: 1
    )
}

ctx.clear(CGRect(x: 0, y: 0, width: size, height: size))

// Flip to SVG's top-left origin, then map the 64-unit tile onto the Apple
// icon grid: 64 px margin, 896 px tile, so 1 unit = 14 px.
let margin: CGFloat = 64
let unit = (size - 2 * margin) / 64
ctx.translateBy(x: 0, y: size)
ctx.scaleBy(x: 1, y: -1)
ctx.translateBy(x: margin, y: margin)
ctx.scaleBy(x: unit, y: unit)

func rounded(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, _ r: CGFloat) -> CGPath {
    CGPath(roundedRect: CGRect(x: x, y: y, width: w, height: h), cornerWidth: r, cornerHeight: r, transform: nil)
}

// Tile, with the hairline edge the SVG master carries.
ctx.addPath(rounded(0, 0, 64, 64, 14))
ctx.setFillColor(hex(0x171B25))
ctx.fillPath()
if !small {
    ctx.addPath(rounded(0.5, 0.5, 63, 63, 13.5))
    ctx.setStrokeColor(hex(0x2A3142))
    ctx.setLineWidth(1)
    ctx.strokePath()
}

// Eight sealed days, row by row; the ninth cell is today.
let detail: [UInt32] = [0x3B2F7A, 0x5B45C9, 0x8B7CFF, 0x5B45C9, 0xB4A8FF, 0x3B2F7A, 0x8B7CFF, 0x5B45C9]
let bright: [UInt32] = [0x5B45C9, 0x8B7CFF, 0xB4A8FF, 0x8B7CFF, 0xB4A8FF, 0x5B45C9, 0xB4A8FF, 0x8B7CFF]
let ramp = small ? bright : detail
let origins: [CGFloat] = [7, 25, 43]
for (i, color) in ramp.enumerated() {
    ctx.addPath(rounded(origins[i % 3], origins[i / 3], 14, 14, small ? 3 : 3.5))
    ctx.setFillColor(hex(color))
    ctx.fillPath()
}

let amber = hex(0xF5B841)
if small {
    ctx.addPath(rounded(43, 43, 14, 14, 3))
    ctx.setFillColor(amber)
    ctx.fillPath()
} else {
    ctx.addPath(rounded(44.25, 44.25, 11.5, 11.5, 2.5))
    ctx.setStrokeColor(amber)
    ctx.setLineWidth(2.5)
    ctx.strokePath()
    ctx.addEllipse(in: CGRect(x: 50 - 2.6, y: 50 - 2.6, width: 5.2, height: 5.2))
    ctx.setFillColor(amber)
    ctx.fillPath()
}

guard let image = ctx.makeImage() else {
    fputs("failed to snapshot CGImage\n", stderr)
    exit(1)
}
let rep = NSBitmapImageRep(cgImage: image)
guard let data = rep.representation(using: .png, properties: [:]) else {
    fputs("failed to encode PNG\n", stderr)
    exit(1)
}
try data.write(to: URL(fileURLWithPath: outPath))
SWIFT

SMALL_PNG=$(mktemp -t tokmeter-icon-small-XXXXXX).png
echo "==> Rendering 1024x1024 masters via Core Graphics"
swift "${SWIFT_SRC}" "${BASE_PNG}"
swift "${SWIFT_SRC}" "${SMALL_PNG}" small

# macOS .iconset layout: 10 PNGs at the standard sizes, downscaled by sips.
# 16 and 32 px come from the small master; everything larger from the detail one.
declare -a sizes=(
    "16 icon_16x16.png"
    "32 icon_16x16@2x.png"
    "32 icon_32x32.png"
    "64 icon_32x32@2x.png"
    "128 icon_128x128.png"
    "256 icon_128x128@2x.png"
    "256 icon_256x256.png"
    "512 icon_256x256@2x.png"
    "512 icon_512x512.png"
    "1024 icon_512x512@2x.png"
)

for entry in "${sizes[@]}"; do
    size="${entry%% *}"
    name="${entry#* }"
    src="${BASE_PNG}"
    [[ "${size}" -le 32 ]] && src="${SMALL_PNG}"
    echo "==> Writing ${name} (${size}px)"
    sips -z "${size}" "${size}" "${src}" --out "${ICONSET}/${name}" >/dev/null
done

rm -f "${SWIFT_SRC}" "${BASE_PNG}" "${SMALL_PNG}"

# Compile the .iconset folder into a single .icns file.
echo "==> Compiling ${OUT}"
iconutil -c icns "${ICONSET}" -o "${OUT}"
rm -rf "${ICONSET}"

echo "==> ${OUT} built ($(du -sh "${OUT}" | cut -f1))"
