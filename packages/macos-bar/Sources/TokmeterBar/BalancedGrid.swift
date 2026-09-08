import SwiftUI

/// Reflows cards at explicit width thresholds without geometry/state feedback.
/// Allowed counts keep a four-card KPI row balanced at two columns on small windows.
struct BalancedGrid: Layout {
    let columnCounts: [Int]
    let minimumColumnWidth: CGFloat
    var spacing: CGFloat = 12

    private func metrics(width: CGFloat, subviews: Subviews) -> (columns: Int, columnWidth: CGFloat, rowHeights: [CGFloat]) {
        let columns = columnCounts.sorted(by: >).first {
            CGFloat($0) * minimumColumnWidth + CGFloat($0 - 1) * spacing <= width
        } ?? 1
        let columnWidth = max(0, (width - CGFloat(columns - 1) * spacing) / CGFloat(columns))
        var heights: [CGFloat] = []
        for start in stride(from: 0, to: subviews.count, by: columns) {
            let height = (start..<min(start + columns, subviews.count)).map {
                subviews[$0].sizeThatFits(ProposedViewSize(width: columnWidth, height: nil)).height
            }.max() ?? 0
            heights.append(height)
        }
        return (columns, columnWidth, heights)
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? minimumColumnWidth
        let layout = metrics(width: width, subviews: subviews)
        return CGSize(width: width, height: layout.rowHeights.reduce(0, +)
            + CGFloat(max(0, layout.rowHeights.count - 1)) * spacing)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let layout = metrics(width: bounds.width, subviews: subviews)
        var y = bounds.minY
        for (row, height) in layout.rowHeights.enumerated() {
            for column in 0..<layout.columns {
                let index = row * layout.columns + column
                guard index < subviews.count else { break }
                subviews[index].place(at: CGPoint(x: bounds.minX + CGFloat(column) * (layout.columnWidth + spacing), y: y),
                    anchor: .topLeading, proposal: ProposedViewSize(width: layout.columnWidth, height: height))
            }
            y += height + spacing
        }
    }
}
