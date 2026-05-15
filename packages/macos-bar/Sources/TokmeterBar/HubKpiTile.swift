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
        HubCard(theme: theme) {
            HStack(alignment: .center, spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 9)
                        .fill(accent.opacity(0.18))
                        .frame(width: 36, height: 36)
                    Image(systemName: icon)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundColor(accent)
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text(label.uppercased())
                        .font(.system(size: 9, weight: .semibold, design: theme.fonts.labelDesign))
                        .tracking(1.3)
                        .foregroundColor(bg.secondaryTextColor)
                    Text(value)
                        .font(.system(size: 20, weight: .bold, design: theme.fonts.valueDesign))
                        .foregroundColor(bg.primaryTextColor)
                        .contentTransition(.numericText())
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                }
                Spacer(minLength: 0)
            }
        }
        .scaleEffect(hovered ? 1.015 : 1.0)
        .offset(y: hovered ? -1 : 0)
        .animation(.spring(response: 0.32, dampingFraction: 0.70), value: hovered)
        .onHover { hovered = $0 }
    }
}
