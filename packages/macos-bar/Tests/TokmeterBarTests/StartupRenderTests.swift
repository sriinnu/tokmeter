import AppKit
import SwiftUI
import XCTest
@testable import TokmeterBar

final class StartupRenderTests: XCTestCase {
    @MainActor
    func testRenderActionableStartupErrors() throws {
        guard let directory = ProcessInfo.processInfo.environment["TOKMETER_UI_QA_DIR"] else {
            throw XCTSkip("Set TOKMETER_UI_QA_DIR for startup layout inspection")
        }
        let root = URL(fileURLWithPath: directory)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let view = VStack(alignment: .leading, spacing: 16) {
            ConnectionIssueView(error: "Install Node.js 18 or later, then choose Retry. Tokmeter needs Node to run its local usage service.",
                                needsNodeSetup: true, isRetrying: false, retry: {})
            ConnectionIssueView(error: DaemonError.versionMismatch(2).localizedDescription,
                                needsNodeSetup: false, isRetrying: false, retry: {})
            ConnectionIssueView(error: "Couldn't start the usage service: the request timed out. Check your connection, then retry.",
                                needsNodeSetup: false, isRetrying: false, retry: {})
        }
        .padding(12)
        .frame(width: 320)
        .background(Color(red: 0.035, green: 0.04, blue: 0.07))
        .environment(\.colorScheme, .dark)
        let renderer = ImageRenderer(content: view)
        renderer.scale = 2
        let image = try XCTUnwrap(renderer.nsImage)
        let bitmap = try XCTUnwrap(NSBitmapImageRep(data: XCTUnwrap(image.tiffRepresentation)))
        let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
        try png.write(to: root.appendingPathComponent("startup-errors.png"))
    }
}
