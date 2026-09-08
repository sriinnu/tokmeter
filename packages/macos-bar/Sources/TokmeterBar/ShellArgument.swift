import Foundation

/// One literal argument for POSIX shell commands copied to the clipboard.
enum ShellArgument {
    static func quote(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\"'\"'") + "'"
    }
}
