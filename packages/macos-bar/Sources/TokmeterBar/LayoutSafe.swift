// LayoutSafe.swift — Auto Layout dimension guard.
//
// SwiftUI bar/progress widths are computed from live daemon data:
// `geo.size.width * someShare`, `cost / total`, `percentageOfTotal / 100`.
// If any input is non-finite (a 0 denominator slipping past a guard, an
// Infinity from the wire) or negative, the value flows into a `.frame(width:)`,
// becomes a NaN/∞ constraint constant, and AppKit's constraint pass throws an
// uncaught NSException — the app dies with EXC_BREAKPOINT inside a CATransaction
// commit. (That is exactly the Hub-open / project-detail crash in 1.5.0.)
//
// `safeDim` is the single chokepoint: clamp to a finite, non-negative value
// before it ever reaches a frame. NaN/±∞ collapse to `floor`; negatives clamp
// up to `floor`. Use it everywhere a frame dimension is computed from data.

import CoreGraphics

/// Clamp a computed layout dimension to a value Auto Layout will accept.
/// Non-finite (NaN, ±∞) → `floor`; finite values are floored at `floor`
/// (so a sensible minimum bar is always drawn and negatives can't slip in).
@inline(__always)
func safeDim(_ value: CGFloat, floor: CGFloat = 0) -> CGFloat {
    guard value.isFinite else { return floor }
    return Swift.max(floor, value)
}
