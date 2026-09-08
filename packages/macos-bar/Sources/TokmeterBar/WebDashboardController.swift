import AppKit
import Foundation

/// Owns only the optional dashboard child. The usage daemon has its own lifecycle.
@MainActor
final class WebDashboardController: ObservableObject {
    static let shared = WebDashboardController()
    @Published private(set) var isRunning = false
    @Published private(set) var isStarting = false
    @Published private(set) var error: String?
    private var process: Process?
    private var input: Pipe?
    private var generation = UUID()
    private var terminationObserver: NSObjectProtocol?
    private let resources: URL?
    private let port: Int
    private let openURL: (URL) -> Void
    private let resolveToolchain: () async -> NodeToolchain?

    init(resources: URL? = Bundle.main.resourceURL, port: Int = 3000,
         openURL: @escaping (URL) -> Void = { NSWorkspace.shared.open($0) },
         resolveToolchain: @escaping () async -> NodeToolchain? = {
             await NodeToolchain.firstSupported(candidates: NodeToolchain.candidates(),
                                                environment: ProcessInfo.processInfo.environment)
         }) {
        self.resources = resources
        self.port = port
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

    var url: URL { URL(string: "http://127.0.0.1:\(port)/")! }

    func open() async {
        guard !isStarting else { return }
        if isRunning, process?.isRunning == true {
            openURL(url)
            return
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
        let child = Process()
        let stdin = Pipe()
        child.executableURL = URL(fileURLWithPath: toolchain.node)
        child.arguments = [assets.appendingPathComponent("dashboard-server.mjs").path,
                           assets.path, String(port), attempt.uuidString]
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
        // Check a per-child nonce: an unrelated server on port 3000 is never opened.
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
        error = "Could not start the dashboard on port \(port). Another server may be using it."
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
    }
}
