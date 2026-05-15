// AnomalyDetail.swift — Tappable pricing-anomaly pill + drill-in sheet.
//
// The pill in the footer is the glance: "⚠︎ 6 models repriced." Click opens
// a sheet with every per-field movement, sortable and copyable, without
// stuffing it all into a tooltip.

import AppKit
import SwiftUI

/// Tappable footer pill. Pressed state squashes 0.97 with a quick spring
/// (anticipation), releases on tap, then triggers `onTap`. Pixar: motion
/// confirms the gesture before the sheet starts to rise.
struct AnomalyPill: View {
    let text: String
    let detailCount: Int
    let modelCount: Int
    let theme: AppTheme
    let onTap: () -> Void

    @State private var pressed = false
    @State private var hovered = false

    var body: some View {
        Text(text + " ›")
            .font(.system(size: 10, weight: .medium, design: theme.fonts.bodyDesign))
            .foregroundColor(.red)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(
                RoundedRectangle(cornerRadius: 5)
                    .fill(Color.red.opacity(hovered ? 0.12 : 0.06))
            )
            // Squash 0.92 instead of 0.96 — at ~80pt wide / 10pt text, the
            // smaller deformation was below the perceptual floor. 90ms dwell
            // (was 120ms) keeps the confirm snappy. The press feels like
            // touching a real button instead of "did it register?"
            .scaleEffect(pressed ? 0.92 : 1.0)
            .animation(.spring(response: 0.22, dampingFraction: 0.6), value: pressed)
            .animation(.easeInOut(duration: 0.15), value: hovered)
            .onHover { hovered = $0 }
            .onTapGesture {
                pressed = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.09) {
                    pressed = false
                    onTap()
                }
            }
            .help(
                "Click for the per-field breakdown — \(detailCount) field "
                + "movement(s) across \(modelCount) model(s)."
            )
    }
}

/// Drill-in sheet showing every anomaly row from kosha's last-24h log.
/// Anticipation: rows stagger in 40ms apart on first appear. After settle,
/// no continuous animation — just hover affordances.
struct AnomalyDetailSheet: View {
    let response: AnomaliesResponse
    let theme: AppTheme
    @Binding var isPresented: Bool

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    /// Group per-field rows back into model groups (the same collapse the
    /// footer pill does) — but here we KEEP the per-field detail visible
    /// inside each group instead of hiding it in a tooltip.
    private var groups: [AnomalyGroup] {
        collapseAnomalies(response.anomalies)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().opacity(0.4)
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(Array(groups.enumerated()), id: \.element.key) { idx, group in
                        AnomalyGroupCard(
                            group: group,
                            allAnomalies: response.anomalies,
                            rank: idx,
                            theme: theme
                        )
                    }
                }
                .padding(20)
            }
        }
        // Solid surface — a `.sheet` already presents as a modal with its
        // own backdrop, so ultraThinMaterial here would let the Hub bleed
        // through and read as "I haven't committed to being a modal."
        .background(
            (bg.isLight
                ? Color(red: 0.99, green: 0.98, blue: 0.96)
                : Color(red: 0.12, green: 0.12, blue: 0.14))
        )
        .frame(minWidth: 560, minHeight: 380)
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(.red)
            VStack(alignment: .leading, spacing: 2) {
                Text("Pricing anomalies")
                    .font(.system(size: 14, weight: .semibold, design: theme.fonts.labelDesign))
                    .foregroundColor(bg.primaryTextColor)
                Text("\(response.total) field movement(s) >25% across \(groups.count) model(s) in the last 24h")
                    .font(.system(size: 11, design: theme.fonts.bodyDesign))
                    .foregroundColor(bg.secondaryTextColor)
            }
            Spacer()
            Button {
                copyToClipboard()
            } label: {
                Image(systemName: "doc.on.doc")
                    .font(.system(size: 12))
            }
            .buttonStyle(.borderless)
            .help("Copy all anomaly rows to clipboard")
            Button {
                isPresented = false
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 16))
                    .foregroundColor(bg.secondaryTextColor)
            }
            .buttonStyle(.borderless)
            .keyboardShortcut(.escape, modifiers: [])
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
    }

    private func copyToClipboard() {
        let lines: [String] = response.anomalies.map { a in
            let dir = a.deltaPct > 0 ? "↑" : "↓"
            let pct = abs(a.deltaPct * 100)
            return String(
                format: "%@ · %@ %@ %.1f%% (%.6f → %.6f)",
                a.key, a.field, dir, pct, a.previous, a.current
            )
        }
        let text = lines.joined(separator: "\n")
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}

/// One model's anomalies as a card. Each per-field movement appears as its
/// own row inside the card — readable at a glance, no tooltip-chasing.
private struct AnomalyGroupCard: View {
    let group: AnomalyGroup
    let allAnomalies: [PricingAnomaly]
    let rank: Int
    let theme: AppTheme

    @State private var appeared = false

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "circle.hexagongrid.fill")
                    .font(.system(size: 12))
                    .foregroundColor(c.accent)
                Text(group.key)
                    .font(.system(size: 12, weight: .semibold, design: theme.fonts.labelDesign))
                    .foregroundColor(bg.primaryTextColor)
                    .textSelection(.enabled)
                Spacer()
                Text("\(group.fieldCount) field\(group.fieldCount == 1 ? "" : "s")")
                    .font(.system(size: 10, design: theme.fonts.bodyDesign))
                    .foregroundColor(bg.secondaryTextColor)
            }
            VStack(spacing: 4) {
                ForEach(rowsForGroup, id: \.id) { row in
                    AnomalyFieldRow(row: row, theme: theme)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(Color.primary.opacity(bg.isLight ? 0.04 : 0.06))
                .overlay(
                    RoundedRectangle(cornerRadius: 10)
                        .stroke(c.accent.opacity(0.12), lineWidth: 1)
                )
        )
        .opacity(appeared ? 1 : 0)
        .offset(y: appeared ? 0 : 6)
        .animation(
            .spring(response: 0.45, dampingFraction: 0.85)
                .delay(Double(rank) * 0.04),
            value: appeared
        )
        .onAppear { appeared = true }
    }

    /// All per-field rows for this group, sorted by |deltaPct| descending so
    /// the most dramatic movement reads first.
    private var rowsForGroup: [AnomalyFieldRowData] {
        allAnomalies
            .filter { $0.key == group.key }
            .sorted { abs($0.deltaPct) > abs($1.deltaPct) }
            .map { a in
                AnomalyFieldRowData(
                    id: "\(a.field)|\(a.side)|\(a.ts)",
                    field: a.field,
                    side: a.side,
                    previous: a.previous,
                    current: a.current,
                    deltaPct: a.deltaPct
                )
            }
    }
}

private struct AnomalyFieldRowData: Identifiable {
    let id: String
    let field: String
    let side: String
    let previous: Double
    let current: Double
    let deltaPct: Double
}

private struct AnomalyFieldRow: View {
    let row: AnomalyFieldRowData
    let theme: AppTheme

    private var bg: BackgroundMode { theme.backgroundMode }
    private var sign: String { row.deltaPct > 0 ? "↑" : "↓" }
    private var deltaColor: Color {
        row.deltaPct > 0 ? Color.tokDanger : Color.tokSuccess
    }

    var body: some View {
        HStack(spacing: 8) {
            Text(row.field)
                .font(.system(size: 11, weight: .medium, design: theme.fonts.labelDesign))
                .foregroundColor(bg.primaryTextColor)
                .frame(width: 100, alignment: .leading)
            Text("(\(row.side))")
                .font(.system(size: 10, design: theme.fonts.bodyDesign))
                .foregroundColor(bg.secondaryTextColor)
                .frame(width: 60, alignment: .leading)
            Spacer()
            Text(formatRate(row.previous))
                .font(.system(size: 11, design: theme.fonts.valueDesign))
                .foregroundColor(bg.secondaryTextColor)
            Image(systemName: "arrow.right")
                .font(.system(size: 9))
                .foregroundColor(bg.secondaryTextColor.opacity(0.6))
            Text(formatRate(row.current))
                .font(.system(size: 11, weight: .medium, design: theme.fonts.valueDesign))
                .foregroundColor(bg.primaryTextColor)
            Text("\(sign) \(String(format: "%.1f", abs(row.deltaPct * 100)))%")
                .font(.system(size: 11, weight: .semibold, design: theme.fonts.valueDesign))
                .foregroundColor(deltaColor)
                .frame(width: 70, alignment: .trailing)
        }
    }

    private func formatRate(_ rate: Double) -> String {
        if rate >= 1 { return String(format: "$%.2f", rate) }
        if rate >= 0.01 { return String(format: "$%.4f", rate) }
        return String(format: "$%.6f", rate)
    }
}
