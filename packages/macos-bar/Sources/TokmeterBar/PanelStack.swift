// PanelStack.swift — the popover's vertical stack, capped in one layout pass.
//
// The popover used to size its scroll area from heights measured on the
// previous pass (hero assumed 110pt, footer 80pt until measured). A taller
// hero — any skin's front panel, or a theme switch — overshot the cap for a
// pass; the MenuBarExtra window grew to the screen's height and never shrank
// back, leaving empty bands above and below the content.
//
// A Layout measures every fixed child and the scroll child's natural height
// in the same pass, then gives the scroll child only what's left under the
// cap, so the window never grows past `maxHeight` — with one deliberate
// exception: the scroll area keeps a floor (`minScrollHeight`, 80pt) so the
// usage list is never squeezed to nothing. Only when the hero, banner and
// footer alone leave less than that under the cap (a very short display)
// does the panel exceed `maxHeight`, and then by at most the shortfall.

import SwiftUI

struct PanelStack: Layout {
    /// The tallest the whole panel may be.
    var maxHeight: CGFloat
    /// The scroll area never collapses below this, even if that pushes the
    /// total past `maxHeight` (see the note at the top of the file).
    var minScrollHeight: CGFloat = 80

    private func heights(width: CGFloat, subviews: Subviews) -> [CGFloat] {
        let natural = subviews.map {
            $0.sizeThatFits(ProposedViewSize(width: width, height: nil)).height
        }
        var result = natural
        // Children can come and go (the error banner is empty when there's
        // no error), so the scroller is tagged, not counted.
        guard let scrollIndex = subviews.firstIndex(where: { $0[PanelScrollKey.self] }) else {
            return result
        }
        let fixed = natural.enumerated()
            .filter { $0.offset != scrollIndex }
            .reduce(0) { $0 + $1.element }
        let room = max(minScrollHeight, maxHeight - fixed)
        result[scrollIndex] = min(natural[scrollIndex], room)
        return result
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 400
        return CGSize(width: width, height: heights(width: width, subviews: subviews).reduce(0, +))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for (subview, height) in zip(subviews, heights(width: bounds.width, subviews: subviews)) {
            subview.place(at: CGPoint(x: bounds.minX, y: y), anchor: .topLeading,
                          proposal: ProposedViewSize(width: bounds.width, height: height))
            y += height
        }
    }
}

private struct PanelScrollKey: LayoutValueKey {
    static let defaultValue = false
}

extension View {
    /// Marks the PanelStack child that scrolls when the panel hits its cap.
    func panelScrollArea() -> some View {
        layoutValue(key: PanelScrollKey.self, value: true)
    }
}
