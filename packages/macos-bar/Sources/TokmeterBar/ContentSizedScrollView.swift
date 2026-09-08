import SwiftUI

/// Shrinks when disclosure content closes, while keeping long content scrollable.
struct ContentSizedScrollView<Content: View>: View {
    let maximumHeight: CGFloat
    @ViewBuilder var content: Content
    @State private var contentHeight: CGFloat?

    var body: some View {
        ScrollView(.vertical, showsIndicators: true) {
            content
                .fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in
                    guard height > 0 else { return }
                    contentHeight = height
                }
        }
        // Give the initial layout room to measure its content. A one-point
        // bootstrap can prevent a popover's scroll content from ever mounting.
        .frame(height: min(contentHeight ?? maximumHeight, maximumHeight))
    }
}
