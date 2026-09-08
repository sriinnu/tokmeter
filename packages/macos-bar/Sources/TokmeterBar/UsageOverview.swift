// Shared by the live popover and the fixture-backed visual demo.
import SwiftUI

struct UsageOverview: View {
    @ObservedObject var loader: TokmeterLoader
    let theme: AppTheme
    @State private var showAllSessions = false
    @Binding var showUsageDetails: Bool

    init(loader: TokmeterLoader, theme: AppTheme, showUsageDetails: Binding<Bool> = .constant(false)) {
        self.loader = loader
        self.theme = theme
        _showUsageDetails = showUsageDetails
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if !loader.topModels.isEmpty || !loader.todayModels.isEmpty || loader.isWarming {
                ModelsSection(loader: loader, theme: theme)
            }
            if !loader.todayProjects.isEmpty || loader.isWarming {
                SessionsSection(loader: loader, theme: theme, showAll: $showAllSessions)
            }
            Text("Model and project costs may combine estimates and tool reports.")
                .font(.system(size: 9, design: theme.fonts.bodyDesign))
                .foregroundColor(theme.backgroundMode.secondaryTextColor)
            DisclosureGroup(isExpanded: $showUsageDetails) {
                VStack(spacing: 14) {
                    SignalsRibbon(loader: loader, theme: theme)
                    StatsGrid(loader: loader, theme: theme)
                    if loader.recentDaily.count > 1 || loader.isWarming {
                        WeekSection(loader: loader, theme: theme)
                    }
                }
                .padding(.top, 10)
            } label: {
                Text("Usage details")
                    .foregroundStyle(theme.backgroundMode.primaryTextColor)
            }
            .disclosureGroupStyle(FullRowDisclosureStyle())
            .font(.system(size: 11, weight: .medium, design: theme.fonts.bodyDesign))
            .tint(theme.backgroundMode.secondaryTextColor)
        }
    }
}

/// One button owns the chevron, label, and remaining row width, so every
/// click toggles once and keyboard activation uses the same action.
private struct FullRowDisclosureStyle: DisclosureGroupStyle {
    func makeBody(configuration: Configuration) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                configuration.isExpanded.toggle()
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: configuration.isExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .accessibilityHidden(true)
                    configuration.label
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 4)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(configuration.isExpanded ? "Expanded" : "Collapsed")
            if configuration.isExpanded {
                configuration.content
            }
        }
    }
}
