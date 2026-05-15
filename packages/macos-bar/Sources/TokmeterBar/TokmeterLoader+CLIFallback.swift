// TokmeterLoader+CLIFallback.swift — Offline path: when the daemon isn't
// running, spawn the `tokmeter` CLI in a subprocess and use its `--json`
// output to populate the same @Published state the daemon would fill.
//
// Cached to ~/.cache/tokmeter/bar-cache.json with a 120s TTL so the menubar
// doesn't fork a node subprocess every 30s timer tick. Also computes
// pricing-mtime + cron install state from disk so the footer badges stay
// honest while the daemon is down.

import Foundation

extension TokmeterLoader {

    // ─── Pricing refresh via CLI ─────────────────────────────────────

    func refreshPricingViaCLI() async {
        let npxCandidates = [
            "/opt/homebrew/bin/npx",
            "/usr/local/bin/npx",
        ]
        guard let npxPath = npxCandidates.first(where: { FileManager.default.fileExists(atPath: $0) }) else {
            pricingRefreshError = "No node toolchain found — run `tokmeter update` manually."
            return
        }
        do {
            _ = try await runProcess(executable: npxPath,
                                     arguments: ["-y", "@sriinnu/tokmeter", "update"],
                                     timeout: 30)
            let cacheFile = NSHomeDirectory() + "/.cache/tokmeter/bar-cache.json"
            try? FileManager.default.removeItem(atPath: cacheFile)
            await loadData()
        } catch {
            pricingRefreshError = "Pricing update failed: \(error.localizedDescription)"
        }
    }

    // ─── CLI fallback (daemon offline) ───────────────────────────────

    /// When the daemon isn't running, spawn `tokmeter --json` as a subprocess
    /// to read the same session files + scan-cache from disk. The output is
    /// cached to `~/.cache/tokmeter/bar-cache.json` with a 120s TTL so we
    /// don't re-scan on every 30s timer tick.
    func loadFromCLI() async {
        self.isWarming = false
        applyOfflinePricingAndCronStatus()

        let cacheFile = NSHomeDirectory() + "/.cache/tokmeter/bar-cache.json"
        if let cached = readBarCache(path: cacheFile, maxAgeSeconds: 120) {
            applyTokmeterJSON(cached)
            self.lastError = nil
            self.hasFreshData = true
            return
        }

        // Security: we DO NOT shell out via `$SHELL -l -c` — that loads the
        // user's dotfiles, a code-execution path any malicious config can
        // abuse. Instead we resolve `npx` at known root-owned system paths
        // and exec directly with a fixed argv. No user-writable PATH entries,
        // no interpolation, no shell metacharacters.
        let npxCandidates = [
            "/opt/homebrew/bin/npx",
            "/usr/local/bin/npx",
        ]
        guard let npxPath = npxCandidates.first(where: { FileManager.default.fileExists(atPath: $0) }) else {
            self.lastError = "Daemon offline; no node toolchain found at /opt/homebrew or /usr/local."
            self.hasFreshData = false
            return
        }
        let args = ["-y", "@sriinnu/tokmeter", "stats", "--json"]

        do {
            let output = try await runProcess(executable: npxPath, arguments: args, timeout: 15)
            guard let data = output.data(using: .utf8) else {
                self.lastError = "CLI returned non-UTF8 output"
                return
            }
            writeBarCache(data: data, path: cacheFile)

            if let full = try? JSONDecoder().decode(TokmeterFullJSON.self, from: data) {
                applyTokmeterJSON(full)
            } else if let statsOnly = try? JSONDecoder().decode(StatsData.self, from: data) {
                self.stats = statsOnly
                self.totalCost = statsOnly.totalCost
                self.totalTokens = statsOnly.totalTokens
            } else {
                self.lastError = "CLI returned unparseable output"
                return
            }
            self.lastError = nil
            self.hasFreshData = true
        } catch {
            self.lastError = "Daemon offline · CLI: \(error.localizedDescription)"
            self.hasFreshData = false
        }
    }

    func applyTokmeterJSON(_ data: TokmeterFullJSON) {
        self.stats = data.stats
        self.totalCost = data.stats.totalCost
        self.totalTokens = data.stats.totalTokens

        if let today = data.daily.last {
            self.todayCost = today.cost
            self.todayTokens = today.totalTokens
        }

        let mappedDaily = data.daily.map { DailyUsage(date: $0.date, tokens: $0.totalTokens, cost: $0.cost) }
        self.allDaily = mappedDaily
        self.recentDaily = Array(mappedDaily.suffix(7))

        self.topModels = data.models.prefix(5).map(TokmeterLoader.toUsage)
        self.todayModels = []

        let sorted = data.projects
            .sorted { ($0.lastUsed ?? 0) > ($1.lastUsed ?? 0) }
        self.sessions = Array(sorted.prefix(50))
    }

    // ─── Offline status (no daemon) ──────────────────────────────────

    /// Mirror of /api/pricing-status + /api/cron-status, computed from disk
    /// when the daemon isn't running. Log parsing (lastRunOk / lastRunTail)
    /// stays daemon-side — when the daemon's dead we just expose install
    /// state + 0 last-run.
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

    // ─── Disk cache helpers ──────────────────────────────────────────

    func readBarCache(path: String, maxAgeSeconds: TimeInterval) -> TokmeterFullJSON? {
        guard FileManager.default.fileExists(atPath: path),
              let attrs = try? FileManager.default.attributesOfItem(atPath: path),
              let modified = attrs[.modificationDate] as? Date,
              Date().timeIntervalSince(modified) < maxAgeSeconds,
              let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let decoded = try? JSONDecoder().decode(TokmeterFullJSON.self, from: data) else {
            return nil
        }
        return decoded
    }

    func writeBarCache(data: Data, path: String) {
        let dir = (path as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        try? data.write(to: URL(fileURLWithPath: path))
    }

    // ─── Subprocess runner ───────────────────────────────────────────

    func runProcess(executable: String, arguments: [String], timeout: TimeInterval) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            let proc = Process()
            proc.executableURL = URL(fileURLWithPath: executable)
            proc.arguments = arguments

            let outPipe = Pipe()
            proc.standardOutput = outPipe
            proc.standardError = FileHandle.nullDevice

            // Double-resume guard: termination handler and timeout both race
            // to resume the continuation. First caller wins. Boxed in a class
            // so @Sendable closures capture a reference, not a mutable var.
            final class ResumeGuard: @unchecked Sendable {
                var resumed = false
                let lock = NSLock()
            }
            let guardBox = ResumeGuard()
            @Sendable func finish(_ result: Result<String, Error>) {
                guardBox.lock.lock()
                defer { guardBox.lock.unlock() }
                guard !guardBox.resumed else { return }
                guardBox.resumed = true
                switch result {
                case .success(let output): continuation.resume(returning: output)
                case .failure(let error):  continuation.resume(throwing: error)
                }
            }

            proc.terminationHandler = { _ in
                let data = outPipe.fileHandleForReading.readDataToEndOfFile()
                guard let output = String(data: data, encoding: .utf8) else {
                    finish(.failure(DaemonError.decodingError("non-UTF8 CLI output")))
                    return
                }
                finish(.success(output))
            }

            do {
                try proc.run()
            } catch {
                finish(.failure(error))
                return
            }

            DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + timeout) {
                guard proc.isRunning else { return }
                proc.terminate()
                finish(.failure(DaemonError.networkError("CLI timed out after \(Int(timeout))s")))
            }
        }
    }
}
