// Skin+PumpFooter.swift — the Pump skin's footer: the pump's control panel.
//
// Icon keys are square stencil keys set into the housing, Refresh is the
// pump's red START/RESET push button, and the lamp matches the header lamp.
// Nothing animates continuously; the Refresh arrow turns only while a
// refresh runs.

import SwiftUI

enum PumpFooter: SkinFooterSpec {
    @MainActor static func key(symbol: String, hovered: Bool, disabled: Bool) -> AnyView {
        AnyView(
            Image(systemName: symbol)
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(hovered && !disabled ? PumpSkin.amber : PumpSkin.cream)
                .frame(width: 24, height: 22)
                .background(RoundedRectangle(cornerRadius: 4).fill(PumpSkin.housingDeep))
                .overlay(
                    RoundedRectangle(cornerRadius: 4)
                        .strokeBorder(hovered && !disabled ? PumpSkin.amber : PumpSkin.cream.opacity(0.45),
                                      lineWidth: 1)
                )
                .overlay(alignment: .bottom) {
                    // Key travel: a darker lip under the cap.
                    Rectangle().fill(Color.black.opacity(0.3)).frame(height: 1.5).padding(.horizontal, 2)
                }
                .opacity(disabled ? 0.4 : 1)
        )
    }

    @MainActor static func refreshKey(label: String, angle: Double, busy: Bool) -> AnyView {
        AnyView(
            HStack(spacing: 5) {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 10, weight: .heavy))
                    .rotationEffect(.degrees(angle))
                Text(label.uppercased())
                    .font(PumpSkin.plateFont(12))
                    .tracking(1.4)
            }
            .foregroundColor(.white)
            .padding(.horizontal, 11)
            .frame(height: 22)
            .background(
                Capsule().fill(
                    RadialGradient(colors: [Color(red: 0.91, green: 0.32, blue: 0.29),
                                            Color(red: 0.62, green: 0.13, blue: 0.10)],
                                   center: UnitPoint(x: 0.5, y: 0.3), startRadius: 1, endRadius: 40))
            )
            .overlay(Capsule().strokeBorder(Color(red: 0.30, green: 0.05, blue: 0.05), lineWidth: 1.2))
            .opacity(busy ? 0.8 : 1)
        )
    }

    @MainActor static func lamp(isAlive: Bool, isVisible: Bool) -> AnyView {
        AnyView(
            HStack(spacing: 6) {
                Circle()
                    .fill(isAlive ? PumpSkin.lampGreen : PumpSkin.lampRed)
                    .frame(width: 8, height: 8)
                    .overlay(Circle().strokeBorder(Color.black.opacity(0.25), lineWidth: 0.5))
                Text(isAlive ? "LIVE" : "OFF")
                    .font(PumpSkin.plateFont(12))
                    .tracking(1.4)
                    .foregroundColor(PumpSkin.cream)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(isAlive ? "Usage service live" : "Usage service offline")
        )
    }

    static var printFont: Font { .system(size: 9.5, weight: .regular, design: .monospaced) }
    static var printColor: Color { PumpSkin.creamDim }
    static var ruleColor: Color { PumpSkin.cream.opacity(0.25) }
}
