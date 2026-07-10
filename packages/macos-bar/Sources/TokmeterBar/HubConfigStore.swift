// HubConfigStore.swift — in-process mirror of ~/.tokmeter/config.json.
//
// The bar and the Hub both read/write the same user-config file the CLI
// owns (packages/core/src/config-service.ts). Swift keeps a thin in-memory
// copy and atomically writes any mutation back to disk with `modifiedBy:
// "user"` so a later cross-machine restore won't silently clobber edits
// made here.
//
// Consumers:
//   - TokmeterLoader subscribes to $config and restarts its refresh timer
//     whenever bar.refreshSeconds changes.
//   - HubSettingsPanel reads/writes the entire struct via `update { ... }`.
//
// The struct and field validation intentionally mirror config-service.ts's
// `UserConfig` so both sides agree on schema, including min/max clamping.

import Combine
import Foundation

// ─── Schema ───────────────────────────────────────────────────────────────

enum ConfigModifiedBy: String, Codable {
    case user
    case tokmeter
}

enum ConfigDefaultRange: String, Codable, CaseIterable, Identifiable {
    case all, today, week, month, year
    var id: String { rawValue }
    var label: String {
        switch self {
        case .all:   return "All time"
        case .today: return "Today"
        case .week:  return "Last 7 days"
        case .month: return "This month"
        case .year:  return "This year"
        }
    }
}

enum ConfigDefaultSort: String, Codable, CaseIterable, Identifiable {
    case cost, tokens, activeDays
    var id: String { rawValue }
    var label: String {
        switch self {
        case .cost:       return "Cost"
        case .tokens:     return "Tokens"
        case .activeDays: return "Active days"
        }
    }
}

/// Which live signal tints the menubar. Mirrors MenubarColorSource in
/// packages/core/src/config-service.ts — keep the raw values identical.
enum MenubarColorSource: String, Codable, CaseIterable, Identifiable {
    case off, context, block, budget
    var id: String { rawValue }
    var label: String {
        switch self {
        case .off:     return "Off"
        case .context: return "Context window fill"
        case .block:   return "5-hour billing block"
        case .budget:  return "Cost vs daily budget"
        }
    }
}

struct HubUserConfig: Codable {
    struct BarConfig: Codable {
        var refreshSeconds: Int
        /// Optional so a config.json written before this field existed still
        /// decodes; nil means the default (context). Use `colorSource` to read.
        var menubarColorSource: MenubarColorSource?
    }
    struct DaemonConfig: Codable {
        var scanIntervalSeconds: Int
        /// Off by default, deliberately. Reads a CSRF token out of
        /// Antigravity's own running process and calls its undocumented
        /// internal status RPC — real enough to run unsupervised and
        /// indefinitely in the background that it needs an explicit,
        /// durable opt-in (see config-service.ts for the full rationale).
        var antigravityLivePolling: Bool
    }
    struct CliConfig: Codable {
        var defaultRange: ConfigDefaultRange
        var defaultSort: ConfigDefaultSort
    }
    struct AlertsConfig: Codable {
        var dailyCostThreshold: Double?
    }

    var version: Int
    var bar: BarConfig
    var daemon: DaemonConfig
    var cli: CliConfig
    var alerts: AlertsConfig
    /// Extra per-provider search paths (config-service.ts). No Hub UI for
    /// this yet — edit config.json by hand — but it must still round-trip:
    /// without this field, saving any *other* Hub setting would silently
    /// drop a hand-edited providerPaths entry on the next disk write.
    var providerPaths: [String: [String]]
    var modifiedBy: ConfigModifiedBy
    var modifiedAt: String

    /// Menubar color source with the nil-safe default applied.
    var colorSource: MenubarColorSource { bar.menubarColorSource ?? .context }

    static let defaults = HubUserConfig(
        version: 1,
        bar: .init(refreshSeconds: 30, menubarColorSource: .context),
        daemon: .init(scanIntervalSeconds: 60, antigravityLivePolling: false),
        cli: .init(defaultRange: .all, defaultSort: .cost),
        alerts: .init(dailyCostThreshold: nil),
        providerPaths: [:],
        modifiedBy: .tokmeter,
        modifiedAt: ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: 0))
    )
}

// ─── Store ────────────────────────────────────────────────────────────────

/// Global singleton. Lazy-loaded on first access — TokmeterLoader subscribes
/// via Combine so UI edits propagate to the bar's refresh cadence without any
/// manual plumbing.
@MainActor
final class HubConfigStore: ObservableObject {
    static let shared = HubConfigStore()

    @Published private(set) var config: HubUserConfig

    /// Where the file lives. Same path the CLI uses in config-service.ts.
    static let filePath: String = {
        let home = NSHomeDirectory()
        return "\(home)/.tokmeter/config.json"
    }()

    private init() {
        self.config = Self.loadFromDisk() ?? .defaults
    }

    /// Atomic update: mutate in memory, stamp user flag + timestamp, then
    /// write to disk. Subscribers on `$config` see the new value immediately.
    func update(_ mutate: (inout HubUserConfig) -> Void) {
        var next = config
        mutate(&next)
        next.modifiedBy = .user
        next.modifiedAt = ISO8601DateFormatter().string(from: Date())
        config = next
        saveToDisk(next)
    }

    /// Reload from disk — used when reopening the Settings panel in case the
    /// user also edited the file by hand, or the CLI wrote to it.
    func reload() {
        if let fresh = Self.loadFromDisk() {
            self.config = fresh
        }
    }

    /// Reset to defaults but stamp as user-flagged so a later restore merge
    /// won't resurrect old values from a pre-existing snapshot.
    func reset() {
        var fresh = HubUserConfig.defaults
        fresh.modifiedBy = .user
        fresh.modifiedAt = ISO8601DateFormatter().string(from: Date())
        config = fresh
        saveToDisk(fresh)
    }

    // MARK: - Disk IO

    private static func loadFromDisk() -> HubUserConfig? {
        guard FileManager.default.fileExists(atPath: filePath),
              let data = try? Data(contentsOf: URL(fileURLWithPath: filePath)) else {
            return nil
        }
        // Tolerant decode: a missing field falls back to its default so schema
        // growth on the CLI side doesn't brick the Swift side.
        if let decoded = try? JSONDecoder().decode(HubUserConfig.self, from: data) {
            return decoded
        }
        // Partial / old schema — try a lenient Any decode and merge over defaults.
        if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            return Self.merge(defaults: .defaults, raw: obj)
        }
        return nil
    }

    private func saveToDisk(_ cfg: HubUserConfig) {
        let dir = (Self.filePath as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(cfg) else { return }
        // Atomic replace: write to sibling tmp, rename over the real file.
        let tmp = Self.filePath + ".tmp-\(getpid())"
        do {
            try data.write(to: URL(fileURLWithPath: tmp))
            _ = try FileManager.default.replaceItemAt(
                URL(fileURLWithPath: Self.filePath),
                withItemAt: URL(fileURLWithPath: tmp)
            )
        } catch {
            // If replaceItemAt fails because the target doesn't exist, fall
            // back to a direct write — replaceItemAt is strict about that.
            try? data.write(to: URL(fileURLWithPath: Self.filePath))
        }
    }

    /// Graceful merge — used when the file parses as JSON but doesn't match
    /// the full struct shape. Each field defaults if the disk side is missing
    /// or the wrong type.
    private static func merge(defaults d: HubUserConfig, raw: [String: Any]) -> HubUserConfig {
        var out = d
        if let bar = raw["bar"] as? [String: Any] {
            // Read each bar field independently — a missing refreshSeconds must
            // not also drop menubarColorSource (they were coupled in one `if let`
            // before, silently reverting the user's color choice on the fallback
            // decode path).
            if let refresh = bar["refreshSeconds"] as? Int {
                out.bar.refreshSeconds = clamp(refresh, min: 5, max: 3600, def: d.bar.refreshSeconds)
            }
            if let cs = bar["menubarColorSource"] as? String,
               let src = MenubarColorSource(rawValue: cs) {
                out.bar.menubarColorSource = src
            }
        }
        if let daemon = raw["daemon"] as? [String: Any] {
            // Independent `if let`s, same reasoning as the `bar` block above —
            // a missing scanIntervalSeconds must not also revert
            // antigravityLivePolling (or vice versa).
            if let scan = daemon["scanIntervalSeconds"] as? Int {
                out.daemon.scanIntervalSeconds = clamp(scan, min: 10, max: 3600, def: d.daemon.scanIntervalSeconds)
            }
            // Strict bool check, no truthy coercion — mirrors the TS side's
            // `=== true` — a malformed value must never accidentally turn
            // this on.
            if let live = daemon["antigravityLivePolling"] as? Bool {
                out.daemon.antigravityLivePolling = live
            }
        }
        if let cli = raw["cli"] as? [String: Any] {
            if let r = cli["defaultRange"] as? String,
               let range = ConfigDefaultRange(rawValue: r) {
                out.cli.defaultRange = range
            }
            if let s = cli["defaultSort"] as? String,
               let sort = ConfigDefaultSort(rawValue: s) {
                out.cli.defaultSort = sort
            }
        }
        if let alerts = raw["alerts"] as? [String: Any] {
            if let t = alerts["dailyCostThreshold"] as? Double {
                out.alerts.dailyCostThreshold = t
            } else if alerts["dailyCostThreshold"] is NSNull {
                out.alerts.dailyCostThreshold = nil
            }
        }
        if let pp = raw["providerPaths"] as? [String: [Any]] {
            out.providerPaths = pp.mapValues { $0.compactMap { $0 as? String } }
        }
        if let mb = raw["modifiedBy"] as? String,
           let flag = ConfigModifiedBy(rawValue: mb) {
            out.modifiedBy = flag
        }
        if let ts = raw["modifiedAt"] as? String {
            out.modifiedAt = ts
        }
        return out
    }

    private static func clamp(_ v: Int, min lo: Int, max hi: Int, def: Int) -> Int {
        guard v >= lo && v <= hi else { return def }
        return v
    }
}
