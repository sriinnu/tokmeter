import AppKit
import SwiftUI

/// A single native blur samples the desktop. Surfaces above it use translucent
/// fills, so nested materials don't muddy the background or blur the readings.
struct FrostedGlassBackground: View {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        ZStack {
            if reduceTransparency {
                Color(red: 0.92, green: 0.95, blue: 0.97)
            } else {
                DesktopFrost()
            }
            LinearGradient(
                colors: [Color.white.opacity(0.24), Color.white.opacity(0.06),
                         Color(red: 0.62, green: 0.77, blue: 0.88).opacity(0.10)],
                startPoint: .topLeading, endPoint: .bottomTrailing
            )
            Rectangle().strokeBorder(Color.white.opacity(0.52), lineWidth: 0.5)
        }
        .allowsHitTesting(false)
    }
}

struct FrostedGlassPanel: View {
    var cornerRadius: CGFloat = 14
    var tint: Color = .white

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        shape
            .fill(LinearGradient(colors: [Color.white.opacity(0.28), Color.white.opacity(0.10)],
                                 startPoint: .topLeading, endPoint: .bottomTrailing))
            .overlay(shape.fill(tint.opacity(0.018)))
            .overlay(shape.strokeBorder(
                LinearGradient(colors: [Color.white.opacity(0.65), Color.white.opacity(0.12),
                                        Color(red: 0.26, green: 0.38, blue: 0.48).opacity(0.09)],
                               startPoint: .topLeading, endPoint: .bottomTrailing), lineWidth: 0.5))
            .shadow(color: Color(red: 0.14, green: 0.24, blue: 0.32).opacity(0.035), radius: 8, x: 0, y: 3)
    }
}

private struct DesktopFrost: NSViewRepresentable {
    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.material = .popover
        view.blendingMode = .behindWindow
        view.state = .active
        view.appearance = NSAppearance(named: .aqua)
        return view
    }

    func updateNSView(_ nsView: NSVisualEffectView, context: Context) {}
}
