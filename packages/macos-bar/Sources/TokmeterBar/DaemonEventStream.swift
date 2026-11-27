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
    private(set) var isConnected = false
    private var generation: UInt64 = 0

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
        isConnected = false
        generation &+= 1
        let gen = generation
        runTask = Task { [weak self] in
            await Self.connectionLoop(generation: gen) { [weak self] in self }
        }
    }

    func stop() {
        stopped = true
        isConnected = false
        generation &+= 1
        runTask?.cancel()
        runTask = nil
        activeSocket?.cancel(with: .normalClosure, reason: nil)
        activeSocket = nil
    }

    /// Connect immediately only when disconnected or stopped, keeping an
    /// already-healthy WebSocket intact so in-flight daemon events aren't dropped.
    func ensureConnected() {
        if runTask == nil || stopped {
            start()
        } else if !isConnected {
            reconnectNow()
        }
    }

    /// Tear down any sleeping backoff or stale socket (e.g. after wake or daemon
    /// restart) and connect immediately.
    func reconnectNow() {
        stopped = false
        isConnected = false
        reconnectAttempt = 0
        generation &+= 1
        let gen = generation
        runTask?.cancel()
        runTask = nil
        activeSocket?.cancel(with: .goingAway, reason: nil)
        activeSocket = nil
        runTask = Task { [weak self] in
            await Self.connectionLoop(generation: gen) { [weak self] in self }
        }
    }

    private enum LoopAction {
        case stop
        case backoff(TimeInterval)
        case connect(url: URL, session: URLSession, token: String)
    }

    @MainActor
    private static func nextAction(
        generation: UInt64,
        owner: () -> DaemonEventStream?
    ) -> LoopAction {
        guard let stream = owner(), !Task.isCancelled, !stream.stopped, stream.generation == generation else {
            return .stop
        }
        guard let token = stream.tokenProvider(true), !token.isEmpty else {
            stream.isConnected = false
            stream.reconnectAttempt += 1
            let delay = min(30.0, max(1.0, reconnectDelay(attempt: stream.reconnectAttempt)))
            return .backoff(delay)
        }
        return .connect(url: stream.wsURL, session: stream.session, token: token)
    }

    private static func connectionLoop(
        generation: UInt64,
        owner: @escaping @MainActor () -> DaemonEventStream?
    ) async {
        while !Task.isCancelled {
            switch nextAction(generation: generation, owner: owner) {
            case .stop:
                return
            case .backoff(let delay):
                try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                continue
            case .connect(let wsURL, let session, let token):
                var request = URLRequest(url: wsURL)
                request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                let socket = session.webSocketTask(with: request)
                if let stream = owner(), !stream.stopped, stream.generation == generation {
                    stream.activeSocket = socket
                } else {
                    return
                }
                socket.resume()

                do {
                    try await socket.send(.string(#"{"type":"subscribe_events"}"#))
                    let shouldContinue: Bool = {
                        guard let stream = owner(),
                              !Task.isCancelled,
                              !stream.stopped,
                              stream.generation == generation else {
                            return false
                        }
                        stream.reconnectAttempt = 0
                        stream.isConnected = true
                        return true
                    }()
                    guard shouldContinue else {
                        socket.cancel(with: .goingAway, reason: nil)
                        return
                    }

                    while !Task.isCancelled {
                        let stillValid = {
                            guard let stream = owner(), !stream.stopped, stream.generation == generation else {
                                return false
                            }
                            return true
                        }()
                        guard stillValid else { break }

                        let message = try await socket.receive()
                        guard !Task.isCancelled else { break }
                        let parsedEvent: DaemonPushEvent?
                        switch message {
                        case .string(let text):
                            parsedEvent = parseEvent(from: text)
                        case .data(let data):
                            parsedEvent = String(data: data, encoding: .utf8).flatMap { parseEvent(from: $0) }
                        @unknown default:
                            parsedEvent = nil
                        }
                        let dispatchOk: Bool = {
                            guard let stream = owner(), !stream.stopped, stream.generation == generation else {
                                return false
                            }
                            if let parsedEvent { stream.onEvent(parsedEvent) }
                            return true
                        }()
                        guard dispatchOk else { break }
                    }
                } catch {
                    socket.cancel(with: .goingAway, reason: nil)
                }

                let backoffDelay: TimeInterval? = {
                    guard let stream = owner() else { return nil }
                    if stream.generation == generation {
                        stream.isConnected = false
                        if stream.activeSocket === socket {
                            stream.activeSocket = nil
                        }
                    }
                    guard !Task.isCancelled, !stream.stopped, stream.generation == generation else {
                        return nil
                    }
                    stream.reconnectAttempt += 1
                    return max(1.0, reconnectDelay(attempt: stream.reconnectAttempt))
                }()
                guard let backoffDelay else { return }
                try? await Task.sleep(nanoseconds: UInt64(backoffDelay * 1_000_000_000))
            }
        }
    }
}
