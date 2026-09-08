import Darwin
import Foundation

enum SubprocessRunner {
    static func run(executable: String, arguments: [String], environment: [String: String], timeout: TimeInterval) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            Execution(executable: executable, arguments: arguments, environment: environment,
                      timeout: timeout, continuation: continuation).start()
        }
    }

    /// Drain both pipes while the child runs. Waiting until termination to
    /// read them deadlocks a noisy npm install once an OS pipe fills.
    private final class Execution: @unchecked Sendable {
        let process = Process()
        let stdout = Pipe()
        let stderr = Pipe()
        let queue = DispatchQueue(label: "tokmeter.subprocess")
        let timeout: TimeInterval
        var continuation: CheckedContinuation<String, Error>?
        var sources: [DispatchSourceRead] = []
        var output = Data()
        var errorOutput = Data()
        var timer: DispatchWorkItem?
        var finished = false
        var ended = [false, false]

        init(executable: String, arguments: [String], environment: [String: String], timeout: TimeInterval,
             continuation: CheckedContinuation<String, Error>) {
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = arguments
            process.environment = environment
            process.standardOutput = stdout
            process.standardError = stderr
            self.timeout = timeout
            self.continuation = continuation
        }

        func start() {
            queue.async { self.launch() }
        }

        private func launch() {
            for (index, pipe) in [stdout, stderr].enumerated() {
                let handle = pipe.fileHandleForReading
                let fd = handle.fileDescriptor
                _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
                let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
                source.setEventHandler { self.drain(error: index == 1) }
                source.setCancelHandler { try? handle.close() }
                sources.append(source)
                source.resume()
            }
            process.terminationHandler = { process in
                self.queue.async {
                    guard !self.finished else { return }
                    self.drain(error: false)
                    self.drain(error: true)
                    if process.terminationStatus != 0 {
                        let line = String(decoding: self.errorOutput, as: UTF8.self)
                            .split(separator: "\n").first.map(String.init) ?? ""
                        let detail = line.isEmpty ? "" : ": \(line)"
                        self.finish(.failure(DaemonError.networkError("exit \(process.terminationStatus)\(detail)")))
                    } else if let text = String(data: self.output, encoding: .utf8) {
                        self.finish(.success(text))
                    } else {
                        self.finish(.failure(DaemonError.decodingError("non-UTF8 CLI output")))
                    }
                }
            }
            do {
                try process.run()
            } catch {
                queue.async { self.finish(.failure(error)) }
                return
            }
            let timer = DispatchWorkItem {
                guard !self.finished else { return }
                if self.process.isRunning { self.process.terminate() }
                // A child that ignores SIGTERM must not outlive its command
                // budget indefinitely. This affects this child only.
                let process = self.process
                self.queue.asyncAfter(deadline: .now() + 1) {
                    if process.isRunning { kill(process.processIdentifier, SIGKILL) }
                }
                self.finish(.failure(DaemonError.networkError("CLI timed out after \(Int(self.timeout))s")))
            }
            self.timer = timer
            queue.asyncAfter(deadline: .now() + timeout, execute: timer)
        }

        func drain(error: Bool) {
            let index = error ? 1 : 0
            guard !finished, !ended[index] else { return }
            let fd = (error ? stderr : stdout).fileHandleForReading.fileDescriptor
            var bytes = [UInt8](repeating: 0, count: 8192)
            while true {
                let count = Darwin.read(fd, &bytes, bytes.count)
                if count == 0 {
                    ended[index] = true
                    sources[index].cancel()
                    return
                }
                if count < 0 { return }
                // Bound retained output while continuing to drain all bytes.
                let available = max(0, (error ? 16_384 : 262_144) - (error ? errorOutput.count : output.count))
                if error { errorOutput.append(contentsOf: bytes.prefix(min(count, available))) }
                else { output.append(contentsOf: bytes.prefix(min(count, available))) }
            }
        }

        func finish(_ result: Result<String, Error>) {
            guard !finished else { return }
            finished = true
            timer?.cancel()
            timer = nil
            for source in sources { source.cancel() }
            sources.removeAll()
            process.terminationHandler = nil
            continuation?.resume(with: result)
            continuation = nil
        }
    }
}
