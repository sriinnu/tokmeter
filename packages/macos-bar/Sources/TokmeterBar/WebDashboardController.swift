import AppKit
import Foundation

/// Owns only the optional dashboard child. The usage daemon has its own lifecycle.
@MainActor
final class WebDashboardController: ObservableObject {
    static let shared = WebDashboardController()
    @Published private(set) var isRunning = false
    @Published private(set) var isStarting = false
    @Published private(set) var error: String?
    /// Set when the dashboard had to move off the configured port, so the
    /// user knows the address their bookmark doesn't point at.
    @Published private(set) var notice: String?
    private var process: Process?
    private var input: Pipe?
    private var generation = UUID()
    private var terminationObserver: NSObjectProtocol?
    private let resources: URL?
    /// Preferred port (bar.dashboardPort, default 8888; tests pin one). The
    /// dashboard moves off it when something else holds it, instead of
    /// failing with "another server may be using it". It used to be fixed at
    /// 3000, which the web package's own vite dev server also binds.
    private let fixedPort: Int?
    private var activePort: Int
    /// The preferred port the running child was started for. A Settings or
    /// CLI change to bar.dashboardPort restarts the child on the next open.
    private var startedPreferred: Int?
    private let openURL: (URL) -> Void
    private let resolveToolchain: () async -> NodeToolchain?

    /// `port` nil (the app) reads bar.dashboardPort from config.json at each
    /// open, so a change in Settings applies on the next launch of the page.
    init(resources: URL? = Bundle.main.resourceURL, port: Int? = nil,
         openURL: @escaping (URL) -> Void = { NSWorkspace.shared.open($0) },
         resolveToolchain: @escaping () async -> NodeToolchain? = {
             await NodeToolchain.firstSupported(candidates: NodeToolchain.candidates(),
                                                environment: ProcessInfo.processInfo.environment)
         }) {
        self.resources = resources
        self.fixedPort = port
        self.activePort = port ?? HubUserConfig.defaultDashboardPort
        self.openURL = openURL
        self.resolveToolchain = resolveToolchain
        terminationObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.stop() }
        }
    }

    deinit {
        if let terminationObserver { NotificationCenter.default.removeObserver(terminationObserver) }
        try? input?.fileHandleForWriting.close()
    }

    var url: URL { URL(string: "http://127.0.0.1:\(activePort)/")! }

    /// First port in preferred…preferred+9 that 127.0.0.1 can bind, else one
    /// the kernel assigns. The daemon's CORS accepts any localhost port. A
    /// port taken between this check and the child's bind fails the nonce
    /// probe below and reports an error, same as before.
    static func availablePort(preferred: Int) -> Int {
        for candidate in preferred...min(preferred + 9, 65535) where canBind(candidate) { return candidate }
        return boundEphemeralPort() ?? preferred
    }

    private static func withLoopbackSocket<T>(port: Int, _ body: (Int32) -> T?) -> T? {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        defer { close(fd) }
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(UInt16(port).bigEndian)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bound == 0 else { return nil }
        return body(fd)
    }

    private static func canBind(_ port: Int) -> Bool {
        withLoopbackSocket(port: port) { _ in true } ?? false
    }

    private static func boundEphemeralPort() -> Int? {
        withLoopbackSocket(port: 0) { fd in
            var addr = sockaddr_in()
            var len = socklen_t(MemoryLayout<sockaddr_in>.size)
            let ok = withUnsafeMutablePointer(to: &addr) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) }
            }
            return ok == 0 ? Int(UInt16(bigEndian: addr.sin_port)) : nil
        }
    }

    /// The port to aim for right now. Re-reads config.json so a change made
    /// with `tokmeter config set bar.dashboardPort` applies without a relaunch.
    private func preferredPort() -> Int {
        if let fixedPort { return fixedPort }
        HubConfigStore.shared.reload()
        return HubConfigStore.shared.config.dashboardPort
    }

    func open() async {
        guard !isStarting else { return }
        let preferred = preferredPort()
        if isRunning, process?.isRunning == true {
            if preferred == startedPreferred {
                openURL(url)
                return
            }
            stop()
        }
        isStarting = true
        error = nil
        let attempt = UUID()
        generation = attempt
        defer { if generation == attempt { isStarting = false } }
        guard let assets = resources?.appendingPathComponent("Dashboard"),
              FileManager.default.fileExists(atPath: assets.appendingPathComponent("index.html").path),
              FileManager.default.fileExists(atPath: assets.appendingPathComponent("dashboard-server.mjs").path) else {
            error = "Dashboard files are missing. Reinstall Tokmeter."
            return
        }
        guard let toolchain = await resolveToolchain() else {
            if generation == attempt { error = "Install Node.js 18 or newer to open the web dashboard." }
            return
        }
        guard generation == attempt else { return }
        activePort = Self.availablePort(preferred: preferred)
        startedPreferred = preferred
        notice = activePort == preferred ? nil : "Port \(preferred) is in use, so the dashboard opened on \(activePort)."
        let child = Process()
        let stdin = Pipe()
        child.executableURL = URL(fileURLWithPath: toolchain.node)
        child.arguments = [assets.appendingPathComponent("dashboard-server.mjs").path,
                           assets.path, String(activePort), attempt.uuidString]
        child.environment = toolchain.environment(base: ProcessInfo.processInfo.environment)
        child.standardInput = stdin
        child.standardOutput = FileHandle.nullDevice
        child.standardError = FileHandle.nullDevice
        child.terminationHandler = { [weak self] _ in
            Task { @MainActor in
                guard let self, self.generation == attempt else { return }
                self.isRunning = false
                if !self.isStarting { self.error = "Web dashboard stopped. Open it again to restart." }
            }
        }
        do { try child.run() } catch {
            self.error = "Could not start the web dashboard: \(error.localizedDescription)"
            return
        }
        process = child
        input = stdin
        // Check a per-child nonce: an unrelated server on the port is never opened.
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 0.5
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        for _ in 0..<20 {
            guard generation == attempt else { return }
            if !child.isRunning { break }
            if let (data, response) = try? await session.data(from: url.appendingPathComponent("_tokmeter/ready")),
               (response as? HTTPURLResponse)?.statusCode == 200,
               String(data: data, encoding: .utf8) == attempt.uuidString {
                guard generation == attempt, child.isRunning, !Task.isCancelled else { return }
                isRunning = true
                openURL(url)
                return
            }
            try? await Task.sleep(nanoseconds: 150_000_000)
        }
        guard generation == attempt else { return }
        stop()
        error = "Could not start the dashboard on port \(activePort). Another server may be using it."
    }

    func stop() {
        generation = UUID()
        try? input?.fileHandleForWriting.close()
        input = nil
        if let process, process.isRunning { process.terminate() }
        process = nil
        isRunning = false
        isStarting = false
        error = nil
        notice = nil
    }
}
