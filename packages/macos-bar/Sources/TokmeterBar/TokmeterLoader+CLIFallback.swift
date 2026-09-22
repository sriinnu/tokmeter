// TokmeterLoader+CLIFallback.swift — Offline path: when the daemon isn't
// running, the bar AUTO-STARTS the singleton daemon and reads from it over
// HTTP. It never spawns a per-fetch `tokmeter --json` scan — those cold-read
// the entire session history into memory (~2GB RSS each), and a stampede of
// them from the 30s poll (daily/models/sessions/signals/cross-tool…) used to
// exhaust RAM and panic the kernel.
//
// The only subprocesses the bar spawns are intentional one-shots:
//   • `tokmeter-mcp daemon start`   — singleton auto-start (debounced, idempotent)
//   • `tokmeter update`         — user-triggered pricing refresh
//   • `tokmeter install-cron`   — user-triggered cron install (in TokmeterLoader)
// All of them are bounded, single invocations — never one-per-fetch.

import Foundation

extension TokmeterLoader {

    func recordConnectionFailure(_ error: Error) {
        needsNodeSetup = false
        isWarming = false
        hasFreshData = false
        liveContextFillPct = nil
        blockPct = nil
        lastError = error.localizedDescription
    }

    // ─── Daemon offline handler (no CLI scan, ever) ──────────────────

    /// Called from `loadData()` when the daemon HTTP endpoint is unreachable.
    /// Starts the singleton daemon once and presents a warming skeleton —
    /// the next 30s poll tick reads real numbers over HTTP once the daemon
    /// is up. Cheap disk-derived footer state (pricing mtime, cron install)
    /// is still surfaced so the badges stay honest while the daemon warms.
    func handleDaemonOffline() async {
        self.isDaemonAlive = false
        self.hasFreshData = false
        self.isWarming = true
        self.lastError = nil
        // Clear the live menubar-color inputs: with the daemon down we have no
        // fresh reading, and both ride the daemon's /api/quick — leaving them
        // would keep the menubar showing a stale color/% (a "live" lie) until
        // the daemon comes back. Cleared → menubarBand falls back to neutral.
        self.liveContextFillPct = nil
        self.blockPct = nil
        applyOfflinePricingAndCronStatus()
        ensureDaemonStarted()
    }

    /// Spawn `tokmeter-mcp daemon start` exactly once, detached. The daemon CLI
    /// itself enforces a PID singleton (it no-ops with "already running" if a
    /// live daemon exists), so the worst case from a redundant call is a quick
    /// no-op child. We still debounce with `isStartingDaemon` so concurrent
    /// poll ticks / fetches can't fork a burst of starts. The flag clears when
    /// the start subprocess returns (the detached child exits immediately
    /// after forking the real daemon).
    func ensureDaemonStarted() {
        guard !isStartingDaemon else { return }
        let candidates = NodeToolchain.candidates()
        guard !candidates.isEmpty else {
            self.lastError =
                "Install Node.js 18 or later, then choose Retry. Tokmeter needs Node to run its local usage service."
            self.isWarming = false
            self.hasFreshData = false
            self.needsNodeSetup = true
            return
        }
        needsNodeSetup = false
        isStartingDaemon = true
        Task { [weak self] in
            guard let self else { return }
            defer { self.isStartingDaemon = false }
            do {
                guard let toolchain = await NodeToolchain.firstSupported(
                    candidates: candidates, environment: ProcessInfo.processInfo.environment) else {
                    self.needsNodeSetup = true
                    throw DaemonError.networkError("No working Node.js 18 or later was found. Update Node and choose Retry.")
                }
                // `daemon start` forks a detached child and returns fast; the
                // child becomes the long-lived daemon. This invocation never
                // scans — it just launches (or no-ops on) the singleton.
                _ = try await self.runProcess(
                    executable: toolchain.npx,
                    arguments: NodeToolchain.daemonArguments(version: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String),
                    timeout: 120
                )
            } catch {
                self.lastError = "Couldn't start the usage service: \(error.localizedDescription)"
                self.isWarming = false
                self.hasFreshData = false
            }
        }
    }

    // ─── Pricing refresh via CLI (user-triggered, one-shot) ──────────

    func refreshPricingViaCLI() async {
        guard let toolchain = NodeToolchain.resolve() else {
            pricingRefreshError = "No node toolchain found — run `tokmeter update` manually."
            return
        }
        do {
            _ = try await runProcess(executable: toolchain.npx,
                                     arguments: ["-y", "@sriinnu/tokmeter", "update"],
                                     timeout: 30)
            await loadData()
        } catch {
            pricingRefreshError = "Pricing update failed: \(error.localizedDescription)"
        }
    }

    // ─── Offline status (no daemon) ──────────────────────────────────

    /// Mirror of /api/pricing-status + /api/cron-status, computed from disk
    /// when the daemon isn't running. These are cheap stat() calls — no scan.
    /// Log parsing (lastRunOk / lastRunTail) stays daemon-side — when the
    /// daemon's dead we just expose install state + 0 last-run.
    func applyOfflinePricingAndCronStatus() {
        let fm = FileManager.default
        let home = NSHomeDirectory()

        let registryPath = home + "/.kosha/registry.json"
        if let attrs = try? fm.attributesOfItem(atPath: registryPath),
           let modified = attrs[.modificationDate] as? Date {
            self.pricingMtime = modified.timeIntervalSince1970 * 1000
        } else {
            self.pricingMtime = 0
        }

        let plistPath = home + "/Library/LaunchAgents/com.sriinnu.tokmeter.daily.plist"
        let installed = fm.fileExists(atPath: plistPath)
        self.cronStatus = CronStatus(
            installed: installed,
            lastRunMtime: 0,
            lastRunOk: nil,
            lastRunTail: ""
        )
    }

    // ─── Subprocess runner ───────────────────────────────────────────

    func runProcess(executable: String, arguments: [String], timeout: TimeInterval) async throws -> String {
        let toolchain = NodeToolchain(binDirectory: URL(fileURLWithPath: executable).deletingLastPathComponent().path)
        return try await SubprocessRunner.run(
            executable: executable, arguments: arguments,
            environment: toolchain.environment(base: ProcessInfo.processInfo.environment), timeout: timeout
        )
    }
}
