// TokmeterLoader+CLIFallback.swift — Offline path: when the daemon isn't
// running, the bar AUTO-STARTS the singleton daemon and reads from it over
// HTTP. It never spawns a per-fetch `tokmeter --json` scan — those cold-read
// the entire session history into memory (~2GB RSS each), and a stampede of
// them from the 30s poll (daily/models/sessions/signals/cross-tool…) used to
// exhaust RAM and panic the kernel.
//
// The only subprocesses the bar spawns are intentional one-shots:
//   • `tokmeter daemon start`   — singleton auto-start (debounced, idempotent)
//   • `tokmeter update`         — user-triggered pricing refresh
//   • `tokmeter install-cron`   — user-triggered cron install (in TokmeterLoader)
// All of them are bounded, single invocations — never one-per-fetch.

import Foundation

extension TokmeterLoader {

    // ─── Node toolchain resolution ───────────────────────────────────

    /// Resolve `npx` at known root-owned system paths. We deliberately DO NOT
    /// shell out via `$SHELL -l -c` — that loads the user's dotfiles, a
    /// code-execution path any malicious config can abuse. Exec directly with
    /// a fixed argv: no user-writable PATH entries, no shell metacharacters.
    private func resolveNpxPath() -> String? {
        let npxCandidates = [
            "/opt/homebrew/bin/npx",
            "/usr/local/bin/npx",
        ]
        return npxCandidates.first(where: { FileManager.default.fileExists(atPath: $0) })
    }

    /// PATH for spawned subprocesses. A GUI-launched app inherits launchd's
    /// minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), so `/opt/homebrew/bin`
    /// is absent — and `npx`'s shebang is `#!/usr/bin/env node`, which means
    /// `env` searches PATH for `node` and fails (exit 127) when Homebrew node
    /// isn't there. Result: the daemon never starts, the bar shows "warming"
    /// forever. Prepend the well-known Homebrew/local bins so spawned scripts
    /// can find their interpreter regardless of how the bar was launched.
    private func subprocessEnvironment() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        let prepend = ["/opt/homebrew/bin", "/usr/local/bin"]
        let current = env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        // Prepend only those that aren't already present, preserving order.
        let parts = current.split(separator: ":").map(String.init)
        let needed = prepend.filter { !parts.contains($0) }
        env["PATH"] = (needed + parts).joined(separator: ":")
        return env
    }

    // ─── Daemon offline handler (no CLI scan, ever) ──────────────────

    /// Called from `loadData()` when the daemon HTTP endpoint is unreachable.
    /// Starts the singleton daemon once and presents a warming skeleton —
    /// the next 30s poll tick reads real numbers over HTTP once the daemon
    /// is up. Cheap disk-derived footer state (pricing mtime, cron install)
    /// is still surfaced so the badges stay honest while the daemon warms.
    func handleDaemonOffline() async {
        self.isDaemonAlive = false
        self.isWarming = true
        self.lastError = nil
        applyOfflinePricingAndCronStatus()
        ensureDaemonStarted()
    }

    /// Spawn `tokmeter daemon start` exactly once, detached. The daemon CLI
    /// itself enforces a PID singleton (it no-ops with "already running" if a
    /// live daemon exists), so the worst case from a redundant call is a quick
    /// no-op child. We still debounce with `isStartingDaemon` so concurrent
    /// poll ticks / fetches can't fork a burst of starts. The flag clears when
    /// the start subprocess returns (the detached child exits immediately
    /// after forking the real daemon).
    func ensureDaemonStarted() {
        guard !isStartingDaemon else { return }
        guard let npxPath = resolveNpxPath() else {
            self.lastError =
                "Daemon offline; no node toolchain found at /opt/homebrew or /usr/local."
            self.isWarming = false
            self.hasFreshData = false
            return
        }
        isStartingDaemon = true
        Task { [weak self] in
            defer { Task { @MainActor in self?.isStartingDaemon = false } }
            do {
                // `daemon start` forks a detached child and returns fast; the
                // child becomes the long-lived daemon. This invocation never
                // scans — it just launches (or no-ops on) the singleton.
                _ = try await self?.runProcess(
                    executable: npxPath,
                    arguments: ["-y", "@sriinnu/tokmeter", "daemon", "start"],
                    timeout: 30
                )
            } catch {
                await MainActor.run {
                    self?.lastError =
                        "Couldn't start daemon: \(error.localizedDescription)"
                    self?.isWarming = false
                }
            }
        }
    }

    // ─── Pricing refresh via CLI (user-triggered, one-shot) ──────────

    func refreshPricingViaCLI() async {
        guard let npxPath = resolveNpxPath() else {
            pricingRefreshError = "No node toolchain found — run `tokmeter update` manually."
            return
        }
        do {
            _ = try await runProcess(executable: npxPath,
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
        let env = subprocessEnvironment()
        return try await withCheckedThrowingContinuation { continuation in
            let proc = Process()
            proc.executableURL = URL(fileURLWithPath: executable)
            proc.arguments = arguments
            // Augment PATH so a GUI-launched bar's spawned scripts can find
            // node/bun even though launchd's PATH doesn't include Homebrew.
            proc.environment = env

            let outPipe = Pipe()
            let errPipe = Pipe()
            proc.standardOutput = outPipe
            // Capture stderr instead of /dev/null'ing it — we need it to
            // surface the real failure (e.g. "env: node: No such file or
            // directory" from npx exit-127). Silent success on exit != 0 was
            // the bug that left the bar stuck on "warming" forever.
            proc.standardError = errPipe

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

            proc.terminationHandler = { p in
                let outData = outPipe.fileHandleForReading.readDataToEndOfFile()
                let errData = errPipe.fileHandleForReading.readDataToEndOfFile()
                guard let output = String(data: outData, encoding: .utf8) else {
                    finish(.failure(DaemonError.decodingError("non-UTF8 CLI output")))
                    return
                }
                // Surface non-zero exit as a real failure with the first line
                // of stderr (or a generic message if stderr is empty). Without
                // this, exit-127 from the npx PATH gotcha was silently
                // resolved as success and the bar showed "warming" forever.
                if p.terminationStatus != 0 {
                    let errStr = String(data: errData, encoding: .utf8) ?? ""
                    let firstLine = errStr.split(separator: "\n", maxSplits: 1)
                        .first.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? ""
                    let msg = firstLine.isEmpty
                        ? "exit \(p.terminationStatus)"
                        : "exit \(p.terminationStatus): \(firstLine)"
                    finish(.failure(DaemonError.networkError(msg)))
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
