// Skin+DeckFooter.swift — the Deck skin's footer: the deck's bottom rail.
//
// Icon actions are function keys set into the fascia, Refresh is a transport
// key with its own cyan lamp, the service lamp is the same red LIVE lamp as
// the front panel, and the small print is engraved legend type. Nothing
// animates except the refresh glyph, which turns only while a refresh runs.

import SwiftUI

enum DeckFooter: SkinFooterSpec {
    @MainActor static func key(symbol: String, hovered: Bool, disabled: Bool) -> AnyView {
        AnyView(
            Image(systemName: symbol)
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundColor(disabled ? DeckSkin.legend.opacity(0.45) : (hovered ? DeckSkin.cyan : DeckSkin.face))
                .frame(width: 28, height: 20)
                .background(Keycap(pressed: false, hovered: hovered && !disabled))
        )
    }

    @MainActor static func refreshKey(label: String, angle: Double, busy: Bool) -> AnyView {
        AnyView(
            HStack(spacing: 6) {
                Circle()
                    .fill(busy ? DeckSkin.cyan : DeckSkin.cyan.opacity(0.35))
                    .frame(width: 5, height: 5)
                    .shadow(color: busy ? DeckSkin.cyan.opacity(0.9) : .clear, radius: 3)
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 9.5, weight: .bold))
                    .rotationEffect(.degrees(angle))
                Text(label.uppercased())
                    .font(DeckSkin.legendFont(7.5))
                    .tracking(1.2)
                    .lineLimit(1)
                    .fixedSize()
            }
            .foregroundColor(DeckSkin.face)
            .padding(.horizontal, 9)
            .frame(height: 20)
            .background(Keycap(pressed: busy, hovered: false))
        )
    }

    @MainActor static func lamp(isAlive: Bool, isVisible: Bool) -> AnyView {
        AnyView(DeckSkin.Lamp(text: isAlive ? "Live" : "Offline", color: DeckSkin.lampRed, lit: isAlive))
    }

    static var printFont: Font { .system(size: 8, weight: .medium).width(.expanded) }
    static var printColor: Color { DeckSkin.legend }
    static var ruleColor: Color { Color(red: 0.55, green: 0.57, blue: 0.59).opacity(0.55) }

    /// A soft-touch key: brushed grey cap, black edge, a lit top lip; pressed
    /// sits darker and lower.
    private struct Keycap: View {
        let pressed: Bool
        let hovered: Bool

        var body: some View {
            RoundedRectangle(cornerRadius: 3)
                .fill(LinearGradient(
                    colors: pressed
                        ? [Color(red: 0.10, green: 0.105, blue: 0.11), Color(red: 0.14, green: 0.145, blue: 0.15)]
                        : [Color(red: hovered ? 0.29 : 0.24, green: hovered ? 0.295 : 0.245, blue: hovered ? 0.305 : 0.255),
                           Color(red: 0.15, green: 0.155, blue: 0.16)],
                    startPoint: .top, endPoint: .bottom))
                .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(Color.black, lineWidth: 1))
                .overlay(alignment: .top) {
                    if !pressed {
                        Rectangle().fill(Color.white.opacity(0.14)).frame(height: 1).padding(.horizontal, 2).padding(.top, 1)
                    }
                }
        }
    }
}
