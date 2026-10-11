// SkinFooter.swift — how a skin dresses the popover's footer.
//
// The footer keeps its controls, actions, shortcuts and popovers; a skin
// only supplies the faces: icon keys, the Refresh key, the live lamp, the
// small print and the rule above. Each skin implements this in its own
// Skin+<Name>Footer.swift.

import SwiftUI

protocol SkinFooterSpec {
    /// Face of an icon key: Hub, Settings, Update, Quit, Start/Restart.
    @MainActor static func key(symbol: String, hovered: Bool, disabled: Bool) -> AnyView
    /// Face of the Refresh key. `angle` spins while a refresh runs.
    @MainActor static func refreshKey(label: String, angle: Double, busy: Bool) -> AnyView
    /// The daemon lamp and its word ("Live" / "Offline"). Animate only
    /// while `isVisible`; respect Reduce Motion.
    @MainActor static func lamp(isAlive: Bool, isVisible: Bool) -> AnyView
    /// Small print: attribution, version, pricing freshness.
    static var printFont: Font { get }
    static var printColor: Color { get }
    /// The rule between the content and the footer.
    static var ruleColor: Color { get }
}

extension Skin {
    var footer: any SkinFooterSpec.Type {
        switch self {
        case .meter: return MeterFooter.self
        case .pump: return PumpFooter.self
        case .rams: return RamsFooter.self
        case .deck: return DeckFooter.self
        case .passbook: return PassbookFooter.self
        }
    }
}
