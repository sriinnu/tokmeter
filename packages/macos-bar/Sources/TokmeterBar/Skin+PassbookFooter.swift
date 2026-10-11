// Skin+PassbookFooter.swift — the Passbook skin's footer: the book's back
// page. Small print in muted printer mono (branch, version, pricing as of),
// a navy "UPDATE BOOK" key struck like a stamp, navy icon keys that invert
// on hover, and a lamp reading LIVE / OFFLINE like the cover. No animation.

import SwiftUI

enum PassbookFooter: SkinFooterSpec {
    @MainActor static func key(symbol: String, hovered: Bool, disabled: Bool) -> AnyView {
        AnyView(
            Image(systemName: symbol)
                .font(.system(size: 11.5, weight: .semibold))
                .foregroundColor(hovered && !disabled ? PassbookSkin.page : PassbookSkin.navy)
                .frame(width: 24, height: 22)
                .background(hovered && !disabled ? PassbookSkin.navy : Color.clear)
                .overlay(Rectangle().strokeBorder(PassbookSkin.navy, lineWidth: 1))
                .opacity(disabled ? 0.4 : 1)
        )
    }

    /// Navy key with gilt type. While a refresh runs it reads UPDATING… —
    /// the label changes instead of anything spinning.
    @MainActor static func refreshKey(label: String, angle: Double, busy: Bool) -> AnyView {
        AnyView(
            Text(busy ? "UPDATING…" : "UPDATE BOOK")
                .font(.system(size: 9, weight: .heavy, design: .serif))
                .tracking(1.3)
                .foregroundColor(PassbookSkin.gilt)
                .padding(.horizontal, 9)
                .frame(height: 22)
                .background(PassbookSkin.navy)
                .overlay(Rectangle().strokeBorder(PassbookSkin.gilt.opacity(0.5), lineWidth: 0.75).padding(2))
                .opacity(busy ? 0.75 : 1)
                .accessibilityLabel(busy ? "Updating book" : label)
        )
    }

    @MainActor static func lamp(isAlive: Bool, isVisible: Bool) -> AnyView {
        AnyView(
            HStack(spacing: 5) {
                Circle()
                    .fill(isAlive ? PassbookSkin.green : PassbookSkin.red)
                    .frame(width: 7, height: 7)
                Text(isAlive ? "LIVE" : "OFFLINE")
                    .font(.system(size: 9, weight: .heavy, design: .serif))
                    .tracking(1.3)
                    .foregroundColor(PassbookSkin.navy)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(isAlive ? "Usage service live" : "Usage service offline")
        )
    }

    static var printFont: Font { .system(size: 9, weight: .regular, design: .monospaced) }
    static var printColor: Color { PassbookSkin.muted }
    static var ruleColor: Color { PassbookSkin.navy }
}
