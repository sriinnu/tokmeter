// Shared by the live popover and the fixture-backed visual demo.
import SwiftUI

struct UsageOverview: View {
    @ObservedObject var loader: TokmeterLoader
    let theme: AppTheme
    @State private var showAllSessions = false
    @Binding var showUsageDetails: Bool
    var showRates: Binding<Bool>? = nil

    init(loader: TokmeterLoader, theme: AppTheme, showUsageDetails: Binding<Bool> = .constant(false),
         showRates: Binding<Bool>? = nil) {
        self.loader = loader
        self.theme = theme
        _showUsageDetails = showUsageDetails
        self.showRates = showRates
    }

    var body: some View {
        // Built once per render: the label is both the disclosure's content
        // and the signal that the style should omit its own chevron.
        let customDisclosure = theme.skin?.spec.disclosureLabel(expanded: showUsageDetails, theme: theme)
        VStack(alignment: .leading, spacing: 16) {
            if !loader.topModels.isEmpty || !loader.todayModels.isEmpty || loader.isWarming {
                ModelsSection(loader: loader, theme: theme, showRates: showRates)
            }
            if !loader.todayProjects.isEmpty || loader.isWarming {
                SessionsSection(loader: loader, theme: theme, showAll: $showAllSessions)
            }
            if let custom = theme.skin?.spec.footnote(
                "Model and project costs may combine estimates and tool reports.", theme: theme) {
                custom
            } else {
                Text("Model and project costs may combine estimates and tool reports.")
                    .font(theme == .paper
                          ? .system(size: 10, design: .serif).italic()
                          : .system(size: 9, design: theme.fonts.bodyDesign))
                    .foregroundColor(theme.backgroundMode.secondaryTextColor)
            }
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
                if let custom = customDisclosure {
                    custom
                } else if theme == .paper {
                    Kicker(text: "Usage details")
                } else {
                    Text("Usage details")
                        .foregroundStyle(theme.backgroundMode.primaryTextColor)
                }
            }
            .disclosureGroupStyle(FullRowDisclosureStyle(
                paper: theme == .paper,
                customLabel: customDisclosure != nil))
            .font(.system(size: 11, weight: .medium, design: theme.fonts.bodyDesign))
            .tint(theme.backgroundMode.secondaryTextColor)
        }
    }
}

/// One button owns the chevron, label, and remaining row width, so every
/// click toggles once and keyboard activation uses the same action.
private struct FullRowDisclosureStyle: DisclosureGroupStyle {
    /// Paper: a ruled kicker row with a printer's triangle, not a chevron.
    var paper = false
    /// A skin drew the whole label, chevron included.
    var customLabel = false

    func makeBody(configuration: Configuration) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if paper { InkRule() }
            Button {
                configuration.isExpanded.toggle()
            } label: {
                HStack(spacing: 5) {
                    if customLabel {
                        EmptyView()
                    } else if paper {
                        Text(configuration.isExpanded ? "▾" : "▸")
                            .font(.system(size: 10, weight: .heavy))
                            .foregroundStyle(Broadsheet.ink)
                            .accessibilityHidden(true)
                    } else {
                        Image(systemName: configuration.isExpanded ? "chevron.down" : "chevron.right")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(.secondary)
                            .accessibilityHidden(true)
                    }
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
