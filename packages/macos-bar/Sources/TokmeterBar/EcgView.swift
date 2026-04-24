// EcgView.swift — a tiny, always-moving ECG-style trace that signals "alive."
//
// Design intent:
//   - Gives the popover a visible heartbeat so users trust the data is live.
//   - Placed in the hero header as a compact strip next to the value.
//
// Performance notes:
//   - Built on `TimelineView(.animation(minimumInterval:))` + `Canvas` so the
//     view repaints at a fixed target rate (30 fps) without invalidating
//     surrounding SwiftUI views. The parent tree does NOT re-render per frame.
//   - Canvas drawing uses GPU-accelerated CoreGraphics via SwiftUI. We only
//     build a lightweight `Path` each tick — no allocations beyond that.
//   - When the popover closes, SwiftUI unmounts this view and the timeline
//     stops, so there's zero CPU cost while the menu bar is idle.
//
// The waveform is synthesized analytically from a phase-within-cycle value —
// no array of samples, no state growth over time. O(width/step) per tick.

import SwiftUI

/// A compact live ECG-style trace. Put this anywhere you'd use a "live dot";
/// it communicates the same thing with far more confidence.
struct EcgView: View {
    /// Primary line color — usually the theme's accent or phosphor color.
    let color: Color
    /// Seconds per beat. Lower = faster heartbeat; 1.8 feels natural.
    var beatInterval: Double = 1.8
    /// Horizontal scroll speed in points/sec. 40 is brisk without blurring the pulse.
    var scrollSpeed: Double = 40.0

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { timeline in
            Canvas { ctx, size in
                // Time since a stable epoch — used both for scroll offset and
                // to sample the waveform. Stable across redraws of this view.
                let t = timeline.date.timeIntervalSinceReferenceDate

                // Build the visible slice of the waveform. Step of 1.5pt keeps
                // the line smooth enough at 30 fps without busy-looping the CPU.
                var path = Path()
                let midY = size.height * 0.5
                let amp = size.height * 0.42

                var started = false
                for xInt in stride(from: 0.0, through: size.width, by: 1.5) {
                    // Convert the pixel's x into the virtual time it represents,
                    // so the same phase-point "slides" leftward across frames.
                    let timeAtX = t - (size.width - xInt) / scrollSpeed
                    let y = midY - ecgSample(atTime: timeAtX, cycle: beatInterval) * amp
                    let p = CGPoint(x: xInt, y: y)
                    if !started { path.move(to: p); started = true }
                    else        { path.addLine(to: p) }
                }

                // Main stroke — crisp, consistent line weight.
                ctx.stroke(
                    path,
                    with: .color(color),
                    style: StrokeStyle(lineWidth: 1.3, lineCap: .round, lineJoin: .round)
                )

                // Soft afterglow layer — adds a subtle "phosphor" trail without
                // needing a separate blur pass. Two-stroke composite costs nothing
                // extra given Canvas batches draw calls.
                ctx.stroke(
                    path,
                    with: .color(color.opacity(0.35)),
                    style: StrokeStyle(lineWidth: 2.8, lineCap: .round, lineJoin: .round)
                )
            }
        }
    }

    /// Sample the synthesized ECG waveform at the given time.
    /// Produces a reasonable PQRST shape: flat baseline, small P bump, sharp
    /// QRS spike, small T wave. Returned value is roughly in [-0.5, 1.0].
    private func ecgSample(atTime t: Double, cycle: Double) -> Double {
        // Wrap time to the interval [0, cycle) so we repeat every heartbeat.
        let phase = t.truncatingRemainder(dividingBy: cycle) / cycle
        switch phase {
        // P wave — soft half-sine, 5% of the cycle
        case 0.10..<0.15:
            return sin((phase - 0.10) / 0.05 * .pi) * 0.18
        // Q dip just before the spike
        case 0.20..<0.22:
            return -0.25
        // R spike — single triangular peak, the "beat"
        case 0.22..<0.25:
            // Triangle: rises to 1.0 at the midpoint, falls back
            let local = (phase - 0.22) / 0.03       // 0 → 1 across the spike
            return 1.0 - abs(local * 2.0 - 1.0)     // peak at 0.5
        // S dip just after
        case 0.25..<0.27:
            return -0.4
        // T wave — gentle half-sine, 10% of the cycle
        case 0.35..<0.45:
            return sin((phase - 0.35) / 0.10 * .pi) * 0.28
        default:
            return 0.0
        }
    }
}
