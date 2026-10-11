// HubSkin.swift — the Hub, dressed by the selected skin.
//
// Paper's Hub is bespoke (HubBroadsheet.swift). The five skins get theirs
// from what each skin already defines for the popover, so a skin needs no
// Hub-specific code to look like itself:
//
//   cards        → the skin's Card behind the content
//   card titles  → the skin's SectionHead
//   figures      → the skin's value face and money ink
//   labels       → tracked capitals in the skin's label face
//   controls     → square-ish keys in the skin's ink and corner radius
//
// Every view here is reached only when `theme.skin != nil`; the other
// themes keep their own paths untouched.

import SwiftUI

/// A card title in the skin's section-head style.
struct HubSkinTitle: View {
    let text: String
    var count: String? = nil
    let theme: AppTheme

    var body: some View {
        if let skin = theme.skin {
            SkinSectionHead(skin: skin, label: text.uppercased(),
                            count: count.flatMap { Int($0) } ?? 0, theme: theme)
        }
    }
}

/// Tracked capitals over a figure (KPI tiles, pulse columns, sidebar).
struct HubSkinLabel: View {
    let text: String
    let theme: AppTheme
    var color: Color? = nil

    var body: some View {
        Text(text.uppercased())
            .font(theme.fonts.label(size: 9, weight: .heavy))
            .tracking(1.3)
            .foregroundColor(color ?? theme.backgroundMode.secondaryTextColor)
            .lineLimit(1)
    }
}

/// A figure in the skin's value face. Money takes the skin's cost ink.
struct HubSkinFigure: View {
    let value: String
    let size: CGFloat
    let theme: AppTheme
    var money = false
    var active = true

    var body: some View {
        Text(value)
            .font(theme.fonts.value(size: size).monospacedDigit())
            .foregroundColor(money ? theme.costInk : theme.backgroundMode.primaryTextColor)
            .opacity(active ? 1 : 0.55)
            .contentTransition(.numericText())
            .lineLimit(1)
            .minimumScaleFactor(0.85)
    }
}

/// The page head: the skin's hero face for the title, its body face for the
/// standfirst, and a rule in its ink.
struct HubSkinPageHeader: View {
    let theme: AppTheme
    let title: String
    let subtitle: String
    var dateline: String? = nil

    var body: some View {
        let bg = theme.backgroundMode
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(theme.skin?.spec.displayName.uppercased() ?? "")
                    .font(theme.fonts.label(size: 9, weight: .heavy))
                    .tracking(2)
                    .foregroundColor(theme.colors.accent)
                Spacer(minLength: 0)
                if let dateline {
                    Text(dateline.uppercased())
                        .font(theme.fonts.label(size: 9, weight: .heavy))
                        .tracking(1.4)
                        .foregroundColor(bg.secondaryTextColor)
                        .lineLimit(1)
                }
            }
            Text(title)
                .font(theme.fonts.hero(size: 30))
                .foregroundColor(bg.primaryTextColor)
            Text(subtitle)
                .font(theme.fonts.body(size: 12))
                .foregroundColor(bg.secondaryTextColor)
            Rectangle()
                .fill(bg.primaryTextColor.opacity(0.35))
                .frame(height: 1)
                .padding(.top, 6)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Key shape for skin controls: the skin's corner radius, an ink outline,
/// filled (inverse video) when primary or pressed.
struct HubSkinKey: ViewModifier {
    let theme: AppTheme
    var filled = false

    func body(content: Content) -> some View {
        let bg = theme.backgroundMode
        let radius = min(theme.skin?.spec.cornerRadius ?? 6, 8)
        content
            .foregroundColor(filled ? bg.surfaceColor : bg.primaryTextColor)
            .background(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .fill(filled ? bg.primaryTextColor : bg.primaryTextColor.opacity(0.06))
            )
            .overlay(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(bg.primaryTextColor.opacity(filled ? 0 : 0.45), lineWidth: 1)
            )
    }
}

extension View {
    func hubSkinKey(_ theme: AppTheme, filled: Bool = false) -> some View {
        modifier(HubSkinKey(theme: theme, filled: filled))
    }
}

struct HubSkinButtonStyle: ButtonStyle {
    let theme: AppTheme
    var primary = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(theme.fonts.label(size: 10, weight: .heavy))
            .tracking(0.8)
            .textCase(.uppercase)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .hubSkinKey(theme, filled: primary != configuration.isPressed)
            .contentShape(Rectangle())
    }
}
