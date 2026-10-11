// HubKpiTile.swift — Big-number stat tile for the Hub header row.

import SwiftUI

/// Themed KPI card: accent-colored icon pip, big value, small label. Hovers
/// lift slightly — the same idiom as the bar's popover rows.
struct HubKpiTile: View {
    let label: String
    let value: String
    let icon: String
    let accent: Color
    let theme: AppTheme

    @State private var hovered = false

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        if theme.skin != nil {
            skinBody
        } else if theme == .paper {
            paperBody
        } else {
            standardBody
        }
    }

    /// Paper: a market-table column. Kicker over a serif figure, no icon.
    private var paperBody: some View {
        HubCard(theme: theme) {
            VStack(alignment: .leading, spacing: 6) {
                HubPaperLabel(text: label)
                Text(value)
                    .font(Broadsheet.display(26, weight: .bold))
                    .monospacedDigit()
                    .foregroundColor(Broadsheet.ink)
                    .contentTransition(.numericText())
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .accessibilityElement(children: .combine)
        }
    }

    /// Skins: the skin's label over a figure in its value face; money in
    /// its cost ink. No icon pip — the skin's card carries the identity.
    private var skinBody: some View {
        HubCard(theme: theme) {
            VStack(alignment: .leading, spacing: 6) {
                HubSkinLabel(text: label, theme: theme)
                HubSkinFigure(value: value, size: 26, theme: theme, money: value.hasPrefix("$"))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .accessibilityElement(children: .combine)
        }
    }

    private var standardBody: some View {
        HubCard(theme: theme) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    Image(systemName: icon)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(accent)
                    Text(label.uppercased())
                        .font(.system(size: 9, weight: .semibold, design: theme.fonts.labelDesign))
                        .tracking(0.7)
                        .foregroundColor(bg.secondaryTextColor)
                        .lineLimit(1)
                }
                Text(value)
                    .font(.system(size: 22, weight: .bold, design: theme.fonts.valueDesign))
                    .foregroundColor(bg.primaryTextColor)
                    .contentTransition(.numericText())
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .accessibilityElement(children: .combine)
        }
        .scaleEffect(hovered ? 1.015 : 1.0)
        .offset(y: hovered ? -1 : 0)
        .animation(.spring(response: 0.32, dampingFraction: 0.70), value: hovered)
        .onHover { hovered = $0 }
    }
}
