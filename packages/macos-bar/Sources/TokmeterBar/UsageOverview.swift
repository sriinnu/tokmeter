// Shared by the live popover and the fixture-backed visual demo.
import SwiftUI

struct UsageOverview: View {
    @ObservedObject var loader: TokmeterLoader
    let theme: AppTheme
    @State private var showAllSessions = false
    @State private var showUsageDetails = false

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
            DisclosureGroup("Usage details", isExpanded: $showUsageDetails) {
                VStack(spacing: 14) {
                    SignalsRibbon(loader: loader, theme: theme)
                    StatsGrid(loader: loader, theme: theme)
                    if loader.recentDaily.count > 1 || loader.isWarming {
                        WeekSection(loader: loader, theme: theme)
                    }
                }
                .padding(.top, 10)
            }
            .font(.system(size: 11, weight: .medium, design: theme.fonts.bodyDesign))
            .tint(theme.backgroundMode.secondaryTextColor)
        }
    }
}
