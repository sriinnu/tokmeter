import SwiftUI

/// Shared hover details for charts backed by recorded daily totals.
struct DailyUsageTooltip: View {
    let day: DailyUsage
    let theme: AppTheme

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(day.date)
                .foregroundColor(theme.backgroundMode.secondaryTextColor)
            Text("\(day.tokens.formatted()) tokens")
                .foregroundColor(theme.backgroundMode.primaryTextColor)
            Text("\(Fmt.cost(day.cost)) cost")
                .foregroundColor(theme.costInk)
        }
        .font(.system(size: 10, weight: .medium, design: theme.fonts.bodyDesign))
        .monospacedDigit()
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 7).fill(theme.backgroundMode.surfaceColor))
        .overlay(RoundedRectangle(cornerRadius: 7).stroke(theme.costInk.opacity(0.4)))
        .shadow(color: .black.opacity(0.2), radius: 5, y: 2)
        .fixedSize()
        .allowsHitTesting(false)
    }
}

struct SparklineUsageHover: ViewModifier {
    let days: [DailyUsage]
    let theme: AppTheme
    @State private var selected: DailyUsage?

    func body(content: Content) -> some View {
        content.overlay {
            GeometryReader { geometry in
                Color.clear.contentShape(Rectangle())
                    .onContinuousHover { phase in
                        switch phase {
                        case .active(let point):
                            guard !days.isEmpty, geometry.size.width > 0 else { selected = nil; return }
                            let fraction = min(1, max(0, point.x / geometry.size.width))
                            let index = Int((fraction * Double(days.count - 1)).rounded())
                            selected = days[index]
                        case .ended: selected = nil
                        }
                    }
            }
        }
        .overlay(alignment: .bottom) {
            if let selected {
                DailyUsageTooltip(day: selected, theme: theme).offset(y: -24)
            }
        }
    }
}
