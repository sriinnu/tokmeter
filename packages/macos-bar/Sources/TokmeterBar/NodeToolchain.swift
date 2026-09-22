import Foundation

/// Resolve a paired Node/npx installation without executing shell profiles.
/// These are user-installed programs, not a sandbox or root-ownership proof.
struct NodeToolchain: Equatable {
    let binDirectory: String
    var node: String { binDirectory + "/node" }
    var npx: String { binDirectory + "/npx" }

    static func resolve(home: String = NSHomeDirectory(), fileManager: FileManager = .default,
                        systemDirectories: [String] = ["/opt/homebrew/bin", "/usr/local/bin"]) -> NodeToolchain? {
        candidates(home: home, fileManager: fileManager, systemDirectories: systemDirectories).first
    }

    static func candidates(home: String = NSHomeDirectory(), fileManager: FileManager = .default,
                           systemDirectories: [String] = ["/opt/homebrew/bin", "/usr/local/bin"]) -> [NodeToolchain] {
        let fixed = systemDirectories + [home + "/.volta/bin"]
        let managed = [
            (home + "/.nvm/versions/node", "/bin"),
            (home + "/.local/share/fnm/node-versions", "/installation/bin"),
            (home + "/Library/Application Support/fnm/node-versions", "/installation/bin"),
            (home + "/.local/share/mise/installs/node", "/bin"),
            (home + "/.asdf/installs/nodejs", "/bin"),
        ]
        let directories = fixed + managed.flatMap { root, suffix in
            (try? fileManager.contentsOfDirectory(atPath: root))?
                .filter { majorVersion($0).map { $0 >= 18 } ?? false }
                .sorted { $0.compare($1, options: .numeric) == .orderedDescending }
                .map { root + "/" + $0 + suffix } ?? []
        }
        return available(directories: directories, isExecutable: fileManager.isExecutableFile(atPath:))
    }

    static func firstAvailable(directories: [String], isExecutable: (String) -> Bool) -> NodeToolchain? {
        available(directories: directories, isExecutable: isExecutable).first
    }

    private static func available(directories: [String], isExecutable: (String) -> Bool) -> [NodeToolchain] {
        var seen = Set<String>()
        return directories.filter {
            seen.insert($0).inserted && isExecutable($0 + "/node") && isExecutable($0 + "/npx")
        }.map { NodeToolchain(binDirectory: $0) }
    }

    /// An old system Node or broken version-manager shim must not hide a
    /// working installation. Probe in preference order, with one total budget
    /// as well as a per-child timeout; never run a shell profile or npm here.
    static func firstSupported(candidates: [NodeToolchain], environment: [String: String],
                               timeout: TimeInterval = 10, probeTimeout: TimeInterval = 2) async -> NodeToolchain? {
        let deadline = ProcessInfo.processInfo.systemUptime + timeout
        for candidate in candidates {
            let remaining = deadline - ProcessInfo.processInfo.systemUptime
            guard remaining > 0, !Task.isCancelled else { return nil }
            do {
                let version = try await SubprocessRunner.run(
                    executable: candidate.node, arguments: ["--version"],
                    environment: candidate.environment(base: environment),
                    timeout: min(probeTimeout, remaining))
                if let major = majorVersion(version), major >= 18 { return candidate }
            } catch {
                // Missing runtimes behind executable shims and hung probes
                // are candidate failures, not proof that Node is unavailable.
            }
        }
        return nil
    }

    static func majorVersion(_ version: String) -> Int? {
        let value = version.trimmingCharacters(in: .whitespacesAndNewlines)
        let digits = value.hasPrefix("v") ? value.dropFirst() : Substring(value)
        return digits.split(separator: ".").first.flatMap { Int($0) }
    }

    func environment(base: [String: String]) -> [String: String] {
        var environment = base
        let paths = [binDirectory, "/opt/homebrew/bin", "/usr/local/bin"]
            + (base["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(separator: ":").map(String.init)
        var seen = Set<String>()
        environment["PATH"] = paths.filter { !$0.isEmpty && seen.insert($0).inserted }.joined(separator: ":")
        return environment
    }

    /// tokmeter-mcp owns the daemon and depends on Tokmeter. Installing Tokmeter
    /// alone does not install tokmeter-mcp, so it cannot bootstrap the daemon.
    static func daemonArguments(version: String?) -> [String] {
        guard let version else { return ["--yes", "@sriinnu/tokmeter-mcp", "daemon", "start"] }
        return ["--yes", "\(daemonPackage(version: version))@\(version)", "daemon", "start"]
    }

    /// The daemon shipped as @sriinnu/drishti through 1.12.x and as
    /// @sriinnu/tokmeter-mcp from 1.13.0; neither exists under the other's
    /// versions, so a pinned bootstrap must pick the name that version had.
    static func daemonPackage(version: String) -> String {
        let parts = version.split(separator: ".").prefix(2).map { Int($0) ?? 0 }
        let major = parts.first ?? 0
        let minor = parts.count > 1 ? parts[1] : 0
        return (major, minor) < (1, 13) ? "@sriinnu/drishti" : "@sriinnu/tokmeter-mcp"
    }
}
