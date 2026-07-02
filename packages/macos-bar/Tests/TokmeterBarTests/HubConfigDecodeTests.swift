import XCTest

@testable import TokmeterBar

/// Guards config.json decode robustness — specifically that a file written
/// BEFORE menubarColorSource existed still decodes (the field is optional and
/// falls back to .context), and that a present value is honored. This is the
/// forward/backward-compat contract the daemon's config rewrite relies on.
final class HubConfigDecodeTests: XCTestCase {
    private func decode(_ json: String) throws -> HubUserConfig {
        try JSONDecoder().decode(HubUserConfig.self, from: Data(json.utf8))
    }

    /// A config from before the color feature — no bar.menubarColorSource key.
    private let legacyJSON = """
        {
          "version": 1,
          "bar": { "refreshSeconds": 30 },
          "daemon": { "scanIntervalSeconds": 60 },
          "cli": { "defaultRange": "all", "defaultSort": "cost" },
          "alerts": { "dailyCostThreshold": null },
          "modifiedBy": "user",
          "modifiedAt": "2026-01-01T00:00:00Z"
        }
        """

    func testLegacyConfigWithoutColorSourceDecodesToDefault() throws {
        let cfg = try decode(legacyJSON)
        XCTAssertNil(cfg.bar.menubarColorSource) // absent in the file
        XCTAssertEqual(cfg.colorSource, .context) // nil-safe accessor → default
    }

    func testPresentColorSourceIsHonored() throws {
        let json = legacyJSON.replacingOccurrences(
            of: "\"refreshSeconds\": 30",
            with: "\"refreshSeconds\": 30, \"menubarColorSource\": \"block\""
        )
        let cfg = try decode(json)
        XCTAssertEqual(cfg.bar.menubarColorSource, .block)
        XCTAssertEqual(cfg.colorSource, .block)
    }

    func testDefaultsExposeContextColorSource() {
        XCTAssertEqual(HubUserConfig.defaults.colorSource, .context)
    }
}
