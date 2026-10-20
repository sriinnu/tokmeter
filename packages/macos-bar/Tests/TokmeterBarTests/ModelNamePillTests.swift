import AppKit
import SwiftUI
import XCTest
@testable import TokmeterBar

final class ModelNamePillTests: XCTestCase {
    /// The pill sizes to the full id instead of truncating it, in every theme.
    @MainActor
    func testPillShowsTheWholeNameInEveryTheme() throws {
        let long = "minimax-m3.1-flash-free"
        for theme in AppTheme.allCases {
            let renderer = ImageRenderer(content:
                ModelNamePillLabel(fullName: long, provider: "opencode", theme: theme))
            let image = try XCTUnwrap(renderer.nsImage, "\(theme) did not render")
            // ~6.6pt per 11pt monospaced glyph: the whole id must fit, not
            // be squeezed into a row-name column (110pt).
            XCTAssertGreaterThan(image.size.width, CGFloat(long.count) * 6.0, "\(theme) truncated the id")
        }
    }

    /// Renders every theme's pill on that theme's surface for a visual check.
    @MainActor
    func testRenderPillsForReview() throws {
        guard let directory = ProcessInfo.processInfo.environment["TOKMETER_UI_QA_DIR"] else {
            throw XCTSkip("Set TOKMETER_UI_QA_DIR for theme inspection")
        }
        let grid = VStack(alignment: .leading, spacing: 6) {
            ForEach(AppTheme.allCases) { theme in
                HStack(spacing: 10) {
                    Text(theme.rawValue)
                        .font(.system(size: 9, design: .monospaced))
                        .frame(width: 80, alignment: .leading)
                        .foregroundColor(theme.backgroundMode.secondaryTextColor)
                    ModelNamePillLabel(fullName: "deepseek-v4-pro-flash", provider: "ribhu", theme: theme)
                }
                .padding(8)
                .frame(width: 360, alignment: .leading)
                .background(theme.backgroundMode.surfaceColor)
            }
        }
        let renderer = ImageRenderer(content: grid)
        renderer.scale = 2
        let image = try XCTUnwrap(renderer.nsImage)
        let data = try XCTUnwrap(NSBitmapImageRep(data: XCTUnwrap(image.tiffRepresentation))?
            .representation(using: .png, properties: [:]))
        try data.write(to: URL(fileURLWithPath: directory).appendingPathComponent("model-name-pills.png"))
    }
}
