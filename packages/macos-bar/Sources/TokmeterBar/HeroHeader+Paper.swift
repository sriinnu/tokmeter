// HeroHeader+Paper.swift — Paper's front page.
//
// Replaces the rounded hero card with a masthead: dateline (today, edition
// number = days in the ledger, live status), the nameplate, a double rule,
// then today's two figures as front-page columns split by a column rule.
// Same data and states as every other theme's hero.

import SwiftUI

extension HeroHeader {
    var paperMasthead: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center, spacing: 8) {
                Kicker(text: BroadsheetDateline.date())
                    .lineLimit(1)
                    .fixedSize()
                // The edition number gives way first when a live session
                // needs the room; the date never wraps.
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) {
                        Text("·").font(Broadsheet.kickerFont).foregroundColor(Broadsheet.muted)
                        Kicker(text: BroadsheetDateline.edition(daysRecorded: loader.allDaily.count),
                               color: Broadsheet.muted)
                            .lineLimit(1)
                            .fixedSize()
                    }
                    EmptyView()
                }
                .layoutPriority(-1)
                Spacer(minLength: 4)
                cacheWalletToggle
                statusIndicator
            }
            .frame(minHeight: 22)
            .padding(.bottom, 4)

            InkRule(weight: 0.5)

            Text("The Tokmeter")
                .font(Broadsheet.display(28))
                .tracking(-0.6)
                .foregroundColor(Broadsheet.ink)
                .frame(maxWidth: .infinity)
                .padding(.top, 4)
                .padding(.bottom, 3)
                .accessibilityAddTraits(.isHeader)

            DoubleRule()

            paperFigures
                .padding(.top, 8)

            paperBreakdown
        }
        .padding(.horizontal, 18)
        .padding(.top, 8)
        .padding(.bottom, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Broadsheet.stock)
    }

    @ViewBuilder
    private var paperFigures: some View {
        switch loader.daemonPhase {
        case .warming:
            skeletonHero
        case .offline, .needsNode:
            offlineHero
        case .live:
            HStack(alignment: .top, spacing: 14) {
                paperFigure(Fmt.number(loader.todayTokens), kicker: "Tokens today")
                Rectangle().fill(Broadsheet.ink.opacity(0.35)).frame(width: 1)
                paperFigure(estimatedCostText, kicker: "Est. API cost today")
                    .help("Usage valued at model API rates. Tool-reported costs are listed separately below.")
            }
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func paperFigure(_ value: String, kicker: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Kicker(text: kicker, color: Broadsheet.muted)
            Text(value)
                .font(Broadsheet.display(34))
                .monospacedDigit()
                .tracking(-0.8)
                .foregroundColor(Broadsheet.ink)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    /// The cost-basis footnotes, set as leader rows.
    @ViewBuilder
    private var paperBreakdown: some View {
        if loader.daemonPhase == .live, let basis = loader.statbarSignals?.costBasisToday {
            VStack(alignment: .leading, spacing: 3) {
                if basis.reportedRecords > 0 {
                    leaderRow("Tool-reported cost", Fmt.cost(basis.reportedCost))
                }
                if basis.unavailableRecords > 0 {
                    Text("Cost unavailable for some usage")
                        .foregroundColor(theme.statusWarning)
                } else if basis.estimatedRecords + basis.reportedRecords == 0 {
                    Text("No usage recorded today").foregroundColor(Broadsheet.muted)
                }
            }
            .font(.system(size: 11, design: .serif))
            .padding(.top, 6)
            .help("API estimates value usage at model rates. Tool-reported costs come from local usage records. Neither is a verified subscription bill.")
        }
    }

    private func leaderRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Text(label).foregroundColor(Broadsheet.ink2)
            LeaderDots()
            Text(value).fontWeight(.bold).monospacedDigit().foregroundColor(Broadsheet.ink)
        }
        .accessibilityElement(children: .combine)
    }
}
