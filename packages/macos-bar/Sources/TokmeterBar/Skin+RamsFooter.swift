// Skin+RamsFooter.swift — the Rams skin's footer: the calculator's key row.
//
// Icon keys are small round face-coloured keys; Refresh is the one yellow
// "=" key, the only coloured control on the body. The lamp is green only
// while the usage service is live. Nothing moves continuously: a running
// refresh shows as the "=" key held down, not as a spinner.

import SwiftUI

enum RamsFooter: SkinFooterSpec {
    private static let keySize: CGFloat = 24

    @MainActor static func key(symbol: String, hovered: Bool, disabled: Bool) -> AnyView {
        AnyView(
            Image(systemName: symbol)
                .font(.system(size: 10.5, weight: .medium))
                .foregroundColor(RamsSkin.ink)
                .frame(width: keySize, height: keySize)
                .background(
                    Circle()
                        .fill(RamsSkin.face)
                        .shadow(color: .black.opacity(hovered ? 0.30 : 0.20), radius: 0, x: 0, y: hovered ? 2 : 1.5)
                )
                .overlay(Circle().strokeBorder(RamsSkin.ink.opacity(0.18), lineWidth: 0.5))
                .offset(y: hovered ? -0.5 : 0)
                .opacity(disabled ? 0.4 : 1)
                .contentShape(Circle())
        )
    }

    @MainActor static func refreshKey(label: String, angle: Double, busy: Bool) -> AnyView {
        // `angle` would spin; Rams holds the key down instead. The "=" key
        // carries a caption: a bare equals sign doesn't say "refresh".
        AnyView(
            HStack(spacing: 6) {
                Text("=")
                    .font(.system(size: 17, weight: .medium, design: .monospaced))
                    .foregroundColor(RamsSkin.ink)
                    .frame(width: 30, height: 30)
                    .background(
                        Circle()
                            .fill(LinearGradient(colors: [RamsSkin.yellow, RamsSkin.yellowDeep],
                                                 startPoint: .top, endPoint: .bottom))
                            .shadow(color: Color(red: 0.54, green: 0.42, blue: 0.0).opacity(busy ? 0 : 0.9),
                                    radius: 0, x: 0, y: busy ? 0 : 2)
                    )
                    .offset(y: busy ? 1.5 : 0)
                    .opacity(busy ? 0.8 : 1)
                    .contentShape(Circle())
                RamsSkin.legendText(label, color: RamsSkin.ink)
            }
            .help(busy ? "Refreshing…" : "Refresh (⌘R)")
        )
    }

    @MainActor static func lamp(isAlive: Bool, isVisible: Bool) -> AnyView {
        AnyView(HStack(spacing: 5) {
            Circle()
                .fill(isAlive ? RamsSkin.live : RamsSkin.unlit)
                .overlay(Circle().strokeBorder(RamsSkin.ink.opacity(0.25), lineWidth: 0.5))
                .frame(width: 8, height: 8)
            RamsSkin.legendText(isAlive ? "Live" : "Offline", color: isAlive ? RamsSkin.ink : RamsSkin.muted)
        })
    }

    static var printFont: Font { .system(size: 9.5, weight: .medium) }
    static var printColor: Color { RamsSkin.muted }
    static var ruleColor: Color { RamsSkin.ink.opacity(0.14) }
}
