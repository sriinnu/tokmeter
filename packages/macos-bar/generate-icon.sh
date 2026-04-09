#!/usr/bin/env bash
# generate-icon.sh — create AppIcon.icns with a twilight infinity glyph.
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

// I render at 1024 because that's the largest macOS icon size (@2x of 512).
let size: CGFloat = 1024
let outPath = CommandLine.arguments[1]

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

// Clear to transparent so the squircle mask shows through.
ctx.clear(CGRect(x: 0, y: 0, width: size, height: size))

// Twilight gradient background (same palette as the statusline).
// Stops: indigo -> violet -> lighter violet, top-left to bottom-right.
let cs = CGColorSpace(name: CGColorSpace.sRGB)!
let colors: CFArray = [
    CGColor(srgbRed: 0.263, green: 0.220, blue: 0.792, alpha: 1.0),  // #4338ca
    CGColor(srgbRed: 0.427, green: 0.157, blue: 0.851, alpha: 1.0),  // #6d28d9
    CGColor(srgbRed: 0.545, green: 0.361, blue: 0.965, alpha: 1.0),  // #8b5cf6
] as CFArray
let locations: [CGFloat] = [0.0, 0.5, 1.0]
let gradient = CGGradient(colorsSpace: cs, colors: colors, locations: locations)!

// macOS squircle: ~22.5% corner radius, 64px margin to match the Apple
// icon grid.
let margin: CGFloat = 64
let rect = CGRect(x: margin, y: margin, width: size - 2 * margin, height: size - 2 * margin)
let radius: CGFloat = 200
let squircle = CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil)

ctx.saveGState()
ctx.addPath(squircle)
ctx.clip()
ctx.drawLinearGradient(
    gradient,
    start: CGPoint(x: 0, y: size),
    end: CGPoint(x: size, y: 0),
    options: []
)
ctx.restoreGState()

// Subtle white inner stroke for depth.
ctx.saveGState()
ctx.addPath(squircle)
ctx.setStrokeColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 0.15))
ctx.setLineWidth(2)
ctx.strokePath()
ctx.restoreGState()

// The infinity glyph, drawn as two overlapping circles that form a lemniscate
// via a single continuous stroke. I centre it slightly below-middle so the
// visual weight sits right.
ctx.saveGState()
ctx.translateBy(x: size / 2, y: size / 2 - 28)

let infinity = CGMutablePath()
// Left lobe
infinity.move(to: CGPoint(x: -240, y: 0))
infinity.addCurve(
    to: CGPoint(x: -80, y: 40),
    control1: CGPoint(x: -240, y: -100),
    control2: CGPoint(x: -140, y: -100)
)
infinity.addLine(to: CGPoint(x: 0, y: -40))
infinity.addLine(to: CGPoint(x: 80, y: 40))
infinity.addCurve(
    to: CGPoint(x: 240, y: 0),
    control1: CGPoint(x: 140, y: -100),
    control2: CGPoint(x: 240, y: -100)
)
infinity.addCurve(
    to: CGPoint(x: 80, y: -40),
    control1: CGPoint(x: 240, y: 100),
    control2: CGPoint(x: 140, y: 100)
)
infinity.addLine(to: CGPoint(x: 0, y: 40))
infinity.addLine(to: CGPoint(x: -80, y: -40))
infinity.addCurve(
    to: CGPoint(x: -240, y: 0),
    control1: CGPoint(x: -140, y: 100),
    control2: CGPoint(x: -240, y: 100)
)
infinity.closeSubpath()

// Soft glow underneath: draw the path twice with decreasing blur.
ctx.setShadow(offset: .zero, blur: 24, color: CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 0.4))
ctx.addPath(infinity)
ctx.setStrokeColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1))
ctx.setLineWidth(56)
ctx.setLineCap(.round)
ctx.setLineJoin(.round)
ctx.strokePath()
ctx.restoreGState()

// Amber sparkle accent in the upper-right corner.
ctx.saveGState()
ctx.translateBy(x: 760, y: size - 280)  // flip y because CG is bottom-up
let sparkle = CGMutablePath()
sparkle.move(to: CGPoint(x: 0, y: -40))
sparkle.addLine(to: CGPoint(x: 8, y: -8))
sparkle.addLine(to: CGPoint(x: 40, y: 0))
sparkle.addLine(to: CGPoint(x: 8, y: 8))
sparkle.addLine(to: CGPoint(x: 0, y: 40))
sparkle.addLine(to: CGPoint(x: -8, y: 8))
sparkle.addLine(to: CGPoint(x: -40, y: 0))
sparkle.addLine(to: CGPoint(x: -8, y: -8))
sparkle.closeSubpath()
ctx.addPath(sparkle)
ctx.setFillColor(CGColor(srgbRed: 0.961, green: 0.690, blue: 0.255, alpha: 0.9))  // #f5b041
ctx.fillPath()
ctx.restoreGState()

// Serialize to PNG.
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

echo "==> Rendering base 1024x1024 PNG via Core Graphics"
swift "${SWIFT_SRC}" "${BASE_PNG}"

# macOS .iconset layout: 10 PNGs at the standard sizes. sips handles the
# downscale cleanly from the 1024px master.
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
    echo "==> Writing ${name} (${size}px)"
    sips -z "${size}" "${size}" "${BASE_PNG}" --out "${ICONSET}/${name}" >/dev/null
done

rm -f "${SWIFT_SRC}" "${BASE_PNG}"

# Compile the .iconset folder into a single .icns file.
echo "==> Compiling ${OUT}"
iconutil -c icns "${ICONSET}" -o "${OUT}"
rm -rf "${ICONSET}"

echo "==> ${OUT} built ($(du -sh "${OUT}" | cut -f1))"
