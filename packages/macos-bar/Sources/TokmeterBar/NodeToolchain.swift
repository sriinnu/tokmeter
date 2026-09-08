import Foundation

/// Resolve a paired Node/npx installation without executing shell profiles.
/// These are user-installed programs, not a sandbox or root-ownership proof.
struct NodeToolchain: Equatable {
    let binDirectory: String
    var node: String { binDirectory + "/node" }
    var npx: String { binDirectory + "/npx" }

    static func resolve(home: String = NSHomeDirectory(), fileManager: FileManager = .default,
                        systemDirectories: [String] = ["/opt/homebrew/bin", "/usr/local/bin"]) -> NodeToolchain? {
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
        return firstAvailable(directories: directories, isExecutable: fileManager.isExecutableFile(atPath:))
    }

    static func firstAvailable(directories: [String], isExecutable: (String) -> Bool) -> NodeToolchain? {
        directories.first { isExecutable($0 + "/node") && isExecutable($0 + "/npx") }
            .map { NodeToolchain(binDirectory: $0) }
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

    /// Drishti owns the daemon and depends on Tokmeter. Installing Tokmeter
    /// alone does not install Drishti, so it cannot bootstrap the daemon.
    static func daemonArguments(version: String?) -> [String] {
        let package = version.map { "@sriinnu/drishti@\($0)" } ?? "@sriinnu/drishti"
        return ["--yes", package, "daemon", "start"]
    }
}
