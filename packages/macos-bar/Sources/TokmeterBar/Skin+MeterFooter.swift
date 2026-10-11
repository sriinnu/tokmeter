// Skin+MeterFooter.swift — the Meter skin's footer: the meter's control
// strip. Icon actions are black bakelite keys (the CACHE key's family),
// Refresh is a labelled key, the daemon state is an indicator lamp with an
// engraved legend, and the small print is stamped like a serial plate.
// Nothing animates except the Refresh glyph while a refresh actually runs.

import SwiftUI

enum MeterFooter: SkinFooterSpec {
    @MainActor static func key(symbol: String, hovered: Bool, disabled: Bool) -> AnyView {
        AnyView(
            Image(systemName: symbol)
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(Color(white: hovered ? 1 : 0.9))
                .frame(width: 26, height: 22)
                .background(MeterFooterKey(lit: hovered))
                .opacity(disabled ? 0.45 : 1)
        )
    }

    @MainActor static func refreshKey(label: String, angle: Double, busy: Bool) -> AnyView {
        AnyView(
            HStack(spacing: 5) {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 9.5, weight: .bold))
                    .rotationEffect(.degrees(angle))
                Text(label.uppercased())
                    .font(.system(size: 9, weight: .semibold))
                    .tracking(1.2)
                    .lineLimit(1)
                    .fixedSize()
            }
            .foregroundColor(Color(white: 0.92))
            .padding(.horizontal, 9)
            .frame(height: 22)
            .background(MeterFooterKey(lit: busy))
        )
    }

    @MainActor static func lamp(isAlive: Bool, isVisible: Bool) -> AnyView {
        let color = isAlive ? MeterSkin.Plate.ledGreen : MeterSkin.Plate.ledRed
        return AnyView(
            HStack(spacing: 6) {
                Circle()
                    .fill(RadialGradient(colors: [color, color.opacity(0.75)],
                                         center: UnitPoint(x: 0.35, y: 0.3), startRadius: 0, endRadius: 8))
                    .overlay(Circle().strokeBorder(Color.black.opacity(0.45), lineWidth: 0.6))
                    .frame(width: 8, height: 8)
                    .shadow(color: color.opacity(0.8), radius: 3)
                Text(isAlive ? "LIVE" : "OFFLINE")
                    .font(.system(size: 9, weight: .semibold))
                    .tracking(1.4)
                    .lineLimit(1)
                    .fixedSize()
                    .foregroundColor(MeterSkin.Plate.ink)
                    .shadow(color: .white.opacity(0.7), radius: 0, x: 0, y: 1)
            }
        )
    }

    /// Stamped like a serial plate: small monospaced type.
    static var printFont: Font { .system(size: 9.5, weight: .medium, design: .monospaced) }
    static var printColor: Color { MeterSkin.Plate.muted }
    /// An engraved cut, the same tone as the face's grooves.
    static var ruleColor: Color { Color(red: 0.16, green: 0.17, blue: 0.19).opacity(0.45) }
}

/// A black bakelite key face, slightly lit when hovered or working.
private struct MeterFooterKey: View {
    let lit: Bool

    var body: some View {
        RoundedRectangle(cornerRadius: 4)
            .fill(LinearGradient(colors: [Color(white: lit ? 0.32 : 0.235), Color(white: lit ? 0.12 : 0.07)],
                                 startPoint: .top, endPoint: .bottom))
            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Color.black, lineWidth: 1))
            .shadow(color: .black.opacity(0.9), radius: 0, x: 0, y: 1.5)
    }
}
