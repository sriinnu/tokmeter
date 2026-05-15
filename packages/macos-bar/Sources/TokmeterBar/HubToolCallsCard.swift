// HubToolCallsCard.swift — Per-tool cost breakdown for the Hub.
//
// Bars spring-grow on appear with staggered timing (60ms / row); uniform
// 0.78 damping (rank-aware was over-engineered — users don't perceive 0.62
// vs 0.80 at 60ms stagger). After settle, no continuous animation.

import SwiftUI

/// The "Today's tools" card — title + count summary + a column of animated
/// ToolCallRows. Caps at top 8 tools by cost. Hidden by the parent when
/// `tools.byTool` is empty.
struct HubToolCallsCard: View {
    let tools: ToolCallsToday
    let theme: AppTheme

    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        HubCard(theme: theme) {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Today's tools")
                        .font(.system(size: 13, weight: .semibold, design: theme.fonts.labelDesign))
                        .foregroundColor(bg.primaryTextColor)
                    Spacer()
                    Text(String(
                        format: "$%.2f across %d call(s) in %d turn(s)",
                        tools.totalCost, tools.callCount, tools.turnsWithTools
                    ))
                        .font(.system(size: 10, design: theme.fonts.bodyDesign))
                        .foregroundColor(bg.secondaryTextColor)
                        .contentTransition(.numericText())
                }
                VStack(spacing: 6) {
                    ForEach(Array(tools.byTool.prefix(8).enumerated()), id: \.element.id) {
                        index, entry in
                        ToolCallRow(entry: entry, rank: index, theme: theme)
                    }
                }
            }
        }
    }
}

/// One tool's cost row. Bar grows from 0 to its target width with a spring
/// that overshoots slightly for the leader, settles crisply for the rest.
/// Each row staggers in by rank so the list "assembles" instead of slamming.
struct ToolCallRow: View {
    let entry: ToolCallEntry
    let rank: Int
    let theme: AppTheme

    @State private var grown = false
    @State private var hovered = false

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    /// Color rotates through a 5-stop wheel by rank so neighboring rows
    /// don't read as the same color. Hot accent for the dominant tool;
    /// cool drift for the long tail.
    private var accent: Color {
        switch rank % 5 {
        case 0: return c.highlight
        case 1: return c.accent
        case 2: return c.secondary
        case 3: return c.warm
        default: return c.tertiary
        }
    }

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: iconForTool(entry.tool))
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(accent)
                .frame(width: 16)
            Text(entry.tool)
                .font(.system(size: 11, weight: .medium, design: theme.fonts.labelDesign))
                .foregroundColor(bg.primaryTextColor)
                .frame(width: 100, alignment: .leading)
                .lineLimit(1)
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 3)
                        .fill(bg.secondaryTextColor.opacity(0.08))
                        .frame(height: 6)
                    RoundedRectangle(cornerRadius: 3)
                        .fill(
                            LinearGradient(
                                colors: [accent.opacity(0.95), accent.opacity(0.6)],
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                        )
                        .frame(
                            width: max(2, geo.size.width * (grown ? entry.share : 0)),
                            height: 6
                        )
                }
            }
            .frame(height: 6)
            Text(String(format: "$%.2f", entry.cost))
                .font(.system(size: 11, weight: .semibold, design: theme.fonts.valueDesign))
                .foregroundColor(bg.primaryTextColor)
                .frame(width: 64, alignment: .trailing)
                .contentTransition(.numericText(value: entry.cost))
            Text("\(entry.calls)×")
                .font(.system(size: 10, design: theme.fonts.bodyDesign))
                .foregroundColor(bg.secondaryTextColor)
                .frame(width: 36, alignment: .trailing)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(
            RoundedRectangle(cornerRadius: 5)
                .fill(hovered ? accent.opacity(0.06) : Color.clear)
        )
        .onHover { hovered = $0 }
        .onAppear {
            // Uniform 0.78 damping across all rows — rank-aware was clever
            // but users don't perceive 0.62 vs 0.80 at 60ms stagger, and a
            // single bouncy bar reads as "weird, why is just the first one
            // wobbly." Wave-like stagger is enough character on its own.
            withAnimation(
                .spring(response: 0.55, dampingFraction: 0.78)
                    .delay(Double(rank) * 0.06)
            ) {
                grown = true
            }
        }
    }

    /// Map common Claude Code tool names to SF Symbols. Anything unmatched
    /// falls back to the wrench fallback.
    ///
    /// Read uses non-filled doc (looking only), Write uses the macOS compose
    /// idiom `square.and.pencil` (modification). Monitor uses an uptrend
    /// chart (waveform is audio-coded). ToolSearch uses the toolbox glyph so
    /// it doesn't collide visually with the generic-fallback wrench.
    private func iconForTool(_ name: String) -> String {
        switch name {
        case "Bash":             return "terminal.fill"
        case "Read":             return "doc.text"
        case "Edit":             return "pencil.line"
        case "Write":            return "square.and.pencil"
        case "Glob":             return "magnifyingglass"
        case "Grep":             return "text.magnifyingglass"
        case "Task", "Agent":    return "person.2.fill"
        case "TodoWrite",
             "TaskCreate",
             "TaskUpdate",
             "TaskList",
             "TaskGet",
             "TaskStop",
             "TaskOutput":       return "checklist"
        case "WebFetch",
             "WebSearch":        return "globe"
        case "AskUserQuestion":  return "questionmark.bubble.fill"
        case "Monitor":          return "chart.line.uptrend.xyaxis"
        case "ToolSearch":       return "wrench.and.screwdriver"
        case "NotebookEdit":     return "book.pages"
        default:                 return "wrench.fill"
        }
    }
}
