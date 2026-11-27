// DaemonEventStream.swift — Push-notification WebSocket stream from the
// Tokmeter daemon (ws://127.0.0.1:9876).
//
// The daemon broadcasts `daemon_event` frames whenever its in-memory core
// finishes warming up, completes a background refresh, or crosses local
// midnight (`core_warmed`, `refresh_completed`, `day_rolled_over`). Subscribing
// here lets the menubar UI react in <150ms regardless of `bar.refreshSeconds`
// (even when set to 5+ minutes).

import Foundation

struct DaemonPushEvent: Decodable, Equatable {
    let type: String
    let event: String
    let computedAt: Double?
    let localDate: String?
}

@MainActor
final class DaemonEventStream {
    private let wsURL: URL
    private let tokenProvider: (Bool) -> String?
    private let session: URLSession
    private let onEvent: @MainActor (DaemonPushEvent) -> Void

    private var runTask: Task<Void, Never>?
    private var activeSocket: URLSessionWebSocketTask?
    private var reconnectAttempt = 0
    private var stopped = false

    static func reconnectDelay(attempt: Int) -> TimeInterval {
        guard attempt > 0 else { return 0 }
        return min(30, pow(2.0, Double(attempt - 1)))
    }

    static func parseEvent(from text: String) -> DaemonPushEvent? {
        guard let data = text.data(using: .utf8),
              let msg = try? JSONDecoder().decode(DaemonPushEvent.self, from: data),
              msg.type == "daemon_event" else {
            return nil
        }
        return msg
    }

    init(
        wsURL: URL = DaemonClient.wsURL,
        tokenProvider: @escaping (Bool) -> String? = { forceReload in
            DaemonClient.shared.currentBearerToken(forceReload: forceReload)
        },
        session: URLSession = .shared,
        onEvent: @escaping @MainActor (DaemonPushEvent) -> Void
    ) {
        self.wsURL = wsURL
        self.tokenProvider = tokenProvider
        self.session = session
        self.onEvent = onEvent
    }

    func start() {
        guard runTask == nil else { return }
        stopped = false
        runTask = Task { [weak self] in
            await self?.connectionLoop()
        }
    }

    func stop() {
        stopped = true
        runTask?.cancel()
        runTask = nil
        activeSocket?.cancel(with: .normalClosure, reason: nil)
        activeSocket = nil
    }

    /// Tear down any sleeping backoff or stale socket (e.g. after wake or daemon
    /// restart) and connect immediately.
    func reconnectNow() {
        stopped = false
        reconnectAttempt = 0
        runTask?.cancel()
        runTask = nil
        activeSocket?.cancel(with: .goingAway, reason: nil)
        activeSocket = nil
        runTask = Task { [weak self] in
            await self?.connectionLoop()
        }
    }

    private func connectionLoop() async {
        while !Task.isCancelled && !stopped {
            guard let token = tokenProvider(true), !token.isEmpty else {
                reconnectAttempt += 1
                let delay = min(30.0, max(1.0, Self.reconnectDelay(attempt: reconnectAttempt)))
                try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                continue
            }

            var request = URLRequest(url: wsURL)
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            let socket = session.webSocketTask(with: request)
            activeSocket = socket
            socket.resume()

            do {
                try await socket.send(.string(#"{"type":"subscribe_events"}"#))
                reconnectAttempt = 0

                while !Task.isCancelled && !stopped {
                    let message = try await socket.receive()
                    switch message {
                    case .string(let text):
                        if let event = Self.parseEvent(from: text) {
                            onEvent(event)
                        }
                    case .data(let data):
                        if let text = String(data: data, encoding: .utf8),
                           let event = Self.parseEvent(from: text) {
                            onEvent(event)
                        }
                    @unknown default:
                        break
                    }
                }
            } catch {
                socket.cancel(with: .goingAway, reason: nil)
            }

            if activeSocket === socket {
                activeSocket = nil
            }
            guard !Task.isCancelled && !stopped else { break }

            reconnectAttempt += 1
            let delay = max(1.0, Self.reconnectDelay(attempt: reconnectAttempt))
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
        }
    }
}
