import SwiftUI

/// Hugs its content so the popover is dynamic-height, and only becomes a
/// capped, scrollable area once the content would exceed `maximumHeight`.
///
/// The earlier version always wrapped the content in a `ScrollView` whose frame
/// fell back to `maximumHeight` until the content measured itself
/// (`contentHeight ?? maximumHeight`). On the first layout — and any time the
/// measurement lagged — that reserved the full maximum height even when the
/// content was tiny, so at a low-content moment (start of day, no active agent)
/// the popover opened with a large empty frosted gap instead of hugging its
/// content. Measuring in a background `GeometryReader` (independent of any
/// scroll clipping) and rendering the content directly until it genuinely
/// overflows removes that reserve entirely: the window is exactly as tall as
/// what it shows, and only caps + scrolls when there's too much to fit.
struct ContentSizedScrollView<Content: View>: View {
    let maximumHeight: CGFloat
    @ViewBuilder var content: Content
    @State private var contentHeight: CGFloat?

    private var measuredContent: some View {
        content
            .fixedSize(horizontal: false, vertical: true)
            .background(
                GeometryReader { proxy in
                    Color.clear
                        .onAppear { contentHeight = proxy.size.height }
                        .onChange(of: proxy.size.height) { _, height in
                            guard height > 0 else { return }
                            contentHeight = height
                        }
                }
            )
    }

    var body: some View {
        // Overflow only once we've measured content taller than the cap. Until
        // then — and whenever it fits — render directly so the view hugs its
        // content and the popover stays dynamic-height with no empty reserve.
        if let height = contentHeight, height > maximumHeight {
            ScrollView(.vertical, showsIndicators: true) {
                measuredContent
            }
            .frame(height: maximumHeight)
        } else {
            measuredContent
        }
    }
}
